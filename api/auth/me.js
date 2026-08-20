// api/auth/me.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  ok,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";

import {
  clearAuthCookies,
  getSessionCookieName,
} from "../../lib/cookies.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #29
   AUTH / MEMBER COMPATIBILITY ENDPOINT

   ROUTE
   -----
   GET /api/auth/me

   PURPOSE
   -------
   Return one consistent authenticated member payload for every Card Leo
   portal page.

   THIS ENDPOINT NOW NORMALIZES
   ----------------------------
   - member identity
   - authentication state
   - payment readiness
   - membership readiness
   - portal readiness
   - Access Perks readiness
   - allowance readiness
   - Card Leo virtual card readiness
   - Growth Pool contribution status

   IMPORTANT
   ---------
   This endpoint is READ ONLY.

   It does not:
   - charge Stripe
   - create a card
   - load allowance
   - enroll Access members
   - create Growth Pool contributions

============================================================================ */

/* ==========================================================================
   ROUTES
============================================================================ */

const DEFAULT_REDIRECT =
  "/portal/index.html";

const LOGIN_REDIRECT =
  "/login.html";

const PAYMENT_REDIRECT =
  "/signup.html?status=payment_required";

/* ==========================================================================
   COOKIE NAMES
============================================================================ */

const SESSION_COOKIE_NAME =
  "cardleo_session";

const SESSION_TOKEN_COOKIE_NAME =
  "cardleo_session_token";

const AUTH_COOKIE_ALIASES = [
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,

  "cardleo_auth",
  "cardleo_member",
  "cardleo_member_id",
  "cardleo_portal_session",
  "card_leo_session",

  "member_session",
  "portal_session",
  "session",

  "token",
  "access_token",
  "refresh_token",

  "sb-access-token",
  "sb-refresh-token",
];

const POSSIBLE_SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const POSSIBLE_TOKEN_COOKIE_NAMES = [
  SESSION_TOKEN_COOKIE_NAME,
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",
];

/* ==========================================================================
   STATUS RULES
============================================================================ */

const ACTIVE_ACCOUNT_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
]);

const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
]);

const PAYMENT_REQUIRED_STATUSES = new Set([
  "",
  "unpaid",
  "payment_pending",
  "pending_payment",
  "requires_payment",
  "incomplete",
  "past_due",
  "failed",
  "payment_failed",
]);

const BLOCKED_ACCOUNT_STATUSES = new Set([
  "disabled",
  "suspended",
  "paused",
  "denied",
  "closed",
  "cancelled",
  "canceled",
]);

const BAD_PORTAL_REDIRECTS = new Set([
  "",
  "/",

  "/login",
  "/login.html",
  "login",
  "login.html",

  "/member-login",
  "member-login",

  "/signup",
  "/signup.html",
  "signup",
  "signup.html",

  "/join",
  "join",
]);

/* ==========================================================================
   GENERIC HELPERS
============================================================================ */

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLower(value);
}

function normalizeStatus(value) {
  return normalizeLower(value);
}

function normalizeTier(value) {
  const tier =
    normalizeLower(
      value || "core"
    );

  if (
    [
      "core",
      "silver",
      "gold",
      "platinum",
      "vip",
    ].includes(tier)
  ) {
    return tier;
  }

  return "core";
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    typeof value === "number"
  ) {
    return value !== 0;
  }

  const normalized =
    normalizeLower(value);

  if (
    [
      "true",
      "1",
      "yes",
      "y",
      "on",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "n",
      "off",
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function normalizeNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function normalizeInteger(
  value,
  fallback = 0
) {
  const number =
    Number.parseInt(
      String(value ?? ""),
      10
    );

  return Number.isFinite(number)
    ? number
    : fallback;
}

function centsToDollars(value) {
  return Number(
    (
      normalizeNumber(
        value,
        0
      ) / 100
    ).toFixed(2)
  );
}

function titleCase(value) {
  return normalizeString(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /\b\w/g,
      (character) =>
        character.toUpperCase()
    );
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function getUnixNow() {
  return Math.floor(
    Date.now() / 1000
  );
}

function getClientIp(req) {
  const forwardedFor =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"];

  if (
    typeof forwardedFor === "string" &&
    forwardedFor.trim()
  ) {
    return forwardedFor
      .split(",")[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   DATABASE ERROR HELPERS
============================================================================ */

function isMissingOptionalTableOrColumn(
  error
) {
  const code =
    String(
      error?.code ||
      ""
    );

  const message =
    String(
      error?.message ||
      ""
    ).toLowerCase();

  const details =
    String(
      error?.details ||
      ""
    ).toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes(
      "does not exist"
    ) ||
    message.includes(
      "could not find"
    ) ||
    message.includes(
      "schema cache"
    ) ||
    details.includes(
      "does not exist"
    ) ||
    details.includes(
      "could not find"
    ) ||
    details.includes(
      "schema cache"
    )
  );
}

/* ==========================================================================
   COOKIE HELPERS
============================================================================ */

function appendSetCookie(
  res,
  cookieValue
) {
  const existing =
    res.getHeader(
      "Set-Cookie"
    );

  if (!existing) {
    res.setHeader(
      "Set-Cookie",
      cookieValue
    );

    return;
  }

  if (
    Array.isArray(
      existing
    )
  ) {
    res.setHeader(
      "Set-Cookie",
      [
        ...existing,
        cookieValue,
      ]
    );

    return;
  }

  res.setHeader(
    "Set-Cookie",
    [
      existing,
      cookieValue,
    ]
  );
}

function buildExpiredCookie(
  name,
  {
    httpOnly = true,
  } = {}
) {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax",
  ];

  if (httpOnly) {
    parts.push(
      "HttpOnly"
    );
  }

  if (
    process.env.NODE_ENV ===
    "production"
  ) {
    parts.push(
      "Secure"
    );
  }

  return parts.join("; ");
}

function clearCookieAliases(
  res
) {
  const configuredName =
    typeof getSessionCookieName ===
      "function"
      ? normalizeString(
          getSessionCookieName()
        )
      : "";

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...AUTH_COOKIE_ALIASES,
        ]
          .map(
            normalizeString
          )
          .filter(Boolean)
      )
    );

  for (const name of names) {
    appendSetCookie(
      res,
      buildExpiredCookie(
        name,
        {
          httpOnly:
            true,
        }
      )
    );

    appendSetCookie(
      res,
      buildExpiredCookie(
        name,
        {
          httpOnly:
            false,
        }
      )
    );
  }
}

function clearEveryAuthCookie(
  res
) {
  try {
    clearAuthCookies(
      res
    );
  } catch {
    // Continue clearing all aliases.
  }

  clearCookieAliases(
    res
  );
}

/* ==========================================================================
   COOKIE PARSING
============================================================================ */

function parseCookieHeader(req) {
  if (
    req?.cookies &&
    typeof req.cookies ===
      "object"
  ) {
    return req.cookies;
  }

  const cookieHeader =
    req?.headers?.cookie ||
    "";

  return String(cookieHeader)
    .split(";")
    .map(
      (part) =>
        part.trim()
    )
    .filter(Boolean)
    .reduce(
      (
        cookies,
        part
      ) => {
        const index =
          part.indexOf("=");

        if (index === -1) {
          return cookies;
        }

        const name =
          part
            .slice(
              0,
              index
            )
            .trim();

        const value =
          part
            .slice(
              index + 1
            )
            .trim();

        if (name) {
          cookies[name] =
            value;
        }

        return cookies;
      },
      {}
    );
}

function decodeCookieValue(value) {
  const raw =
    String(value || "");

  if (!raw) {
    return "";
  }

  try {
    return decodeURIComponent(
      raw
    );
  } catch {
    return raw;
  }
}

function safeJsonParse(value) {
  try {
    const parsed =
      JSON.parse(value);

    return isObject(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function safeBase64JsonParse(
  value
) {
  const raw =
    String(value || "");

  if (!raw) {
    return null;
  }

  const attempts = [
    raw,

    raw
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      ),
  ];

  for (
    const attempt
    of attempts
  ) {
    try {
      const padded =
        attempt.padEnd(
          Math.ceil(
            attempt.length / 4
          ) * 4,
          "="
        );

      const decoded =
        Buffer
          .from(
            padded,
            "base64"
          )
          .toString(
            "utf8"
          );

      const parsed =
        JSON.parse(
          decoded
        );

      if (
        isObject(parsed)
      ) {
        return parsed;
      }
    } catch {
      // Try next format.
    }
  }

  return null;
}

function parseSessionValue(
  rawValue
) {
  const decoded =
    decodeCookieValue(
      rawValue
    );

  if (!decoded) {
    return null;
  }

  const parsedJson =
    safeJsonParse(
      decoded
    );

  if (
    isObject(
      parsedJson
    )
  ) {
    return parsedJson;
  }

  const parsedBase64 =
    safeBase64JsonParse(
      decoded
    );

  if (
    isObject(
      parsedBase64
    )
  ) {
    return parsedBase64;
  }

  return null;
}

function readSessionCookie(req) {
  const cookies =
    parseCookieHeader(
      req
    );

  const configuredName =
    typeof getSessionCookieName ===
      "function"
      ? normalizeString(
          getSessionCookieName()
        )
      : "";

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...POSSIBLE_SESSION_COOKIE_NAMES,
        ]
          .map(
            normalizeString
          )
          .filter(Boolean)
      )
    );

  for (const name of names) {
    if (
      !cookies[name]
    ) {
      continue;
    }

    const parsed =
      parseSessionValue(
        cookies[name]
      );

    if (
      isObject(parsed)
    ) {
      return {
        name,

        raw:
          cookies[name],

        value:
          parsed,
      };
    }
  }

  return null;
}

