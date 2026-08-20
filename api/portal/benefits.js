// api/portal/benefits.js

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

import {
  buildPortalAccessCatalog,
  fetchAllAccessOffers,
  filterAccessOffers,
  getAccessOffersConfigForDebug,
  getAccessOffersIntegrationStatus,
  sanitizeAccessOfferForPortal,
  validateAccessOffersConfiguration,
} from "../../lib/access-offers.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #19
   PORTAL BENEFITS API

   ROUTE
   -----
   GET /api/portal/benefits

   PURPOSE
   -------
   Builds the complete Benefits experience for the Card Leo member portal.

   THIS ROUTE COMBINES
   -------------------
   1. Card Leo authentication
   2. Active / paid member status
   3. Access AMT member status
   4. Access Perks readiness
   5. Full Access Offers catalog
   6. Access offer categories
   7. Access merchants
   8. Access locations
   9. Redemption readiness
   10. Card Leo internal benefits
   11. Member reward/account information
   12. Onboarding status

   IMPORTANT
   ---------
   Actual coupon/QR/barcode generation is NOT done here.

   Actual member redemption uses:

     POST /api/access/redeem-offer

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_TIMEZONE =
  "America/New_York";

const DEFAULT_PORTAL_PATH =
  "/portal/index.html";

const DEFAULT_BENEFITS_PATH =
  "/portal/benefits.html";

const ACCESS_OFFERS_ENDPOINT =
  "/api/access/offers";

const ACCESS_REDEEM_ENDPOINT =
  "/api/access/redeem-offer";

const ACCESS_SYNC_ENDPOINT =
  "/api/access/sync-member";

const DEFAULT_ACCESS_PAGE_SIZE =
  100;

const DEFAULT_ACCESS_MAX_PAGES =
  100;

const MAX_ACCESS_PAGE_SIZE =
  500;

const MAX_ACCESS_MAX_PAGES =
  250;

/* ==========================================================================
   ACTIVE MEMBER STATES
============================================================================ */

const ACTIVE_STATUSES =
  new Set([
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

const PAID_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "succeeded",
    "complete",
    "completed",
  ]);

const ACTIVE_MEMBERSHIP_STATUSES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
  ]);

const INACTIVE_STATUSES =
  new Set([
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
  ]);

/* ==========================================================================
   SESSION COOKIE NAMES
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
   CARD LEO INTERNAL BENEFITS
============================================================================ */

