// api/admin/members.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  ok,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";

import { adminRateLimit } from "../../lib/rate-limit.js";

import {
  getAccessTokenFromRequest,
} from "../../lib/cookies.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   ADMIN PORTAL
   STEP #4
   ADMIN MEMBERS API

   ROUTE
   -----
   GET /api/admin/members

   PURPOSE
   -------
   Return a complete operational member directory for the Card Leo
   administration portal.

   PRIMARY MEMBER SOURCE
   ---------------------
   public.signups

   ENRICHMENT SOURCES
   ------------------
   Optional tables are used when available:

   - profiles
   - admin_roles
   - reward_accounts
   - member_onboarding
   - referrals
   - member_cards
   - member_allowances
   - member_allowance
   - allowance_transactions
   - growth_pool_transactions
   - support_tickets
   - admin_notes

   MEMBER OPERATIONS PROVIDED
   --------------------------
   - Membership status
   - Payment status
   - Billing
   - Access Perks
   - Card Leo / Lithic card state
   - Growth Pool participation
   - Referral counts
   - Rewards / allowance amounts
   - Stripe identifiers
   - Support ticket counts
   - Admin/operator status
   - Signup information

   SECURITY
   --------
   This endpoint FAILS CLOSED.

   It supports both:

   1. Existing Supabase auth/access-token admin sessions
   2. Card Leo custom authenticated session cookies

   Admin authorization is then checked using:

   - admin_roles
   - administrator role fields
   - configured admin email environment variables

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

const GROWTH_POOL_ID = 1;

const DEFAULT_MONTHLY_FEE = 20;
const DEFAULT_ACTIVATION_FEE = 25;
const DEFAULT_BILLING_DAY = 10;

const VALID_STATUSES = [
  "all",
  "pending",
  "active",
  "approved",
  "paid",
  "paused",
  "suspended",
  "cancelled",
  "canceled",
  "closed",
];

const VALID_PAYMENT_STATUSES = [
  "all",
  "paid",
  "pending",
  "unpaid",
  "payment_pending",
  "past_due",
  "failed",
];

const VALID_ACCESS_STATUSES = [
  "all",
  "ready",
  "pending",
  "suspended",
  "error",
];

const VALID_TIERS = [
  "all",
  "core",
  "silver",
  "gold",
  "platinum",
  "vip",
];

const VALID_ROLES = [
  "all",
  "member",
  "admin",
  "support",
];

const VALID_SORTS = [
  "newest",
  "oldest",
  "name",
  "status",
  "payment",
  "access",
  "rewards",
  "referrals",
];

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

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

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
]);

const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

const PENDING_PAYMENT_STATUSES = new Set([
  "",
  "pending",
  "unpaid",
  "payment_pending",
  "pending_payment",
  "requires_payment",
  "incomplete",
]);

const SUSPENDED_STATUSES = new Set([
  "suspended",
  "suspend",
  "paused",
  "disabled",
  "denied",
  "cancelled",
  "canceled",
  "closed",
]);

const SUCCESSFUL_GROWTH_POOL_STATUSES = new Set([
  "completed",
  "paid",
  "succeeded",
]);

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

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLower(value);
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
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
      "open",
      "ready",
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