function readSessionTokenCookie(
  req
) {
  const cookies =
    parseCookieHeader(
      req
    );

  for (
    const name
    of POSSIBLE_TOKEN_COOKIE_NAMES
  ) {
    const raw =
      cookies[name];

    if (!raw) {
      continue;
    }

    const token =
      normalizeString(
        decodeCookieValue(
          raw
        )
      );

    if (token) {
      return {
        name,
        token,
      };
    }
  }

  return null;
}

/* ==========================================================================
   SESSION EXPIRATION
============================================================================ */

function getSessionExpiresAt(
  sessionCookie
) {
  const value =
    sessionCookie?.value ||
    sessionCookie ||
    {};

  const candidates = [
    value.expires_at,
    value.expiresAt,
    value.exp,

    value.session?.expires_at,
    value.session?.expiresAt,
  ];

  for (
    const candidate
    of candidates
  ) {
    const number =
      Number(candidate);

    if (
      Number.isFinite(number) &&
      number >
        0
    ) {
      return number;
    }
  }

  return 0;
}

function isSessionExpired(
  sessionCookie
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionCookie
    );

  /*
   * Existing Card Leo sessions are expected to contain expiration.
   * Missing expiration is treated as invalid.
   */

  if (!expiresAt) {
    return true;
  }

  return (
    expiresAt <=
    getUnixNow()
  );
}

/* ==========================================================================
   SESSION IDENTITY
============================================================================ */

function getSessionIdentity(
  sessionCookie
) {
  const value =
    sessionCookie?.value ||
    sessionCookie ||
    {};

  const member =
    isObject(
      value.member
    )
      ? value.member
      : {};

  const profile =
    isObject(
      value.profile
    )
      ? value.profile
      : {};

  const user =
    isObject(
      value.user
    )
      ? value.user
      : {};

  const userMetadata =
    isObject(
      user.user_metadata
    )
      ? user.user_metadata
      : {};

  const ids = [
    value.signupId,
    value.signup_id,

    value.memberId,
    value.member_id,

    value.recordId,
    value.id,

    member.id,
    member.signupId,
    member.signup_id,
    member.memberId,
    member.member_id,

    profile.id,
    profile.signupId,
    profile.signup_id,
    profile.memberId,
    profile.member_id,

    userMetadata.signupId,
    userMetadata.signup_id,
    userMetadata.memberId,
    userMetadata.member_id,

    user.id,
  ]
    .map(
      normalizeString
    )
    .filter(Boolean);

  const portalUserIds = [
    value.portalUserId,
    value.portal_user_id,

    member.portalUserId,
    member.portal_user_id,

    profile.portalUserId,
    profile.portal_user_id,

    user.portalUserId,
    user.portal_user_id,

    userMetadata.portalUserId,
    userMetadata.portal_user_id,
  ]
    .map(
      normalizeString
    )
    .filter(Boolean);

  const email =
    normalizeEmail(
      value.email ||
      value.userEmail ||
      member.email ||
      profile.email ||
      user.email ||
      userMetadata.email
    );

  const token =
    normalizeString(
      value.token ||
      value.sessionToken ||
      value.session_token ||
      value.authToken ||
      value.auth_token ||
      value.loginToken ||
      value.login_token ||
      value.portalToken ||
      value.portal_token ||
      value.session?.token ||
      value.session?.access_token
    );

  return {
    ids:
      Array.from(
        new Set(
          ids
        )
      ),

    portalUserIds:
      Array.from(
        new Set(
          portalUserIds
        )
      ),

    email,

    token,
  };
}

/* ==========================================================================
   MEMBER STATUS / PAYMENT
============================================================================ */

function getDisplayName(member) {
  const fullName =
    normalizeString(
      member?.full_name ||
      member?.fullName
    );

  if (fullName) {
    return fullName;
  }

  return (
    [
      member?.first_name,
      member?.last_name,
    ]
      .map(
        normalizeString
      )
      .filter(Boolean)
      .join(" ") ||
    "Card Leo Member"
  );
}

function isPaymentPaid(member) {
  const paymentStatus =
    normalizeStatus(
      member
        ?.payment_status
    );

  return (
    PAID_PAYMENT_STATUSES.has(
      paymentStatus
    )
  );
}

function isPaymentRequired(member) {
  if (!member) {
    return true;
  }

  const paymentStatus =
    normalizeStatus(
      member.payment_status
    );

  /*
   * If payment_status exists, it is the primary authority.
   */

  if (paymentStatus) {
    return (
      !PAID_PAYMENT_STATUSES.has(
        paymentStatus
      )
    );
  }

  /*
   * Legacy fallback only when payment_status is absent.
   */

  const membershipStatus =
    normalizeStatus(
      member
        .membership_status
    );

  if (
    PAYMENT_REQUIRED_STATUSES.has(
      membershipStatus
    )
  ) {
    return true;
  }

  const status =
    normalizeStatus(
      member.status
    );

  if (
    BLOCKED_ACCOUNT_STATUSES.has(
      status
    )
  ) {
    return true;
  }

  return !(
    ACTIVE_ACCOUNT_STATUSES.has(
      status
    ) &&
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    )
  );
}

