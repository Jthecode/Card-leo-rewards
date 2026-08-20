// api/portal/activity.js

import crypto from "crypto";

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  ok,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";

import {
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #28
   UNIFIED MEMBER ACTIVITY API

   ROUTE
   -----
   GET /api/portal/activity

   PURPOSE
   -------
   Build one clean authenticated member activity feed combining:

   - Account lifecycle
   - Membership/payment activity
   - Referral activity
   - Referral rewards
   - Reward transactions
   - Allowance approvals
   - Allowance card loads
   - Card issuance/status
   - Access Perks membership sync
   - Access benefit redemptions
   - Growth Pool contribution
   - Support tickets
   - Existing member_activity records

   IMPORTANT
   ---------
   The feed is READ ONLY.

   It does not:
   - create rewards
   - load cards
   - redeem Access offers
   - create Growth Pool contributions
   - change membership state

   DUPLICATE PROTECTION
   --------------------
   Different APIs/tables can represent the same business event.

   This endpoint deduplicates activity using:
   - provider event ID
   - Stripe event/session/invoice IDs
   - source + transaction IDs
   - referral IDs
   - redemption IDs
   - card IDs
   - stable business-event fingerprints

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 150;

const DEFAULT_PORTAL_PATH =
  "/portal/index.html";

const DEFAULT_TIMEZONE =
  "America/New_York";

const GROWTH_POOL_ID = 1;

/* ==========================================================================
   CATEGORIES
============================================================================ */

const VALID_CATEGORIES = [
  "all",
  "account",
  "rewards",
  "allowance",
  "cards",
  "referrals",
  "benefits",
  "growth_pool",
  "support",
  "system",
];

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
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
  "succeeded",
  "complete",
  "completed",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
]);

const INACTIVE_STATUSES = new Set([
  "inactive",
  "disabled",
  "suspended",
  "paused",
  "denied",
  "closed",
  "cancelled",
  "canceled",
  "unpaid",
  "past_due",
  "payment_failed",
  "failed",
]);

/* ==========================================================================
   COOKIE NAMES
============================================================================ */

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLower(value);
}

function normalizeStatus(value) {
  return normalizeLower(value);
}

function normalizeTier(value) {
  const tier =
    normalizeLower(value || "core");

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

function toPositiveInteger(
  value,
  fallback = DEFAULT_LIMIT
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return fallback;
  }

  return Math.min(
    Math.floor(number),
    MAX_LIMIT
  );
}

function normalizeCategory(value) {
  const category =
    normalizeLower(value || "all");

  return VALID_CATEGORIES.includes(
    category
  )
    ? category
    : "all";
}

