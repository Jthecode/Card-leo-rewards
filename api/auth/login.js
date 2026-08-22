// api/auth/login.js

import crypto from "crypto";

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";

import {
  validateLoginInput,
} from "../../lib/validation.js";

import {
  clearAuthCookies,
} from "../../lib/cookies.js";

import {
  loginRateLimit,
} from "../../lib/rate-limit.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   MEMBER LOGIN API

   ROUTE
   -----
   POST /api/auth/login

   PURPOSE
   -------
   Authenticate a Card Leo member and create the member session consumed by:

   - /api/auth/me
   - assets/js/auth-guard.js
   - login.html
   - /portal/index.html
   - /portal/card.html
   - all protected Card Leo portal pages

   SESSION ARCHITECTURE
   --------------------
   Primary session cookie:

     cardleo_session

   Session-token cookie:

     cardleo_session_token

   Compatibility cookie:

     cardleo_auth

   IMPORTANT
   ---------
   Successful login means:

   1. Member exists
   2. Password matches
   3. Account is not blocked
   4. Membership/payment grants portal access
   5. Session cookies are created
   6. Database session token is updated when supported

============================================================================ */

/* ==========================================================================
   ROUTES
============================================================================ */

const DEFAULT_REDIRECT =
  "/portal/index.html";

const LOGIN_PATH =
  "/login.html";

const PAYMENT_REQUIRED_REDIRECT =
  "/signup.html?status=payment_required";

/* ==========================================================================
   SESSION COOKIES
============================================================================ */

const SESSION_COOKIE_NAME =
  "cardleo_session";

const SESSION_TOKEN_COOKIE_NAME =
  "cardleo_session_token";

const COMPATIBILITY_SESSION_COOKIE_NAME =
  "cardleo_auth";

/* ==========================================================================
   SESSION DURATIONS
============================================================================ */

const DEFAULT_SESSION_SECONDS =
  60 * 60 * 24;

const REMEMBER_SESSION_SECONDS =
  60 * 60 * 24 * 30;

/* ==========================================================================
   STATUS RULES

   These intentionally match /api/auth/me and auth-guard.js.
============================================================================ */

const ACTIVE_ACCOUNT_STATUSES =
  new Set([
    "active",
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
    "auto_approved",
  ]);

const PAID_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

const ACTIVE_MEMBERSHIP_STATUSES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
    "auto_approved",
  ]);

const PAYMENT_REQUIRED_STATUSES =
  new Set([
    "",
    "unpaid",
    "payment_pending",
    "pending_payment",
    "requires_payment",
    "incomplete",
    "past_due",
    "failed",
    "payment_failed",
    "pending",
    "inactive",
  ]);

const BLOCKED_ACCOUNT_STATUSES =
  new Set([
    "disabled",
    "suspended",
    "paused",
    "denied",
    "closed",
    "cancelled",
    "canceled",
  ]);

/* ==========================================================================
   REQUEST HELPERS
============================================================================ */