function hasPortalAccessForMember(
  member
) {
  if (!member) {
    return false;
  }

  const status =
    normalizeStatus(
      member.status
    );

  const paymentStatus =
    normalizeStatus(
      member.payment_status
    );

  const membershipStatus =
    normalizeStatus(
      member.membership_status
    );

  if (
    BLOCKED_ACCOUNT_STATUSES.has(
      status
    )
  ) {
    return false;
  }

  /*
   * EXPLICIT PAYMENT STATE
   *
   * An approved account alone must NOT unlock the portal when payment_status
   * says unpaid/payment_pending/etc.
   */

  if (paymentStatus) {
    if (
      !PAID_PAYMENT_STATUSES.has(
        paymentStatus
      )
    ) {
      return false;
    }

    return (
      ACTIVE_ACCOUNT_STATUSES.has(
        status
      ) ||
      ACTIVE_MEMBERSHIP_STATUSES.has(
        membershipStatus
      )
    );
  }

  /*
   * LEGACY FALLBACK
   *
   * Used only for very old records without payment_status.
   */

  return (
    ACTIVE_ACCOUNT_STATUSES.has(
      status
    ) &&
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    )
  );
}

function doesMemberRequirePayment(
  member
) {
  return isPaymentRequired(
    member
  );
}

function normalizeMemberStatus(
  member
) {
  if (!member) {
    return "pending";
  }

  if (
    hasPortalAccessForMember(
      member
    )
  ) {
    return "active";
  }

  if (
    doesMemberRequirePayment(
      member
    )
  ) {
    return "payment_required";
  }

  const status =
    normalizeStatus(
      member.status
    );

  if (
    [
      "pending",
      "reviewing",
    ].includes(status)
  ) {
    return "pending";
  }

  if (
    [
      "disabled",
      "suspended",
      "paused",
    ].includes(status)
  ) {
    return "suspended";
  }

  return (
    status ||
    "pending"
  );
}

/* ==========================================================================
   PORTAL REDIRECT
============================================================================ */

function resolvePortalLoginUrl(
  member
) {
  const raw =
    normalizeString(
      member
        ?.portal_login_url
    );

  const normalized =
    raw.toLowerCase();

  if (
    BAD_PORTAL_REDIRECTS.has(
      normalized
    )
  ) {
    return DEFAULT_REDIRECT;
  }

  if (!raw) {
    return DEFAULT_REDIRECT;
  }

  if (
    raw.startsWith("/") &&
    !raw.startsWith("//")
  ) {
    if (
      !raw.startsWith(
        "/portal"
      )
    ) {
      return DEFAULT_REDIRECT;
    }

    return raw;
  }

  return DEFAULT_REDIRECT;
}

/* ==========================================================================
   ACCESS PERKS
============================================================================ */

function getAccessMemberStatus(
  member
) {
  return normalizeString(
    member
      ?.access_member_status ||
    "pending"
  );
}

function getAccessPerksReady(
  member
) {
  const explicit =
    member
      ?.access_perks_ready;

  if (
    typeof explicit ===
    "boolean"
  ) {
    return explicit;
  }

  return (
    getAccessMemberStatus(
      member
    ).toUpperCase() ===
    "OPEN"
  );
}

function buildAccessState(
  member
) {
  const memberIdentifier =
    normalizeString(
      member
        ?.access_member_identifier
    );

  const memberStatus =
    getAccessMemberStatus(
      member
    );

  const ready =
    getAccessPerksReady(
      member
    );

  const syncError =
    normalizeString(
      member
        ?.access_sync_error
    );

  return {
    member_identifier:
      memberIdentifier,

    memberIdentifier,

    member_customer_identifier:
      memberIdentifier,

    member_status:
      memberStatus,

    memberStatus,

    status:
      memberStatus,

    synced_at:
      member
        ?.access_synced_at ||
      null,

    syncedAt:
      member
        ?.access_synced_at ||
      null,

    suspended_at:
      member
        ?.access_suspended_at ||
      null,

    suspendedAt:
      member
        ?.access_suspended_at ||
      null,

    sync_error:
      syncError,

    syncError,

    perks_ready:
      ready,

    perksReady:
      ready,

    benefits_ready:
      ready,

    benefitsReady:
      ready,

    ready,

    requires_sync:
      !ready,

    requiresSync:
      !ready,

    portal_url:
      "/portal/benefits.html",

    portalUrl:
      "/portal/benefits.html",
  };
}

/* ==========================================================================
   HYDRATE MEMBER
============================================================================ */

function hydrateMember(row) {
  if (
    !row?.id
  ) {
    return null;
  }

  return {
    ...row,

    full_name:
      row.full_name ||
      [
        row.first_name,
        row.last_name,
      ]
        .map(
          normalizeString
        )
        .filter(Boolean)
        .join(" "),

    goals:
      row.goals ||
      "",

    referral_name:
      row.referral_name ||
      "",

    referral_email:
      row.referral_email ||
      "",

    referral_code:
      row.referral_code ||
      "",

    tier:
      row.tier ||
      "core",

    email_verified:
      normalizeBoolean(
        row.email_verified,
        false
      ),

    email_verified_at:
      row.email_verified_at ||
      null,

    payment_status:
      row.payment_status ||
      "",

    membership_status:
      row.membership_status ||
      "",

    approval_status:
      row.approval_status ||
      "",

    activation_fee_amount:
      normalizeNumber(
        row.activation_fee_amount,
        25
      ),

    monthly_fee_amount:
      normalizeNumber(
        row.monthly_fee_amount,
        20
      ),

    billing_day:
      normalizeInteger(
        row.billing_day,
        10
      ),

    access_member_identifier:
      row.access_member_identifier ||
      "",

    access_member_status:
      row.access_member_status ||
      "pending",

    access_synced_at:
      row.access_synced_at ||
      null,

    access_suspended_at:
      row.access_suspended_at ||
      null,

    access_sync_error:
      row.access_sync_error ||
      "",

    access_perks_ready:
      normalizeBoolean(
        row.access_perks_ready,
        false
      ),
  };
}

/* ==========================================================================
   SIGNUPS LOOKUP

   IMPORTANT
   ---------
   We intentionally use select("*").

   Your actual Card Leo signups table contains many columns, but not every
   guessed/newer column exists.

   Selecting "*" prevents ONE missing optional column such as approval_status
   from causing the endpoint to throw away valid payment_status or
   membership_status data.
============================================================================ */

async function queryMemberBy({
  column,
  value,
}) {
  if (
    !column ||
    !value
  ) {
    return {
      data:
        null,

      error:
        null,
    };
  }

  return supabaseAdmin
    .from(
      "signups"
    )
    .select("*")
    .eq(
      column,
      value
    )
    .limit(1)
    .maybeSingle();
}