const BASE_BENEFITS = [
  {
    code: "member_portal",
    title: "Member Portal Access",
    description:
      "Secure access to your Card Leo Rewards dashboard, profile, rewards activity, referral tower, benefits, allowance card, and account settings.",
    category: "core",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: true,
    sortOrder: 10,
    href: "/portal/index.html",
  },

  {
    code: "access_perks_lifestyle",
    title: "Access Perks Lifestyle Savings",
    description:
      "Restaurants, shopping, travel, entertainment, fitness, grocery savings, local deals, and online offers through your Card Leo Rewards benefits portal.",
    category: "offers",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Access Perks",
    featured: true,
    sortOrder: 12,
    href: "/portal/benefits.html",
  },

  {
    code: "allowance_card",
    title: "Card Leo Member Allowance Card",
    description:
      "View your Card Leo allowance card, personal reward allowance, card readiness, and future eligible allowance funding activity.",
    category: "allowance",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Member Card",
    featured: true,
    sortOrder: 14,
    href: "/portal/card.html",
  },

  {
    code: "reward_tracking",
    title: "Reward Tracking",
    description:
      "Track your direct referral rewards, team rewards, available allowance, and recent reward activity in one place.",
    category: "rewards",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: true,
    sortOrder: 20,
    href: "/portal/rewards.html",
  },

  {
    code: "support_access",
    title: "Member Support",
    description:
      "Get help with rewards, account questions, benefits access, allowance-card questions, and membership issues.",
    category: "support",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: false,
    sortOrder: 30,
    href: "/portal/index.html",
  },

  {
    code: "company_building",
    title: "Growth Pool / Company-Building Tracking",
    description:
      "View company-building activity separately from your personal spendable member allowance.",
    category: "rewards",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Company Pool",
    featured: true,
    sortOrder: 40,
    href: "/portal/rewards.html",
  },

  {
    code: "referral_access",
    title: "Referral Program Access",
    description:
      "Copy and share your personal referral link, invite new members, and track direct and team referral activity.",
    category: "referrals",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Popular",
    featured: true,
    sortOrder: 50,
    href: "/portal/referrals.html",
  },

  {
    code: "priority_support",
    title: "Priority Support Routing",
    description:
      "Priority routing for important membership and account support requests.",
    category: "support",
    tiers: ["gold", "platinum", "vip"],
    badge: "Priority",
    featured: true,
    sortOrder: 60,
    href: "/portal/index.html",
  },

  {
    code: "premium_offers",
    title: "Premium Member Offers",
    description:
      "Enhanced partner promotions and premium member savings available through the Access catalog.",
    category: "offers",
    tiers: ["silver", "gold", "platinum", "vip"],
    badge: "Perk",
    featured: true,
    sortOrder: 70,
    href: "/portal/benefits.html",
  },

  {
    code: "vip_concierge",
    title: "VIP Concierge Access",
    description:
      "Elevated member support and premium experiences for eligible VIP members.",
    category: "vip",
    tiers: ["vip"],
    badge: "VIP",
    featured: true,
    sortOrder: 80,
    href: "/portal/index.html",
  },
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
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(value) {
  return normalizeText(
    value
  ).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(
    value || ""
  ).toLowerCase();
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
    normalizeStatus(value);

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

function normalizeInteger(
  value,
  fallback = 0
) {
  const parsed =
    Number.parseInt(
      String(
        value ?? ""
      ),
      10
    );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function normalizeNumber(
  value,
  fallback = null
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    Math.max(
      value,
      min
    ),
    max
  );
}

function normalizeTier(value) {
  const tier =
    normalizeStatus(
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

function getUnixNow() {
  return Math.floor(
    Date.now() / 1000
  );
}

function titleCase(value) {
  return String(
    value || ""
  )
    .split(/[\s_-]+/)
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

function money(value) {
  const number =
    Number(
      value || 0
    );

  return Number.isFinite(number)
    ? Number(
        number.toFixed(2)
      )
    : 0;
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date.toISOString();
}

/* ==========================================================================
   TIER HELPERS
============================================================================ */

function getTierRank(tier) {
  const order = {
    core: 1,
    silver: 2,
    gold: 3,
    platinum: 4,
    vip: 5,
  };

  return (
    order[
      normalizeTier(tier)
    ] ||
    1
  );
}

function getNextTier(tier) {
  const tiers = [
    "core",
    "silver",
    "gold",
    "platinum",
    "vip",
  ];

  const currentIndex =
    tiers.indexOf(
      normalizeTier(tier)
    );

  if (
    currentIndex < 0 ||
    currentIndex ===
      tiers.length - 1
  ) {
    return null;
  }

  return tiers[
    currentIndex + 1
  ];
}

/* ==========================================================================
   COOKIE HELPERS
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

  return String(
    cookieHeader
  )
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

        if (
          index === -1
        ) {
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

function decodeCookieValue(
  value
) {
  const raw =
    String(
      value || ""
    );

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

function parseJsonObject(
  value
) {
  if (
    isObject(value)
  ) {
    return value;
  }

  const raw =
    normalizeText(value);

  if (!raw) {
    return null;
  }

  const decoded =
    decodeCookieValue(
      raw
    );

  const direct =
    safeJsonParse(
      decoded,
      null
    );

  if (
    isObject(direct)
  ) {
    return direct;
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
    // Ignore invalid base64.
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
          normalized.length /
          4
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

    const parsed =
      safeJsonParse(
        decodedUrl,
        null
      );

    if (
      isObject(parsed)
    ) {
      return parsed;
    }
  } catch {
    // Ignore invalid base64url.
  }

  return null;
}

function readSessionCookie(
  req
) {
  const cookies =
    parseCookieHeader(
      req
    );

  const configuredName =
    typeof getSessionCookieName ===
      "function"
      ? getSessionCookieName()
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

  for (
    const name of names
  ) {
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
   SESSION HELPERS
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
    value.session
      ?.expires_at,
    value.session
      ?.expiresAt,
  ];

  for (
    const candidate
    of candidates
  ) {
    const number =
      Number(candidate);

    if (
      Number.isFinite(
        number
      ) &&
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

  /*
   * Keep compatibility with sessions that did not store expiration.
   */

  if (!expiresAt) {
    return false;
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
   OPTIONAL DATABASE SUPPORT
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
   MEMBER DISPLAY
============================================================================ */

function getDisplayName(
  member
) {
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

/* ==========================================================================
   PORTAL ACCESS
============================================================================ */

function hasPortalAccess(
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
    hasPortalAccess(member)
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

  if (
    [
      "denied",
      "closed",
      "cancelled",
      "canceled",
    ].includes(status)
  ) {
    return status;
  }

  return (
    status ||
    "pending"
  );
}

/* ==========================================================================
   ACCESS MEMBER STATUS
============================================================================ */

function getAccessMemberStatus(
  member
) {
  return normalizeText(
    member
      ?.access_member_status ||
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
  const memberStatus =
    getAccessMemberStatus(
      member
    );

  const perksReady =
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
      memberStatus,

    status:
      memberStatus,

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
      perksReady,

    benefits_ready:
      perksReady,

    ready:
      perksReady,

    sync_endpoint:
      ACCESS_SYNC_ENDPOINT,

    offers_endpoint:
      ACCESS_OFFERS_ENDPOINT,

    redeem_endpoint:
      ACCESS_REDEEM_ENDPOINT,
  };
}

/* ==========================================================================
   SAFE MEMBER
============================================================================ */

function sanitizeMember(
  member
) {
  if (!member) {
    return null;
  }

  const portalAccess =
    hasPortalAccess(
      member
    );

  const access =
    buildAccessPayload(
      member
    );

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

  const status =
    normalizeStatus(
      member.status
    ) ||
    "pending";

  const tier =
    normalizeTier(
      member.tier ||
      "core"
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
      member.email ||
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
      titleCase(tier),

    referralCode:
      member
        .referral_code ||
      "",

    referral_code:
      member
        .referral_code ||
      "",

    portalUserId:
      member
        .portal_user_id ||
      null,

    portal_user_id:
      member
        .portal_user_id ||
      null,

    portalLoginUrl:
      member
        .portal_login_url ||
      DEFAULT_PORTAL_PATH,

    portal_login_url:
      member
        .portal_login_url ||
      DEFAULT_PORTAL_PATH,

    portalAccess,

    portal_access:
      portalAccess,

    accessLevel:
      "member",

    access_level:
      "member",

    stripeCustomerId:
      member
        .stripe_customer_id ||
      "",

    stripe_customer_id:
      member
        .stripe_customer_id ||
      "",

    stripeSubscriptionId:
      member
        .stripe_subscription_id ||
      "",

    stripe_subscription_id:
      member
        .stripe_subscription_id ||
      "",

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

    benefitsReady:
      access
        .benefits_ready,

    benefits_ready:
      access
        .benefits_ready,

    emailVerified:
      Boolean(
        member.email_verified
      ),

    emailVerifiedAt:
      member
        .email_verified_at ||
      null,

    email_verified:
      Boolean(
        member.email_verified
      ),

    email_verified_at:
      member
        .email_verified_at ||
      null,

    createdAt:
      member
        .created_at ||
      null,

    updatedAt:
      member
        .updated_at ||
      null,

    created_at:
      member
        .created_at ||
      null,

    updated_at:
      member
        .updated_at ||
      null,

    role:
      "member",
  };
}

/* ==========================================================================
   SIGNUP SELECT
============================================================================ */

function getSignupSelectFields({
  extended = true,
} = {}) {
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
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
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

    "goals",

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

/* ==========================================================================
   MEMBER LOOKUP
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
        .from("signups")
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
        fallback.data
          ? {
              ...fallback.data,

              goals:
                "",

              payment_status:
                "",

              membership_status:
                "",

              approval_status:
                "",

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
            }
          : null,

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
    readSessionCookie(
      req
    );

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
    const status =
      normalizeStatus(
        data.status ||
        "pending"
      );

    return {
      member:
        null,

      response:
        forbidden(
          res,

          status ===
            "pending" ||
          status ===
            "reviewing" ||
          !status
            ? "Your account is pending approval or payment."
            : "Your account is not active.",

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
   FEATURE FLAGS
============================================================================ */

async function getFeatureFlags() {
  const fallback = {
    rewards_enabled:
      true,

    referrals_enabled:
      true,

    support_enabled:
      true,

    benefits_enabled:
      true,

    access_perks_enabled:
      true,

    allowance_card_enabled:
      true,
  };

  try {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "system_settings"
        )
        .select(
          "value"
        )
        .eq(
          "key",
          "portal.features"
        )
        .maybeSingle();

    if (
      error &&
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return fallback;
    }

    if (error) {
      throw error;
    }

    return {
      rewards_enabled:
        data
          ?.value
          ?.rewards_enabled !==
        false,

      referrals_enabled:
        data
          ?.value
          ?.referrals_enabled !==
        false,

      support_enabled:
        data
          ?.value
          ?.support_enabled !==
        false,

      benefits_enabled:
        data
          ?.value
          ?.benefits_enabled !==
        false,

      access_perks_enabled:
        data
          ?.value
          ?.access_perks_enabled !==
        false,

      allowance_card_enabled:
        data
          ?.value
          ?.allowance_card_enabled !==
        false,
    };
  } catch {
    return fallback;
  }
}

/* ==========================================================================
   DEFAULT ONBOARDING
============================================================================ */

function buildDefaultOnboarding(
  member
) {
  const safeMember =
    sanitizeMember(
      member
    );

  const emailVerified =
    Boolean(
      member
        ?.email_verified ||
      member
        ?.email_verified_at
    );

  const profileCompleted =
    Boolean(
      normalizeText(
        member
          ?.first_name
      ) &&
      normalizeText(
        member
          ?.last_name
      ) &&
      normalizeText(
        member
          ?.email
      ) &&
      normalizeText(
        member
          ?.phone
      )
    );

  const rewardsActivated =
    hasPortalAccess(
      member
    );

  let percent =
    0;

  if (
    profileCompleted
  ) {
    percent += 40;
  }

  if (
    emailVerified
  ) {
    percent += 30;
  }

  if (
    rewardsActivated
  ) {
    percent += 30;
  }

  return {
    signup_id:
      safeMember.id,

    member_id:
      safeMember.id,

    accepted_terms:
      Boolean(
        member?.agreed
      ),

    accepted_privacy:
      Boolean(
        member?.agreed
      ),

    profile_completed:
      profileCompleted,

    email_verified:
      emailVerified,

    first_login_completed:
      true,

    rewards_activated:
      rewardsActivated,

    onboarding_percent:
      Math.max(
        0,
        Math.min(
          100,
          percent
        )
      ),

    onboarding_status:
      percent >= 100
        ? "complete"
        : "in_progress",
  };
}

/* ==========================================================================
   DEFAULT REWARD ACCOUNT
============================================================================ */

function buildDefaultRewardAccount(
  member
) {
  return {
    signup_id:
      member?.id ||
      null,

    member_id:
      member?.id ||
      null,

    account_status:
      hasPortalAccess(
        member
      )
        ? "active"
        : "pending",

    total_cardleo_allocated:
      0,

    total_direct_referral_earned:
      0,

    total_override_earned:
      0,

    company_building_pending:
      0,

    company_building_released:
      0,

    company_building_forfeited:
      0,

    total_member_revenue_processed:
      0,

    total_rewards_earned:
      0,

    total_rewards_paid:
      0,

    last_membership_paid_at:
      null,

    last_direct_referral_at:
      null,

    last_override_at:
      null,

    last_company_building_release_at:
      null,
  };
}

/* ==========================================================================
   OPTIONAL SINGLE LOOKUP
============================================================================ */

async function queryOptionalSingleByMemberColumns({
  table,
  memberId,
  columns,
}) {
  for (
    const column
    of columns
  ) {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(table)
        .select("*")
        .eq(
          column,
          memberId
        )
        .maybeSingle();

    if (!error) {
      return (
        data ||
        null
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

  return null;
}

/* ==========================================================================
   STATIC CARD LEO BENEFITS
============================================================================ */

function buildStaticBenefits(
  memberTier,
  featureFlags = {},
  member = {}
) {
  const normalizedTier =
    normalizeTier(
      memberTier
    );

  const tierRank =
    getTierRank(
      normalizedTier
    );

  const referralsEnabled =
    featureFlags
      .referrals_enabled !==
    false;

  const benefitsEnabled =
    featureFlags
      .benefits_enabled !==
    false;

  const rewardsEnabled =
    featureFlags
      .rewards_enabled !==
    false;

  const supportEnabled =
    featureFlags
      .support_enabled !==
    false;

  const accessPerksEnabled =
    featureFlags
      .access_perks_enabled !==
    false;

  const allowanceEnabled =
    featureFlags
      .allowance_card_enabled !==
    false;

  const access =
    buildAccessPayload(
      member
    );

  if (
    !benefitsEnabled
  ) {
    return [];
  }

  return BASE_BENEFITS
    .filter(
      (benefit) => {
        if (
          benefit.code ===
            "referral_access" &&
          !referralsEnabled
        ) {
          return false;
        }

        if (
          [
            "reward_tracking",
            "company_building",
          ].includes(
            benefit.code
          ) &&
          !rewardsEnabled
        ) {
          return false;
        }

        if (
          [
            "support_access",
            "priority_support",
          ].includes(
            benefit.code
          ) &&
          !supportEnabled
        ) {
          return false;
        }

        if (
          benefit.code ===
            "access_perks_lifestyle" &&
          !accessPerksEnabled
        ) {
          return false;
        }

        if (
          benefit.code ===
            "allowance_card" &&
          !allowanceEnabled
        ) {
          return false;
        }

        return true;
      }
    )
    .map(
      (benefit) => {
        const requiredTierRank =
          Math.min(
            ...benefit.tiers.map(
              (tier) =>
                getTierRank(
                  tier
                )
            )
          );

        let unlocked =
          benefit.tiers.includes(
            normalizedTier
          );

        let lockedReason =
          null;

        const lockedBecauseTier =
          !unlocked &&
          tierRank <
            requiredTierRank;

        if (
          lockedBecauseTier
        ) {
          lockedReason =
            `Available starting at ${titleCase(
              benefit
                .tiers[0] ||
              "core"
            )} tier.`;
        }

        if (
          benefit.code ===
          "access_perks_lifestyle"
        ) {
          unlocked =
            access.perks_ready;

          if (
            !access.perks_ready
          ) {
            lockedReason =
              access.sync_error
                ? `Access Perks sync is pending: ${access.sync_error}`
                : "Access Perks benefits unlock after your Access AMT member status becomes OPEN.";
          }
        }

        return {
          ...benefit,

          type:
            "cardleo",

          provider:
            "cardleo",

          requiredTier:
            benefit
              .tiers[0] ||
            "core",

          unlocked,

          locked:
            !unlocked,

          lockedReason,

          claimable:
            false,

          redeemable:
            false,

          meta:
            benefit.code ===
            "access_perks_lifestyle"
              ? {
                  accessMemberIdentifier:
                    access
                      .member_identifier,

                  accessMemberStatus:
                    access
                      .member_status,

                  accessPerksReady:
                    access
                      .perks_ready,

                  accessSyncError:
                    access
                      .sync_error,
                }
              : {},
        };
      }
    )
    .sort(
      (
        a,
        b
      ) =>
        a.sortOrder -
        b.sortOrder
    );
}

/* ==========================================================================
   DYNAMIC BENEFITS
============================================================================ */

function buildDynamicBenefits({
  member,
  onboarding,
  rewardAccount,
  referralsEnabled,
  rewardsEnabled,
  accessPerksEnabled,
}) {
  const benefits =
    [];

  const memberStatus =
    normalizeMemberStatus(
      member
    );

  const access =
    buildAccessPayload(
      member
    );

  const onboardingPercent =
    Number(
      onboarding
        ?.onboarding_percent ||
      0
    );

  const profileComplete =
    Boolean(
      onboarding
        ?.profile_completed
    );

  const emailVerified =
    Boolean(
      onboarding
        ?.email_verified
    ) ||
    Boolean(
      member
        ?.email_verified_at
    ) ||
    Boolean(
      member
        ?.email_verified
    );

  const rewardsActive =
    Boolean(
      onboarding
        ?.rewards_activated
    );

  const directEarned =
    money(
      rewardAccount
        ?.total_direct_referral_earned
    );

  const overrideEarned =
    money(
      rewardAccount
        ?.total_override_earned
    );

  const companyPending =
    money(
      rewardAccount
        ?.company_building_pending
    );

  const companyReleased =
    money(
      rewardAccount
        ?.company_building_released
    );

  const companyForfeited =
    money(
      rewardAccount
        ?.company_building_forfeited
    );

  const totalRewardsEarned =
    money(
      rewardAccount
        ?.total_rewards_earned
    );

  const totalRewardsPaid =
    money(
      rewardAccount
        ?.total_rewards_paid
    );

  const personalAllowanceEarned =
    money(
      directEarned +
      overrideEarned
    );

  benefits.push({
    code:
      "account_status",

    title:
      "Member Account Status",

    description:
      memberStatus ===
      "active"
        ? "Your membership is active and your Card Leo portal is fully enabled."
        : "Your account is not fully active yet.",

    category:
      "account",

    badge:
      titleCase(
        memberStatus
      ),

    featured:
      true,

    sortOrder:
      5,

    unlocked:
      memberStatus ===
      "active",

    locked:
      memberStatus !==
      "active",

    lockedReason:
      memberStatus ===
      "active"
        ? null
        : "Activate your account to unlock the full member experience.",

    type:
      "cardleo",

    provider:
      "cardleo",

    claimable:
      false,

    redeemable:
      false,

    meta: {
      memberStatus,
    },
  });

  if (
    accessPerksEnabled !==
    false
  ) {
    benefits.push({
      code:
        "access_perks_status",

      title:
        "Access Perks Member Status",

      description:
        access.perks_ready
          ? "Your Access Perks member record is OPEN and the Access benefits catalog is ready."
          : access.sync_error
            ? "Your membership is active, but Access Perks member synchronization needs attention."
            : "Your membership is active. Access Perks will unlock when your Access member record becomes OPEN.",

      category:
        "offers",

      badge:
        access.perks_ready
          ? "Active"
          : access.sync_error
            ? "Sync Needed"
            : "Syncing",

      featured:
        true,

      sortOrder:
        8,

      unlocked:
        access.perks_ready,

      locked:
        !access.perks_ready,

      lockedReason:
        access.perks_ready
          ? null
          : "Access Perks requires an OPEN Access AMT member record.",

      href:
        DEFAULT_BENEFITS_PATH,

      type:
        "cardleo",

      provider:
        "access",

      claimable:
        false,

      redeemable:
        false,

      meta: {
        enabled:
          accessPerksEnabled !==
          false,

        accessMemberIdentifier:
          access
            .member_identifier,

        accessMemberStatus:
          access
            .member_status,

        accessSyncedAt:
          access
            .synced_at,

        accessSyncError:
          access
            .sync_error,

        accessPerksReady:
          access
            .perks_ready,
      },
    });
  }

  benefits.push({
    code:
      "onboarding_progress",

    title:
      "Onboarding Progress",

    description:
      onboardingPercent >=
      100
        ? "Your onboarding is complete and your account is fully set up."
        : "Complete your remaining setup items to finish your Card Leo account.",

    category:
      "account",

    badge:
      `${Math.max(
        0,
        Math.min(
          100,
          onboardingPercent
        )
      )}% Complete`,

    featured:
      true,

    sortOrder:
      15,

    unlocked:
      onboardingPercent >=
      100,

    locked:
      onboardingPercent <
      100,

    lockedReason:
      onboardingPercent >=
      100
        ? null
        : "Finish onboarding to complete account setup.",

    type:
      "cardleo",

    provider:
      "cardleo",

    claimable:
      false,

    redeemable:
      false,

    meta: {
      onboardingPercent,

      profileComplete,

      emailVerified,

      rewardsActive,
    },
  });

  if (
    rewardsEnabled
  ) {
    benefits.push({
      code:
        "member_allowance",

      title:
        "Personal Member Allowance",

      description:
        personalAllowanceEarned >
        0
          ? "Your direct and team referral rewards are tracked separately as personal member allowance."
          : "Your personal allowance will grow from eligible direct and team referral rewards.",

      category:
        "allowance",

      badge:
        `$${personalAllowanceEarned.toFixed(
          2
        )} Earned`,

      featured:
        true,

      sortOrder:
        18,

      unlocked:
        true,

      locked:
        false,

      lockedReason:
        null,

      href:
        "/portal/card.html",

      type:
        "cardleo",

      provider:
        "cardleo",

      claimable:
        false,

      redeemable:
        false,

      meta: {
        directEarned,

        teamEarned:
          overrideEarned,

        personalAllowanceEarned,

        growthPoolIncluded:
          false,
      },
    });

    benefits.push({
      code:
        "rewards_balance",

      title:
        "Current Rewards Earnings",

      description:
        totalRewardsEarned >
        0
          ? "Your current tracked Card Leo rewards are available in your Rewards dashboard."
          : "Your rewards account is ready. Earnings will appear as eligible referral activity occurs.",

      category:
        "rewards",

      badge:
        `$${totalRewardsEarned.toFixed(
          2
        )} Earned`,

      featured:
        true,

      sortOrder:
        25,

      unlocked:
        true,

      locked:
        false,

      lockedReason:
        null,

      href:
        "/portal/rewards.html",

      type:
        "cardleo",

      provider:
        "cardleo",

      claimable:
        false,

      redeemable:
        false,

      meta: {
        totalRewardsEarned,

        totalRewardsPaid,
      },
    });

    benefits.push({
      code:
        "growth_pool_status",

      title:
        "Growth Pool Status",

      description:
        "Growth Pool/company-building money is tracked separately from your personal spendable allowance.",

      category:
        "rewards",

      badge:
        `$${companyPending.toFixed(
          2
        )} Pending`,

      featured:
        true,

      sortOrder:
        35,

      unlocked:
        true,

      locked:
        false,

      lockedReason:
        null,

      type:
        "cardleo",

      provider:
        "cardleo",

      claimable:
        false,

      redeemable:
        false,

      meta: {
        companyPending,

        companyReleased,

        companyForfeited,

        includedInAllowance:
          false,
      },
    });
  }

  if (
    referralsEnabled
  ) {
    benefits.push({
      code:
        "referral_readiness",

      title:
        "Referral Sharing",

      description:
        "Copy your personal Card Leo referral link and send it directly to new recruits by text, email, social media, or messaging apps.",

      category:
        "referrals",

      badge:
        memberStatus ===
          "active"
          ? "Ready"
          : "Almost Ready",

      featured:
        true,

      sortOrder:
        75,

      unlocked:
        memberStatus ===
        "active",

      locked:
        memberStatus !==
        "active",

      lockedReason:
        memberStatus ===
        "active"
          ? null
          : "Your membership must be active before sharing your referral link.",

      href:
        "/portal/referrals.html",

      type:
        "cardleo",

      provider:
        "cardleo",

      claimable:
        false,

      redeemable:
        false,

      meta: {
        referralCode:
          member
            ?.referral_code ||
          "",

        directEarned,

        overrideEarned,
      },
    });
  }

  return benefits.sort(
    (
      a,
      b
    ) =>
      a.sortOrder -
      b.sortOrder
  );
}

/* ==========================================================================
   GROUP CARD LEO BENEFITS
============================================================================ */

function groupBenefitsByCategory(
  benefits
) {
  const groups =
    {};

  for (
    const benefit
    of benefits
  ) {
    const key =
      benefit.category ||
      "other";

    if (
      !groups[key]
    ) {
      groups[key] =
        [];
    }

    groups[key].push(
      benefit
    );
  }

  return Object
    .entries(groups)
    .map(
      ([
        category,
        items,
      ]) => ({
        category,

        title:
          titleCase(
            category
          ),

        count:
          items.length,

        unlockedCount:
          items.filter(
            (item) =>
              item.unlocked
          ).length,

        lockedCount:
          items.filter(
            (item) =>
              item.locked
          ).length,

        items:
          items.sort(
            (
              a,
              b
            ) =>
              (
                a.sortOrder ||
                0
              ) -
              (
                b.sortOrder ||
                0
              )
          ),
      })
    );
}

/* ==========================================================================
   ACCESS QUERY OPTIONS
============================================================================ */

function getAccessCatalogOptions(
  req
) {
  const query =
    req.query ||
    {};

  const pageSize =
    clamp(
      normalizeInteger(
        query
          .access_page_size ??
        query.page_size ??
        query.pageSize,
        DEFAULT_ACCESS_PAGE_SIZE
      ),
      1,
      MAX_ACCESS_PAGE_SIZE
    );

  const maxPages =
    clamp(
      normalizeInteger(
        query
          .access_max_pages ??
        query.max_pages ??
        query.maxPages,
        DEFAULT_ACCESS_MAX_PAGES
      ),
      1,
      MAX_ACCESS_MAX_PAGES
    );

  const latitude =
    normalizeNumber(
      query.latitude ??
      query.lat,
      null
    );

  const longitude =
    normalizeNumber(
      query.longitude ??
      query.lng ??
      query.lon,
      null
    );

  const radius =
    normalizeNumber(
      query.radius,
      null
    );

  return {
    pageSize,

    maxPages,

    search:
      normalizeText(
        query.search ??
        query.q ??
        ""
      ),

    category:
      normalizeText(
        query.category ??
        ""
      ),

    latitude,

    longitude,

    radius,

    online:
      query.online !==
      undefined
        ? normalizeBoolean(
            query.online
          )
        : undefined,

    local:
      query.local !==
      undefined
        ? normalizeBoolean(
            query.local
          )
        : undefined,

    featured:
      query.featured !==
      undefined
        ? normalizeBoolean(
            query.featured
          )
        : undefined,

    debug:
      normalizeBoolean(
        query.debug,
        false
      ),
  };
}

/* ==========================================================================
   ACCESS CATALOG FALLBACK
============================================================================ */

function buildEmptyAccessCatalog({
  configured,
  ready,
  reason = "",
} = {}) {
  return {
    configured:
      Boolean(configured),

    ready:
      Boolean(ready),

    loaded:
      false,

    offers:
      [],

    benefits:
      [],

    categories:
      [],

    merchants:
      [],

    count:
      0,

    fullFilteredCount:
      0,

    rawCatalogCount:
      0,

    pagesFetched:
      0,

    hitSafetyLimit:
      false,

    reason:
      reason ||
      null,
  };
}

/* ==========================================================================
   LOAD FULL ACCESS CATALOG
============================================================================ */

async function loadAccessCatalog({
  member,
  featureFlags,
  options,
}) {
  const access =
    buildAccessPayload(
      member
    );

  const accessEnabled =
    featureFlags
      .access_perks_enabled !==
    false;

  if (
    !accessEnabled
  ) {
    return buildEmptyAccessCatalog({
      configured:
        false,

      ready:
        false,

      reason:
        "access_perks_disabled",
    });
  }

  if (
    !access.perks_ready
  ) {
    return buildEmptyAccessCatalog({
      configured:
        false,

      ready:
        false,

      reason:
        access.sync_error
          ? "access_member_sync_failed"
          : "access_member_not_open",
    });
  }

  const validation =
    validateAccessOffersConfiguration();

  if (
    !validation.valid
  ) {
    return {
      ...buildEmptyAccessCatalog({
        configured:
          false,

        ready:
          true,

        reason:
          "access_offers_not_configured",
      }),

      configurationErrors:
        validation.errors,
    };
  }

  try {
    const result =
      await fetchAllAccessOffers({
        pageSize:
          options.pageSize,

        maxPages:
          options.maxPages,

        search:
          options.search ||
          undefined,

        category:
          options.category ||
          undefined,

        latitude:
          options.latitude ??
          undefined,

        longitude:
          options.longitude ??
          undefined,

        radius:
          options.radius ??
          undefined,

        online:
          options.online,

        featured:
          options.featured,
      });

    let offers =
      result.offers ||
      [];

    const rawCatalogCount =
      offers.length;

    offers =
      filterAccessOffers(
        offers,
        {
          search:
            options.search,

          category:
            options.category,

          online:
            options.online,

          local:
            options.local,

          featured:
            options.featured,

          active:
            true,
        }
      );

    const catalog =
      buildPortalAccessCatalog(
        offers
      );

    const safeOffers =
      catalog
        .offers
        .map(
          sanitizeAccessOfferForPortal
        )
        .filter(Boolean)
        .map(
          (offer) => ({
            ...offer,

            type:
              "access_offer",

            provider:
              "access",

            unlocked:
              true,

            locked:
              false,

            lockedReason:
              null,

            claimable:
              Boolean(
                offer.redeemable
              ),

            redeemable:
              Boolean(
                offer.redeemable
              ),

            claimEndpoint:
              ACCESS_REDEEM_ENDPOINT,

            redeemEndpoint:
              ACCESS_REDEEM_ENDPOINT,

            claimMethod:
              "POST",

            claimPayload: {
              offerId:
                offer.accessOfferId ||
                offer.id,
            },
          })
        );

    return {
      configured:
        true,

      ready:
        true,

      loaded:
        true,

      offers:
        safeOffers,

      benefits:
        safeOffers,

      categories:
        catalog.categories ||
        [],

      merchants:
        catalog.merchants ||
        [],

      count:
        safeOffers.length,

      fullFilteredCount:
        safeOffers.length,

      rawCatalogCount,

      pagesFetched:
        result
          .pagesFetched ||
        0,

      pageSize:
        result.pageSize ||
        options.pageSize,

      hitSafetyLimit:
        Boolean(
          result
            .hitSafetyLimit
        ),

      pagination:
        result.pagination ||
        null,

      reason:
        null,
    };
  } catch (
    error
  ) {
    /*
     * Do not destroy the entire Card Leo Benefits page because
     * Access is temporarily unavailable.
     */

    logRequestError(
      null,
      error,
      {
        scope:
          "portal_benefits_access_catalog",
      }
    );

    return {
      ...buildEmptyAccessCatalog({
        configured:
          true,

        ready:
          true,

        reason:
          "access_catalog_request_failed",
      }),

      providerError: {
        message:
          error?.message ||
          "Access Offers request failed.",

        code:
          error?.code ||
          null,

        status:
          error?.status ||
          null,
      },
    };
  }
}

/* ==========================================================================
   REDEMPTION STATUS
============================================================================ */

function buildRedemptionStatus({
  member,
  accessCatalog,
}) {
  const access =
    buildAccessPayload(
      member
    );

  const redemptionEndpointConfigured =
    Boolean(
      normalizeText(
        process.env
          .ACCESS_REDEMPTION_ENDPOINT_PATH
      )
    );

  return {
    memberReady:
      access.perks_ready,

    offersReady:
      Boolean(
        accessCatalog.loaded
      ),

    endpointConfigured:
      redemptionEndpointConfigured,

    ready:
      Boolean(
        access.perks_ready &&
        accessCatalog.loaded &&
        redemptionEndpointConfigured
      ),

    endpoint:
      ACCESS_REDEEM_ENDPOINT,

    method:
      "POST",

    supports: {
      code:
        true,

      barcode:
        true,

      qrCode:
        true,

      onlineUrl:
        true,
    },

    note:
      redemptionEndpointConfigured
        ? "Claim Offer will request member-specific redemption material from Access."
        : "Claim Offer will remain unavailable until the Access-approved redemption endpoint is configured.",
  };
}

/* ==========================================================================
   OPTIONAL MEMBER CARD STATUS
============================================================================ */

async function getOptionalMemberCard(
  memberId
) {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "member_cards"
      )
      .select(
        [
          "id",
          "member_id",
          "provider",
          "card_status",
          "card_type",
          "last_four",
          "allowance_balance_cents",
          "total_allowance_loaded_cents",
          "total_allowance_spent_cents",
          "card_paused",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq(
        "member_id",
        memberId
      )
      .maybeSingle();

  if (!error) {
    return (
      data ||
      null
    );
  }

  if (
    isMissingOptionalTableOrColumn(
      error
    )
  ) {
    return null;
  }

  throw error;
}

function buildMemberCardPayload(
  card
) {
  if (!card) {
    return {
      exists:
        false,

      provider:
        "lithic",

      cardStatus:
        "not_created",

      cardType:
        "virtual",

      lastFour:
        null,

      maskedNumber:
        null,

      allowanceBalanceCents:
        0,

      allowanceBalance:
        0,

      href:
        "/portal/card.html",
    };
  }

  const lastFour =
    normalizeText(
      card.last_four
    );

  const balanceCents =
    Number(
      card
        .allowance_balance_cents ||
      0
    );

  return {
    exists:
      true,

    id:
      card.id,

    provider:
      normalizeText(
        card.provider ||
        "lithic"
      ),

    cardStatus:
      normalizeText(
        card.card_status ||
        "not_created"
      ),

    cardType:
      normalizeText(
        card.card_type ||
        "virtual"
      ),

    lastFour:
      lastFour ||
      null,

    maskedNumber:
      lastFour
        ? `•••• •••• •••• ${lastFour}`
        : null,

    cardPaused:
      Boolean(
        card.card_paused
      ),

    allowanceBalanceCents:
      balanceCents,

    allowanceBalance:
      money(
        balanceCents /
        100
      ),

    totalAllowanceLoaded:
      money(
        Number(
          card
            .total_allowance_loaded_cents ||
          0
        ) /
        100
      ),

    totalAllowanceSpent:
      money(
        Number(
          card
            .total_allowance_spent_cents ||
          0
        ) /
        100
      ),

    href:
      "/portal/card.html",
  };
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
        "portal_benefits",
    }
  );

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
       AUTHENTICATE
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

    const safeMember =
      sanitizeMember(
        member
      );

    const memberId =
      safeMember.id;

    /* ======================================================================
       FEATURE FLAGS + MEMBER DATA
    ====================================================================== */

    const featureFlags =
      await getFeatureFlags();

    const [
      onboardingOptional,
      rewardAccountOptional,
      memberCardOptional,
    ] =
      await Promise.all([
        queryOptionalSingleByMemberColumns({
          table:
            "member_onboarding",

          memberId,

          columns: [
            "member_id",
            "signup_id",
            "profile_id",
          ],
        }),

        queryOptionalSingleByMemberColumns({
          table:
            "reward_accounts",

          memberId,

          columns: [
            "member_id",
            "signup_id",
            "profile_id",
          ],
        }),

        getOptionalMemberCard(
          memberId
        ),
      ]);

    const onboarding =
      onboardingOptional ||
      buildDefaultOnboarding(
        member
      );

    const rewardAccount =
      rewardAccountOptional ||
      buildDefaultRewardAccount(
        member
      );

    const memberCard =
      buildMemberCardPayload(
        memberCardOptional
      );

    /* ======================================================================
       MEMBER / ACCESS
    ====================================================================== */

    const tier =
      normalizeTier(
        member.tier ||
        "core"
      );

    const nextTier =
      getNextTier(
        tier
      );

    const access =
      buildAccessPayload(
        member
      );

    /* ======================================================================
       CARD LEO BENEFITS
    ====================================================================== */

    const staticBenefits =
      buildStaticBenefits(
        tier,
        featureFlags,
        member
      );

    const dynamicBenefits =
      buildDynamicBenefits({
        member,

        onboarding,

        rewardAccount,

        referralsEnabled:
          featureFlags
            .referrals_enabled,

        rewardsEnabled:
          featureFlags
            .rewards_enabled,

        accessPerksEnabled:
          featureFlags
            .access_perks_enabled,
      });

    const cardLeoBenefits =
      [
        ...dynamicBenefits,
        ...staticBenefits,
      ].sort(
        (
          a,
          b
        ) =>
          (
            a.sortOrder ||
            0
          ) -
          (
            b.sortOrder ||
            0
          )
      );

    const cardLeoGroups =
      groupBenefitsByCategory(
        cardLeoBenefits
      );

    /* ======================================================================
       ACCESS FULL CATALOG
    ====================================================================== */

    const catalogOptions =
      getAccessCatalogOptions(
        req
      );

    const accessCatalog =
      await loadAccessCatalog({
        member,

        featureFlags,

        options:
          catalogOptions,
      });

    /* ======================================================================
       REDEMPTION STATUS
    ====================================================================== */

    const redemption =
      buildRedemptionStatus({
        member,

        accessCatalog,
      });

    /* ======================================================================
       COUNTS
    ====================================================================== */

    const unlockedCount =
      cardLeoBenefits
        .filter(
          (item) =>
            item.unlocked
        ).length;

    const lockedCount =
      cardLeoBenefits
        .filter(
          (item) =>
            item.locked
        ).length;

    const featuredBenefits =
      cardLeoBenefits
        .filter(
          (item) =>
            item.featured
        )
        .slice(
          0,
          10
        );

    const accessOfferCount =
      accessCatalog.count ||
      0;

    const totalVisibleBenefits =
      cardLeoBenefits.length +
      accessOfferCount;

    /* ======================================================================
       LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "portal_benefits",

        memberId,

        email:
          safeMember.email,

        tier,

        cardLeoBenefitCount:
          cardLeoBenefits.length,

        accessOfferCount,

        totalVisibleBenefits,

        accessMemberStatus:
          access.member_status,

        accessPerksReady:
          access.perks_ready,

        accessCatalogLoaded:
          accessCatalog.loaded,

        accessPagesFetched:
          accessCatalog.pagesFetched,

        redemptionReady:
          redemption.ready,
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

        /* ================================================================
           SUMMARY
        ================================================================= */

        summary: {
          profileId:
            safeMember.id,

          memberId:
            safeMember.id,

          memberName:
            safeMember.fullName,

          email:
            safeMember.email,

          tier,

          tierLabel:
            titleCase(
              tier
            ),

          nextTier,

          nextTierLabel:
            nextTier
              ? titleCase(
                  nextTier
                )
              : null,

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

          portalAccess:
            safeMember
              .portalAccess,

          timezone:
            DEFAULT_TIMEZONE,

          totals: {
            /*
             * All benefit cards available to portal.
             */

            benefits:
              totalVisibleBenefits,

            cardLeoBenefits:
              cardLeoBenefits.length,

            accessOffers:
              accessOfferCount,

            unlocked:
              unlockedCount,

            locked:
              lockedCount,

            accessCategories:
              accessCatalog
                .categories
                ?.length ||
              0,

            accessMerchants:
              accessCatalog
                .merchants
                ?.length ||
              0,
          },
        },

        /* ================================================================
           MEMBER
        ================================================================= */

        member:
          safeMember,

        profile:
          safeMember,

        /* ================================================================
           MEMBER CARD
        ================================================================= */

        memberCard,

        card:
          memberCard,

        /* ================================================================
           ACCESS MEMBER
        ================================================================= */

        access,

        accessPerks: {
          enabled:
            featureFlags
              .access_perks_enabled !==
            false,

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
            DEFAULT_BENEFITS_PATH,

          sync_endpoint:
            ACCESS_SYNC_ENDPOINT,

          offers_endpoint:
            ACCESS_OFFERS_ENDPOINT,

          redemption_endpoint:
            ACCESS_REDEEM_ENDPOINT,
        },

        /* ================================================================
           ACCESS OFFERS CATALOG
        ================================================================= */

        accessCatalog,

        offers:
          accessCatalog.offers,

        accessOffers:
          accessCatalog.offers,

        /*
         * Alias for frontend compatibility.
         *
         * This is the REAL Access offer list.
         */

        partnerBenefits:
          accessCatalog.offers,

        /* ================================================================
           ACCESS CATEGORIES
        ================================================================= */

        accessCategories:
          accessCatalog.categories,

        accessMerchants:
          accessCatalog.merchants,

        /* ================================================================
           REDEMPTION
        ================================================================= */

        redemption,

        claim: {
          enabled:
            redemption.ready,

          endpoint:
            ACCESS_REDEEM_ENDPOINT,

          method:
            "POST",

          instructions:
            "Send the selected Access offer ID to the redemption endpoint. Card Leo will display the code, barcode, QR code, or online redemption URL returned by Access.",
        },

        /* ================================================================
           CARD LEO INTERNAL BENEFITS
        ================================================================= */

        benefits:
          cardLeoBenefits,

        cardLeoBenefits,

        featuredBenefits,

        groups:
          cardLeoGroups,

        categories:
          cardLeoGroups.map(
            (group) => ({
              slug:
                group.category,

              name:
                group.title,

              count:
                group.count,

              unlockedCount:
                group
                  .unlockedCount,

              lockedCount:
                group
                  .lockedCount,
            })
          ),

        /* ================================================================
           MEMBER DATA
        ================================================================= */

        featureFlags,

        onboarding,

        rewardAccount,

        /* ================================================================
           FILTERS
        ================================================================= */

        filters: {
          search:
            catalogOptions.search,

          category:
            catalogOptions.category,

          online:
            catalogOptions.online ??
            null,

          local:
            catalogOptions.local ??
            null,

          featured:
            catalogOptions.featured ??
            null,

          latitude:
            catalogOptions.latitude,

          longitude:
            catalogOptions.longitude,

          radius:
            catalogOptions.radius,

          pageSize:
            catalogOptions.pageSize,

          maxPages:
            catalogOptions.maxPages,
        },

        /* ================================================================
           LINKS
        ================================================================= */

        links: {
          portal:
            DEFAULT_PORTAL_PATH,

          benefits:
            DEFAULT_BENEFITS_PATH,

          rewards:
            "/portal/rewards.html",

          referrals:
            "/portal/referrals.html",

          card:
            "/portal/card.html",

          accessSync:
            ACCESS_SYNC_ENDPOINT,

          accessOffers:
            ACCESS_OFFERS_ENDPOINT,

          redeemOffer:
            ACCESS_REDEEM_ENDPOINT,
        },

        /* ================================================================
           ACCESS INTEGRATION DEBUG
        ================================================================= */

        integration:
          catalogOptions.debug
            ? {
                accessOffers:
                  getAccessOffersIntegrationStatus(),

                config:
                  getAccessOffersConfigForDebug(),
              }
            : undefined,

        fetchedAt:
          new Date()
            .toISOString(),
      },

      accessCatalog.loaded
        ? `Benefits loaded successfully. ${accessCatalog.count} Access offers are available.`
        : "Benefits loaded successfully."
    );
  } catch (
    error
  ) {
    logRequestError(
      req,
      error,
      {
        scope:
          "portal_benefits_unexpected",
      }
    );

    return serverError(
      res,

      "Failed to load portal benefits.",

      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,
          }
        : null
    );
  }
}