function getRequestBody(
  req
) {
  if (!req?.body) {
    return {};
  }

  if (
    typeof req.body ===
    "string"
  ) {
    try {
      const parsed =
        JSON.parse(
          req.body
        );

      return (
        parsed &&
        typeof parsed ===
          "object"
      )
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  if (
    typeof req.body ===
    "object"
  ) {
    return req.body;
  }

  return {};
}

/* ==========================================================================
   NORMALIZATION
============================================================================ */

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeStatus(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeBoolean(
  value
) {
  if (
    typeof value ===
    "boolean"
  ) {
    return value;
  }

  if (
    typeof value ===
    "number"
  ) {
    return value !== 0;
  }

  const normalized =
    normalizeString(
      value
    ).toLowerCase();

  return [
    "true",
    "1",
    "yes",
    "y",
    "on",
  ].includes(
    normalized
  );
}

function normalizeNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : fallback;
}

/* ==========================================================================
   CLIENT IP
============================================================================ */

function getClientIp(
  req
) {
  const forwardedFor =
    req.headers?.[
      "x-forwarded-for"
    ] ||
    req.headers?.[
      "x-real-ip"
    ] ||
    req.headers?.[
      "cf-connecting-ip"
    ];

  if (
    typeof forwardedFor ===
      "string" &&
    forwardedFor.trim()
  ) {
    return forwardedFor
      .split(",")[0]
      .trim();
  }

  return (
    req.socket
      ?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   PASSWORD
============================================================================ */

function hashPassword(
  password
) {
  return crypto
    .createHash(
      "sha256"
    )
    .update(
      String(
        password ||
        ""
      )
    )
    .digest(
      "hex"
    );
}

function safeCompareHash(
  inputHash,
  storedHash
) {
  const cleanInput =
    normalizeString(
      inputHash
    );

  const cleanStored =
    normalizeString(
      storedHash
    );

  if (
    !cleanInput ||
    !cleanStored
  ) {
    return false;
  }

  let left;
  let right;

  try {
    left =
      Buffer.from(
        cleanInput,
        "hex"
      );

    right =
      Buffer.from(
        cleanStored,
        "hex"
      );
  } catch {
    return false;
  }

  if (
    !left.length ||
    !right.length ||
    left.length !==
      right.length
  ) {
    return false;
  }

  try {
    return crypto
      .timingSafeEqual(
        left,
        right
      );
  } catch {
    return false;
  }
}

/* ==========================================================================
   DISPLAY NAME
============================================================================ */

function getDisplayName(
  member
) {
  const fullName =
    normalizeString(
      member?.full_name ||
      member?.fullName
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
        normalizeString
      )
      .filter(Boolean)
      .join(" ");

  return (
    joined ||
    "Card Leo Member"
  );
}

/* ==========================================================================
   TIER
============================================================================ */

function normalizeTier(
  value
) {
  const tier =
    normalizeString(
      value ||
      "core"
    ).toLowerCase();

  if (
    [
      "core",
      "silver",
      "gold",
      "platinum",
      "vip",
    ].includes(
      tier
    )
  ) {
    return tier;
  }

  return "core";
}

function titleCase(
  value
) {
  return String(
    value ||
    ""
  )
    .split(
      /[\s_-]+/
    )
    .filter(Boolean)
    .map(
      (part) =>
        part
          .charAt(0)
          .toUpperCase() +
        part
          .slice(1)
          .toLowerCase()
    )
    .join(" ");
}

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

function getMemberStatuses(
  member
) {
  return {
    status:
      normalizeStatus(
        member?.status
      ),

    paymentStatus:
      normalizeStatus(
        member
          ?.payment_status
      ),

    membershipStatus:
      normalizeStatus(
        member
          ?.membership_status
      ),

    approvalStatus:
      normalizeStatus(
        member
          ?.approval_status
      ),
  };
}

function isBlockedMember(
  member
) {
  if (!member) {
    return true;
  }

  const {
    status,
    membershipStatus,
    approvalStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    BLOCKED_ACCOUNT_STATUSES.has(
      status
    ) ||
    BLOCKED_ACCOUNT_STATUSES.has(
      membershipStatus
    ) ||
    BLOCKED_ACCOUNT_STATUSES.has(
      approvalStatus
    )
  );
}

function hasPortalAccessForMember(
  member
) {
  if (!member) {
    return false;
  }

  /*
   * Blocked status overrides everything else.
   *
   * A suspended member must not regain portal access simply because an
   * older payment_status still says "paid".
   */

  if (
    isBlockedMember(
      member
    )
  ) {
    return false;
  }

  const {
    status,
    paymentStatus,
    membershipStatus,
    approvalStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    ACTIVE_ACCOUNT_STATUSES.has(
      status
    ) ||
    PAID_PAYMENT_STATUSES.has(
      paymentStatus
    ) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_ACCOUNT_STATUSES.has(
      approvalStatus
    )
  );
}

function doesMemberRequirePayment(
  member
) {
  if (!member) {
    return true;
  }

  /*
   * Disabled/suspended/denied/cancelled accounts are account-access
   * problems, not checkout problems.
   */

  if (
    isBlockedMember(
      member
    )
  ) {
    return false;
  }

  if (
    hasPortalAccessForMember(
      member
    )
  ) {
    return false;
  }

  const {
    status,
    paymentStatus,
    membershipStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    PAYMENT_REQUIRED_STATUSES.has(
      status
    ) ||
    PAYMENT_REQUIRED_STATUSES.has(
      paymentStatus
    ) ||
    PAYMENT_REQUIRED_STATUSES.has(
      membershipStatus
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
    isBlockedMember(
      member
    )
  ) {
    const {
      status,
      membershipStatus,
      approvalStatus,
    } =
      getMemberStatuses(
        member
      );

    if (
      BLOCKED_ACCOUNT_STATUSES.has(
        status
      )
    ) {
      return status;
    }

    if (
      BLOCKED_ACCOUNT_STATUSES.has(
        membershipStatus
      )
    ) {
      return membershipStatus;
    }

    if (
      BLOCKED_ACCOUNT_STATUSES.has(
        approvalStatus
      )
    ) {
      return approvalStatus;
    }

    return "suspended";
  }

  if (
    hasPortalAccessForMember(
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
    ].includes(
      status
    )
  ) {
    return "pending";
  }

  return (
    status ||
    "pending"
  );
}

/* ==========================================================================
   SAFE PORTAL REDIRECT
============================================================================ */

function getSafeRedirect(
  value
) {
  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return DEFAULT_REDIRECT;
  }

  if (
    raw === LOGIN_PATH
  ) {
    return DEFAULT_REDIRECT;
  }

  if (
    raw.startsWith(
      "//"
    )
  ) {
    return DEFAULT_REDIRECT;
  }

  try {
    const url =
      new URL(
        raw,
        "https://cardleorewards.local"
      );

    /*
     * Login is only allowed to redirect into Card Leo portal pages.
     *
     * This also prevents open-redirect abuse.
     */

    if (
      !url.pathname.startsWith(
        "/portal/"
      ) &&
      url.pathname !==
        "/portal"
    ) {
      return DEFAULT_REDIRECT;
    }

    return (
      `${url.pathname}` +
      `${url.search || ""}` +
      `${url.hash || ""}`
    );
  } catch {
    return DEFAULT_REDIRECT;
  }
}

function resolvePortalLoginUrl(
  member,
  requestedNext = ""
) {
  /*
   * Explicit ?next=/portal/card.html from the login page takes priority.
   *
   * This is what allows:
   *
   * /portal/card.html
   *       ↓
   * login
   *       ↓
   * successful session
   *       ↓
   * /portal/card.html
   */

  const requested =
    getSafeRedirect(
      requestedNext
    );

  if (
    requestedNext &&
    requested !==
      DEFAULT_REDIRECT
  ) {
    return requested;
  }

  const portalLoginUrl =
    normalizeString(
      member
        ?.portal_login_url
    );

  if (
    portalLoginUrl &&
    portalLoginUrl.startsWith(
      "/"
    ) &&
    !portalLoginUrl.startsWith(
      "//"
    )
  ) {
    return getSafeRedirect(
      portalLoginUrl
    );
  }

  return DEFAULT_REDIRECT;
}

/* ==========================================================================
   MEMBER RESPONSE
============================================================================ */

function sanitizeMember(
  member,
  requestedNext = ""
) {
  if (!member) {
    return null;
  }

  const portalAccess =
    hasPortalAccessForMember(
      member
    );

  const requiresPayment =
    doesMemberRequirePayment(
      member
    );

  const {
    status,
    paymentStatus,
    membershipStatus,
    approvalStatus:
      rawApprovalStatus,
  } =
    getMemberStatuses(
      member
    );

  const approvalStatus =
    portalAccess
      ? (
          rawApprovalStatus ||
          "approved"
        )
      : rawApprovalStatus ||
        status;

  const tier =
    normalizeTier(
      member.tier ||
      "core"
    );

  const portalLoginUrl =
    resolvePortalLoginUrl(
      member,
      requestedNext
    );

  return {
    /* ----------------------------------------------------------------------
       IDENTITY
    ---------------------------------------------------------------------- */

    id:
      member.id ||
      null,

    memberId:
      member.id ||
      null,

    member_id:
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
      normalizeString(
        member.first_name
      ),

    first_name:
      normalizeString(
        member.first_name
      ),

    lastName:
      normalizeString(
        member.last_name
      ),

    last_name:
      normalizeString(
        member.last_name
      ),

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
      normalizeString(
        member.phone
      ),

    city:
      normalizeString(
        member.city
      ),

    state:
      normalizeString(
        member.state
      ),

    interest:
      normalizeString(
        member.interest
      ),

    goals:
      normalizeString(
        member.goals
      ),

    /* ----------------------------------------------------------------------
       REFERRAL
    ---------------------------------------------------------------------- */

    referralName:
      normalizeString(
        member.referral_name
      ),

    referral_name:
      normalizeString(
        member.referral_name
      ),

    referralEmail:
      normalizeString(
        member.referral_email
      ),

    referral_email:
      normalizeString(
        member.referral_email
      ),

    referralCode:
      normalizeString(
        member.referral_code
      ),

    referral_code:
      normalizeString(
        member.referral_code
      ),

    /* ----------------------------------------------------------------------
       MEMBER STATUS
    ---------------------------------------------------------------------- */

    status,

    payment_status:
      paymentStatus,

    paymentStatus,

    membership_status:
      membershipStatus,

    membershipStatus,

    approval_status:
      approvalStatus,

    approvalStatus,

    memberStatus:
      normalizeMemberStatus(
        member
      ),

    member_status:
      normalizeMemberStatus(
        member
      ),

    active:
      portalAccess,

    portalAccess,

    portal_access:
      portalAccess,

    requires_payment:
      requiresPayment,

    requiresPayment,

    payment_required:
      requiresPayment,

    paymentRequired:
      requiresPayment,

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
      normalizeNumber(
        member.billing_day,
        10
      ),

    billingDay:
      normalizeNumber(
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

    portalUserId:
      normalizeString(
        member
          .portal_user_id
      ) ||
      null,

    portal_user_id:
      normalizeString(
        member
          .portal_user_id
      ) ||
      null,

    portalLoginUrl,

    portal_login_url:
      portalLoginUrl,

    /* ----------------------------------------------------------------------
       STRIPE
    ---------------------------------------------------------------------- */

    stripeCustomerId:
      normalizeString(
        member
          .stripe_customer_id
      ),

    stripe_customer_id:
      normalizeString(
        member
          .stripe_customer_id
      ),

    stripeSubscriptionId:
      normalizeString(
        member
          .stripe_subscription_id
      ),

    stripe_subscription_id:
      normalizeString(
        member
          .stripe_subscription_id
      ),

    stripeCheckoutSessionId:
      normalizeString(
        member
          .stripe_checkout_session_id
      ),

    stripe_checkout_session_id:
      normalizeString(
        member
          .stripe_checkout_session_id
      ),

    /* ----------------------------------------------------------------------
       DATES
    ---------------------------------------------------------------------- */

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

    /* ----------------------------------------------------------------------
       AUTH ROLE
    ---------------------------------------------------------------------- */

    role:
      "member",

    accessLevel:
      "member",

    access_level:
      "member",
  };
}

/* ==========================================================================
   USER RESPONSE
============================================================================ */

function buildUser(
  member,
  requestedNext = ""
) {
  const safeMember =
    sanitizeMember(
      member,
      requestedNext
    );

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

      approval_status:
        safeMember.approvalStatus,

      requires_payment:
        safeMember.requiresPayment,

      signup_id:
        safeMember.id,

      member_id:
        safeMember.id,

      portal_user_id:
        safeMember.portalUserId,

      portal_access:
        safeMember.portalAccess,

      portal_login_url:
        safeMember.portalLoginUrl,
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
   PROFILE RESPONSE
============================================================================ */

function buildProfile(
  member,
  requestedNext = ""
) {
  const safeMember =
    sanitizeMember(
      member,
      requestedNext
    );

  if (!safeMember) {
    return null;
  }

  return {
    id:
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

    approval_status:
      safeMember.approvalStatus,

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
      safeMember
        .portalLoginUrl,

    created_at:
      safeMember.createdAt,

    updated_at:
      safeMember.updatedAt,
  };
}

/* ==========================================================================
   OPTIONAL DATABASE COLUMN DETECTION
============================================================================ */

function isMissingOptionalColumn(
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
   DATABASE SELECT
============================================================================ */

function getSelectFields({
  extended = true,
} = {}) {
  const base = [
    "id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "city",
    "state",
    "interest",
    "agreed",
    "status",
    "password_hash",
    "portal_user_id",
    "portal_login_url",
    "created_at",
    "updated_at",
  ];

  if (!extended) {
    return base.join(
      ", "
    );
  }

  return [
    ...base,

    "full_name",
    "goals",

    "referral_name",
    "referral_email",
    "referral_code",

    "tier",

    "payment_status",
    "membership_status",
    "approval_status",

    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",

    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_checkout_session_id",

    "session_token",
    "auth_token",
    "login_token",
    "portal_token",

    "session_expires_at",
    "last_login_at",
  ].join(
    ", "
  );
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findMemberByEmail(
  email
) {
  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select(
        getSelectFields({
          extended:
            true,
        })
      )
      .ilike(
        "email",
        email
      )
      .limit(1)
      .maybeSingle();

  /*
   * Compatibility fallback for installations that have not added all of
   * the newer session/billing fields yet.
   */

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    result =
      await supabaseAdmin
        .from(
          "signups"
        )
        .select(
          getSelectFields({
            extended:
              false,
          })
        )
        .ilike(
          "email",
          email
        )
        .limit(1)
        .maybeSingle();
  }

  return result;
}

/* ==========================================================================
   SESSION TOKEN
============================================================================ */

function makeSessionToken() {
  return crypto
    .randomBytes(
      32
    )
    .toString(
      "hex"
    );
}

/* ==========================================================================
   SESSION COOKIE ENCODING
============================================================================ */

function encodeSessionCookiePayload(
  payload
) {
  return Buffer
    .from(
      JSON.stringify(
        payload
      ),
      "utf8"
    )
    .toString(
      "base64url"
    );
}

function decodeSessionCookiePayload(
  value
) {
  try {
    const raw =
      Buffer
        .from(
          String(
            value ||
            ""
          ),
          "base64url"
        )
        .toString(
          "utf8"
        );

    return JSON.parse(
      raw
    );
  } catch {
    return null;
  }
}

/* ==========================================================================
   SESSION PAYLOAD

   IMPORTANT
   ---------
   /api/auth/me recognizes all of these identity fields.
============================================================================ */

function buildSmallSessionPayload(
  member,
  remember,
  sessionToken,
  maxAge,
  requestedNext = ""
) {
  const now =
    Math.floor(
      Date.now() /
      1000
    );

  const expiresAt =
    now +
    maxAge;

  const safeMember =
    sanitizeMember(
      member,
      requestedNext
    );

  return {
    authenticated:
      true,

    provider:
      "cardleo-signups",

    type:
      "member",

    role:
      "member",

    /*
     * Identity
     */

    id:
      safeMember?.id ||
      member.id,

    memberId:
      safeMember?.id ||
      member.id,

    member_id:
      safeMember?.id ||
      member.id,

    signupId:
      safeMember?.id ||
      member.id,

    signup_id:
      safeMember?.id ||
      member.id,

    portalUserId:
      safeMember
        ?.portalUserId ||
      null,

    portal_user_id:
      safeMember
        ?.portalUserId ||
      null,

    email:
      safeMember?.email ||
      normalizeEmail(
        member.email
      ),

    /*
     * Session token
     */

    token:
      sessionToken,

    sessionToken:
      sessionToken,

    session_token:
      sessionToken,

    /*
     * Member state
     */

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

    approval_status:
      safeMember
        ?.approvalStatus ||
      "",

    portalAccess:
      safeMember
        ?.portalAccess ===
      true,

    portal_access:
      safeMember
        ?.portalAccess ===
      true,

    /*
     * Lifetime
     */

    remember:
      Boolean(
        remember
      ),

    created_at:
      now,

    checked_at:
      now,

    expires_at:
      expiresAt,

    expiresAt,

    /*
     * Redirect
     */

    redirectTo:
      safeMember
        ?.portalLoginUrl ||
      DEFAULT_REDIRECT,

    redirect_to:
      safeMember
        ?.portalLoginUrl ||
      DEFAULT_REDIRECT,
  };
}

/* ==========================================================================
   COOKIE OPTIONS
============================================================================ */

function getCookieOptions({
  maxAge =
    DEFAULT_SESSION_SECONDS,

  httpOnly =
    true,
} = {}) {
  const parts = [
    "Path=/",

    `Max-Age=${Math.max(
      0,
      normalizeNumber(
        maxAge,
        0
      )
    )}`,

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

  return parts.join(
    "; "
  );
}

/* ==========================================================================
   SET COOKIE
============================================================================ */

function appendSetCookie(
  res,
  cookie
) {
  const current =
    res.getHeader(
      "Set-Cookie"
    );

  if (!current) {
    res.setHeader(
      "Set-Cookie",
      cookie
    );

    return;
  }

  if (
    Array.isArray(
      current
    )
  ) {
    res.setHeader(
      "Set-Cookie",
      [
        ...current,
        cookie,
      ]
    );

    return;
  }

  res.setHeader(
    "Set-Cookie",
    [
      current,
      cookie,
    ]
  );
}

function setCookie(
  res,
  name,
  value,
  options = {}
) {
  const encodedValue =
    encodeURIComponent(
      String(
        value ||
        ""
      )
    );

  appendSetCookie(
    res,

    `${name}=${encodedValue}; ${getCookieOptions(
      options
    )}`
  );
}

function expireCookie(
  res,
  name
) {
  appendSetCookie(
    res,

    `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${
      process.env.NODE_ENV ===
      "production"
        ? "; Secure"
        : ""
    }`
  );
}

/* ==========================================================================
   CLEAR AUTH COOKIES
============================================================================ */

function clearAllAuthCookies(
  res
) {
  try {
    clearAuthCookies(
      res
    );
  } catch {
    // Continue clearing compatibility cookies.
  }

  [
    SESSION_COOKIE_NAME,
    SESSION_TOKEN_COOKIE_NAME,
    COMPATIBILITY_SESSION_COOKIE_NAME,

    "cardleo_member",
    "cardleo_member_id",
    "cardleo_portal_session",
    "card_leo_session",

    "member_session",
    "portal_session",
    "session",

    "token",
  ].forEach(
    (name) => {
      expireCookie(
        res,
        name
      );
    }
  );
}

/* ==========================================================================
   SAVE SESSION TOKEN
============================================================================ */

async function saveSessionToken(
  memberId,
  sessionToken,
  expiresAtIso
) {
  const now =
    new Date()
      .toISOString();

  const fullPayload = {
    session_token:
      sessionToken,

    auth_token:
      sessionToken,

    login_token:
      sessionToken,

    portal_token:
      sessionToken,

    session_expires_at:
      expiresAtIso,

    last_login_at:
      now,

    updated_at:
      now,
  };

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fullPayload
      )
      .eq(
        "id",
        memberId
      );

  if (!result.error) {
    return {
      saved:
        true,
    };
  }

  /*
   * Session persistence columns are optional for compatibility.
   *
   * Cookie authentication can still work by member ID/email.
   */

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    console.error(
      "Session token save failed:",
      result.error
    );

    return {
      saved:
        false,

      error:
        result.error,
    };
  }

  const fallbackPayload = {
    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fallbackPayload
      )
      .eq(
        "id",
        memberId
      );

  if (result.error) {
    console.error(
      "Fallback login update failed:",
      result.error
    );
  }

  return {
    saved:
      false,

    fallback:
      true,

    error:
      result.error ||
      null,
  };
}

/* ==========================================================================
   SET AUTH COOKIES
============================================================================ */

function setAuthCookies(
  res,
  member,
  remember,
  requestedNext = ""
) {
  const maxAge =
    remember
      ? REMEMBER_SESSION_SECONDS
      : DEFAULT_SESSION_SECONDS;

  const sessionToken =
    makeSessionToken();

  const sessionPayload =
    buildSmallSessionPayload(
      member,
      remember,
      sessionToken,
      maxAge,
      requestedNext
    );

  const encodedSession =
    encodeSessionCookiePayload(
      sessionPayload
    );

  /*
   * Primary member session.
   */

  setCookie(
    res,
    SESSION_COOKIE_NAME,
    encodedSession,
    {
      httpOnly:
        true,

      maxAge,
    }
  );

  /*
   * Server-verifiable session token.
   */

  setCookie(
    res,
    SESSION_TOKEN_COOKIE_NAME,
    sessionToken,
    {
      httpOnly:
        true,

      maxAge,
    }
  );

  /*
   * Compatibility cookie for older Card Leo portal code.
   */

  setCookie(
    res,
    COMPATIBILITY_SESSION_COOKIE_NAME,
    encodedSession,
    {
      httpOnly:
        true,

      maxAge,
    }
  );

  return {
    sessionToken,

    encodedSession,

    sessionPayload,

    maxAge,

    expiresAtIso:
      new Date(
        sessionPayload
          .expires_at *
        1000
      ).toISOString(),
  };
}

/* ==========================================================================
   REQUEST ORIGIN
============================================================================ */

function getOrigin(
  req
) {
  const forwardedProto =
    normalizeString(
      req.headers?.[
        "x-forwarded-proto"
      ]
    );

  const proto =
    forwardedProto
      .split(",")[0]
      .trim() ||
    (
      process.env.NODE_ENV ===
      "production"
        ? "https"
        : "http"
    );

  const forwardedHost =
    normalizeString(
      req.headers?.[
        "x-forwarded-host"
      ]
    );

  const host =
    forwardedHost
      .split(",")[0]
      .trim() ||
    normalizeString(
      req.headers?.host
    ) ||
    "www.cardleorewards.com";

  return `${proto}://${host}`;
}

/* ==========================================================================
   CHECKOUT FOR UNPAID MEMBER
============================================================================ */

async function createCheckoutForUnpaidMember(
  req,
  member
) {
  try {
    const origin =
      getOrigin(
        req
      );

    const response =
      await fetch(
        `${origin}/api/billing/create-checkout-session`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json",
          },

          body:
            JSON.stringify({
              signup_id:
                member.id,

              signupId:
                member.id,

              email:
                member.email,

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

              phone:
                member.phone ||
                "",

              referralName:
                member.referral_name ||
                "",

              referral_name:
                member.referral_name ||
                "",

              activation_fee_amount:
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

              billing_day:
                normalizeNumber(
                  member.billing_day,
                  10
                ),

              success_url:
                "/thank-you.html?payment=success&membership=activated",

              cancel_url:
                "/login.html?payment=cancelled",
            }),
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => ({})
        );

    if (
      !response.ok ||
      data?.success ===
        false ||
      data?.ok ===
        false
    ) {
      return {
        checkoutUrl:
          "",

        error:
          data?.message ||
          data?.error ||
          "Checkout could not be created.",
      };
    }

    return {
      checkoutUrl:
        normalizeString(
          data.checkout_url ||
          data.checkoutUrl ||
          data.url ||
          data.payment_url ||
          data.paymentUrl
        ),

      error:
        "",
    };
  } catch (
    error
  ) {
    console.error(
      "Unable to create checkout during login:",
      error
    );

    return {
      checkoutUrl:
        "",

      error:
        error?.message ||
        "Checkout could not be created.",
    };
  }
}

/* ==========================================================================
   PAYMENT REQUIRED RESPONSE
============================================================================ */

function paymentRequiredPayload(
  member,
  checkoutUrl = "",
  requestedNext = ""
) {
  const safeMember =
    sanitizeMember(
      member,
      requestedNext
    );

  return {
    authenticated:
      false,

    member:
      safeMember,

    user:
      null,

    profile:
      buildProfile(
        member,
        requestedNext
      ),

    role:
      "",

    status:
      safeMember?.status ||
      "",

    payment_status:
      safeMember
        ?.paymentStatus ||
      "",

    paymentStatus:
      safeMember
        ?.paymentStatus ||
      "",

    membership_status:
      safeMember
        ?.membershipStatus ||
      "",

    membershipStatus:
      safeMember
        ?.membershipStatus ||
      "",

    approval_status:
      safeMember
        ?.approvalStatus ||
      "",

    approvalStatus:
      safeMember
        ?.approvalStatus ||
      "",

    portalAccess:
      false,

    portal_access:
      false,

    requires_payment:
      true,

    requiresPayment:
      true,

    payment_required:
      true,

    paymentRequired:
      true,

    checkout_url:
      checkoutUrl,

    checkoutUrl,

    payment_url:
      checkoutUrl,

    paymentUrl:
      checkoutUrl,

    redirectTo:
      checkoutUrl ||
      PAYMENT_REQUIRED_REDIRECT,
  };
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  logRequestStart(
    req,
    {
      scope:
        "auth_login",
    }
  );

  /* ------------------------------------------------------------------------
     METHOD
  ------------------------------------------------------------------------ */

  if (
    req.method !==
    "POST"
  ) {
    return methodNotAllowed(
      res,
      ["POST"],
      "Method not allowed. Use POST."
    );
  }

  try {
    /* ======================================================================
       RATE LIMIT
    ====================================================================== */

    const rateLimit =
      loginRateLimit(
        req,
        res
      );

    if (
      rateLimit &&
      !rateLimit.allowed
    ) {
      return badRequest(
        res,

        "Too many login attempts. Please try again later.",

        {
          retryAfter:
            rateLimit.retryAfter ??
            null,
        },

        {
          statusCode:
            429,

          error:
            "rate_limited",
        }
      );
    }

    /* ======================================================================
       BODY + VALIDATION
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const validation =
      validateLoginInput(
        body
      );

    if (
      !validation?.valid
    ) {
      return badRequest(
        res,

        "Email and password are required.",

        validation?.errors ||
          {}
      );
    }

    const safeEmail =
      normalizeEmail(
        validation
          .values
          .email
      );

    const password =
      String(
        validation
          .values
          .password ||
        ""
      );

    const remember =
      normalizeBoolean(
        body.remember
      );

    const requestedNext =
      getSafeRedirect(
        body.next
      );

    /* ======================================================================
       FIND MEMBER
    ====================================================================== */

    const {
      data:
        member,

      error:
        lookupError,
    } =
      await findMemberByEmail(
        safeEmail
      );

    if (lookupError) {
      /*
       * IMPORTANT:
       *
       * Database failure is not evidence that an existing browser session
       * is invalid. Do not clear cookies here.
       */

      logRequestError(
        req,
        lookupError,
        {
          scope:
            "auth_login_lookup",

          email:
            safeEmail,
        }
      );

      return serverError(
        res,
        "Unable to check your account right now."
      );
    }

    /* ======================================================================
       ACCOUNT NOT FOUND
    ====================================================================== */

    if (!member?.id) {
      clearAllAuthCookies(
        res
      );

      logAuthEvent(
        "Login failed.",
        {
          email:
            safeEmail,

          reason:
            "account_not_found",

          ip:
            getClientIp(
              req
            ),
        }
      );

      return unauthorized(
        res,
        "Invalid email or password."
      );
    }

    /* ======================================================================
       PASSWORD EXISTS
    ====================================================================== */

    if (
      !member.password_hash
    ) {
      clearAllAuthCookies(
        res
      );

      logAuthEvent(
        "Login blocked because password is missing.",
        {
          email:
            safeEmail,

          memberId:
            member.id,

          ip:
            getClientIp(
              req
            ),
        }
      );

      return forbidden(
        res,

        "This account does not have a password yet. Please reset your account password."
      );
    }

    /* ======================================================================
       PASSWORD CHECK
    ====================================================================== */

    const inputHash =
      hashPassword(
        password
      );

    const passwordMatches =
      safeCompareHash(
        inputHash,
        member.password_hash
      );

    if (
      !passwordMatches
    ) {
      clearAllAuthCookies(
        res
      );

      logAuthEvent(
        "Login failed.",
        {
          email:
            safeEmail,

          memberId:
            member.id,

          reason:
            "invalid_password",

          ip:
            getClientIp(
              req
            ),
        }
      );

      return unauthorized(
        res,
        "Invalid email or password."
      );
    }

    /* ======================================================================
       BLOCKED ACCOUNT

       This MUST happen before checking payment status.
    ====================================================================== */

    if (
      isBlockedMember(
        member
      )
    ) {
      clearAllAuthCookies(
        res
      );

      const {
        status,
        membershipStatus,
        approvalStatus,
      } =
        getMemberStatuses(
          member
        );

      logAuthEvent(
        "Login blocked for restricted account.",
        {
          email:
            safeEmail,

          memberId:
            member.id,

          status,

          membershipStatus,

          approvalStatus,

          ip:
            getClientIp(
              req
            ),
        }
      );

      if (
        status ===
          "disabled" ||
        status ===
          "suspended" ||
        status ===
          "paused" ||
        membershipStatus ===
          "suspended"
      ) {
        return forbidden(
          res,
          "This account is currently suspended or disabled. Please contact Card Leo Rewards support."
        );
      }

      if (
        status ===
          "denied" ||
        approvalStatus ===
          "denied"
      ) {
        return forbidden(
          res,
          "This account was not approved. Please contact Card Leo Rewards support."
        );
      }

      return forbidden(
        res,
        "This account does not currently have portal access. Please contact Card Leo Rewards support."
      );
    }

    /* ======================================================================
       PORTAL / PAYMENT STATUS
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

      const {
        status,
        paymentStatus,
        membershipStatus,
      } =
        getMemberStatuses(
          member
        );

      logAuthEvent(
        "Login blocked for inactive or unpaid account.",
        {
          email:
            safeEmail,

          memberId:
            member.id,

          status,

          paymentStatus,

          membershipStatus,

          requiresPayment,

          ip:
            getClientIp(
              req
            ),
        }
      );

      /* --------------------------------------------------------------------
         PAYMENT REQUIRED
      -------------------------------------------------------------------- */

      if (
        requiresPayment
      ) {
        /*
         * Do not create a portal auth session until membership becomes
         * eligible for portal access.
         */

        clearAllAuthCookies(
          res
        );

        const {
          checkoutUrl,
        } =
          await createCheckoutForUnpaidMember(
            req,
            member
          );

        return forbidden(
          res,

          "Membership payment is required before portal access.",

          paymentRequiredPayload(
            member,
            checkoutUrl,
            requestedNext
          ),

          {
            statusCode:
              402,

            error:
              "payment_required",

            redirectTo:
              checkoutUrl ||
              PAYMENT_REQUIRED_REDIRECT,
          }
        );
      }

      /* --------------------------------------------------------------------
         OTHER INACTIVE STATE
      -------------------------------------------------------------------- */

      clearAllAuthCookies(
        res
      );

      return forbidden(
        res,
        "Your Card Leo Rewards membership is not active yet. Please contact support."
      );
    }

    /* ======================================================================
       MEMBER IS ELIGIBLE
    ====================================================================== */

    const safeMember =
      sanitizeMember(
        member,
        requestedNext
      );

    const redirectTo =
      safeMember
        ?.portalLoginUrl ||
      requestedNext ||
      DEFAULT_REDIRECT;

    /* ======================================================================
       CREATE COOKIE SESSION
    ====================================================================== */

    const sessionInfo =
      setAuthCookies(
        res,
        member,
        remember,
        redirectTo
      );

    /* ======================================================================
       SAVE TOKEN SERVER SIDE

       This is compatibility/revocation support.

       Authentication can still resolve from the secure session cookie even
       when an older database schema does not contain the token columns.
    ====================================================================== */

    await saveSessionToken(
      member.id,
      sessionInfo
        .sessionToken,
      sessionInfo
        .expiresAtIso
    );

    const decodedSession =
      decodeSessionCookiePayload(
        sessionInfo
          .encodedSession
      );

    /* ======================================================================
       LOG SUCCESS
    ====================================================================== */

    logAuthEvent(
      "Login successful.",
      {
        email:
          safeEmail,

        memberId:
          member.id,

        status:
          safeMember.status,

        paymentStatus:
          safeMember
            .paymentStatus,

        membershipStatus:
          safeMember
            .membershipStatus,

        redirectTo,

        remember,

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
          "auth_login",

        memberId:
          member.id,

        email:
          safeEmail,

        redirectTo,
      }
    );

    /* ======================================================================
       SUCCESS RESPONSE
    ====================================================================== */

    return ok(
      res,

      {
        success:
          true,

        authenticated:
          true,

        portalAccess:
          true,

        portal_access:
          true,

        member:
          safeMember,

        user:
          buildUser(
            member,
            redirectTo
          ),

        profile:
          buildProfile(
            member,
            redirectTo
          ),

        role:
          "member",

        status:
          safeMember.status,

        memberStatus:
          safeMember
            .memberStatus,

        member_status:
          safeMember
            .memberStatus,

        payment_status:
          safeMember
            .paymentStatus,

        paymentStatus:
          safeMember
            .paymentStatus,

        membership_status:
          safeMember
            .membershipStatus,

        membershipStatus:
          safeMember
            .membershipStatus,

        approval_status:
          safeMember
            .approvalStatus,

        approvalStatus:
          safeMember
            .approvalStatus,

        requires_payment:
          false,

        requiresPayment:
          false,

        payment_required:
          false,

        paymentRequired:
          false,

        redirectTo,

        redirect_to:
          redirectTo,

        next:
          redirectTo,

        session: {
          authenticated:
            true,

          provider:
            "cardleo-signups",

          token_type:
            "custom",

          remember,

          member_id:
            member.id,

          signup_id:
            member.id,

          email:
            safeEmail,

          portal_access:
            true,

          expires_in:
            sessionInfo
              .maxAge,

          expires_at:
            decodedSession
              ?.expires_at ||
            null,

          expiresAt:
            decodedSession
              ?.expires_at ||
            null,
        },
      },

      "Login successful.",

      {
        redirectTo,
      }
    );
  } catch (
    error
  ) {
    /*
     * IMPORTANT:
     *
     * Do NOT clear authentication cookies because of an unexpected server
     * exception.
     *
     * A temporary API/database/server error is not proof that an existing
     * Card Leo member session is invalid.
     */

    logRequestError(
      req,
      error,
      {
        scope:
          "auth_login_unexpected",
      }
    );

    console.error(
      "Card Leo login error:",
      error
    );

    return serverError(
      res,

      process.env.NODE_ENV ===
        "development"
        ? (
            error?.message ||
            "Something went wrong while trying to sign you in."
          )
        : "Something went wrong while trying to sign you in."
    );
  }
}