function titleCase(value) {
  return normalizeText(value)
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

function safeNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function safeInteger(
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

function money(value) {
  return Number(
    safeNumber(
      value,
      0
    ).toFixed(2)
  );
}

function centsToDollars(value) {
  return money(
    safeNumber(
      value,
      0
    ) / 100
  );
}

function getUnixNow() {
  return Math.floor(
    Date.now() / 1000
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(
      String(value ?? "")
    )
    .digest("hex");
}

function firstText(
  object,
  keys,
  fallback = ""
) {
  for (const key of keys) {
    const value =
      normalizeText(
        object?.[key]
      );

    if (value) {
      return value;
    }
  }

  return fallback;
}

function firstNumber(
  object,
  keys,
  fallback = 0
) {
  for (const key of keys) {
    const value =
      object?.[key];

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      const number =
        Number(value);

      if (
        Number.isFinite(number)
      ) {
        return number;
      }
    }
  }

  return fallback;
}

/* ==========================================================================
   CLIENT IP
============================================================================ */

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
   COOKIE PARSING
============================================================================ */

function parseCookieHeader(req) {
  if (
    req?.cookies &&
    typeof req.cookies === "object"
  ) {
    return req.cookies;
  }

  const cookieHeader =
    req?.headers?.cookie || "";

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
            .slice(0, index)
            .trim();

        const value =
          part
            .slice(index + 1)
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

function parseJsonObject(value) {
  if (isObject(value)) {
    return value;
  }

  const raw =
    normalizeText(value);

  if (!raw) {
    return null;
  }

  const decoded =
    decodeCookieValue(raw);

  const parsed =
    safeJsonParse(
      decoded,
      null
    );

  if (isObject(parsed)) {
    return parsed;
  }

  try {
    const base64Decoded =
      Buffer
        .from(
          decoded,
          "base64"
        )
        .toString(
          "utf8"
        );

    const parsedBase64 =
      safeJsonParse(
        base64Decoded,
        null
      );

    if (
      isObject(
        parsedBase64
      )
    ) {
      return parsedBase64;
    }
  } catch {
    // Ignore malformed base64.
  }

  try {
    const normalized =
      decoded
        .replace(
          /-/g,
          "+"
        )
        .replace(
          /_/g,
          "/"
        );

    const padded =
      normalized.padEnd(
        Math.ceil(
          normalized.length / 4
        ) * 4,
        "="
      );

    const decodedUrl =
      Buffer
        .from(
          padded,
          "base64"
        )
        .toString(
          "utf8"
        );

    const parsedUrl =
      safeJsonParse(
        decodedUrl,
        null
      );

    if (
      isObject(
        parsedUrl
      )
    ) {
      return parsedUrl;
    }
  } catch {
    // Ignore malformed base64url.
  }

  return null;
}

function readSessionCookie(req) {
  const cookies =
    parseCookieHeader(req);

  const configuredName =
    typeof getSessionCookieName ===
      "function"
      ? normalizeText(
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
            normalizeText
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
      parseJsonObject(
        cookies[name]
      );

    if (
      isObject(parsed)
    ) {
      return {
        name,
        value:
          parsed,
      };
    }
  }

  return null;
}

/* ==========================================================================
   SESSION
============================================================================ */

function getSessionExpiresAt(
  sessionCookie
) {
  const value =
    sessionCookie?.value ||
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
      number > 0
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

  if (!expiresAt) {
    return true;
  }

  return (
    expiresAt <=
    getUnixNow()
  );
}

function getSessionMemberId(
  sessionCookie
) {
  const value =
    sessionCookie?.value ||
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

  const metadata =
    isObject(
      user.user_metadata
    )
      ? user.user_metadata
      : {};

  return normalizeText(
    member.id ||
      member.signupId ||
      member.signup_id ||
      member.memberId ||
      member.member_id ||
      profile.id ||
      profile.signupId ||
      profile.signup_id ||
      profile.memberId ||
      profile.member_id ||
      user.id ||
      metadata.signupId ||
      metadata.signup_id ||
      metadata.memberId ||
      metadata.member_id ||
      value.signupId ||
      value.signup_id ||
      value.memberId ||
      value.member_id ||
      value.id
  );
}

function getSessionEmail(
  sessionCookie
) {
  const value =
    sessionCookie?.value ||
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

  const metadata =
    isObject(
      user.user_metadata
    )
      ? user.user_metadata
      : {};

  return normalizeEmail(
    member.email ||
      profile.email ||
      user.email ||
      metadata.email ||
      value.email ||
      value.userEmail
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
   MEMBER
============================================================================ */

function getDisplayName(member) {
  const fullName =
    normalizeText(
      member?.full_name
    );

  if (fullName) {
    return fullName;
  }

  const joined =
    [
      member?.first_name,
      member?.last_name,
    ]
      .map(
        normalizeText
      )
      .filter(Boolean)
      .join(" ");

  return (
    joined ||
    "Card Leo Member"
  );
}

function hasPortalAccess(member) {
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

  /*
   * approval_status is optional.
   * Your current real schema may not contain it.
   */
  const approvalStatus =
    normalizeStatus(
      member.approval_status
    );

  if (
    INACTIVE_STATUSES.has(
      status
    ) ||
    INACTIVE_STATUSES.has(
      paymentStatus
    ) ||
    INACTIVE_STATUSES.has(
      membershipStatus
    ) ||
    INACTIVE_STATUSES.has(
      approvalStatus
    )
  ) {
    return false;
  }

  return (
    ACTIVE_STATUSES.has(
      status
    ) ||
    PAID_PAYMENT_STATUSES.has(
      paymentStatus
    ) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_STATUSES.has(
      approvalStatus
    )
  );
}

function normalizeMemberStatus(
  member
) {
  if (!member) {
    return "pending";
  }

  if (
    hasPortalAccess(
      member
    )
  ) {
    return "active";
  }

  const status =
    normalizeStatus(
      member.status
    );

  if (
    [
      "pending",
      "reviewing",
      "",
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
   ACCESS PERKS
============================================================================ */

function getAccessMemberStatus(
  member
) {
  return normalizeText(
    member?.access_member_status ||
    "pending"
  );
}

function getAccessPerksReady(
  member
) {
  const raw =
    member
      ?.access_perks_ready;

  if (
    typeof raw ===
    "boolean"
  ) {
    return raw;
  }

  return (
    getAccessMemberStatus(
      member
    ).toUpperCase() ===
    "OPEN"
  );
}

function buildAccessPayload(
  member
) {
  const accessMemberStatus =
    getAccessMemberStatus(
      member
    );

  const accessPerksReady =
    getAccessPerksReady(
      member
    );

  return {
    member_identifier:
      normalizeText(
        member
          ?.access_member_identifier
      ),

    member_customer_identifier:
      normalizeText(
        member
          ?.access_member_identifier
      ),

    member_status:
      accessMemberStatus,

    status:
      accessMemberStatus,

    synced_at:
      member
        ?.access_synced_at ||
      null,

    suspended_at:
      member
        ?.access_suspended_at ||
      null,

    sync_error:
      normalizeText(
        member
          ?.access_sync_error
      ),

    perks_ready:
      accessPerksReady,

    benefits_ready:
      accessPerksReady,

    ready:
      accessPerksReady,
  };
}

/* ==========================================================================
   SANITIZE MEMBER
============================================================================ */

function sanitizeMember(member) {
  if (!member) {
    return null;
  }

  const tier =
    normalizeTier(
      member.tier ||
      "core"
    );

  const portalAccess =
    hasPortalAccess(
      member
    );

  const access =
    buildAccessPayload(
      member
    );

  const status =
    normalizeStatus(
      member.status
    ) ||
    "pending";

  const paymentStatus =
    normalizeStatus(
      member.payment_status
    );

  const membershipStatus =
    normalizeStatus(
      member.membership_status
    );

  const approvalStatus =
    normalizeStatus(
      member.approval_status
    );

  return {
    id:
      member.id ||
      null,

    signupId:
      member.id ||
      null,

    signup_id:
      member.id ||
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

    status:
      portalAccess
        ? "active"
        : status,

    payment_status:
      paymentStatus,

    membership_status:
      portalAccess
        ? "active"
        : membershipStatus,

    approval_status:
      portalAccess
        ? "approved"
        : approvalStatus,

    paymentStatus,

    membershipStatus:
      portalAccess
        ? "active"
        : membershipStatus,

    approvalStatus:
      portalAccess
        ? "approved"
        : approvalStatus,

    memberStatus:
      normalizeMemberStatus(
        member
      ),

    tier,

    tierLabel:
      titleCase(
        tier
      ),

    referralCode:
      member.referral_code ||
      "",

    referral_code:
      member.referral_code ||
      "",

    portalLoginUrl:
      member.portal_login_url ||
      DEFAULT_PORTAL_PATH,

    portal_login_url:
      member.portal_login_url ||
      DEFAULT_PORTAL_PATH,

    portalAccess,

    portal_access:
      portalAccess,

    accessMemberIdentifier:
      access
        .member_identifier,

    access_member_identifier:
      access
        .member_identifier,

    accessMemberStatus:
      access
        .member_status,

    access_member_status:
      access
        .member_status,

    accessPerksReady:
      access
        .perks_ready,

    access_perks_ready:
      access
        .perks_ready,

    createdAt:
      member.created_at ||
      null,

    created_at:
      member.created_at ||
      null,

    updatedAt:
      member.updated_at ||
      null,

    updated_at:
      member.updated_at ||
      null,

    role:
      "member",
  };
}

/* ==========================================================================
   SIGNUPS SELECT
============================================================================ */

function getSignupSelectFields({
  extended = true,
} = {}) {
  /*
   * Base fields confirmed in the existing Card Leo signups schema.
   */

  const base = [
    "id",
    "first_name",
    "last_name",
    "full_name",
    "email",
    "phone",
    "city",
    "state",
    "interest",
    "agreed",
    "status",
    "created_at",
    "updated_at",
    "portal_user_id",
    "portal_login_url",
  ];

  if (!extended) {
    return base.join(", ");
  }

  /*
   * Optional fields.
   *
   * If any do not exist, getSignupRecord() falls back to the base query.
   */

  return [
    ...base,
    "goals",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "payment_status",
    "membership_status",
    "approval_status",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_checkout_session_id",
    "access_member_identifier",
    "access_member_status",
    "access_synced_at",
    "access_suspended_at",
    "access_sync_error",
    "access_perks_ready",
  ].join(", ");
}

function hydrateFallbackSignupRecord(
  row
) {
  if (!row) {
    return null;
  }

  return {
    ...row,

    goals:
      "",

    tier:
      "core",

    referral_code:
      "",

    email_verified:
      false,

    email_verified_at:
      null,

    payment_status:
      "",

    membership_status:
      "",

    approval_status:
      "",

    activation_fee_amount:
      25,

    monthly_fee_amount:
      20,

    billing_day:
      10,

    stripe_customer_id:
      "",

    stripe_subscription_id:
      "",

    stripe_checkout_session_id:
      "",

    access_member_identifier:
      "",

    access_member_status:
      "pending",

    access_synced_at:
      null,

    access_suspended_at:
      null,

    access_sync_error:
      "",

    access_perks_ready:
      false,
  };
}

/* ==========================================================================
   SIGNUP LOOKUP
============================================================================ */

async function getSignupRecord({
  memberId,
  email,
}) {
  let query =
    supabaseAdmin
      .from("signups")
      .select(
        getSignupSelectFields({
          extended:
            true,
        })
      )
      .limit(1);

  if (memberId) {
    query =
      query.eq(
        "id",
        memberId
      );
  } else {
    query =
      query.ilike(
        "email",
        email
      );
  }

  let result =
    await query
      .maybeSingle();

  if (
    result.error &&
    isMissingOptionalTableOrColumn(
      result.error
    )
  ) {
    let fallbackQuery =
      supabaseAdmin
        .from(
          "signups"
        )
        .select(
          getSignupSelectFields({
            extended:
              false,
          })
        )
        .limit(1);

    if (memberId) {
      fallbackQuery =
        fallbackQuery.eq(
          "id",
          memberId
        );
    } else {
      fallbackQuery =
        fallbackQuery.ilike(
          "email",
          email
        );
    }

    const fallback =
      await fallbackQuery
        .maybeSingle();

    return {
      data:
        hydrateFallbackSignupRecord(
          fallback.data
        ),

      error:
        fallback.error,
    };
  }

  return result;
}

/* ==========================================================================
   AUTH
============================================================================ */

async function getAuthenticatedMember(
  req,
  res
) {
  const sessionCookie =
    readSessionCookie(req);

  if (
    !sessionCookie?.value
  ) {
    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Unauthorized. Please sign in."
        ),
    };
  }

  if (
    isSessionExpired(
      sessionCookie
    )
  ) {
    clearAuthCookies(
      res
    );

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Session expired. Please sign in again."
        ),
    };
  }

  if (
    sessionCookie
      .value
      .authenticated !==
    true
  ) {
    clearAuthCookies(
      res
    );

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Session invalid. Please sign in again."
        ),
    };
  }

  const memberId =
    getSessionMemberId(
      sessionCookie
    );

  const email =
    getSessionEmail(
      sessionCookie
    );

  if (
    !memberId &&
    !email
  ) {
    clearAuthCookies(
      res
    );

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Session missing member information."
        ),
    };
  }

  const {
    data,
    error,
  } =
    await getSignupRecord({
      memberId,
      email,
    });

  if (error) {
    throw error;
  }

  if (
    !data?.id
  ) {
    clearAuthCookies(
      res
    );

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Account not found. Please sign in again."
        ),
    };
  }

  if (
    !hasPortalAccess(
      data
    )
  ) {
    return {
      member:
        null,

      response:
        forbidden(
          res,

          "Your account is pending approval or payment.",

          {
            authenticated:
              true,

            member:
              sanitizeMember(
                data
              ),

            requires_payment:
              true,

            requiresPayment:
              true,

            redirectTo:
              "/signup.html?status=payment_required",
          }
        ),
    };
  }

  return {
    member:
      data,

    response:
      null,
  };
}