async function queryMemberByEmail(
  email
) {
  const safeEmail =
    normalizeEmail(
      email
    );

  if (!safeEmail) {
    return {
      data:
        null,

      error:
        null,
    };
  }

  return supabaseAdmin
    .from(
      "signups"
    )
    .select("*")
    .ilike(
      "email",
      safeEmail
    )
    .limit(1)
    .maybeSingle();
}

/* ==========================================================================
   TOKEN LOOKUP

   Token columns may not all exist in the real signups table.

   Therefore we test them individually rather than building one PostgREST
   OR expression that fails when any single column is missing.
============================================================================ */

async function queryMemberByToken(
  token
) {
  const safeToken =
    normalizeString(
      token
    );

  if (!safeToken) {
    return {
      data:
        null,

      error:
        null,

      matchedBy:
        "",
    };
  }

  const columns = [
    "session_token",
    "auth_token",
    "login_token",
    "portal_token",
  ];

  let lastError =
    null;

  for (
    const column
    of columns
  ) {
    const {
      data,
      error,
    } =
      await queryMemberBy({
        column,

        value:
          safeToken,
      });

    if (!error) {
      if (
        data?.id
      ) {
        return {
          data,

          error:
            null,

          matchedBy:
            column,
        };
      }

      continue;
    }

    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      continue;
    }

    lastError =
      error;
  }

  return {
    data:
      null,

    error:
      lastError,

    matchedBy:
      "",
  };
}

/* ==========================================================================
   FIND MEMBER FROM SESSION
============================================================================ */

async function findMemberFromSession(
  req,
  sessionCookie
) {
  const tokenCookie =
    readSessionTokenCookie(
      req
    );

  const identity =
    getSessionIdentity(
      sessionCookie
    );

  const sessionToken =
    normalizeString(
      tokenCookie?.token ||
      identity.token
    );

  let lastError =
    null;

  /* ------------------------------------------------------------------------
     MEMBER ID FIRST

     This is the strongest and safest identity lookup.
  ------------------------------------------------------------------------ */

  for (
    const id
    of identity.ids
  ) {
    const {
      data,
      error,
    } =
      await queryMemberBy({
        column:
          "id",

        value:
          id,
      });

    if (error) {
      lastError =
        error;

      continue;
    }

    if (
      data?.id
    ) {
      return {
        member:
          hydrateMember(
            data
          ),

        error:
          null,

        identity,

        matchedBy:
          "id",
      };
    }
  }

  /* ------------------------------------------------------------------------
     PORTAL USER ID
  ------------------------------------------------------------------------ */

  for (
    const portalUserId
    of identity.portalUserIds
  ) {
    const {
      data,
      error,
    } =
      await queryMemberBy({
        column:
          "portal_user_id",

        value:
          portalUserId,
      });

    if (error) {
      if (
        isMissingOptionalTableOrColumn(
          error
        )
      ) {
        continue;
      }

      lastError =
        error;

      continue;
    }

    if (
      data?.id
    ) {
      return {
        member:
          hydrateMember(
            data
          ),

        error:
          null,

        identity,

        matchedBy:
          "portal_user_id",
      };
    }
  }

  /* ------------------------------------------------------------------------
     EMAIL
  ------------------------------------------------------------------------ */

  if (
    identity.email
  ) {
    const {
      data,
      error,
    } =
      await queryMemberByEmail(
        identity.email
      );

    if (error) {
      lastError =
        error;
    } else if (
      data?.id
    ) {
      return {
        member:
          hydrateMember(
            data
          ),

        error:
          null,

        identity,

        matchedBy:
          "email",
      };
    }
  }

  /* ------------------------------------------------------------------------
     TOKEN FALLBACK

     Token is checked last because ID/email are much more reliable and token
     columns may be absent in older signups schemas.
  ------------------------------------------------------------------------ */

  if (
    sessionToken
  ) {
    const tokenResult =
      await queryMemberByToken(
        sessionToken
      );

    if (
      tokenResult.error
    ) {
      lastError =
        tokenResult.error;
    }

    if (
      tokenResult
        .data
        ?.id
    ) {
      return {
        member:
          hydrateMember(
            tokenResult.data
          ),

        error:
          null,

        identity,

        matchedBy:
          tokenResult
            .matchedBy ||
          "session_token",
      };
    }
  }

  return {
    member:
      null,

    error:
      lastError,

    identity,

    matchedBy:
      "",
  };
}

/* ==========================================================================
   OPTIONAL MEMBER CARD
============================================================================ */

async function getMemberCard(
  memberId
) {
  if (!memberId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "member_cards"
      )
      .select("*")
      .eq(
        "member_id",
        memberId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

function buildCardState(
  row
) {
  if (!row) {
    return {
      exists:
        false,

      ready:
        false,

      card_status:
        "not_created",

      cardStatus:
        "not_created",

      card_type:
        "virtual",

      cardType:
        "virtual",

      provider:
        "lithic",

      last_four:
        "",

      lastFour:
        "",

      paused:
        false,

      allowance_balance_cents:
        0,

      allowanceBalanceCents:
        0,

      allowance_balance:
        0,

      allowanceBalance:
        0,

      total_allowance_loaded_cents:
        0,

      totalAllowanceLoadedCents:
        0,

      total_allowance_loaded:
        0,

      totalAllowanceLoaded:
        0,

      portal_url:
        "/portal/card.html",

      portalUrl:
        "/portal/card.html",
    };
  }

  const cardStatus =
    normalizeStatus(
      row.card_status ||
      row.status ||
      "not_created"
    );

  const active =
    [
      "active",
      "open",
      "created",
      "ready",
    ].includes(
      cardStatus
    );

  const balanceCents =
    normalizeInteger(
      row.allowance_balance_cents,
      0
    );

  const lifetimeLoadedCents =
    normalizeInteger(
      row.total_allowance_loaded_cents ??
      row.lifetime_loaded_cents,
      0
    );

  return {
    exists:
      true,

    ready:
      active,

    id:
      row.id ||
      null,

    provider:
      normalizeString(
        row.provider ||
        "lithic"
      ),

    card_status:
      cardStatus,

    cardStatus,

    card_type:
      normalizeString(
        row.card_type ||
        "virtual"
      ),

    cardType:
      normalizeString(
        row.card_type ||
        "virtual"
      ),

    last_four:
      normalizeString(
        row.last_four
      ),

    lastFour:
      normalizeString(
        row.last_four
      ),

    paused:
      normalizeBoolean(
        row.card_paused,
        false
      ),

    allowance_balance_cents:
      balanceCents,

    allowanceBalanceCents:
      balanceCents,

    allowance_balance:
      centsToDollars(
        balanceCents
      ),

    allowanceBalance:
      centsToDollars(
        balanceCents
      ),

    total_allowance_loaded_cents:
      lifetimeLoadedCents,

    totalAllowanceLoadedCents:
      lifetimeLoadedCents,

    total_allowance_loaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    totalAllowanceLoaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    created_at:
      safeDate(
        row.created_at
      ),

    createdAt:
      safeDate(
        row.created_at
      ),

    updated_at:
      safeDate(
        row.updated_at
      ),

    updatedAt:
      safeDate(
        row.updated_at
      ),

    portal_url:
      "/portal/card.html",

    portalUrl:
      "/portal/card.html",
  };
}

/* ==========================================================================
   OPTIONAL ALLOWANCE

   Supports either:
     member_allowances
   or:
     member_allowance

   so the API stays compatible while your allowance schema is finalized.
============================================================================ */

async function queryAllowanceTable(
  table,
  memberId
) {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(table)
      .select("*")
      .eq(
        "member_id",
        memberId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        data:
          null,

        available:
          false,
      };
    }

    throw error;
  }

  return {
    data:
      data ||
      null,

    available:
      true,
  };
}