function toPositiveInteger(
  value,
  fallback = DEFAULT_LIMIT,
  max = MAX_LIMIT
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
    max
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

function money(value) {
  return Number(
    normalizeNumber(
      value,
      0
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

function getFullName(row = {}) {
  const fullName =
    normalizeString(
      row.full_name ||
      row.fullName ||
      row.name
    );

  if (fullName) {
    return fullName;
  }

  return (
    [
      row.first_name ||
      row.firstName,

      row.last_name ||
      row.lastName,
    ]
      .map(normalizeString)
      .filter(Boolean)
      .join(" ") ||
    null
  );
}

function buildRange(page, limit) {
  const safePage =
    Math.max(
      1,
      normalizeInteger(
        page,
        1
      )
    );

  const from =
    (safePage - 1) *
    limit;

  const to =
    from +
    limit;

  return {
    page: safePage,
    from,
    to,
  };
}

function getClientIp(req) {
  const forwarded =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"];

  if (
    typeof forwarded === "string" &&
    forwarded.trim()
  ) {
    return forwarded
      .split(",")[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   QUERY NORMALIZATION
============================================================================ */

function normalizeOption(
  value,
  allowed,
  fallback
) {
  const normalized =
    normalizeLower(
      value ||
      fallback
    );

  return allowed.includes(normalized)
    ? normalized
    : fallback;
}

function normalizeStatus(value) {
  return normalizeOption(
    value,
    VALID_STATUSES,
    "all"
  );
}

function normalizePaymentStatus(value) {
  return normalizeOption(
    value,
    VALID_PAYMENT_STATUSES,
    "all"
  );
}

function normalizeAccessStatus(value) {
  return normalizeOption(
    value,
    VALID_ACCESS_STATUSES,
    "all"
  );
}

function normalizeTier(value) {
  return normalizeOption(
    value,
    VALID_TIERS,
    "all"
  );
}

function normalizeRole(value) {
  return normalizeOption(
    value,
    VALID_ROLES,
    "all"
  );
}

function normalizeSort(value) {
  return normalizeOption(
    value,
    VALID_SORTS,
    "newest"
  );
}

function normalizeSearch(value) {
  return normalizeLower(value);
}

/* ==========================================================================
   OPTIONAL SCHEMA ERROR
============================================================================ */

function isMissingOptionalTableOrColumn(error) {
  const code =
    normalizeString(
      error?.code
    );

  const message =
    normalizeLower(
      error?.message
    );

  const details =
    normalizeLower(
      error?.details
    );

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
   COOKIE PARSING
============================================================================ */

function parseCookieHeader(req) {
  if (
    req?.cookies &&
    typeof req.cookies === "object"
  ) {
    return req.cookies;
  }

  const header =
    req?.headers?.cookie ||
    "";

  return String(header)
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

function parseSessionValue(value) {
  const decoded =
    decodeCookieValue(value);

  if (!decoded) {
    return null;
  }

  try {
    const parsed =
      JSON.parse(decoded);

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Continue.
  }

  try {
    const normalized =
      decoded
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    const padded =
      normalized.padEnd(
        Math.ceil(
          normalized.length / 4
        ) * 4,
        "="
      );

    const decodedBase64 =
      Buffer
        .from(
          padded,
          "base64"
        )
        .toString("utf8");

    const parsed =
      JSON.parse(
        decodedBase64
      );

    return isObject(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readCustomSession(req) {
  const cookies =
    parseCookieHeader(req);

  for (
    const name
    of SESSION_COOKIE_NAMES
  ) {
    if (!cookies[name]) {
      continue;
    }

    const value =
      parseSessionValue(
        cookies[name]
      );

    if (isObject(value)) {
      return {
        name,
        value,
      };
    }
  }

  return null;
}

function getSessionMemberId(session) {
  const value =
    session?.value ||
    {};

  return normalizeString(
    value.memberId ||
    value.member_id ||
    value.signupId ||
    value.signup_id ||
    value.member?.id ||
    value.profile?.id ||
    value.user
      ?.user_metadata
      ?.member_id ||
    value.user
      ?.user_metadata
      ?.signup_id ||
    value.id
  );
}

function getSessionEmail(session) {
  const value =
    session?.value ||
    {};

  return normalizeEmail(
    value.email ||
    value.userEmail ||
    value.member?.email ||
    value.profile?.email ||
    value.user?.email ||
    value.user
      ?.user_metadata
      ?.email
  );
}

function getSessionExpiration(session) {
  const value =
    session?.value ||
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

function customSessionIsValid(session) {
  if (
    !session?.value ||
    session.value.authenticated !==
      true
  ) {
    return false;
  }

  const expiration =
    getSessionExpiration(
      session
    );

  if (
    expiration &&
    expiration <=
      Math.floor(
        Date.now() / 1000
      )
  ) {
    return false;
  }

  return true;
}

/* ==========================================================================
   ADMIN CONFIG
============================================================================ */

function parseAdminEmails(value) {
  return normalizeString(value)
    .split(/[,\n;]/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function getConfiguredAdminEmails() {
  return new Set([
    ...parseAdminEmails(
      process.env.ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.SUPER_ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.CARDLEO_ADMIN_EMAILS
    ),

    ...parseAdminEmails(
      process.env.CARD_LEO_ADMIN_EMAILS
    ),
  ]);
}

/* ==========================================================================
   ADMIN AUTH - SUPABASE TOKEN
============================================================================ */

async function getSupabaseAuthUser(req) {
  let accessToken = "";

  try {
    accessToken =
      getAccessTokenFromRequest(req) ||
      "";
  } catch {
    accessToken = "";
  }

  if (!accessToken) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .auth
      .getUser(
        accessToken
      );

  if (
    error ||
    !data?.user
  ) {
    return null;
  }

  return data.user;
}

/* ==========================================================================
   ADMIN PROFILE / ROLE LOOKUP
============================================================================ */

async function getProfileById(profileId) {
  if (!profileId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq(
        "id",
        profileId
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

async function getProfileByEmail(email) {
  const safeEmail =
    normalizeEmail(email);

  if (!safeEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .ilike(
        "email",
        safeEmail
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

async function getSignupById(memberId) {
  if (!memberId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .eq(
        "id",
        memberId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function getSignupByEmail(email) {
  const safeEmail =
    normalizeEmail(email);

  if (!safeEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike(
        "email",
        safeEmail
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function getAdminRole(profileId) {
  if (!profileId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("admin_roles")
      .select("*")
      .eq(
        "profile_id",
        profileId
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

function signupHasAdminRole(signup) {
  if (!signup) {
    return false;
  }

  const roles = [
    signup.role,
    signup.admin_role,
    signup.account_role,
    signup.user_role,
    signup.portal_role,
  ]
    .map(normalizeLower)
    .filter(Boolean);

  if (
    roles.some(
      (role) =>
        [
          "admin",
          "administrator",
          "super_admin",
          "superadmin",
          "owner",
        ].includes(role)
    )
  ) {
    return true;
  }

  return (
    normalizeBoolean(
      signup.is_admin,
      false
    ) ||
    normalizeBoolean(
      signup.admin,
      false
    ) ||
    normalizeBoolean(
      signup.is_super_admin,
      false
    )
  );
}

/* ==========================================================================
   AUTHENTICATE ADMIN
============================================================================ */

async function authenticateAdmin(
  req,
  res
) {
  /* ------------------------------------------------------------------------
     FIRST: EXISTING SUPABASE TOKEN AUTH
  ------------------------------------------------------------------------ */

  const authUser =
    await getSupabaseAuthUser(
      req
    );

  if (authUser?.id) {
    const profile =
      await getProfileById(
        authUser.id
      );

    const role =
      await getAdminRole(
        authUser.id
      );

    if (
      role &&
      (
        normalizeBoolean(
          role.is_super_admin
        ) ||
        normalizeBoolean(
          role.can_manage_members
        )
      )
    ) {
      return {
        admin: {
          id:
            profile?.id ||
            authUser.id,

          email:
            normalizeEmail(
              profile?.email ||
              authUser.email
            ),

          fullName:
            getFullName(
              profile ||
              {}
            ) ||
            authUser.email,

          isSuperAdmin:
            normalizeBoolean(
              role.is_super_admin
            ),

          canManageMembers:
            normalizeBoolean(
              role.can_manage_members
            ),

          source:
            "supabase_auth",
        },

        response:
          null,
      };
    }
  }

  /* ------------------------------------------------------------------------
     SECOND: CARD LEO CUSTOM SESSION
  ------------------------------------------------------------------------ */

  const customSession =
    readCustomSession(req);

  if (
    !customSessionIsValid(
      customSession
    )
  ) {
    return {
      admin: null,

      response:
        unauthorized(
          res,
          "Administrator session required."
        ),
    };
  }

  const memberId =
    getSessionMemberId(
      customSession
    );

  const email =
    getSessionEmail(
      customSession
    );

  let signup = null;

  if (memberId) {
    signup =
      await getSignupById(
        memberId
      );
  }

  if (
    !signup?.id &&
    email
  ) {
    signup =
      await getSignupByEmail(
        email
      );
  }

  if (!signup?.id) {
    return {
      admin: null,

      response:
        unauthorized(
          res,
          "Administrator account not found."
        ),
    };
  }

  const profile =
    (
      await getProfileByEmail(
        signup.email
      )
    ) ||
    null;

  const adminRole =
    profile?.id
      ? await getAdminRole(
          profile.id
        )
      : null;

  const configuredAdmins =
    getConfiguredAdminEmails();

  const emailAllowed =
    configuredAdmins.has(
      normalizeEmail(
        signup.email
      )
    );

  const databaseAllowed =
    Boolean(
      adminRole &&
      (
        normalizeBoolean(
          adminRole.is_super_admin
        ) ||
        normalizeBoolean(
          adminRole.can_manage_members
        )
      )
    );

  const signupRoleAllowed =
    signupHasAdminRole(
      signup
    );

  if (
    !emailAllowed &&
    !databaseAllowed &&
    !signupRoleAllowed
  ) {
    return {
      admin: null,

      response:
        forbidden(
          res,
          "Administrator access required."
        ),
    };
  }

  return {
    admin: {
      id:
        signup.id,

      profileId:
        profile?.id ||
        null,

      email:
        normalizeEmail(
          signup.email
        ),

      fullName:
        getFullName(
          signup
        ) ||
        signup.email,

      isSuperAdmin:
        Boolean(
          normalizeBoolean(
            adminRole
              ?.is_super_admin
          ) ||
          normalizeBoolean(
            signup
              ?.is_super_admin
          )
        ),

      canManageMembers:
        true,

      source:
        "cardleo_session",
    },

    response:
      null,
  };
}

/* ==========================================================================
   OPTIONAL TABLE QUERY
============================================================================ */

async function getOptionalRows(
  table
) {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(table)
      .select("*");

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        available:
          false,

        rows:
          [],
      };
    }

    throw error;
  }

  return {
    available:
      true,

    rows:
      Array.isArray(data)
        ? data
        : [],
  };
}

/* ==========================================================================
   PRIMARY SIGNUPS
============================================================================ */

async function getAllSignups() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .order(
        "created_at",
        {
          ascending: false,
        }
      );

  if (error) {
    throw error;
  }

  return (
    Array.isArray(data)
      ? data
      : []
  );
}

/* ==========================================================================
   MAP BUILDERS
============================================================================ */

function createMap(
  rows,
  getKey
) {
  const map =
    new Map();

  for (const row of rows) {
    const key =
      normalizeString(
        getKey(row)
      );

    if (!key) {
      continue;
    }

    map.set(
      key,
      row
    );
  }

  return map;
}

function createMultiMap(
  rows,
  getKey
) {
  const map =
    new Map();

  for (const row of rows) {
    const key =
      normalizeString(
        getKey(row)
      );

    if (!key) {
      continue;
    }

    if (!map.has(key)) {
      map.set(
        key,
        []
      );
    }

    map
      .get(key)
      .push(row);
  }

  return map;
}

/* ==========================================================================
   MEMBER STATUS HELPERS
============================================================================ */

function getMemberStatus(signup) {
  return normalizeLower(
    signup.membership_status ||
    signup.status ||
    "pending"
  );
}

function getPaymentStatus(signup) {
  return normalizeLower(
    signup.payment_status ||
    "payment_pending"
  );
}

function isPaid(signup) {
  return PAID_PAYMENT_STATUSES.has(
    getPaymentStatus(
      signup
    )
  );
}

function isActive(signup) {
  const account =
    normalizeLower(
      signup.status
    );

  const membership =
    normalizeLower(
      signup.membership_status
    );

  return (
    ACTIVE_ACCOUNT_STATUSES.has(
      account
    ) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membership
    )
  );
}

function isActivePaid(signup) {
  return (
    isActive(signup) &&
    isPaid(signup)
  );
}

function isSuspended(signup) {
  return (
    SUSPENDED_STATUSES.has(
      normalizeLower(
        signup.status
      )
    ) ||
    SUSPENDED_STATUSES.has(
      normalizeLower(
        signup.membership_status
      )
    )
  );
}

function needsPayment(signup) {
  return !isPaid(signup);
}

/* ==========================================================================
   ACCESS PERKS
============================================================================ */

function buildAccessState(signup) {
  const status =
    normalizeLower(
      signup.access_member_status ||
      "pending"
    );

  const error =
    normalizeString(
      signup.access_sync_error
    );

  const ready =
    normalizeBoolean(
      signup.access_perks_ready,
      false
    ) ||
    status ===
      "open";

  return {
    ready,

    status:
      ready
        ? "ready"
        : status ===
            "suspend"
          ? "suspended"
          : error
            ? "error"
            : "pending",

    memberStatus:
      normalizeString(
        signup.access_member_status ||
        "pending"
      ),

    memberIdentifier:
      normalizeString(
        signup
          .access_member_identifier
      ) ||
      null,

    syncedAt:
      safeDate(
        signup
          .access_synced_at
      ),

    suspendedAt:
      safeDate(
        signup
          .access_suspended_at
      ),

    syncError:
      error ||
      null,
  };
}

/* ==========================================================================
   CARD
============================================================================ */

function buildCardState(
  memberCards
) {
  const cards =
    Array.isArray(
      memberCards
    )
      ? memberCards
      : [];

  if (!cards.length) {
    return {
      exists:
        false,

      status:
        "not_configured",

      type:
        "virtual",

      provider:
        "lithic",

      lastFour:
        null,

      paused:
        false,

      availableBalanceCents:
        0,

      availableBalance:
        0,

      lifetimeLoadedCents:
        0,

      lifetimeLoaded:
        0,
    };
  }

  const card =
    cards[0];

  const status =
    normalizeLower(
      card.card_status ||
      card.status ||
      "configured"
    );

  const balanceCents =
    normalizeInteger(
      card
        .allowance_balance_cents ??
      card
        .available_balance_cents,
      0
    );

  const lifetimeLoadedCents =
    normalizeInteger(
      card
        .total_allowance_loaded_cents ??
      card
        .lifetime_loaded_cents,
      0
    );

  return {
    exists:
      true,

    id:
      card.id ||
      null,

    status,

    type:
      normalizeString(
        card.card_type ||
        "virtual"
      ),

    provider:
      normalizeString(
        card.provider ||
        "lithic"
      ),

    lastFour:
      normalizeString(
        card.last_four
      ) ||
      null,

    paused:
      normalizeBoolean(
        card.card_paused,
        false
      ),

    availableBalanceCents:
      balanceCents,

    availableBalance:
      centsToDollars(
        balanceCents
      ),

    lifetimeLoadedCents,

    lifetimeLoaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    createdAt:
      safeDate(
        card.created_at
      ),

    updatedAt:
      safeDate(
        card.updated_at
      ),
  };
}

/* ==========================================================================
   ALLOWANCE
============================================================================ */

function buildAllowanceState(
  allowanceRows,
  transactionRows
) {
  const allowance =
    Array.isArray(
      allowanceRows
    ) &&
    allowanceRows.length
      ? allowanceRows[0]
      : null;

  let pendingCents =
    normalizeInteger(
      allowance
        ?.pending_earnings_cents ??
      allowance
        ?.pending_cents,
      0
    );

  let approvedCents =
    normalizeInteger(
      allowance
        ?.approved_waiting_cents ??
      allowance
        ?.approved_allowance_cents,
      0
    );

  let availableCents =
    normalizeInteger(
      allowance
        ?.available_balance_cents ??
      allowance
        ?.allowance_balance_cents,
      0
    );

  let processingCents =
    normalizeInteger(
      allowance
        ?.processing_cents,
      0
    );

  let lifetimeLoadedCents =
    normalizeInteger(
      allowance
        ?.lifetime_loaded_cents,
      0
    );

  let lifetimeSpentCents =
    normalizeInteger(
      allowance
        ?.lifetime_spent_cents,
      0
    );

  /*
   * If the aggregate allowance table does not yet exist,
   * transaction history still gives us useful lifetime information.
   */

  if (
    !allowance &&
    Array.isArray(
      transactionRows
    )
  ) {
    for (
      const transaction
      of transactionRows
    ) {
      const type =
        normalizeLower(
          transaction
            .transaction_type ||
          transaction.type
        );

      const status =
        normalizeLower(
          transaction.status ||
          "completed"
        );

      if (
        ![
          "completed",
          "paid",
          "succeeded",
          "approved",
        ].includes(status)
      ) {
        continue;
      }

      const amountCents =
        normalizeInteger(
          transaction.amount_cents,
          Math.round(
            normalizeNumber(
              transaction.amount,
              0
            ) *
            100
          )
        );

      if (
        type.includes(
          "load"
        )
      ) {
        lifetimeLoadedCents +=
          amountCents;
      }

      if (
        type.includes(
          "debit"
        ) ||
        type.includes(
          "spent"
        )
      ) {
        lifetimeSpentCents +=
          amountCents;
      }
    }
  }

  return {
    exists:
      Boolean(
        allowance
      ),

    pendingCents,

    pending:
      centsToDollars(
        pendingCents
      ),

    approvedCents,

    approved:
      centsToDollars(
        approvedCents
      ),

    availableCents,

    available:
      centsToDollars(
        availableCents
      ),

    processingCents,

    processing:
      centsToDollars(
        processingCents
      ),

    lifetimeLoadedCents,

    lifetimeLoaded:
      centsToDollars(
        lifetimeLoadedCents
      ),

    lifetimeSpentCents,

    lifetimeSpent:
      centsToDollars(
        lifetimeSpentCents
      ),
  };
}

/* ==========================================================================
   GROWTH POOL
============================================================================ */

function buildGrowthPoolState(
  transactions
) {
  const rows =
    Array.isArray(
      transactions
    )
      ? transactions
      : [];

  const successful =
    rows.filter(
      (row) =>
        (
          normalizeInteger(
            row.growth_pool_id,
            GROWTH_POOL_ID
          ) ===
          GROWTH_POOL_ID
        ) &&
        SUCCESSFUL_GROWTH_POOL_STATUSES.has(
          normalizeLower(
            row.status
          )
        )
    );

  if (!successful.length) {
    return {
      contributed:
        false,

      contributionAmount:
        0,

      contributionAmountCents:
        0,

      transactionId:
        null,

      contributedAt:
        null,
    };
  }

  const transaction =
    successful[0];

  const amountCents =
    normalizeInteger(
      transaction.amount_cents,
      Math.round(
        normalizeNumber(
          transaction.amount,
          2
        ) *
        100
      )
    );

  return {
    contributed:
      true,

    contributionAmountCents:
      amountCents,

    contributionAmount:
      centsToDollars(
        amountCents
      ),

    transactionId:
      transaction.id ||
      null,

    contributedAt:
      safeDate(
        transaction
          .processed_at ||
        transaction
          .created_at
      ),
  };
}

/* ==========================================================================
   REFERRALS
============================================================================ */

function buildReferralState(
  referrals,
  memberId,
  email
) {
  const safeMemberId =
    normalizeString(
      memberId
    );

  const safeEmail =
    normalizeEmail(
      email
    );

  const rows =
    Array.isArray(
      referrals
    )
      ? referrals
      : [];

  let direct = 0;
  let team = 0;
  let pending = 0;
  let rewarded = 0;
  let earned = 0;

  for (const row of rows) {
    const referrerId =
      normalizeString(
        row.referrer_member_id ||
        row.referrer_signup_id ||
        row.referrer_profile_id ||
        row.member_id ||
        row.signup_id
      );

    const referrerEmail =
      normalizeEmail(
        row.referrer_email ||
        row.member_email
      );

    const belongsToMember =
      (
        safeMemberId &&
        referrerId ===
          safeMemberId
      ) ||
      (
        safeEmail &&
        referrerEmail ===
          safeEmail
      );

    if (!belongsToMember) {
      continue;
    }

    const type =
      normalizeLower(
        row.referral_type ||
        row.type ||
        row.level ||
        "direct"
      );

    const status =
      normalizeLower(
        row.status
      );

    if (
      type.includes(
        "team"
      ) ||
      type.includes(
        "indirect"
      ) ||
      type.includes(
        "level_2"
      )
    ) {
      team += 1;
    } else {
      direct += 1;
    }

    if (
      [
        "pending",
        "invited",
        "opened",
        "registered",
        "reward_pending",
      ].includes(status)
    ) {
      pending += 1;
    }

    if (
      [
        "approved",
        "paid",
        "active",
        "completed",
        "rewarded",
      ].includes(status)
    ) {
      rewarded += 1;

      earned +=
        normalizeNumber(
          row.reward_amount ??
          row.amount ??
          row.earned,
          type.includes("team")
            ? 1
            : 7
        );
    }
  }

  return {
    direct,

    team,

    total:
      direct +
      team,

    pending,

    rewarded,

    earned:
      money(earned),
  };
}

/* ==========================================================================
   SUPPORT / NOTES
============================================================================ */

function countOpenSupport(
  tickets
) {
  const openStatuses =
    new Set([
      "open",
      "new",
      "pending",
      "in_progress",
      "waiting",
      "waiting_on_member",
    ]);

  return (
    Array.isArray(
      tickets
    )
      ? tickets
      : []
  ).filter(
    (ticket) =>
      openStatuses.has(
        normalizeLower(
          ticket.status
        )
      )
  ).length;
}

/* ==========================================================================
   PROFILE / ADMIN ROLE
============================================================================ */

function buildProfileState(
  profile,
  adminRole
) {
  return {
    exists:
      Boolean(profile),

    id:
      profile?.id ||
      null,

    role:
      normalizeString(
        profile?.role ||
        "member"
      ),

    tier:
      normalizeString(
        profile?.tier ||
        "core"
      ),

    memberStatus:
      normalizeString(
        profile
          ?.member_status ||
        ""
      ),

    referralCode:
      normalizeString(
        profile
          ?.referral_code
      ) ||
      null,

    avatarUrl:
      normalizeString(
        profile
          ?.avatar_url
      ) ||
      null,

    lastLoginAt:
      safeDate(
        profile
          ?.last_login_at
      ),

    isAdminOperator:
      Boolean(
        adminRole
      ),

    isSuperAdmin:
      normalizeBoolean(
        adminRole
          ?.is_super_admin,
        false
      ),
  };
}

/* ==========================================================================
   ONBOARDING / REWARD ACCOUNT
============================================================================ */

function buildOnboardingState(row) {
  if (!row) {
    return null;
  }

  return {
    onboardingPercent:
      normalizeNumber(
        row.onboarding_percent,
        0
      ),

    onboardingStatus:
      normalizeString(
        row.onboarding_status ||
        "not_started"
      ),

    profileCompleted:
      normalizeBoolean(
        row.profile_completed
      ),

    emailVerified:
      normalizeBoolean(
        row.email_verified
      ),

    firstLoginCompleted:
      normalizeBoolean(
        row.first_login_completed
      ),

    rewardsActivated:
      normalizeBoolean(
        row.rewards_activated
      ),

    updatedAt:
      safeDate(
        row.updated_at
      ),
  };
}

function buildRewardAccountState(row) {
  if (!row) {
    return null;
  }

  return {
    accountStatus:
      normalizeString(
        row.account_status ||
        "active"
      ),

    pointsAvailable:
      normalizeNumber(
        row.points_available,
        0
      ),

    pointsPending:
      normalizeNumber(
        row.points_pending,
        0
      ),

    pointsLifetimeEarned:
      normalizeNumber(
        row
          .points_lifetime_earned,
        0
      ),

    pointsLifetimeRedeemed:
      normalizeNumber(
        row
          .points_lifetime_redeemed,
        0
      ),
  };
}

/* ==========================================================================
   BUILD MEMBER
============================================================================ */

function buildMember({
  signup,
  profile,
  adminRole,
  rewardAccount,
  onboarding,
  memberCards,
  allowanceRows,
  allowanceTransactions,
  growthPoolTransactions,
  referrals,
  supportTickets,
  adminNotes,
}) {
  const access =
    buildAccessState(
      signup
    );

  const card =
    buildCardState(
      memberCards
    );

  const allowance =
    buildAllowanceState(
      allowanceRows,
      allowanceTransactions
    );

  const growthPool =
    buildGrowthPoolState(
      growthPoolTransactions
    );

  const referral =
    buildReferralState(
      referrals,
      signup.id,
      signup.email
    );

  const profileState =
    buildProfileState(
      profile,
      adminRole
    );

  const fullName =
    getFullName(
      signup
    ) ||
    getFullName(
      profile ||
      {}
    );

  const status =
    getMemberStatus(
      signup
    );

  const paymentStatus =
    getPaymentStatus(
      signup
    );

  const approvalStatus =
    normalizeLower(
      signup.approval_status ||
      ""
    );

  const totalEarned =
    Math.max(
      referral.earned,
      allowance.approved +
        allowance.available +
        allowance.lifetimeLoaded
    );

  return {
    /* ----------------------------------------------------------------------
       IDENTITY
    ---------------------------------------------------------------------- */

    id:
      signup.id,

    signupId:
      signup.id,

    signup_id:
      signup.id,

    profileId:
      profile?.id ||
      null,

    profile_id:
      profile?.id ||
      null,

    email:
      normalizeEmail(
        signup.email
      ) ||
      null,

    firstName:
      normalizeString(
        signup.first_name
      ) ||
      null,

    first_name:
      normalizeString(
        signup.first_name
      ) ||
      null,

    lastName:
      normalizeString(
        signup.last_name
      ) ||
      null,

    last_name:
      normalizeString(
        signup.last_name
      ) ||
      null,

    fullName,

    full_name:
      fullName,

    phone:
      normalizeString(
        signup.phone
      ) ||
      null,

    city:
      normalizeString(
        signup.city
      ) ||
      null,

    state:
      normalizeString(
        signup.state
      ) ||
      null,

    avatarUrl:
      profileState
        .avatarUrl,

    avatar_url:
      profileState
        .avatarUrl,

    /* ----------------------------------------------------------------------
       MEMBERSHIP
    ---------------------------------------------------------------------- */

    status,

    statusLabel:
      titleCase(status),

    membershipStatus:
      status,

    membership_status:
      status,

    paymentStatus,

    payment_status:
      paymentStatus,

    approvalStatus,

    approval_status:
      approvalStatus,

    active:
      isActive(signup),

    paid:
      isPaid(signup),

    activePaid:
      isActivePaid(
        signup
      ),

    paymentRequired:
      needsPayment(
        signup
      ),

    payment_required:
      needsPayment(
        signup
      ),

    suspended:
      isSuspended(
        signup
      ),

    /* ----------------------------------------------------------------------
       ROLE / TIER
    ---------------------------------------------------------------------- */

    role:
      normalizeString(
        signup.role ||
        profileState.role ||
        "member"
      ),

    roleLabel:
      titleCase(
        signup.role ||
        profileState.role ||
        "member"
      ),

    tier:
      normalizeString(
        signup.tier ||
        profileState.tier ||
        "core"
      ),

    tierLabel:
      titleCase(
        signup.tier ||
        profileState.tier ||
        "core"
      ),

    /* ----------------------------------------------------------------------
       BILLING
    ---------------------------------------------------------------------- */

    activationFeeAmount:
      normalizeNumber(
        signup
          .activation_fee_amount,
        DEFAULT_ACTIVATION_FEE
      ),

    activation_fee_amount:
      normalizeNumber(
        signup
          .activation_fee_amount,
        DEFAULT_ACTIVATION_FEE
      ),

    monthlyFeeAmount:
      normalizeNumber(
        signup
          .monthly_fee_amount,
        DEFAULT_MONTHLY_FEE
      ),

    monthly_fee_amount:
      normalizeNumber(
        signup
          .monthly_fee_amount,
        DEFAULT_MONTHLY_FEE
      ),

    billingDay:
      normalizeInteger(
        signup.billing_day,
        DEFAULT_BILLING_DAY
      ),

    billing_day:
      normalizeInteger(
        signup.billing_day,
        DEFAULT_BILLING_DAY
      ),

    stripeCustomerId:
      normalizeString(
        signup
          .stripe_customer_id
      ) ||
      null,

    stripe_customer_id:
      normalizeString(
        signup
          .stripe_customer_id
      ) ||
      null,

    stripeSubscriptionId:
      normalizeString(
        signup
          .stripe_subscription_id
      ) ||
      null,

    stripe_subscription_id:
      normalizeString(
        signup
          .stripe_subscription_id
      ) ||
      null,

    stripeCheckoutSessionId:
      normalizeString(
        signup
          .stripe_checkout_session_id
      ) ||
      null,

    stripe_checkout_session_id:
      normalizeString(
        signup
          .stripe_checkout_session_id
      ) ||
      null,

    /* ----------------------------------------------------------------------
       ACCESS
    ---------------------------------------------------------------------- */

    access,

    accessPerksReady:
      access.ready,

    access_perks_ready:
      access.ready,

    accessMemberStatus:
      access.memberStatus,

    access_member_status:
      access.memberStatus,

    accessMemberIdentifier:
      access.memberIdentifier,

    access_member_identifier:
      access.memberIdentifier,

    accessSyncError:
      access.syncError,

    access_sync_error:
      access.syncError,

    accessSyncedAt:
      access.syncedAt,

    access_synced_at:
      access.syncedAt,

    /* ----------------------------------------------------------------------
       CARD
    ---------------------------------------------------------------------- */

    card,

    hasCard:
      card.exists,

    cardStatus:
      card.status,

    card_status:
      card.status,

    cardId:
      card.id ||
      null,

    card_id:
      card.id ||
      null,

    cardLastFour:
      card.lastFour,

    card_last_four:
      card.lastFour,

    /* ----------------------------------------------------------------------
       GROWTH POOL
    ---------------------------------------------------------------------- */

    growthPool,

    growthPoolContributed:
      growthPool
        .contributed,

    growth_pool_contributed:
      growthPool
        .contributed,

    growthPoolContribution:
      growthPool
        .contributionAmount,

    /* ----------------------------------------------------------------------
       REFERRALS
    ---------------------------------------------------------------------- */

    referrals:
      referral,

    approvedReferrals:
      referral.rewarded,

    approved_referrals:
      referral.rewarded,

    totalReferrals:
      referral.total,

    total_referrals:
      referral.total,

    pendingReferrals:
      referral.pending,

    pending_referrals:
      referral.pending,

    directReferrals:
      referral.direct,

    direct_referrals:
      referral.direct,

    teamReferrals:
      referral.team,

    team_referrals:
      referral.team,

    /* ----------------------------------------------------------------------
       REWARDS / ALLOWANCE
    ---------------------------------------------------------------------- */

    allowance,

    rewards: {
      totalEarned:
        money(
          totalEarned
        ),

      pending:
        allowance.pending,

      approved:
        allowance.approved,

      available:
        allowance.available,

      processing:
        allowance.processing,

      lifetimeLoaded:
        allowance
          .lifetimeLoaded,

      lifetimeSpent:
        allowance
          .lifetimeSpent,
    },

    totalEarned:
      money(
        totalEarned
      ),

    total_earned:
      money(
        totalEarned
      ),

    /* ----------------------------------------------------------------------
       PROFILE / LEGACY
    ---------------------------------------------------------------------- */

    profile:
      profileState,

    onboarding:
      buildOnboardingState(
        onboarding
      ),

    rewardAccount:
      buildRewardAccountState(
        rewardAccount
      ),

    /* ----------------------------------------------------------------------
       SUPPORT / NOTES
    ---------------------------------------------------------------------- */

    openSupportTickets:
      countOpenSupport(
        supportTickets
      ),

    open_support_tickets:
      countOpenSupport(
        supportTickets
      ),

    noteCount:
      Array.isArray(
        adminNotes
      )
        ? adminNotes.length
        : 0,

    note_count:
      Array.isArray(
        adminNotes
      )
        ? adminNotes.length
        : 0,

    /* ----------------------------------------------------------------------
       PORTAL / SIGNUP
    ---------------------------------------------------------------------- */

    source:
      normalizeString(
        signup.source ||
        "website"
      ),

    signupPage:
      normalizeString(
        signup.signup_page
      ) ||
      null,

    signup_page:
      normalizeString(
        signup.signup_page
      ) ||
      null,

    portalLoginUrl:
      normalizeString(
        signup.portal_login_url
      ) ||
      "/portal/index.html",

    portal_login_url:
      normalizeString(
        signup.portal_login_url
      ) ||
      "/portal/index.html",

    referralCode:
      normalizeString(
        signup.referral_code ||
        profileState
          .referralCode
      ) ||
      null,

    referral_code:
      normalizeString(
        signup.referral_code ||
        profileState
          .referralCode
      ) ||
      null,

    /* ----------------------------------------------------------------------
       ADMIN
    ---------------------------------------------------------------------- */

    isAdminOperator:
      profileState
        .isAdminOperator,

    isSuperAdmin:
      profileState
        .isSuperAdmin,

    /* ----------------------------------------------------------------------
       DATES
    ---------------------------------------------------------------------- */

    joinedAt:
      safeDate(
        signup.created_at
      ),

    createdAt:
      safeDate(
        signup.created_at
      ),

    created_at:
      safeDate(
        signup.created_at
      ),

    updatedAt:
      safeDate(
        signup.updated_at
      ),

    updated_at:
      safeDate(
        signup.updated_at
      ),

    lastLoginAt:
      profileState
        .lastLoginAt,
  };
}

/* ==========================================================================
   SEARCH
============================================================================ */

function memberMatchesSearch(
  member,
  search
) {
  if (!search) {
    return true;
  }

  const haystack =
    [
      member.id,
      member.profileId,
      member.fullName,
      member.firstName,
      member.lastName,
      member.email,
      member.phone,
      member.city,
      member.state,
      member.status,
      member.paymentStatus,
      member.accessMemberStatus,
      member.accessMemberIdentifier,
      member.referralCode,
      member.stripeCustomerId,
      member.stripeSubscriptionId,
      member.cardLastFour,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  return haystack.includes(
    search
  );
}

/* ==========================================================================
   FILTERS
============================================================================ */

function memberMatchesStatus(
  member,
  status
) {
  if (
    !status ||
    status ===
      "all"
  ) {
    return true;
  }

  if (
    status ===
    "active"
  ) {
    return member.active;
  }

  if (
    status ===
    "pending"
  ) {
    return (
      PENDING_PAYMENT_STATUSES.has(
        member.paymentStatus
      ) ||
      normalizeLower(
        member.status
      ) ===
        "pending"
    );
  }

  if (
    status ===
    "suspended"
  ) {
    return member.suspended;
  }

  return (
    member.status ===
    status
  );
}

function memberMatchesPayment(
  member,
  payment
) {
  if (
    !payment ||
    payment ===
      "all"
  ) {
    return true;
  }

  if (
    payment ===
    "paid"
  ) {
    return member.paid;
  }

  if (
    payment ===
    "pending"
  ) {
    return PENDING_PAYMENT_STATUSES.has(
      member.paymentStatus
    );
  }

  return (
    member.paymentStatus ===
    payment
  );
}

function memberMatchesAccess(
  member,
  access
) {
  if (
    !access ||
    access ===
      "all"
  ) {
    return true;
  }

  if (
    access ===
    "ready"
  ) {
    return member
      .access
      .ready;
  }

  if (
    access ===
    "error"
  ) {
    return Boolean(
      member
        .access
        .syncError
    );
  }

  if (
    access ===
    "suspended"
  ) {
    return (
      member
        .access
        .status ===
      "suspended"
    );
  }

  if (
    access ===
    "pending"
  ) {
    return (
      !member
        .access
        .ready &&
      !member
        .access
        .syncError &&
      member
        .access
        .status !==
        "suspended"
    );
  }

  return true;
}

function memberMatchesTier(
  member,
  tier
) {
  return (
    !tier ||
    tier ===
      "all" ||
    normalizeLower(
      member.tier
    ) ===
      tier
  );
}

function memberMatchesRole(
  member,
  role
) {
  return (
    !role ||
    role ===
      "all" ||
    normalizeLower(
      member.role
    ) ===
      role
  );
}

function applyFilters(
  members,
  {
    search,
    status,
    payment,
    access,
    tier,
    role,
  }
) {
  return members.filter(
    (member) =>
      memberMatchesSearch(
        member,
        search
      ) &&
      memberMatchesStatus(
        member,
        status
      ) &&
      memberMatchesPayment(
        member,
        payment
      ) &&
      memberMatchesAccess(
        member,
        access
      ) &&
      memberMatchesTier(
        member,
        tier
      ) &&
      memberMatchesRole(
        member,
        role
      )
  );
}

/* ==========================================================================
   SORT
============================================================================ */

function sortMembers(
  members,
  sort
) {
  const copy =
    [...members];

  switch (sort) {
    case "oldest":
      return copy.sort(
        (a, b) =>
          new Date(
            a.createdAt ||
            0
          ).getTime() -
          new Date(
            b.createdAt ||
            0
          ).getTime()
      );

    case "name":
      return copy.sort(
        (a, b) =>
          normalizeLower(
            a.fullName
          ).localeCompare(
            normalizeLower(
              b.fullName
            )
          )
      );

    case "status":
      return copy.sort(
        (a, b) =>
          a.status.localeCompare(
            b.status
          )
      );

    case "payment":
      return copy.sort(
        (a, b) =>
          a.paymentStatus.localeCompare(
            b.paymentStatus
          )
      );

    case "access":
      return copy.sort(
        (a, b) =>
          a
            .access
            .status
            .localeCompare(
              b.access.status
            )
      );

    case "rewards":
      return copy.sort(
        (a, b) =>
          normalizeNumber(
            b.totalEarned
          ) -
          normalizeNumber(
            a.totalEarned
          )
      );

    case "referrals":
      return copy.sort(
        (a, b) =>
          b.totalReferrals -
          a.totalReferrals
      );

    case "newest":
    default:
      return copy.sort(
        (a, b) =>
          new Date(
            b.createdAt ||
            0
          ).getTime() -
          new Date(
            a.createdAt ||
            0
          ).getTime()
      );
  }
}

/* ==========================================================================
   SUMMARY
============================================================================ */

function buildSummary(
  members
) {
  const summary = {
    total:
      members.length,

    activeMembers:
      0,

    activePaid:
      0,

    pendingPayment:
      0,

    suspended:
      0,

    accessReady:
      0,

    accessPending:
      0,

    accessErrors:
      0,

    cardsConfigured:
      0,

    growthPoolContributed:
      0,

    directReferrals:
      0,

    teamReferrals:
      0,

    pendingReferrals:
      0,

    estimatedReferralRewards:
      0,

    allowanceAvailable:
      0,

    allowanceApproved:
      0,

    lifetimeAllowanceLoaded:
      0,

    openSupportTickets:
      0,

    monthlyMembershipRevenue:
      0,
  };

  for (
    const member
    of members
  ) {
    if (member.active) {
      summary.activeMembers +=
        1;
    }

    if (
      member.activePaid
    ) {
      summary.activePaid +=
        1;

      summary.monthlyMembershipRevenue +=
        normalizeNumber(
          member.monthlyFeeAmount,
          DEFAULT_MONTHLY_FEE
        );
    }

    if (
      member.paymentRequired
    ) {
      summary.pendingPayment +=
        1;
    }

    if (
      member.suspended
    ) {
      summary.suspended +=
        1;
    }

    if (
      member.access.ready
    ) {
      summary.accessReady +=
        1;
    } else {
      summary.accessPending +=
        1;
    }

    if (
      member
        .access
        .syncError
    ) {
      summary.accessErrors +=
        1;
    }

    if (
      member.card.exists
    ) {
      summary.cardsConfigured +=
        1;
    }

    if (
      member
        .growthPool
        .contributed
    ) {
      summary.growthPoolContributed +=
        1;
    }

    summary.directReferrals +=
      member
        .referrals
        .direct;

    summary.teamReferrals +=
      member
        .referrals
        .team;

    summary.pendingReferrals +=
      member
        .referrals
        .pending;

    summary.estimatedReferralRewards +=
      normalizeNumber(
        member
          .referrals
          .earned,
        0
      );

    summary.allowanceAvailable +=
      normalizeNumber(
        member
          .allowance
          .available,
        0
      );

    summary.allowanceApproved +=
      normalizeNumber(
        member
          .allowance
          .approved,
        0
      );

    summary.lifetimeAllowanceLoaded +=
      normalizeNumber(
        member
          .allowance
          .lifetimeLoaded,
        0
      );

    summary.openSupportTickets +=
      member
        .openSupportTickets;
  }

  summary.monthlyMembershipRevenue =
    money(
      summary
        .monthlyMembershipRevenue
    );

  summary.estimatedReferralRewards =
    money(
      summary
        .estimatedReferralRewards
    );

  summary.allowanceAvailable =
    money(
      summary
        .allowanceAvailable
    );

  summary.allowanceApproved =
    money(
      summary
        .allowanceApproved
    );

  summary.lifetimeAllowanceLoaded =
    money(
      summary
        .lifetimeAllowanceLoaded
    );

  return summary;
}

/* ==========================================================================
   STATUS COUNTS
============================================================================ */

function buildStatusCounts(
  members
) {
  return {
    pending:
      members.filter(
        (member) =>
          memberMatchesStatus(
            member,
            "pending"
          )
      ).length,

    active:
      members.filter(
        (member) =>
          member.active
      ).length,

    paid:
      members.filter(
        (member) =>
          member.paid
      ).length,

    suspended:
      members.filter(
        (member) =>
          member.suspended
      ).length,

    closed:
      members.filter(
        (member) =>
          member.status ===
          "closed"
      ).length,
  };
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore(res);

  logRequestStart(
    req,
    {
      scope:
        "admin_members",
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
       RATE LIMIT
    ====================================================================== */

    const rate =
      adminRateLimit(
        req,
        res
      );

    if (
      rate &&
      rate.allowed ===
        false
    ) {
      return forbidden(
        res,
        "Too many admin requests. Please try again later.",
        {
          retryAfter:
            rate.retryAfter ??
            null,

          error:
            "rate_limited",
        }
      );
    }

    /* ======================================================================
       ADMIN AUTH
    ====================================================================== */

    const {
      admin,
      response,
    } =
      await authenticateAdmin(
        req,
        res
      );

    if (!admin) {
      return response;
    }

    /* ======================================================================
       FILTERS
    ====================================================================== */

    const status =
      normalizeStatus(
        req.query?.status
      );

    const payment =
      normalizePaymentStatus(
        req.query?.payment
      );

    const access =
      normalizeAccessStatus(
        req.query?.access
      );

    const tier =
      normalizeTier(
        req.query?.tier
      );

    const role =
      normalizeRole(
        req.query?.role
      );

    const sort =
      normalizeSort(
        req.query?.sort
      );

    const search =
      normalizeSearch(
        req.query?.search
      );

    const limit =
      toPositiveInteger(
        req.query?.limit,
        DEFAULT_LIMIT,
        MAX_LIMIT
      );

    const {
      page,
      from,
      to,
    } =
      buildRange(
        req.query?.page,
        limit
      );

    /* ======================================================================
       PRIMARY DATA
    ====================================================================== */

    const signups =
      await getAllSignups();

    /* ======================================================================
       OPTIONAL DATA

       Each missing optional table is ignored instead of breaking member
       administration.
    ====================================================================== */

    const [
      profilesResult,
      adminRolesResult,
      rewardsResult,
      onboardingResult,
      cardsResult,
      memberAllowancesResult,
      memberAllowanceResult,
      allowanceTransactionsResult,
      growthPoolResult,
      referralsResult,
      supportResult,
      notesResult,
    ] =
      await Promise.all([
        getOptionalRows(
          "profiles"
        ),

        getOptionalRows(
          "admin_roles"
        ),

        getOptionalRows(
          "reward_accounts"
        ),

        getOptionalRows(
          "member_onboarding"
        ),

        getOptionalRows(
          "member_cards"
        ),

        getOptionalRows(
          "member_allowances"
        ),

        getOptionalRows(
          "member_allowance"
        ),

        getOptionalRows(
          "allowance_transactions"
        ),

        getOptionalRows(
          "growth_pool_transactions"
        ),

        getOptionalRows(
          "referrals"
        ),

        getOptionalRows(
          "support_tickets"
        ),

        getOptionalRows(
          "admin_notes"
        ),
      ]);

    /* ======================================================================
       MAPS
    ====================================================================== */

    const profileBySignupId =
      createMap(
        profilesResult.rows,
        (row) =>
          row.signup_id
      );

    const profileByEmail =
      createMap(
        profilesResult.rows,
        (row) =>
          normalizeEmail(
            row.email
          )
      );

    const adminRoleByProfileId =
      createMap(
        adminRolesResult.rows,
        (row) =>
          row.profile_id
      );

    const rewardByProfileId =
      createMap(
        rewardsResult.rows,
        (row) =>
          row.profile_id
      );

    const onboardingByProfileId =
      createMap(
        onboardingResult.rows,
        (row) =>
          row.profile_id
      );

    const cardsByMemberId =
      createMultiMap(
        cardsResult.rows,
        (row) =>
          row.member_id ||
          row.signup_id
      );

    const memberAllowanceRows =
      memberAllowancesResult
        .available
        ? memberAllowancesResult
            .rows
        : memberAllowanceResult
            .rows;

    const allowanceByMemberId =
      createMultiMap(
        memberAllowanceRows,
        (row) =>
          row.member_id ||
          row.signup_id
      );

    const allowanceTransactionsByMemberId =
      createMultiMap(
        allowanceTransactionsResult.rows,
        (row) =>
          row.member_id ||
          row.signup_id
      );

    const growthPoolByMemberId =
      createMultiMap(
        growthPoolResult.rows,
        (row) =>
          row.member_id ||
          row.signup_id
      );

    const supportByMemberId =
      createMultiMap(
        supportResult.rows,
        (row) =>
          row.member_id ||
          row.signup_id
      );

    const supportByProfileId =
      createMultiMap(
        supportResult.rows,
        (row) =>
          row.profile_id
      );

    const notesByProfileId =
      createMultiMap(
        notesResult.rows,
        (row) =>
          row.target_profile_id ||
          row.profile_id
      );

    /* ======================================================================
       BUILD COMPLETE MEMBERS
    ====================================================================== */

    const allMembers =
      signups.map(
        (signup) => {
          const profile =
            profileBySignupId.get(
              signup.id
            ) ||
            profileByEmail.get(
              normalizeEmail(
                signup.email
              )
            ) ||
            null;

          const profileId =
            profile?.id ||
            null;

          const adminRole =
            profileId
              ? adminRoleByProfileId.get(
                  profileId
                ) ||
                null
              : null;

          const rewardAccount =
            profileId
              ? rewardByProfileId.get(
                  profileId
                ) ||
                null
              : null;

          const onboarding =
            profileId
              ? onboardingByProfileId.get(
                  profileId
                ) ||
                null
              : null;

          const supportTickets = [
            ...(
              supportByMemberId.get(
                signup.id
              ) ||
              []
            ),

            ...(
              profileId
                ? supportByProfileId.get(
                    profileId
                  ) ||
                  []
                : []
            ),
          ];

          return buildMember({
            signup,

            profile,

            adminRole,

            rewardAccount,

            onboarding,

            memberCards:
              cardsByMemberId.get(
                signup.id
              ) ||
              [],

            allowanceRows:
              allowanceByMemberId.get(
                signup.id
              ) ||
              [],

            allowanceTransactions:
              allowanceTransactionsByMemberId.get(
                signup.id
              ) ||
              [],

            growthPoolTransactions:
              growthPoolByMemberId.get(
                signup.id
              ) ||
              [],

            referrals:
              referralsResult.rows,

            supportTickets,

            adminNotes:
              profileId
                ? notesByProfileId.get(
                    profileId
                  ) ||
                  []
                : [],
          });
        }
      );

    /* ======================================================================
       GLOBAL SUMMARY

       Summary is calculated BEFORE frontend filters so dashboard totals remain
       meaningful.
    ====================================================================== */

    const summary =
      buildSummary(
        allMembers
      );

    const statusCounts =
      buildStatusCounts(
        allMembers
      );

    /* ======================================================================
       FILTER / SORT / PAGINATE
    ====================================================================== */

    const filteredMembers =
      applyFilters(
        allMembers,
        {
          search,
          status,
          payment,
          access,
          tier,
          role,
        }
      );

    const sortedMembers =
      sortMembers(
        filteredMembers,
        sort
      );

    const total =
      sortedMembers.length;

    const totalPages =
      total >
      0
        ? Math.ceil(
            total /
            limit
          )
        : 1;

    const members =
      sortedMembers.slice(
        from,
        to
      );

    /* ======================================================================
       OPTIONAL SYSTEM STATUS
    ====================================================================== */

    const systems = {
      profiles:
        profilesResult.available,

      adminRoles:
        adminRolesResult.available,

      rewardAccounts:
        rewardsResult.available,

      onboarding:
        onboardingResult.available,

      cards:
        cardsResult.available,

      allowance:
        memberAllowancesResult.available ||
        memberAllowanceResult.available,

      allowanceTransactions:
        allowanceTransactionsResult.available,

      growthPool:
        growthPoolResult.available,

      referrals:
        referralsResult.available,

      support:
        supportResult.available,

      adminNotes:
        notesResult.available,
    };

    /* ======================================================================
       LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "admin_members",

        adminId:
          admin.id,

        adminEmail:
          admin.email,

        returned:
          members.length,

        filteredTotal:
          total,

        allMembers:
          allMembers.length,

        page,

        limit,

        ip:
          getClientIp(req),
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

        admin,

        /* ------------------------------------------------------------------
           FILTERS
        ------------------------------------------------------------------ */

        filters: {
          statuses:
            VALID_STATUSES,

          activeStatus:
            status,

          paymentStatuses:
            VALID_PAYMENT_STATUSES,

          activePayment:
            payment,

          accessStatuses:
            VALID_ACCESS_STATUSES,

          activeAccess:
            access,

          tiers:
            VALID_TIERS,

          activeTier:
            tier,

          roles:
            VALID_ROLES,

          activeRole:
            role,

          sorts:
            VALID_SORTS,

          activeSort:
            sort,

          search,

          limit,

          page,
        },

        /* ------------------------------------------------------------------
           PAGINATION
        ------------------------------------------------------------------ */

        pagination: {
          page,

          limit,

          total,

          totalPages,

          hasNextPage:
            page <
            totalPages,

          hasPreviousPage:
            page >
            1,

          from:
            total ===
            0
              ? 0
              : from +
                1,

          to:
            Math.min(
              to,
              total
            ),
        },

        /* ------------------------------------------------------------------
           SUMMARY
        ------------------------------------------------------------------ */

        summary: {
          ...summary,

          statusCounts,

          totalMembers:
            summary.total,

          total_members:
            summary.total,

          activePaidMembers:
            summary
              .activePaid,

          active_paid_members:
            summary
              .activePaid,

          pendingPayments:
            summary
              .pendingPayment,

          pending_payments:
            summary
              .pendingPayment,

          accessPerksReady:
            summary
              .accessReady,

          access_perks_ready:
            summary
              .accessReady,

          cardsIssued:
            summary
              .cardsConfigured,

          cards_issued:
            summary
              .cardsConfigured,

          growthPoolMembers:
            summary
              .growthPoolContributed,

          growth_pool_members:
            summary
              .growthPoolContributed,
        },

        /* ------------------------------------------------------------------
           SYSTEM AVAILABILITY
        ------------------------------------------------------------------ */

        systems,

        /* ------------------------------------------------------------------
           MEMBER ROWS
        ------------------------------------------------------------------ */

        members,

        /* ------------------------------------------------------------------
           COMPATIBILITY ALIASES
        ------------------------------------------------------------------ */

        rows:
          members,

        items:
          members,

        count:
          members.length,

        total,

        /* ------------------------------------------------------------------
           METADATA
        ------------------------------------------------------------------ */

        fetchedAt:
          new Date()
            .toISOString(),
      },

      "Admin members loaded successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "admin_members_unexpected",
      }
    );

    console.error(
      "Card Leo admin members error:",
      error
    );

    return serverError(
      res,

      "Failed to load Card Leo members.",

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