/* ==========================================================================
   CATEGORY MAP
============================================================================ */

function activityTypeToCategory(
  type
) {
  const normalized =
    normalizeLower(type);

  /* ------------------------------------------------------------------------
     ALLOWANCE
  ------------------------------------------------------------------------ */

  if (
    [
      "allowance_approved",
      "allowance_pending",
      "allowance_available",
      "allowance_load",
      "allowance_loaded",
      "allowance_debit",
      "allowance_credit",
      "allowance_adjustment",
      "cardleo_allocation",
      "payout",
    ].includes(normalized)
  ) {
    return "allowance";
  }

  /* ------------------------------------------------------------------------
     CARD
  ------------------------------------------------------------------------ */

  if (
    [
      "card_created",
      "card_issued",
      "card_activated",
      "card_paused",
      "card_resumed",
      "card_closed",
      "virtual_card_created",
      "card_status_changed",
    ].includes(normalized)
  ) {
    return "cards";
  }

  /* ------------------------------------------------------------------------
     REWARDS
  ------------------------------------------------------------------------ */

  if (
    [
      "reward_earned",
      "reward_redeemed",
      "reward_expired",
      "reward_adjusted",
      "reward_bonus",
      "membership_payment_recorded",
      "direct_referral_bonus",
      "override_referral_bonus",
      "team_referral_bonus",
    ].includes(normalized)
  ) {
    return "rewards";
  }

  /* ------------------------------------------------------------------------
     GROWTH POOL
  ------------------------------------------------------------------------ */

  if (
    [
      "growth_pool_contribution",
      "member_activation",
      "growth_pool_member_activation",
    ].includes(normalized)
  ) {
    return "growth_pool";
  }

  /* ------------------------------------------------------------------------
     BENEFITS
  ------------------------------------------------------------------------ */

  if (
    [
      "access_perks_sync",
      "access_perks_open",
      "access_perks_pending",
      "benefit_viewed",
      "benefit_redeemed",
      "access_redemption",
      "offer_redeemed",
    ].includes(normalized)
  ) {
    return "benefits";
  }

  /* ------------------------------------------------------------------------
     SUPPORT
  ------------------------------------------------------------------------ */

  if (
    [
      "support_ticket_created",
      "support_ticket_replied",
      "support_updated",
    ].includes(normalized)
  ) {
    return "support";
  }

  /* ------------------------------------------------------------------------
     REFERRALS
  ------------------------------------------------------------------------ */

  if (
    [
      "referral_invited",
      "referral_opened",
      "referral_registered",
      "referral_activated",
      "referral_rewarded",
      "referral_reward_pending",
    ].includes(normalized)
  ) {
    return "referrals";
  }

  if (
    [
      "system_notice",
      "admin_note",
    ].includes(normalized)
  ) {
    return "system";
  }

  return "account";
}

/* ==========================================================================
   NORMALIZED ACTIVITY ITEM
============================================================================ */

function createActivityItem({
  id,
  source,
  category,
  type,
  title,
  description = null,
  status = null,
  badge = null,
  amount = null,
  amountCents = null,
  currency = "USD",
  occurredAt = null,
  createdAt = null,
  dedupeKey = "",
  metadata = {},
}) {
  const safeOccurredAt =
    safeDate(
      occurredAt ||
      createdAt
    );

  const safeCreatedAt =
    safeDate(
      createdAt ||
      occurredAt
    );

  return {
    id:
      normalizeText(
        id
      ) ||
      `activity:${sha256(
        JSON.stringify({
          source,
          type,
          title,
          occurredAt:
            safeOccurredAt,
        })
      ).slice(
        0,
        24
      )}`,

    source:
      normalizeText(
        source
      ) ||
      "unknown",

    category:
      normalizeCategory(
        category ||
        activityTypeToCategory(
          type
        )
      ),

    type:
      normalizeText(
        type
      ) ||
      "activity",

    title:
      normalizeText(
        title
      ) ||
      titleCase(
        type ||
        "Activity"
      ),

    description:
      normalizeText(
        description
      ) ||
      null,

    status:
      normalizeText(
        status
      ) ||
      null,

    badge:
      normalizeText(
        badge
      ) ||
      null,

    amount:
      amount ===
        null ||
      amount ===
        undefined
        ? null
        : money(
            amount
          ),

    amountCents:
      amountCents ===
        null ||
      amountCents ===
        undefined
        ? null
        : safeInteger(
            amountCents,
            0
          ),

    currency:
      normalizeText(
        currency
      ) ||
      "USD",

    occurredAt:
      safeOccurredAt,

    createdAt:
      safeCreatedAt,

    dedupeKey:
      normalizeText(
        dedupeKey
      ),

    metadata:
      isObject(
        metadata
      )
        ? metadata
        : {},
  };
}