async function getMemberAllowance(
  memberId
) {
  if (!memberId) {
    return null;
  }

  const tables = [
    "member_allowances",
    "member_allowance",
  ];

  for (
    const table
    of tables
  ) {
    const result =
      await queryAllowanceTable(
        table,
        memberId
      );

    if (
      result.available
    ) {
      return result.data;
    }
  }

  return null;
}

function buildAllowanceState(
  row,
  card
) {
  const availableBalanceCents =
    normalizeInteger(
      row?.available_balance_cents ??
      row?.allowance_balance_cents ??
      card
        ?.allowanceBalanceCents,
      0
    );

  const approvedWaitingCents =
    normalizeInteger(
      row
        ?.approved_waiting_cents ??
      row
        ?.approved_allowance_cents,
      0
    );

  const pendingCents =
    normalizeInteger(
      row
        ?.pending_earnings_cents ??
      row
        ?.pending_cents,
      0
    );

  const processingCents =
    normalizeInteger(
      row
        ?.processing_cents,
      0
    );

  const lifetimeLoadedCents =
    normalizeInteger(
      row
        ?.lifetime_loaded_cents ??
      card
        ?.totalAllowanceLoadedCents,
      0
    );

  const lifetimeSpentCents =
    normalizeInteger(
      row
        ?.lifetime_spent_cents,
      0
    );

  return {
    exists:
      Boolean(row),

    pending_earnings_cents:
      pendingCents,

    pendingEarningsCents:
      pendingCents,

    pending_earnings:
      centsToDollars(
        pendingCents
      ),

    pendingEarnings:
      centsToDollars(
        pendingCents
      ),

    approved_waiting_cents:
      approvedWaitingCents,

    approvedWaitingCents:
      approvedWaitingCents,

    approved_waiting:
      centsToDollars(
        approvedWaitingCents
      ),

    approvedWaiting:
      centsToDollars(
        approvedWaitingCents
      ),

    available_balance_cents:
      availableBalanceCents,

    availableBalanceCents:
      availableBalanceCents,

    available_balance:
      centsToDollars(
        availableBalanceCents
      ),

    availableBalance:
      centsToDollars(
        availableBalanceCents
      ),

    processing_cents:
      processingCents,

    processingCents,

    processing:
      centsToDollars(
        processingCents
      ),

    lifetime_loaded_cents:
      lifetimeLoadedCents,

    lifetimeLoadedCents,

    lifetime_loaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    lifetimeLoaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    lifetime_spent_cents:
      lifetimeSpentCents,

    lifetimeSpentCents,

    lifetime_spent:
      centsToDollars(
        lifetimeSpentCents
      ),

    lifetimeSpent:
      centsToDollars(
        lifetimeSpentCents
      ),

    ready_for_card_load:
      availableBalanceCents >
      0,

    readyForCardLoad:
      availableBalanceCents >
      0,

    portal_url:
      "/portal/rewards.html",

    portalUrl:
      "/portal/rewards.html",
  };
}

/* ==========================================================================
   GROWTH POOL CONTRIBUTION
============================================================================ */