/* ==========================================================================
   EXISTING MEMBER ACTIVITY
============================================================================ */

function mapMemberActivityRow(
  row
) {
  const activityType =
    row.activity_type ||
    row.type ||
    "account_activity";

  const category =
    row.category ||
    activityTypeToCategory(
      activityType
    );

  const providerReference =
    firstText(
      row,
      [
        "provider_event_id",
        "stripe_event_id",
        "reference_id",
        "external_reference",
      ]
    );

  return createActivityItem({
    id:
      `member_activity:${row.id}`,

    source:
      "member_activity",

    category,

    type:
      activityType,

    title:
      row.title ||
      titleCase(
        activityType
      ),

    description:
      row.description ||
      null,

    status:
      row.status ||
      null,

    badge:
      row.badge ||
      titleCase(
        category
      ),

    amount:
      firstNumber(
        row,
        [
          "amount",
        ],
        null
      ),

    amountCents:
      firstNumber(
        row,
        [
          "amount_cents",
        ],
        null
      ),

    occurredAt:
      row.occurred_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      providerReference
        ? `provider:${providerReference}`
        : `member_activity:${row.id}`,

    metadata:
      isObject(
        row.metadata
      )
        ? row.metadata
        : {},
  });
}

/* ==========================================================================
   REWARD TRANSACTIONS
============================================================================ */

function mapRewardTransactionRow(
  row
) {
  let amount =
    firstNumber(
      row,
      [
        "amount",
        "reward_amount",
      ],
      0
    );

  const amountCents =
    firstNumber(
      row,
      [
        "amount_cents",
        "reward_amount_cents",
      ],
      null
    );

  if (
    amountCents !==
      null &&
    !amount
  ) {
    amount =
      centsToDollars(
        amountCents
      );
  }

  const transactionType =
    row.transaction_type ||
    row.type ||
    "reward_activity";

  const reference =
    firstText(
      row,
      [
        "stripe_event_id",
        "reference_id",
        "external_reference",
      ]
    );

  return createActivityItem({
    id:
      `reward_transaction:${row.id}`,

    source:
      "reward_transactions",

    category:
      "rewards",

    type:
      transactionType,

    title:
      row.title ||
      titleCase(
        transactionType
      ),

    description:
      row.description ||
      `${money(
        amount
      ).toFixed(
        2
      )} USD • ${titleCase(
        row.transaction_status ||
        row.status ||
        "posted"
      )}`,

    status:
      row.transaction_status ||
      row.status ||
      null,

    badge:
      amount
        ? `$${money(
            amount
          ).toFixed(2)}`
        : "Reward",

    amount,

    amountCents,

    currency:
      row.currency_code ||
      row.currency ||
      "USD",

    occurredAt:
      row.posted_at ||
      row.occurred_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      reference
        ? `provider:${reference}`
        : `reward:${row.id}`,

    metadata: {
      transactionType,
      transactionStatus:
        row.transaction_status ||
        row.status ||
        null,

      referenceType:
        row.reference_type ||
        null,

      referenceId:
        row.reference_id ||
        null,
    },
  });
}

/* ==========================================================================
   SUPPORT
============================================================================ */

function mapSupportTicketRow(
  row
) {
  return createActivityItem({
    id:
      `support_ticket:${row.id}`,

    source:
      "support_tickets",

    category:
      "support",

    type:
      "support_ticket_created",

    title:
      row.subject ||
      `Support Ticket ${
        row.ticket_number ||
        ""
      }`.trim(),

    description:
      `Status: ${titleCase(
        row.status ||
        "open"
      )} • Priority: ${titleCase(
        row.priority ||
        "normal"
      )}`,

    status:
      row.status ||
      null,

    badge:
      row.ticket_number ||
      "Ticket",

    occurredAt:
      row.last_message_at ||
      row.updated_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      `support:${row.id}`,

    metadata: {
      ticketId:
        row.id,

      ticketNumber:
        row.ticket_number ||
        null,

      category:
        row.category ||
        null,

      priority:
        row.priority ||
        null,

      source:
        row.source ||
        null,
    },
  });
}

/* ==========================================================================
   REFERRALS
============================================================================ */

function mapReferralRow(
  row,
  memberId
) {
  const isReferrer =
    row.referrer_profile_id ===
      memberId ||
    row.referrer_member_id ===
      memberId ||
    row.referrer_signup_id ===
      memberId;

  const status =
    normalizeLower(
      row.status ||
      "updated"
    );

  const stateTitleMap = {
    invited:
      "Referral Invite Sent",

    opened:
      "Referral Invite Opened",

    registered:
      "Referral Registered",

    activated:
      "Referral Activated",

    reward_pending:
      "Referral Reward Pending",

    rewarded:
      "Referral Rewarded",

    expired:
      "Referral Expired",

    cancelled:
      "Referral Cancelled",

    canceled:
      "Referral Cancelled",
  };

  const amount =
    firstNumber(
      row,
      [
        "reward_amount",
        "amount",
        "earned",
      ],
      0
    );

  return createActivityItem({
    id:
      `referral:${row.id}`,

    source:
      "referrals",

    category:
      "referrals",

    type:
      `referral_${status}`,

    title:
      isReferrer
        ? stateTitleMap[
            status
          ] ||
          "Referral Activity"
        : "You Joined Through a Referral",

    description:
      isReferrer
        ? `Referred: ${
            row.referred_email ||
            row.referred_name ||
            "Member"
          }`
        : `Referral code: ${
            row.referral_code ||
            "N/A"
          }`,

    status:
      status ||
      null,

    badge:
      row.invite_code ||
      row.referral_code ||
      "Referral",

    amount:
      amount ||
      null,

    occurredAt:
      row.rewarded_at ||
      row.activated_at ||
      row.registered_at ||
      row.opened_at ||
      row.invited_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      `referral:${row.id}:${status}`,

    metadata: {
      referralId:
        row.id,

      isReferrer,

      referredEmail:
        row.referred_email ||
        null,

      referredName:
        row.referred_name ||
        null,

      inviteCode:
        row.invite_code ||
        null,

      referralCode:
        row.referral_code ||
        null,

      source:
        row.source ||
        null,

      channel:
        row.channel ||
        null,
    },
  });
}

/* ==========================================================================
   ALLOWANCE TRANSACTIONS
============================================================================ */

function mapAllowanceTransactionRow(
  row
) {
  const type =
    normalizeLower(
      row.transaction_type ||
      row.type ||
      "allowance_activity"
    );

  const amountCents =
    firstNumber(
      row,
      [
        "amount_cents",
        "amountCents",
      ],
      0
    );

  const amount =
    amountCents
      ? centsToDollars(
          amountCents
        )
      : firstNumber(
          row,
          [
            "amount",
          ],
          0
        );

  let title =
    "Allowance Activity";

  if (
    [
      "credit",
      "reward_credit",
      "approved",
      "allowance_credit",
    ].includes(type)
  ) {
    title =
      "Allowance Approved";
  }

  if (
    [
      "load",
      "card_load",
      "loaded",
      "allowance_load",
    ].includes(type)
  ) {
    title =
      "Allowance Loaded To Card";
  }

  if (
    [
      "debit",
      "spent",
      "card_spend",
      "allowance_debit",
    ].includes(type)
  ) {
    title =
      "Allowance Used";
  }

  const status =
    normalizeText(
      row.status ||
      "completed"
    );

  const externalReference =
    firstText(
      row,
      [
        "external_reference",
        "provider_reference",
        "stripe_event_id",
      ]
    );

  return createActivityItem({
    id:
      `allowance_transaction:${row.id}`,

    source:
      "allowance_transactions",

    category:
      "allowance",

    type:
      `allowance_${type}`,

    title,

    description:
      row.description ||
      `${money(
        amount
      ).toFixed(
        2
      )} USD • ${titleCase(
        status
      )}`,

    status,

    badge:
      amount
        ? `$${money(
            amount
          ).toFixed(2)}`
        : "Allowance",

    amount,

    amountCents:
      amountCents ||
      Math.round(
        amount *
        100
      ),

    currency:
      row.currency ||
      "USD",

    occurredAt:
      row.processed_at ||
      row.completed_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      externalReference
        ? `provider:${externalReference}`
        : `allowance:${row.id}`,

    metadata: {
      sourceReward:
        row.source_reward ||
        row.source ||
        null,

      externalReference:
        externalReference ||
        null,

      transactionType:
        type,
    },
  });
}

/* ==========================================================================
   MEMBER CARD
============================================================================ */

function mapMemberCardRow(
  row
) {
  const status =
    normalizeLower(
      row.card_status ||
      row.status ||
      "not_created"
    );

  let title =
    "Allowance Card Updated";

  if (
    [
      "created",
      "open",
      "active",
    ].includes(status)
  ) {
    title =
      "Allowance Card Created";
  }

  if (
    status ===
    "paused"
  ) {
    title =
      "Allowance Card Paused";
  }

  if (
    [
      "closed",
      "terminated",
    ].includes(status)
  ) {
    title =
      "Allowance Card Closed";
  }

  const lastFour =
    normalizeText(
      row.last_four
    );

  return createActivityItem({
    id:
      `member_card:${row.id}`,

    source:
      "member_cards",

    category:
      "cards",

    type:
      status ===
        "not_created"
        ? "card_status_changed"
        : "card_created",

    title,

    description:
      lastFour
        ? `Virtual Card Leo allowance card ending in ${lastFour}.`
        : "Card Leo virtual allowance card status updated.",

    status:
      status,

    badge:
      titleCase(
        row.card_type ||
        "virtual"
      ),

    occurredAt:
      row.issued_at ||
      row.updated_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      firstText(
        row,
        [
          "lithic_card_token",
          "provider_card_id",
          "card_token",
        ]
      )
        ? `card:${firstText(
            row,
            [
              "lithic_card_token",
              "provider_card_id",
              "card_token",
            ]
          )}`
        : `member_card:${row.id}`,

    metadata: {
      cardId:
        row.id,

      cardStatus:
        status,

      cardType:
        row.card_type ||
        "virtual",

      lastFour:
        lastFour ||
        null,

      paused:
        Boolean(
          row.card_paused
        ),

      allowanceBalanceCents:
        firstNumber(
          row,
          [
            "allowance_balance_cents",
          ],
          0
        ),

      lifetimeLoadedCents:
        firstNumber(
          row,
          [
            "total_allowance_loaded_cents",
            "lifetime_loaded_cents",
          ],
          0
        ),
    },
  });
}

/* ==========================================================================
   ACCESS REDEMPTIONS
============================================================================ */

function mapAccessRedemptionRow(
  row
) {
  const status =
    normalizeLower(
      row.status ||
      "ready"
    );

  const offerId =
    normalizeText(
      row.access_offer_id
    );

  const redemptionId =
    normalizeText(
      row.access_redemption_id
    ) ||
    normalizeText(
      row.id
    );

  let title =
    "Benefit Ready To Redeem";

  if (
    [
      "redeemed",
      "completed",
      "claimed",
      "used",
    ].includes(status)
  ) {
    title =
      "Benefit Redeemed";
  }

  if (
    [
      "expired",
      "cancelled",
      "canceled",
      "failed",
    ].includes(status)
  ) {
    title =
      `Benefit ${titleCase(
        status
      )}`;
  }

  return createActivityItem({
    id:
      `access_redemption:${row.id}`,

    source:
      "access_redemptions",

    category:
      "benefits",

    type:
      "access_redemption",

    title,

    description:
      row.instructions ||
      (
        offerId
          ? `Access Perks offer ${offerId}.`
          : "Access Perks benefit redemption activity."
      ),

    status,

    badge:
      row.redemption_code
        ? "Code Ready"
        : row.qr_code_data
          ? "QR Ready"
          : row.barcode_value
            ? "Barcode Ready"
            : "Benefit",

    occurredAt:
      row.redeemed_at ||
      row.updated_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      `access_redemption:${redemptionId}`,

    metadata: {
      accessOfferId:
        offerId ||
        null,

      accessRedemptionId:
        redemptionId ||
        null,

      redemptionCode:
        row.redemption_code ||
        null,

      barcodeValue:
        row.barcode_value ||
        null,

      barcodeFormat:
        row.barcode_format ||
        null,

      hasQrCode:
        Boolean(
          row.qr_code_data
        ),

      redemptionUrl:
        row.redemption_url ||
        null,

      expiresAt:
        row.expires_at ||
        null,
    },
  });
}

/* ==========================================================================
   GROWTH POOL
============================================================================ */

function mapGrowthPoolTransactionRow(
  row
) {
  const amountCents =
    firstNumber(
      row,
      [
        "amount_cents",
      ],
      200
    );

  const amount =
    amountCents
      ? centsToDollars(
          amountCents
        )
      : firstNumber(
          row,
          [
            "amount",
          ],
          2
        );

  const status =
    normalizeLower(
      row.status ||
      "completed"
    );

  return createActivityItem({
    id:
      `growth_pool:${row.id}`,

    source:
      "growth_pool_transactions",

    category:
      "growth_pool",

    type:
      "growth_pool_contribution",

    title:
      "Growth Pool Contribution",

    description:
      `Your qualifying paid activation contributed ${money(
        amount
      ).toFixed(
        2
      )} USD to the Card Leo company Growth Pool.`,

    status,

    badge:
      `$${money(
        amount
      ).toFixed(2)} Pool`,

    amount,

    amountCents,

    currency:
      row.currency ||
      "USD",

    occurredAt:
      row.processed_at ||
      row.created_at,

    createdAt:
      row.created_at,

    dedupeKey:
      firstText(
        row,
        [
          "stripe_event_id",
          "idempotency_key",
          "stripe_checkout_session_id",
        ]
      )
        ? `provider:${firstText(
            row,
            [
              "stripe_event_id",
              "idempotency_key",
              "stripe_checkout_session_id",
            ]
          )}`
        : `growth_pool:${row.id}`,

    metadata: {
      growthPoolId:
        row.growth_pool_id ||
        GROWTH_POOL_ID,

      transactionType:
        row.transaction_type ||
        "member_activation",

      provider:
        row.provider ||
        "stripe",

      stripeEventId:
        row.stripe_event_id ||
        null,

      checkoutSessionId:
        row.stripe_checkout_session_id ||
        null,

      invoiceId:
        row.stripe_invoice_id ||
        null,

      subscriptionId:
        row.stripe_subscription_id ||
        null,

      historicalBackfill:
        Boolean(
          row.metadata
            ?.historical_backfill
        ),
    },
  });
}