async function getGrowthPoolContribution(
  memberId
) {
  if (!memberId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "growth_pool_transactions"
      )
      .select("*")
      .eq(
        "growth_pool_id",
        1
      )
      .eq(
        "member_id",
        memberId
      )
      .eq(
        "transaction_type",
        "member_activation"
      )
      .in(
        "status",
        [
          "completed",
          "paid",
          "succeeded",
        ]
      )
      .order(
        "created_at",
        {
          ascending:
            true,
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

function buildGrowthPoolState(
  row
) {
  if (!row) {
    return {
      contributed:
        false,

      contribution_amount_cents:
        0,

      contributionAmountCents:
        0,

      contribution_amount:
        0,

      contributionAmount:
        0,

      status:
        "not_contributed",

      contributed_at:
        null,

      contributedAt:
        null,

      portal_url:
        "/portal/rewards.html",

      portalUrl:
        "/portal/rewards.html",
    };
  }

  const amountCents =
    normalizeInteger(
      row.amount_cents,
      Math.round(
        normalizeNumber(
          row.amount,
          2
        ) *
        100
      )
    );

  return {
    contributed:
      true,

    contribution_amount_cents:
      amountCents,

    contributionAmountCents:
      amountCents,

    contribution_amount:
      centsToDollars(
        amountCents
      ),

    contributionAmount:
      centsToDollars(
        amountCents
      ),

    status:
      normalizeStatus(
        row.status ||
        "completed"
      ),

    transaction_id:
      row.id ||
      null,

    transactionId:
      row.id ||
      null,

    contributed_at:
      safeDate(
        row.processed_at ||
        row.created_at
      ),

    contributedAt:
      safeDate(
        row.processed_at ||
        row.created_at
      ),

    portal_url:
      "/portal/rewards.html",

    portalUrl:
      "/portal/rewards.html",
  };
}

/* ==========================================================================
   MEMBER SANITIZATION
============================================================================ */

function sanitizeMember(
  member,
  {
    access = null,
    card = null,
    allowance = null,
    growthPool = null,
  } = {}
) {
  if (!member) {
    return null;
  }

  const tier =
    normalizeTier(
      member.tier ||
      "core"
    );

  const status =
    normalizeStatus(
      member.status ||
      "pending"
    );

  const paymentStatus =
    normalizeStatus(
      member
        .payment_status ||
      ""
    );

  const membershipStatus =
    normalizeStatus(
      member
        .membership_status ||
      ""
    );

  const portalAccess =
    hasPortalAccessForMember(
      member
    );

  const requiresPayment =
    doesMemberRequirePayment(
      member
    );

  const portalLoginUrl =
    resolvePortalLoginUrl(
      member
    );

  const accessState =
    access ||
    buildAccessState(
      member
    );

  return {
    /* ----------------------------------------------------------------------
       IDENTITY
    ---------------------------------------------------------------------- */

    id:
      member.id ||
      null,

    signupId:
      member.id ||
      null,

    signup_id:
      member.id ||
      null,

    memberId:
      member.id ||
      null,

    member_id:
      member.id ||
      null,

    portalUserId:
      member
        .portal_user_id ||
      null,

    portal_user_id:
      member
        .portal_user_id ||
      null,

    email:
      normalizeEmail(
        member.email
      ) ||
      null,

    firstName:
      member.first_name ||
      "",

    first_name:
      member.first_name ||
      "",

    lastName:
      member.last_name ||
      "",

    last_name:
      member.last_name ||
      "",

    fullName:
      getDisplayName(
        member
      ),

    full_name:
      getDisplayName(
        member
      ),

    name:
      getDisplayName(
        member
      ),

    phone:
      member.phone ||
      "",

    city:
      member.city ||
      "",

    state:
      member.state ||
      "",

    interest:
      member.interest ||
      "",

    goals:
      member.goals ||
      "",

    /* ----------------------------------------------------------------------
       REFERRAL
    ---------------------------------------------------------------------- */

    referralName:
      member.referral_name ||
      "",

    referral_name:
      member.referral_name ||
      "",

    referralEmail:
      member.referral_email ||
      "",

    referral_email:
      member.referral_email ||
      "",

    referralCode:
      member.referral_code ||
      "",

    referral_code:
      member.referral_code ||
      "",

    /* ----------------------------------------------------------------------
       STATUS
    ---------------------------------------------------------------------- */

    status,

    payment_status:
      paymentStatus,

    paymentStatus,

    membership_status:
      membershipStatus,

    membershipStatus,

    member_status:
      normalizeMemberStatus(
        member
      ),

    memberStatus:
      normalizeMemberStatus(
        member
      ),

    payment_paid:
      isPaymentPaid(
        member
      ),

    paymentPaid:
      isPaymentPaid(
        member
      ),

    requires_payment:
      requiresPayment,

    requiresPayment,

    payment_required:
      requiresPayment,

    paymentRequired:
      requiresPayment,

    portal_access:
      portalAccess,

    portalAccess,

    /* ----------------------------------------------------------------------
       BILLING
    ---------------------------------------------------------------------- */

    activation_fee_amount:
      normalizeNumber(
        member
          .activation_fee_amount,
        25
      ),

    activationFeeAmount:
      normalizeNumber(
        member
          .activation_fee_amount,
        25
      ),

    monthly_fee_amount:
      normalizeNumber(
        member
          .monthly_fee_amount,
        20
      ),

    monthlyFeeAmount:
      normalizeNumber(
        member
          .monthly_fee_amount,
        20
      ),

    billing_day:
      normalizeInteger(
        member.billing_day,
        10
      ),

    billingDay:
      normalizeInteger(
        member.billing_day,
        10
      ),

    /* ----------------------------------------------------------------------
       TIER
    ---------------------------------------------------------------------- */

    tier,

    tierLabel:
      titleCase(
        tier
      ),

    /* ----------------------------------------------------------------------
       PORTAL
    ---------------------------------------------------------------------- */

    portalLoginUrl,

    portal_login_url:
      portalLoginUrl,

    accessLevel:
      "member",

    access_level:
      "member",

    /* ----------------------------------------------------------------------
       ACCESS
    ---------------------------------------------------------------------- */

    access:
      accessState,

    accessMemberIdentifier:
      accessState
        .memberIdentifier,

    access_member_identifier:
      accessState
        .member_identifier,

    accessMemberStatus:
      accessState
        .memberStatus,

    access_member_status:
      accessState
        .member_status,

    accessPerksReady:
      accessState
        .perksReady,

    access_perks_ready:
      accessState
        .perks_ready,

    benefitsReady:
      accessState
        .benefitsReady,

    benefits_ready:
      accessState
        .benefits_ready,

    /* ----------------------------------------------------------------------
       CARD / ALLOWANCE / GROWTH POOL
    ---------------------------------------------------------------------- */

    card:
      card ||
      null,

    cardReady:
      Boolean(
        card?.ready
      ),

    card_ready:
      Boolean(
        card?.ready
      ),

    allowance:
      allowance ||
      null,

    growthPool:
      growthPool ||
      null,

    growth_pool:
      growthPool ||
      null,

    /* ----------------------------------------------------------------------
       EMAIL
    ---------------------------------------------------------------------- */

    emailVerified:
      normalizeBoolean(
        member.email_verified,
        false
      ),

    email_verified:
      normalizeBoolean(
        member.email_verified,
        false
      ),

    emailVerifiedAt:
      member
        .email_verified_at ||
      null,

    email_verified_at:
      member
        .email_verified_at ||
      null,

    /* ----------------------------------------------------------------------
       DATES
    ---------------------------------------------------------------------- */

    createdAt:
      safeDate(
        member.created_at
      ),

    created_at:
      safeDate(
        member.created_at
      ),

    joinedAt:
      safeDate(
        member.created_at
      ),

    updatedAt:
      safeDate(
        member.updated_at
      ),

    updated_at:
      safeDate(
        member.updated_at
      ),

    role:
      "member",
  };
}

/* ==========================================================================
   BUILD USER
============================================================================ */

function buildUser(
  safeMember
) {
  if (!safeMember) {
    return null;
  }

  return {
    id:
      safeMember.id,

    email:
      safeMember.email,

    role:
      "member",

    user_metadata: {
      full_name:
        safeMember.fullName,

      first_name:
        safeMember.firstName,

      last_name:
        safeMember.lastName,

      status:
        safeMember.status,

      payment_status:
        safeMember.paymentStatus,

      membership_status:
        safeMember.membershipStatus,

      member_status:
        safeMember.memberStatus,

      requires_payment:
        safeMember.requiresPayment,

      portal_access:
        safeMember.portalAccess,

      signup_id:
        safeMember.id,

      member_id:
        safeMember.id,

      portal_user_id:
        safeMember.portalUserId,

      access_member_identifier:
        safeMember
          .accessMemberIdentifier,

      access_member_status:
        safeMember
          .accessMemberStatus,

      access_perks_ready:
        safeMember
          .accessPerksReady,

      card_ready:
        safeMember
          .cardReady,
    },

    app_metadata: {
      provider:
        "cardleo-signups",

      role:
        "member",
    },
  };
}

/* ==========================================================================
   BUILD PROFILE
============================================================================ */

function buildProfile(
  safeMember
) {
  if (!safeMember) {
    return null;
  }

  return {
    id:
      safeMember.id,

    member_id:
      safeMember.id,

    signup_id:
      safeMember.id,

    email:
      safeMember.email,

    full_name:
      safeMember.fullName,

    first_name:
      safeMember.firstName,

    last_name:
      safeMember.lastName,

    phone:
      safeMember.phone,

    city:
      safeMember.city,

    state:
      safeMember.state,

    interest:
      safeMember.interest,

    goals:
      safeMember.goals,

    referral_name:
      safeMember.referralName,

    referral_email:
      safeMember.referralEmail,

    referral_code:
      safeMember.referralCode,

    tier:
      safeMember.tier,

    role:
      "member",

    status:
      safeMember.status,

    payment_status:
      safeMember.paymentStatus,

    membership_status:
      safeMember.membershipStatus,

    member_status:
      safeMember.memberStatus,

    requires_payment:
      safeMember.requiresPayment,

    portal_access:
      safeMember.portalAccess,

    activation_fee_amount:
      safeMember
        .activationFeeAmount,

    monthly_fee_amount:
      safeMember
        .monthlyFeeAmount,

    billing_day:
      safeMember.billingDay,

    portal_login_url:
      safeMember.portalLoginUrl,

    access_member_identifier:
      safeMember
        .accessMemberIdentifier,

    access_member_status:
      safeMember
        .accessMemberStatus,

    access_perks_ready:
      safeMember
        .accessPerksReady,

    benefits_ready:
      safeMember
        .benefitsReady,

    card_ready:
      safeMember
        .cardReady,

    card:
      safeMember.card,

    allowance:
      safeMember.allowance,

    growth_pool:
      safeMember.growthPool,

    email_verified:
      safeMember.emailVerified,

    email_verified_at:
      safeMember.emailVerifiedAt,

    created_at:
      safeMember.createdAt,

    updated_at:
      safeMember.updatedAt,
  };
}

/* ==========================================================================
   PORTAL READINESS
============================================================================ */

function buildPortalReadiness({
  member,
  access,
  card,
  allowance,
}) {
  const paymentReady =
    isPaymentPaid(
      member
    );

  const membershipReady =
    hasPortalAccessForMember(
      member
    );

  const accessReady =
    Boolean(
      access?.ready
    );

  const cardReady =
    Boolean(
      card?.ready
    );

  const allowanceReady =
    normalizeInteger(
      allowance
        ?.availableBalanceCents,
      0
    ) >
    0;

  return {
    authenticated:
      true,

    payment_ready:
      paymentReady,

    paymentReady,

    membership_ready:
      membershipReady,

    membershipReady,

    access_ready:
      accessReady,

    accessReady,

    benefits_ready:
      accessReady,

    benefitsReady:
      accessReady,

    card_ready:
      cardReady,

    cardReady,

    allowance_ready:
      allowanceReady,

    allowanceReady,

    fully_ready:
      paymentReady &&
      membershipReady &&
      accessReady,

    fullyReady:
      paymentReady &&
      membershipReady &&
      accessReady,
  };
}

/* ==========================================================================
   RESPONSE BUILDERS
============================================================================ */

function unauthenticatedResponse(
  res,
  message =
    "No active session.",
  extra = {}
) {
  return ok(
    res,

    {
      authenticated:
        false,

      user:
        null,

      profile:
        null,

      member:
        null,

      session:
        null,

      role:
        "",

      readiness: {
        authenticated:
          false,

        payment_ready:
          false,

        membership_ready:
          false,

        access_ready:
          false,

        benefits_ready:
          false,

        card_ready:
          false,

        allowance_ready:
          false,

        fully_ready:
          false,
      },

      redirectTo:
        LOGIN_REDIRECT,

      ...extra,
    },

    message
  );
}

function paymentRequiredResponse(
  res,
  member,
  message =
    "Membership payment is required."
) {
  const access =
    buildAccessState(
      member
    );

  const safeMember =
    sanitizeMember(
      member,
      {
        access,

        card:
          buildCardState(
            null
          ),

        allowance:
          buildAllowanceState(
            null,
            null
          ),

        growthPool:
          buildGrowthPoolState(
            null
          ),
      }
    );

  return ok(
    res,

    {
      authenticated:
        false,

      user:
        null,

      profile:
        buildProfile(
          safeMember
        ),

      member:
        safeMember,

      session:
        null,

      role:
        "",

      status:
        safeMember?.status ||
        "",

      payment_status:
        safeMember
          ?.paymentStatus ||
        "",

      membership_status:
        safeMember
          ?.membershipStatus ||
        "",

      member_status:
        safeMember
          ?.memberStatus ||
        "payment_required",

      requires_payment:
        true,

      requiresPayment:
        true,

      payment_required:
        true,

      paymentRequired:
        true,

      access,

      readiness: {
        authenticated:
          false,

        payment_ready:
          false,

        paymentReady:
          false,

        membership_ready:
          false,

        membershipReady:
          false,

        access_ready:
          false,

        accessReady:
          false,

        benefits_ready:
          false,

        benefitsReady:
          false,

        card_ready:
          false,

        cardReady:
          false,

        allowance_ready:
          false,

        allowanceReady:
          false,

        fully_ready:
          false,

        fullyReady:
          false,
      },

      redirectTo:
        PAYMENT_REDIRECT,
    },

    message,

    {
      redirectTo:
        PAYMENT_REDIRECT,
    }
  );
}

/* ==========================================================================
   ACTIVE SESSION RESPONSE
============================================================================ */

function activeSessionResponse(
  res,
  {
    member,
    sessionCookie,
    card,
    allowance,
    growthPool,
  }
) {
  const access =
    buildAccessState(
      member
    );

  const safeMember =
    sanitizeMember(
      member,
      {
        access,
        card,
        allowance,
        growthPool,
      }
    );

  const user =
    buildUser(
      safeMember
    );

  const profile =
    buildProfile(
      safeMember
    );

  const value =
    sessionCookie?.value ||
    {};

  const now =
    getUnixNow();

  const expiresAt =
    getSessionExpiresAt(
      sessionCookie
    );

  const redirectTo =
    resolvePortalLoginUrl(
      member
    );

  const readiness =
    buildPortalReadiness({
      member,
      access,
      card,
      allowance,
    });

  return ok(
    res,

    {
      /* --------------------------------------------------------------------
         AUTH
      -------------------------------------------------------------------- */

      authenticated:
        true,

      role:
        "member",

      user,

      profile,

      member:
        safeMember,

      /* --------------------------------------------------------------------
         STATUS
      -------------------------------------------------------------------- */

      status:
        safeMember.status,

      payment_status:
        safeMember.paymentStatus,

      membership_status:
        safeMember
          .membershipStatus,

      member_status:
        safeMember.memberStatus,

      requires_payment:
        false,

      requiresPayment:
        false,

      payment_required:
        false,

      paymentRequired:
        false,

      /* --------------------------------------------------------------------
         ACCESS PERKS
      -------------------------------------------------------------------- */

      access,

      accessPerks: {
        ready:
          access.ready,

        status:
          access.member_status,

        member_identifier:
          access
            .member_identifier,

        memberIdentifier:
          access
            .memberIdentifier,

        synced_at:
          access.synced_at,

        syncedAt:
          access.syncedAt,

        suspended_at:
          access.suspended_at,

        sync_error:
          access.sync_error,

        perks_ready:
          access.perks_ready,

        benefits_ready:
          access
            .benefits_ready,

        portal_url:
          "/portal/benefits.html",
      },

      benefits: {
        ready:
          access.ready,

        access_perks_ready:
          access.perks_ready,

        benefits_ready:
          access
            .benefits_ready,

        href:
          "/portal/benefits.html",
      },

      /* --------------------------------------------------------------------
         CARD
      -------------------------------------------------------------------- */

      card,

      cardReady:
        Boolean(
          card?.ready
        ),

      card_ready:
        Boolean(
          card?.ready
        ),

      /* --------------------------------------------------------------------
         ALLOWANCE
      -------------------------------------------------------------------- */

      allowance,

      /* --------------------------------------------------------------------
         GROWTH POOL
      -------------------------------------------------------------------- */

      growthPool,

      growth_pool:
        growthPool,

      /* --------------------------------------------------------------------
         READINESS
      -------------------------------------------------------------------- */

      readiness,

      /* --------------------------------------------------------------------
         SESSION
      -------------------------------------------------------------------- */

      session: {
        provider:
          "cardleo-signups",

        token_type:
          "custom",

        remember:
          Boolean(
            value.remember
          ),

        expires_at:
          expiresAt ||
          null,

        expiresAt:
          expiresAt ||
          null,

        expires_in:
          expiresAt
            ? Math.max(
                0,
                expiresAt -
                now
              )
            : 0,

        expiresIn:
          expiresAt
            ? Math.max(
                0,
                expiresAt -
                now
              )
            : 0,
      },

      /* --------------------------------------------------------------------
         LINKS
      -------------------------------------------------------------------- */

      links: {
        dashboard:
          "/portal/index.html",

        rewards:
          "/portal/rewards.html",

        card:
          "/portal/card.html",

        benefits:
          "/portal/benefits.html",

        activity:
          "/api/portal/activity",

        growthPool:
          "/api/portal/growth-pool",
      },

      redirectTo,

      fetchedAt:
        new Date()
          .toISOString(),
    },

    "Session active.",

    {
      redirectTo,
    }
  );
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore(
    res
  );

  logRequestStart(
    req,
    {
      scope:
        "auth_me",
    }
  );

  /* ------------------------------------------------------------------------
     METHOD
  ------------------------------------------------------------------------ */

  if (
    req.method !==
    "GET"
  ) {
    return methodNotAllowed(
      res,
      ["GET"],
      "Method not allowed. Use GET."
    );
  }

  try {
    /* ======================================================================
       SESSION COOKIE
    ====================================================================== */

    const sessionCookie =
      readSessionCookie(
        req
      );

    if (
      !sessionCookie
        ?.value
    ) {
      return unauthenticatedResponse(
        res,
        "No active session."
      );
    }

    /* ======================================================================
       EXPIRATION
    ====================================================================== */

    if (
      isSessionExpired(
        sessionCookie
      )
    ) {
      clearEveryAuthCookie(
        res
      );

      logAuthEvent(
        "Session expired.",
        {
          reason:
            "custom_session_expired",

          ip:
            getClientIp(
              req
            ),
        }
      );

      return unauthenticatedResponse(
        res,
        "Session expired. Please sign in again."
      );
    }

    /* ======================================================================
       AUTHENTICATED FLAG
    ====================================================================== */

    if (
      sessionCookie
        .value
        .authenticated !==
      true
    ) {
      clearEveryAuthCookie(
        res
      );

      logAuthEvent(
        "Invalid session cookie.",
        {
          reason:
            "not_authenticated",

          ip:
            getClientIp(
              req
            ),
        }
      );

      return unauthenticatedResponse(
        res,
        "Session invalid. Please sign in again."
      );
    }

    /* ======================================================================
       FIND MEMBER
    ====================================================================== */

    const {
      member,
      error:
        memberLookupError,
      identity,
      matchedBy,
    } =
      await findMemberFromSession(
        req,
        sessionCookie
      );

    if (
      memberLookupError
    ) {
      logRequestError(
        req,
        memberLookupError,
        {
          scope:
            "auth_me_member_lookup",

          sessionCookieName:
            sessionCookie.name,
        }
      );

      return serverError(
        res,
        "Unable to verify your account right now."
      );
    }

    /* ======================================================================
       MEMBER NOT FOUND
    ====================================================================== */

    if (
      !member?.id
    ) {
      clearEveryAuthCookie(
        res
      );

      logAuthEvent(
        "Session member not found.",
        {
          email:
            identity?.email ||
            "",

          ids:
            identity?.ids ||
            [],

          portalUserIds:
            identity
              ?.portalUserIds ||
            [],

          ip:
            getClientIp(
              req
            ),
        }
      );

      return unauthenticatedResponse(
        res,
        "Account not found. Please sign in again."
      );
    }

    /* ======================================================================
       PAYMENT / ACCESS GATE
    ====================================================================== */

    if (
      !hasPortalAccessForMember(
        member
      )
    ) {
      const requiresPayment =
        doesMemberRequirePayment(
          member
        );

      logAuthEvent(
        "Session blocked for inactive or unpaid account.",
        {
          email:
            member.email,

          memberId:
            member.id,

          status:
            normalizeStatus(
              member.status
            ),

          paymentStatus:
            normalizeStatus(
              member
                .payment_status
            ),

          membershipStatus:
            normalizeStatus(
              member
                .membership_status
            ),

          requiresPayment,

          ip:
            getClientIp(
              req
            ),
        }
      );

      /* --------------------------------------------------------------------
         PAYMENT REQUIRED

         IMPORTANT:
         We do NOT clear the member's session here.

         This allows an existing signup to be sent to payment instead of
         being forced through the create-account form again.
      -------------------------------------------------------------------- */

      if (
        requiresPayment
      ) {
        return paymentRequiredResponse(
          res,
          member,
          "Membership payment is required before portal access."
        );
      }

      /* --------------------------------------------------------------------
         BLOCKED / SUSPENDED
      -------------------------------------------------------------------- */

      clearEveryAuthCookie(
        res
      );

      return unauthenticatedResponse(
        res,
        "Your account is not active.",
        {
          status:
            normalizeStatus(
              member.status
            ),

          payment_status:
            normalizeStatus(
              member
                .payment_status
            ),

          membership_status:
            normalizeStatus(
              member
                .membership_status
            ),

          redirectTo:
            LOGIN_REDIRECT,
        }
      );
    }

    /* ======================================================================
       LOAD PORTAL READINESS DATA
    ====================================================================== */

    const [
      cardRow,
      allowanceRow,
      growthPoolRow,
    ] =
      await Promise.all([
        getMemberCard(
          member.id
        ),

        getMemberAllowance(
          member.id
        ),

        getGrowthPoolContribution(
          member.id
        ),
      ]);

    const card =
      buildCardState(
        cardRow
      );

    const allowance =
      buildAllowanceState(
        allowanceRow,
        card
      );

    const growthPool =
      buildGrowthPoolState(
        growthPoolRow
      );

    const access =
      buildAccessState(
        member
      );

    /* ======================================================================
       LOG AUTH SUCCESS
    ====================================================================== */

    logAuthEvent(
      "Session check successful.",
      {
        email:
          member.email,

        memberId:
          member.id,

        matchedBy:
          matchedBy ||
          "",

        status:
          normalizeStatus(
            member.status
          ),

        paymentStatus:
          normalizeStatus(
            member
              .payment_status
          ),

        membershipStatus:
          normalizeStatus(
            member
              .membership_status
          ),

        accessMemberStatus:
          access.memberStatus,

        accessPerksReady:
          access.ready,

        cardReady:
          card.ready,

        allowanceBalanceCents:
          allowance
            .availableBalanceCents,

        growthPoolContributed:
          growthPool
            .contributed,

        ip:
          getClientIp(
            req
          ),
      }
    );

    logRequestSuccess(
      req,
      {
        scope:
          "auth_me",

        memberId:
          member.id,

        email:
          member.email,

        matchedBy:
          matchedBy ||
          "",

        paymentReady:
          isPaymentPaid(
            member
          ),

        accessReady:
          access.ready,

        cardReady:
          card.ready,

        growthPoolContributed:
          growthPool
            .contributed,
      }
    );

    /* ======================================================================
       ACTIVE RESPONSE
    ====================================================================== */

    return activeSessionResponse(
      res,
      {
        member,

        sessionCookie,

        card,

        allowance,

        growthPool,
      }
    );
  } catch (error) {
    /*
     * Unexpected server/database failures invalidate the current session
     * rather than leaving stale browser auth state behind.
     */

    clearEveryAuthCookie(
      res
    );

    logRequestError(
      req,
      error,
      {
        scope:
          "auth_me_unexpected",
      }
    );

    console.error(
      "Card Leo /api/auth/me error:",
      error
    );

    return serverError(
      res,

      "Something went wrong while checking the current session.",

      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null,
          }
        : null
    );
  }
}