/* ==========================================================================
   ACCOUNT LIFECYCLE
============================================================================ */

function buildAccountLifecycleItems(
  member
) {
  const items = [];

  if (
    member.created_at
  ) {
    items.push(
      createActivityItem({
        id:
          `account:created:${member.id}`,

        source:
          "signups",

        category:
          "account",

        type:
          "account_created",

        title:
          "Account Created",

        description:
          "Your Card Leo Rewards account was created.",

        status:
          member.status ||
          null,

        badge:
          "Account",

        occurredAt:
          member.created_at,

        createdAt:
          member.created_at,

        dedupeKey:
          `account:created:${member.id}`,

        metadata: {
          memberId:
            member.id,

          email:
            member.email,
        },
      })
    );
  }

  if (
    member.email_verified_at
  ) {
    items.push(
      createActivityItem({
        id:
          `account:email_verified:${member.id}`,

        source:
          "signups",

        category:
          "account",

        type:
          "email_verified",

        title:
          "Email Verified",

        description:
          "Your email address was verified successfully.",

        status:
          "verified",

        badge:
          "Verified",

        occurredAt:
          member
            .email_verified_at,

        createdAt:
          member
            .email_verified_at,

        dedupeKey:
          `account:email_verified:${member.id}`,
      })
    );
  }

  if (
    member.updated_at &&
    member.updated_at !==
      member.created_at
  ) {
    items.push(
      createActivityItem({
        id:
          `account:updated:${member.id}`,

        source:
          "signups",

        category:
          "account",

        type:
          "account_updated",

        title:
          "Account Updated",

        description:
          "Your Card Leo member account was updated.",

        status:
          member.status ||
          null,

        badge:
          titleCase(
            member.status ||
            "Updated"
          ),

        occurredAt:
          member.updated_at,

        createdAt:
          member.updated_at,

        dedupeKey:
          `account:updated:${member.id}:${member.updated_at}`,
      })
    );
  }

  return items;
}

/* ==========================================================================
   ACCESS PERKS MEMBERSHIP ACTIVITY
============================================================================ */

function buildAccessPerksItems(
  member
) {
  const access =
    buildAccessPayload(
      member
    );

  const items = [];

  if (
    access.member_identifier ||
    access.member_status ||
    access.sync_error
  ) {
    items.push(
      createActivityItem({
        id:
          `benefits:access_perks:${member.id}`,

        source:
          "signups",

        category:
          "benefits",

        type:
          access.perks_ready
            ? "access_perks_open"
            : "access_perks_pending",

        title:
          access.perks_ready
            ? "Access Perks Active"
            : access.sync_error
              ? "Access Perks Sync Needs Attention"
              : "Access Perks Sync Pending",

        description:
          access.perks_ready
            ? "Your Access Perks member record is active and your benefits are ready."
            : access.sync_error
              ? "Your Card Leo membership is active, but Access Perks synchronization needs attention."
              : "Your Access Perks member record is being prepared.",

        status:
          access.member_status ||
          "pending",

        badge:
          access.perks_ready
            ? "Active"
            : access.sync_error
              ? "Needs Attention"
              : "Syncing",

        occurredAt:
          access.synced_at ||
          member.updated_at ||
          member.created_at,

        createdAt:
          member.created_at,

        dedupeKey:
          `access_member:${access.member_identifier || member.id}:${access.member_status}`,

        metadata: {
          accessMemberIdentifier:
            access.member_identifier,

          accessMemberStatus:
            access.member_status,

          accessPerksReady:
            access.perks_ready,

          accessSyncError:
            access.sync_error,
        },
      })
    );
  }

  return items;
}

/* ==========================================================================
   OPTIONAL TABLE QUERY
============================================================================ */

async function queryOptionalByColumns({
  table,
  memberId,
  columns,
  limit,
  extraFilters = null,
}) {
  for (
    const column
    of columns
  ) {
    let query =
      supabaseAdmin
        .from(table)
        .select("*")
        .eq(
          column,
          memberId
        )
        .limit(
          limit
        );

    if (
      typeof extraFilters ===
      "function"
    ) {
      query =
        extraFilters(
          query
        );
    }

    const {
      data,
      error,
    } =
      await query;

    if (!error) {
      return (
        data ||
        []
      );
    }

    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      continue;
    }

    throw error;
  }

  return [];
}

/* ==========================================================================
   OPTIONAL REFERRALS
============================================================================ */

async function queryOptionalReferrals({
  memberId,
  limit,
}) {
  const expressions = [
    `referrer_profile_id.eq.${memberId},referred_profile_id.eq.${memberId}`,

    `referrer_member_id.eq.${memberId},referred_member_id.eq.${memberId}`,

    `referrer_signup_id.eq.${memberId},referred_signup_id.eq.${memberId}`,
  ];

  for (
    const expression
    of expressions
  ) {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "referrals"
        )
        .select("*")
        .or(
          expression
        )
        .limit(
          limit
        );

    if (!error) {
      return (
        data ||
        []
      );
    }

    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      continue;
    }

    throw error;
  }

  return [];
}

/* ==========================================================================
   GROWTH POOL QUERY
============================================================================ */

async function queryGrowthPoolTransactions({
  memberId,
  limit,
}) {
  try {
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
          GROWTH_POOL_ID
        )
        .eq(
          "member_id",
          memberId
        )
        .limit(
          limit
        );

    if (!error) {
      return data || [];
    }

    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return [];
    }

    throw error;
  } catch (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return [];
    }

    throw error;
  }
}

/* ==========================================================================
   DEDUPLICATION
============================================================================ */

function getItemFingerprint(
  item
) {
  if (
    item.dedupeKey
  ) {
    return item.dedupeKey;
  }

  const metadata =
    isObject(
      item.metadata
    )
      ? item.metadata
      : {};

  const providerReference =
    normalizeText(
      metadata.stripeEventId ||
      metadata.providerEventId ||
      metadata.externalReference ||
      metadata.checkoutSessionId ||
      metadata.referenceId ||
      metadata.accessRedemptionId
    );

  if (
    providerReference
  ) {
    return (
      "provider:" +
      providerReference
    );
  }

  return (
    "fingerprint:" +
    sha256(
      JSON.stringify({
        category:
          item.category,

        type:
          item.type,

        title:
          item.title,

        amount:
          item.amount,

        occurredAt:
          item.occurredAt,

        memberId:
          metadata.memberId ||
          null,

        referralId:
          metadata.referralId ||
          null,

        cardId:
          metadata.cardId ||
          null,
      })
    )
  );
}

function getActivityScore(
  item
) {
  /*
   * Prefer dedicated source tables over generic member_activity rows
   * when two records represent the same business event.
   */

  const sourcePriority = {
    allowance_transactions:
      100,

    growth_pool_transactions:
      100,

    access_redemptions:
      100,

    member_cards:
      95,

    reward_transactions:
      90,

    referrals:
      85,

    support_tickets:
      80,

    member_activity:
      60,

    signups:
      50,
  };

  return (
    sourcePriority[
      item.source
    ] ||
    10
  );
}

function deduplicateActivity(
  items
) {
  const byFingerprint =
    new Map();

  for (const item of items) {
    if (!item) {
      continue;
    }

    const fingerprint =
      getItemFingerprint(
        item
      );

    const existing =
      byFingerprint.get(
        fingerprint
      );

    if (!existing) {
      byFingerprint.set(
        fingerprint,
        item
      );

      continue;
    }

    const existingScore =
      getActivityScore(
        existing
      );

    const currentScore =
      getActivityScore(
        item
      );

    if (
      currentScore >
      existingScore
    ) {
      byFingerprint.set(
        fingerprint,
        item
      );
    }
  }

  return Array.from(
    byFingerprint.values()
  );
}

/* ==========================================================================
   SORT / FILTER
============================================================================ */

function filterByCategory(
  items,
  category
) {
  if (
    category === "all"
  ) {
    return items;
  }

  return items.filter(
    (item) =>
      item.category ===
      category
  );
}

function sortByOccurredAtDesc(
  items
) {
  return [
    ...items,
  ].sort(
    (
      a,
      b
    ) => {
      const aTime =
        new Date(
          a.occurredAt ||
          a.createdAt ||
          0
        ).getTime();

      const bTime =
        new Date(
          b.occurredAt ||
          b.createdAt ||
          0
        ).getTime();

      return (
        bTime -
        aTime
      );
    }
  );
}

/* ==========================================================================
   SUMMARY
============================================================================ */

function summarizeFeed(
  items
) {
  const summary = {
    total:
      items.length,

    byCategory: {
      account:
        0,

      rewards:
        0,

      allowance:
        0,

      cards:
        0,

      referrals:
        0,

      benefits:
        0,

      growth_pool:
        0,

      support:
        0,

      system:
        0,
    },

    financial: {
      rewardAmount:
        0,

      allowanceAmount:
        0,

      loadedAmount:
        0,

      growthPoolContribution:
        0,
    },

    latestAt:
      null,
  };

  for (const item of items) {
    if (
      summary
        .byCategory[
        item.category
      ] !==
      undefined
    ) {
      summary
        .byCategory[
        item.category
      ] +=
        1;
    }

    if (
      item.category ===
      "rewards"
    ) {
      summary
        .financial
        .rewardAmount +=
        safeNumber(
          item.amount,
          0
        );
    }

    if (
      item.category ===
      "allowance"
    ) {
      summary
        .financial
        .allowanceAmount +=
        safeNumber(
          item.amount,
          0
        );

      if (
        normalizeLower(
          item.type
        ).includes(
          "load"
        )
      ) {
        summary
          .financial
          .loadedAmount +=
          safeNumber(
            item.amount,
            0
          );
      }
    }

    if (
      item.category ===
      "growth_pool"
    ) {
      summary
        .financial
        .growthPoolContribution +=
        safeNumber(
          item.amount,
          0
        );
    }
  }

  summary
    .financial
    .rewardAmount =
    money(
      summary
        .financial
        .rewardAmount
    );

  summary
    .financial
    .allowanceAmount =
    money(
      summary
        .financial
        .allowanceAmount
    );

  summary
    .financial
    .loadedAmount =
    money(
      summary
        .financial
        .loadedAmount
    );

  summary
    .financial
    .growthPoolContribution =
    money(
      summary
        .financial
        .growthPoolContribution
    );

  if (
    items.length >
    0
  ) {
    summary.latestAt =
      items[0]
        .occurredAt ||
      items[0]
        .createdAt ||
      null;
  }

  return summary;
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
        "portal_activity",
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
       AUTH
    ====================================================================== */

    const {
      member,
      response,
    } =
      await getAuthenticatedMember(
        req,
        res
      );

    if (!member) {
      return response;
    }

    const memberId =
      member.id;

    const safeMember =
      sanitizeMember(
        member
      );

    const access =
      buildAccessPayload(
        member
      );

    /* ======================================================================
       REQUEST OPTIONS
    ====================================================================== */

    const limit =
      toPositiveInteger(
        req.query?.limit,
        DEFAULT_LIMIT
      );

    const category =
      normalizeCategory(
        req.query
          ?.category
      );

    /*
     * Query more rows than ultimately returned so we can deduplicate first.
     */
    const queryLimit =
      Math.min(
        Math.max(
          limit *
            3,
          50
        ),
        MAX_LIMIT
      );

    /* ======================================================================
       DATABASE SOURCES
    ====================================================================== */

    const [
      memberActivityRows,
      rewardTransactionRows,
      supportTicketRows,
      referralRows,
      allowanceTransactionRows,
      memberCardRows,
      accessRedemptionRows,
      growthPoolRows,
    ] =
      await Promise.all([
        /* ------------------------------------------------------------------
           GENERIC ACTIVITY
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "member_activity",

          memberId,

          columns: [
            "member_id",
            "signup_id",
            "profile_id",
          ],

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           REWARD LEDGER
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "reward_transactions",

          memberId,

          columns: [
            "member_id",
            "signup_id",
            "profile_id",
          ],

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           SUPPORT
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "support_tickets",

          memberId,

          columns: [
            "member_id",
            "signup_id",
            "profile_id",
          ],

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           REFERRALS
        ------------------------------------------------------------------ */

        queryOptionalReferrals({
          memberId,

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           ALLOWANCE TRANSACTIONS
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "allowance_transactions",

          memberId,

          columns: [
            "member_id",
            "signup_id",
          ],

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           MEMBER CARD
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "member_cards",

          memberId,

          columns: [
            "member_id",
            "signup_id",
          ],

          limit:
            10,
        }),

        /* ------------------------------------------------------------------
           ACCESS REDEMPTIONS
        ------------------------------------------------------------------ */

        queryOptionalByColumns({
          table:
            "access_redemptions",

          memberId,

          columns: [
            "member_id",
            "signup_id",
          ],

          limit:
            queryLimit,
        }),

        /* ------------------------------------------------------------------
           GROWTH POOL
        ------------------------------------------------------------------ */

        queryGrowthPoolTransactions({
          memberId,

          limit:
            10,
        }),
      ]);

    /* ======================================================================
       MAP SOURCES
    ====================================================================== */

    const accountItems =
      buildAccountLifecycleItems(
        member
      );

    const accessPerksItems =
      buildAccessPerksItems(
        member
      );

    const memberActivityItems =
      memberActivityRows.map(
        mapMemberActivityRow
      );

    const rewardItems =
      rewardTransactionRows.map(
        mapRewardTransactionRow
      );

    const supportItems =
      supportTicketRows.map(
        mapSupportTicketRow
      );

    const referralItems =
      referralRows.map(
        (row) =>
          mapReferralRow(
            row,
            memberId
          )
      );

    const allowanceItems =
      allowanceTransactionRows.map(
        mapAllowanceTransactionRow
      );

    const cardItems =
      memberCardRows.map(
        mapMemberCardRow
      );

    const accessRedemptionItems =
      accessRedemptionRows.map(
        mapAccessRedemptionRow
      );

    const growthPoolItems =
      growthPoolRows.map(
        mapGrowthPoolTransactionRow
      );

    /* ======================================================================
       COMBINE
    ====================================================================== */

    const rawFeed = [
      ...accountItems,

      ...accessPerksItems,

      ...memberActivityItems,

      ...rewardItems,

      ...supportItems,

      ...referralItems,

      ...allowanceItems,

      ...cardItems,

      ...accessRedemptionItems,

      ...growthPoolItems,
    ];

    /* ======================================================================
       DEDUPE
    ====================================================================== */

    const deduplicatedFeed =
      deduplicateActivity(
        rawFeed
      );

    /* ======================================================================
       SORT
    ====================================================================== */

    const combinedFeed =
      sortByOccurredAtDesc(
        deduplicatedFeed
      );

    /* ======================================================================
       FILTER
    ====================================================================== */

    const filteredFeed =
      filterByCategory(
        combinedFeed,
        category
      ).slice(
        0,
        limit
      );

    /* ======================================================================
       SUMMARIES
    ====================================================================== */

    const fullSummary =
      summarizeFeed(
        combinedFeed
      );

    const filteredSummary =
      summarizeFeed(
        filteredFeed
      );

    /* ======================================================================
       SOURCE COUNTS
    ====================================================================== */

    const sourceCounts = {
      memberActivity:
        memberActivityRows.length,

      rewardTransactions:
        rewardTransactionRows.length,

      supportTickets:
        supportTicketRows.length,

      referrals:
        referralRows.length,

      allowanceTransactions:
        allowanceTransactionRows.length,

      memberCards:
        memberCardRows.length,

      accessRedemptions:
        accessRedemptionRows.length,

      growthPoolTransactions:
        growthPoolRows.length,

      accountLifecycle:
        accountItems.length,

      accessPerksStatus:
        accessPerksItems.length,

      rawTotal:
        rawFeed.length,

      deduplicatedTotal:
        combinedFeed.length,

      duplicatesRemoved:
        Math.max(
          0,
          rawFeed.length -
            combinedFeed.length
        ),
    };

    /* ======================================================================
       LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "portal_activity",

        memberId,

        email:
          member.email,

        requestedCategory:
          category,

        requestedLimit:
          limit,

        returnedItems:
          filteredFeed.length,

        rawItems:
          rawFeed.length,

        deduplicatedItems:
          combinedFeed.length,

        duplicatesRemoved:
          sourceCounts
            .duplicatesRemoved,

        allowanceEvents:
          allowanceTransactionRows
            .length,

        cardEvents:
          memberCardRows
            .length,

        accessRedemptions:
          accessRedemptionRows
            .length,

        growthPoolEvents:
          growthPoolRows
            .length,

        accessMemberStatus:
          access
            .member_status,

        accessPerksReady:
          access
            .perks_ready,

        ip:
          getClientIp(
            req
          ),
      }
    );

    /* ======================================================================
       RESPONSE
    ====================================================================== */

    return ok(
      res,
      {
        authenticated:
          true,

        /* ------------------------------------------------------------------
           MEMBER SUMMARY
        ------------------------------------------------------------------ */

        summary: {
          memberId:
            safeMember.id,

          signupId:
            safeMember.id,

          profileId:
            safeMember.id,

          memberName:
            safeMember.fullName,

          email:
            safeMember.email,

          memberStatus:
            safeMember
              .memberStatus,

          payment_status:
            safeMember
              .paymentStatus,

          membership_status:
            safeMember
              .membershipStatus,

          approval_status:
            safeMember
              .approvalStatus,

          tier:
            safeMember.tier ||
            "core",

          requestedCategory:
            category,

          requestedLimit:
            limit,

          totals:
            filteredSummary,

          allTotals:
            fullSummary,

          sourceCounts,

          timezone:
            DEFAULT_TIMEZONE,
        },

        /* ------------------------------------------------------------------
           MEMBER
        ------------------------------------------------------------------ */

        member:
          safeMember,

        /* ------------------------------------------------------------------
           ACCESS
        ------------------------------------------------------------------ */

        access,

        accessPerks: {
          ready:
            access
              .perks_ready,

          status:
            access
              .member_status,

          member_identifier:
            access
              .member_identifier,

          synced_at:
            access
              .synced_at,

          suspended_at:
            access
              .suspended_at,

          sync_error:
            access
              .sync_error,

          portal_url:
            "/portal/benefits.html",
        },

        benefits: {
          access_perks_ready:
            access
              .perks_ready,

          benefits_ready:
            access
              .benefits_ready,

          redemptionEvents:
            accessRedemptionRows
              .length,

          href:
            "/portal/benefits.html",
        },

        /* ------------------------------------------------------------------
           ALLOWANCE
        ------------------------------------------------------------------ */

        allowance: {
          activityCount:
            allowanceTransactionRows
              .length,

          href:
            "/portal/rewards.html",
        },

        /* ------------------------------------------------------------------
           CARD
        ------------------------------------------------------------------ */

        card: {
          activityCount:
            memberCardRows
              .length,

          href:
            "/portal/card.html",
        },

        /* ------------------------------------------------------------------
           GROWTH POOL
        ------------------------------------------------------------------ */

        growthPool: {
          activityCount:
            growthPoolRows
              .length,

          memberContributed:
            growthPoolRows.some(
              (row) =>
                [
                  "completed",
                  "paid",
                  "succeeded",
                ].includes(
                  normalizeLower(
                    row.status
                  )
                )
            ),

          contributionAmount:
            growthPoolItems.reduce(
              (
                total,
                item
              ) =>
                total +
                safeNumber(
                  item.amount,
                  0
                ),
              0
            ),

          href:
            "/portal/rewards.html",
        },

        /* ------------------------------------------------------------------
           FILTERS
        ------------------------------------------------------------------ */

        filters: {
          categories:
            VALID_CATEGORIES,

          activeCategory:
            category,

          limit,
        },

        /* ------------------------------------------------------------------
           FEED
        ------------------------------------------------------------------ */

        feed:
          filteredFeed,

        /* ------------------------------------------------------------------
           DEBUG-SAFE SOURCE SUMMARY
        ------------------------------------------------------------------ */

        sources: {
          account:
            accountItems.length,

          memberActivity:
            memberActivityItems
              .length,

          rewards:
            rewardItems.length,

          allowance:
            allowanceItems.length,

          cards:
            cardItems.length,

          referrals:
            referralItems.length,

          benefits:
            accessPerksItems
              .length +
            accessRedemptionItems
              .length,

          growthPool:
            growthPoolItems
              .length,

          support:
            supportItems.length,
        },

        timezone:
          DEFAULT_TIMEZONE,

        fetchedAt:
          new Date()
            .toISOString(),
      },

      "Activity loaded successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "portal_activity_unexpected",
      }
    );

    console.error(
      "Card Leo portal activity error:",
      error
    );

    return serverError(
      res,

      "Failed to load portal activity.",

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