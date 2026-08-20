// api/portal/referrals.js

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
  DIRECT_REFERRAL_REWARD,
  TEAM_REFERRAL_REWARD,

  normalizeText,
  normalizeEmail,
  normalizeStatus,
  titleCase,
  money,

  buildReferralCode,
  buildReferralUrl,
  buildReferralShareMessage,

  isMemberApproved,
  isMemberPaid,

  isReferralApproved,
  isReferralPending,

  getReferrerMemberId,
  getReferredMemberId,

  getReferralRewardAmount,

  summarizeReferralActivity,
  mapReferralForPortal,
  buildReferralTower,
} from "../../lib/referrals.js";

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const DEFAULT_PORTAL_PATH =
  "/portal/index.html";

const DEFAULT_PUBLIC_ORIGIN =
  "https://www.cardleorewards.com";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const VALID_STATUSES = [
  "all",
  "invited",
  "opened",
  "registered",
  "pending",
  "payment_pending",
  "pending_payment",
  "activated",
  "approved",
  "active",
  "reward_pending",
  "rewarded",
  "expired",
  "cancelled",
  "denied",
  "failed",
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

function normalizeStatusFilter(value) {
  const normalized =
    normalizeStatus(
      value || "all"
    );

  return VALID_STATUSES.includes(
    normalized
  )
    ? normalized
    : "all";
}

function normalizeChannel(value) {
  return normalizeText(
    value
  ).toLowerCase();
}

function normalizeSource(value) {
  return normalizeText(
    value
  ).toLowerCase();
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

function getUnixNow() {
  return Math.floor(
    Date.now() / 1000
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

function getClientIp(req) {
  const forwardedFor =
    req.headers?.[
      "x-forwarded-for"
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
    req.socket?.remoteAddress ||
    null
  );
}

function parseOrigin(req) {
  const forwardedProto =
    normalizeText(
      req.headers?.[
        "x-forwarded-proto"
      ]
    );

  const forwardedHost =
    normalizeText(
      req.headers?.[
        "x-forwarded-host"
      ]
    );

  const host =
    forwardedHost ||
    normalizeText(
      req.headers?.host
    );

  if (!host) {
    return DEFAULT_PUBLIC_ORIGIN;
  }

  const proto =
    forwardedProto ||
    (
      host.includes(
        "localhost"
      )
        ? "http"
        : "https"
    );

  return `${proto}://${host}`;
}

function uniqueRowsById(
  rows = []
) {
  const seen =
    new Set();

  const output = [];

  for (
    const row of rows
  ) {
    const id =
      normalizeText(
        row?.id
      );

    if (!id) {
      output.push(row);
      continue;
    }

    if (
      seen.has(id)
    ) {
      continue;
    }

    seen.add(id);

    output.push(row);
  }

  return output;
}

function sortByOccurredAtDesc(
  rows = []
) {
  return [...rows].sort(
    (a, b) => {
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

      return bTime - aTime;
    }
  );
}

/* ==========================================================================
   SUPABASE COMPATIBILITY
============================================================================ */

function isMissingOptionalTableOrColumn(
  error
) {
  const code =
    String(
      error?.code || ""
    );

  const message =
    String(
      error?.message || ""
    ).toLowerCase();

  const details =
    String(
      error?.details || ""
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

function parseCookies(req) {
  if (
    req?.cookies &&
    typeof req.cookies ===
      "object"
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

        if (!name) {
          return cookies;
        }

        try {
          cookies[name] =
            decodeURIComponent(
              value
            );
        } catch {
          cookies[name] =
            value;
        }

        return cookies;
      },
      {}
    );
}

function readSessionCookie(req) {
  const cookies =
    parseCookies(req);

  const configuredName =
    getSessionCookieName?.();

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...SESSION_COOKIE_NAMES,
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
    const raw =
      cookies[name];

    if (!raw) {
      continue;
    }

    const parsed =
      safeJsonParse(
        raw,
        null
      );

    if (
      isObject(parsed)
    ) {
      return {
        cookieName:
          name,

        raw,

        data:
          parsed,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  const candidates = [
    session.expires_at,
    session.expiresAt,
    session.session?.expires_at,
    session.session?.expiresAt,
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
  sessionMeta
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionMeta
    );

  /*
   * If your older session format does not
   * include expiration, do not immediately
   * destroy the valid session.
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
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  return normalizeText(
    session.member?.id ||
      session.profile?.id ||
      session.user?.id ||
      session.signupId ||
      session.signup_id ||
      session.memberId ||
      session.member_id ||
      session.id
  );
}

function getSessionEmail(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  return normalizeEmail(
    session.member?.email ||
      session.profile?.email ||
      session.user?.email ||
      session.email ||
      session.userEmail
  );
}

/* ==========================================================================
   MEMBER NAME
============================================================================ */

function getDisplayName(
  member = {}
) {
  const fullName =
    normalizeText(
      member.full_name ||
        member.fullName ||
        member.name
    );

  if (fullName) {
    return fullName;
  }

  const joined = [
    member.first_name ||
      member.firstName,

    member.last_name ||
      member.lastName,
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
   SIGNUP RECORD LOOKUP
============================================================================ */

async function getSignupRecord({
  signupId,
  email,
}) {
  const extendedFields = [
    "id",
    "email",

    "status",
    "payment_status",
    "membership_status",
    "approval_status",

    "first_name",
    "last_name",
    "full_name",

    "phone",
    "city",
    "state",
    "interest",
    "tier",

    "referral_code",
    "referred_by",
    "referrer_code",
    "sponsor_code",

    "email_verified",
    "email_verified_at",

    "created_at",
    "updated_at",

    "portal_login_url",
    "portal_user_id",

    "access_member_identifier",
    "access_member_status",
    "access_perks_ready",
  ].join(", ");

  const baseFields = [
    "id",
    "email",

    "status",

    "first_name",
    "last_name",
    "full_name",

    "phone",
    "city",
    "state",
    "interest",

    "created_at",
    "updated_at",

    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  let query =
    supabaseAdmin
      .from("signups")
      .select(
        extendedFields
      )
      .limit(1);

  if (signupId) {
    query =
      query.eq(
        "id",
        signupId
      );
  } else {
    query =
      query.eq(
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
          baseFields
        )
        .limit(1);

    if (signupId) {
      fallbackQuery =
        fallbackQuery.eq(
          "id",
          signupId
        );
    } else {
      fallbackQuery =
        fallbackQuery.eq(
          "email",
          email
        );
    }

    result =
      await fallbackQuery
        .maybeSingle();
  }

  return result;
}

/* ==========================================================================
   AUTHENTICATED MEMBER
============================================================================ */

async function getAuthenticatedMember(
  req,
  res
) {
  const sessionMeta =
    readSessionCookie(req);

  if (
    !sessionMeta?.data
  ) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Unauthorized. Please sign in."
        ),
    };
  }

  if (
    isSessionExpired(
      sessionMeta
    )
  ) {
    clearAuthCookies(res);

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Session expired. Please sign in again."
        ),
    };
  }

  if (
    sessionMeta.data
      .authenticated !== true
  ) {
    clearAuthCookies(res);

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Session invalid. Please sign in again."
        ),
    };
  }

  const signupId =
    getSessionMemberId(
      sessionMeta
    );

  const email =
    getSessionEmail(
      sessionMeta
    );

  if (
    !signupId &&
    !email
  ) {
    clearAuthCookies(res);

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Session missing member information."
        ),
    };
  }

  const {
    data: member,
    error,
  } =
    await getSignupRecord({
      signupId,
      email,
    });

  if (error) {
    throw error;
  }

  if (!member?.id) {
    clearAuthCookies(res);

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Account not found. Please sign in again."
        ),
    };
  }

  /*
   * The portal should represent a real
   * active membership.
   *
   * We keep isMemberApproved here because
   * existing Card Leo accounts may have
   * different combinations of active fields.
   */

  const approved =
    isMemberApproved(member);

  if (!approved) {
    const status =
      normalizeStatus(
        member.status ||
          member.membership_status
      );

    return {
      member: null,

      response:
        forbidden(
          res,
          status ===
              "pending" ||
            status ===
              "reviewing" ||
            status ===
              "payment_pending"
            ? "Your account is still pending activation."
            : "Your account is not active."
        ),
    };
  }

  return {
    member,
    response: null,
  };
}

/* ==========================================================================
   MEMBER SANITIZER
============================================================================ */

function sanitizeMember(
  member = {},
  origin
) {
  const referralCode =
    buildReferralCode(
      member
    );

  const referralUrl =
    buildReferralUrl(
      referralCode,
      {
        origin,
      }
    );

  return {
    id:
      member.id ||
      null,

    signupId:
      member.id ||
      null,

    portalUserId:
      member.portal_user_id ||
      null,

    email:
      member.email ||
      null,

    firstName:
      member.first_name ||
      "",

    lastName:
      member.last_name ||
      "",

    fullName:
      getDisplayName(member),

    name:
      getDisplayName(member),

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

    status:
      member.status ||
      "",

    paymentStatus:
      member.payment_status ||
      "",

    membershipStatus:
      member.membership_status ||
      "",

    approvalStatus:
      member.approval_status ||
      "",

    paid:
      isMemberPaid(
        member
      ),

    approved:
      isMemberApproved(
        member
      ),

    tier:
      normalizeText(
        member.tier ||
          "core"
      ).toLowerCase(),

    tierLabel:
      titleCase(
        member.tier ||
          "core"
      ),

    referralCode,

    referralLink:
      referralUrl,

    referralUrl,

    personalReferralUrl:
      referralUrl,

    referredBy:
      member.referred_by ||
      member.referrer_code ||
      member.sponsor_code ||
      null,

    portalLoginUrl:
      member.portal_login_url ||
      DEFAULT_PORTAL_PATH,

    portalAccess:
      true,

    emailVerified:
      Boolean(
        member.email_verified
      ),

    emailVerifiedAt:
      member.email_verified_at ||
      null,

    accessMemberIdentifier:
      member.access_member_identifier ||
      null,

    accessMemberStatus:
      member.access_member_status ||
      null,

    accessPerksReady:
      Boolean(
        member.access_perks_ready
      ),

    createdAt:
      safeDate(
        member.created_at
      ),

    updatedAt:
      safeDate(
        member.updated_at
      ),

    role:
      "member",
  };
}

/* ==========================================================================
   REFERRAL QUERY HELPERS
============================================================================ */

/*
 * Your referrals table may have used one of
 * several column names during development.
 *
 * We safely try each known variation.
 */

async function runReferralQuery({
  column,
  values,
  value,
  limit = MAX_LIMIT,
}) {
  let query =
    supabaseAdmin
      .from("referrals")
      .select("*")
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(limit);

  if (
    Array.isArray(values)
  ) {
    if (
      !values.length
    ) {
      return [];
    }

    query =
      query.in(
        column,
        values
      );
  } else {
    query =
      query.eq(
        column,
        value
      );
  }

  const {
    data,
    error,
  } =
    await query;

  if (!error) {
    return data || [];
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

/* ==========================================================================
   DIRECT REFERRAL ROWS
============================================================================ */

async function queryDirectReferralRows({
  memberId,
  referralCode,
}) {
  const rows = [];

  const referrerColumns = [
    "referrer_signup_id",
    "referrer_member_id",
    "referrer_profile_id",
    "referrer_id",
  ];

  for (
    const column of referrerColumns
  ) {
    const result =
      await runReferralQuery({
        column,
        value:
          memberId,
      });

    if (
      Array.isArray(result)
    ) {
      rows.push(
        ...result
      );
    }
  }

  /*
   * Only use referral_code as a fallback.
   *
   * This prevents a referral-code query from
   * accidentally mixing deeper network rows
   * into the direct-referral collection.
   */

  if (
    !rows.length &&
    referralCode
  ) {
    const result =
      await runReferralQuery({
        column:
          "referral_code",

        value:
          referralCode,
      });

    if (
      Array.isArray(result)
    ) {
      rows.push(
        ...result
      );
    }
  }

  return uniqueRowsById(
    rows
  );
}

/* ==========================================================================
   TEAM REFERRAL ROWS

   TEAM LOGIC:
   Current member -> Direct member -> Team member

   Example:
   Moe -> Marethia -> Monica

   Moe:
     Marethia = direct
     Monica   = team

   Marethia:
     Monica = direct

============================================================================ */

async function queryTeamReferralRows(
  directMemberIds = []
) {
  const ids =
    Array.from(
      new Set(
        directMemberIds
          .map(
            normalizeText
          )
          .filter(Boolean)
      )
    );

  if (!ids.length) {
    return [];
  }

  const rows = [];

  const referrerColumns = [
    "referrer_signup_id",
    "referrer_member_id",
    "referrer_profile_id",
    "referrer_id",
  ];

  for (
    const column
      of referrerColumns
  ) {
    const result =
      await runReferralQuery({
        column,
        values:
          ids,
      });

    if (
      Array.isArray(result)
    ) {
      rows.push(
        ...result
      );
    }
  }

  return uniqueRowsById(
    rows
  );
}

/* ==========================================================================
   REFERRED MEMBER IDS
============================================================================ */

function getReferredIds(
  rows = []
) {
  return Array.from(
    new Set(
      rows
        .map(
          (row) =>
            getReferredMemberId(
              row
            )
        )
        .map(
          normalizeText
        )
        .filter(Boolean)
    )
  );
}

/* ==========================================================================
   LOAD REFERRED SIGNUP RECORDS
============================================================================ */

async function getSignupRecordsByIds(
  ids = []
) {
  const cleanIds =
    Array.from(
      new Set(
        ids
          .map(
            normalizeText
          )
          .filter(Boolean)
      )
    );

  if (
    !cleanIds.length
  ) {
    return new Map();
  }

  const extendedFields = [
    "id",
    "email",
    "first_name",
    "last_name",
    "full_name",

    "status",
    "payment_status",
    "membership_status",
    "approval_status",

    "referral_code",
    "referred_by",
    "referrer_code",
    "sponsor_code",

    "created_at",
    "updated_at",
  ].join(", ");

  const baseFields = [
    "id",
    "email",
    "first_name",
    "last_name",
    "full_name",
    "status",
    "created_at",
    "updated_at",
  ].join(", ");

  let result =
    await supabaseAdmin
      .from("signups")
      .select(
        extendedFields
      )
      .in(
        "id",
        cleanIds
      );

  if (
    result.error &&
    isMissingOptionalTableOrColumn(
      result.error
    )
  ) {
    result =
      await supabaseAdmin
        .from("signups")
        .select(
          baseFields
        )
        .in(
          "id",
          cleanIds
        );
  }

  if (result.error) {
    throw result.error;
  }

  const map =
    new Map();

  for (
    const signup
      of result.data || []
  ) {
    map.set(
      normalizeText(
        signup.id
      ),
      signup
    );
  }

  return map;
}

/* ==========================================================================
   EFFECTIVE REFERRAL STATUS

   IMPORTANT:
   Referral rewards should follow the actual
   referred member's membership/payment status.

   A row saying "registered" should not stay pending
   forever if Stripe already made that signup paid
   and approved.

============================================================================ */

function getEffectiveReferralStatus(
  row = {},
  referredMember = null
) {
  const originalStatus =
    normalizeStatus(
      row.status ||
        row.referral_status ||
        "invited"
    );

  /*
   * Preserve a completed reward state.
   */

  if (
    originalStatus ===
    "rewarded"
  ) {
    return "rewarded";
  }

  if (
    originalStatus ===
    "reward_pending"
  ) {
    return "reward_pending";
  }

  /*
   * Cancelled/expired referral rows remain terminal
   * unless another workflow explicitly reactivates them.
   */

  if (
    [
      "cancelled",
      "expired",
      "denied",
      "failed",
    ].includes(
      originalStatus
    )
  ) {
    return originalStatus;
  }

  if (
    referredMember
  ) {
    const memberApproved =
      isMemberApproved(
        referredMember
      );

    const memberPaid =
      isMemberPaid(
        referredMember
      );

    /*
     * Rewards require an actual paid +
     * approved Card Leo member.
     */

    if (
      memberApproved &&
      memberPaid
    ) {
      return "approved";
    }

    /*
     * Account exists but has not completed
     * qualifying membership activation.
     */

    return (
      originalStatus ===
        "opened"
        ? "opened"
        : "registered"
    );
  }

  return originalStatus;
}

/* ==========================================================================
   REFERRAL DATE
============================================================================ */

function getReferralOccurredAt(
  row = {}
) {
  return (
    row.rewarded_at ||
    row.activated_at ||
    row.registered_at ||
    row.opened_at ||
    row.invited_at ||
    row.created_at ||
    null
  );
}

/* ==========================================================================
   STATUS LABEL
============================================================================ */

function getStatusLabel(
  status
) {
  const normalized =
    normalizeStatus(status);

  const map = {
    invited:
      "Invited",

    opened:
      "Opened",

    registered:
      "Registered",

    pending:
      "Pending",

    payment_pending:
      "Payment Pending",

    pending_payment:
      "Payment Pending",

    activated:
      "Activated",

    approved:
      "Approved",

    active:
      "Active",

    reward_pending:
      "Reward Pending",

    rewarded:
      "Rewarded",

    expired:
      "Expired",

    cancelled:
      "Cancelled",

    denied:
      "Denied",

    failed:
      "Failed",
  };

  return (
    map[normalized] ||
    titleCase(
      status ||
        "Unknown"
    )
  );
}

function getStatusTone(
  status
) {
  const normalized =
    normalizeStatus(status);

  const map = {
    invited:
      "neutral",

    opened:
      "info",

    registered:
      "info",

    pending:
      "warning",

    payment_pending:
      "warning",

    pending_payment:
      "warning",

    activated:
      "success",

    approved:
      "success",

    active:
      "success",

    reward_pending:
      "warning",

    rewarded:
      "success",

    expired:
      "muted",

    cancelled:
      "danger",

    denied:
      "danger",

    failed:
      "danger",
  };

  return (
    map[normalized] ||
    "neutral"
  );
}

function getReferralProgress(
  status
) {
  const normalized =
    normalizeStatus(status);

  const map = {
    invited:
      15,

    opened:
      30,

    registered:
      55,

    pending:
      55,

    payment_pending:
      60,

    pending_payment:
      60,

    activated:
      80,

    approved:
      90,

    active:
      90,

    reward_pending:
      95,

    rewarded:
      100,

    expired:
      0,

    cancelled:
      0,

    denied:
      0,

    failed:
      0,
  };

  return (
    map[normalized] ??
    0
  );
}

/* ==========================================================================
   MAP REFERRAL ROW

   level:
     direct
     team

============================================================================ */

function mapReferralRow({
  row,
  currentMember,
  referredMember,
  level,
}) {
  const currentMemberId =
    normalizeText(
      currentMember?.id
    );

  const effectiveStatus =
    getEffectiveReferralStatus(
      row,
      referredMember
    );

  /*
   * We explicitly assign direct/team level
   * from the network query rather than guessing.
   */

  const relationship =
    level === "team"
      ? "team"
      : "direct";

  const temporaryReferral = {
    ...row,

    status:
      effectiveStatus,

    referral_status:
      effectiveStatus,
  };

  /*
   * mapReferralForPortal from lib/referrals.js
   * is still used as the shared data formatter.
   */

  const sharedMapped =
    mapReferralForPortal(
      temporaryReferral,
      relationship === "direct"
        ? currentMember
        : {}
    );

  const approved =
    isReferralApproved(
      temporaryReferral
    );

  const pending =
    isReferralPending(
      temporaryReferral
    );

  let calculatedReward =
    0;

  if (approved) {
    calculatedReward =
      relationship === "direct"
        ? DIRECT_REFERRAL_REWARD
        : TEAM_REFERRAL_REWARD;
  }

  /*
   * Prefer an actual reward_amount if the
   * database already recorded the payout.
   */

  const storedReward =
    money(
      row.reward_amount ||
        0
    );

  const displayReward =
    storedReward > 0
      ? storedReward
      : calculatedReward;

  const referredName =
    getDisplayName(
      referredMember || {
        first_name:
          row.referred_first_name,

        last_name:
          row.referred_last_name,

        full_name:
          row.referred_name,
      }
    );

  return {
    ...sharedMapped,

    id:
      row.id ||
      null,

    referralId:
      row.id ||
      null,

    referralCode:
      row.referral_code ||
      buildReferralCode(
        currentMember
      ),

    inviteCode:
      row.invite_code ||
      null,

    referrerSignupId:
      getReferrerMemberId(
        row
      ) ||
      null,

    referredSignupId:
      getReferredMemberId(
        row
      ) ||
      null,

    referredEmail:
      referredMember?.email ||
      row.referred_email ||
      null,

    referredFirstName:
      referredMember?.first_name ||
      row.referred_first_name ||
      null,

    referredLastName:
      referredMember?.last_name ||
      row.referred_last_name ||
      null,

    referredName:
      referredName !==
      "Card Leo Member"
        ? referredName
        : row.referred_email ||
          "Referral",

    relationship,

    relationshipLevel:
      relationship === "direct"
        ? 1
        : 2,

    relationshipLabel:
      relationship === "direct"
        ? "Direct Referral"
        : "Team Referral",

    direct:
      relationship === "direct",

    team:
      relationship === "team",

    approved,

    pending,

    referredMemberExists:
      Boolean(
        referredMember?.id
      ),

    referredMemberPaid:
      referredMember
        ? isMemberPaid(
            referredMember
          )
        : false,

    referredMemberApproved:
      referredMember
        ? isMemberApproved(
            referredMember
          )
        : false,

    rewardTransactionId:
      row.reward_transaction_id ||
      null,

    rewardAmount:
      storedReward,

    expectedRewardAmount:
      money(
        calculatedReward
      ),

    displayRewardAmount:
      money(
        displayReward
      ),

    status:
      effectiveStatus,

    statusLabel:
      getStatusLabel(
        effectiveStatus
      ),

    statusTone:
      getStatusTone(
        effectiveStatus
      ),

    progressPercent:
      getReferralProgress(
        effectiveStatus
      ),

    source:
      row.source ||
      null,

    sourceLabel:
      titleCase(
        row.source ||
        ""
      ),

    channel:
      row.channel ||
      null,

    channelLabel:
      titleCase(
        row.channel ||
        ""
      ),

    notes:
      row.notes ||
      null,

    metadata:
      isObject(
        row.metadata
      )
        ? row.metadata
        : {},

    invitedAt:
      safeDate(
        row.invited_at
      ),

    openedAt:
      safeDate(
        row.opened_at
      ),

    registeredAt:
      safeDate(
        row.registered_at
      ),

    activatedAt:
      safeDate(
        row.activated_at
      ),

    rewardedAt:
      safeDate(
        row.rewarded_at
      ),

    expiredAt:
      safeDate(
        row.expired_at
      ),

    cancelledAt:
      safeDate(
        row.cancelled_at
      ),

    occurredAt:
      safeDate(
        getReferralOccurredAt(
          row
        )
      ),

    createdAt:
      safeDate(
        row.created_at
      ),

    updatedAt:
      safeDate(
        row.updated_at
      ),

    currentMemberId,
  };
}

/* ==========================================================================
   EVENT MAPPING
============================================================================ */

function mapEventRow(
  row = {}
) {
  return {
    id:
      row.id ||
      null,

    referralId:
      row.referral_id ||
      null,

    eventType:
      row.event_type ||
      null,

    eventLabel:
      titleCase(
        row.event_type ||
        ""
      ),

    title:
      row.title ||
      titleCase(
        row.event_type ||
          "event"
      ),

    description:
      row.description ||
      null,

    metadata:
      isObject(
        row.metadata
      )
        ? row.metadata
        : {},

    occurredAt:
      safeDate(
        row.occurred_at ||
          row.created_at
      ),

    createdAt:
      safeDate(
        row.created_at
      ),
  };
}

/* ==========================================================================
   REFERRAL EVENTS
============================================================================ */

async function queryReferralEvents(
  referralIds = []
) {
  const ids =
    referralIds
      .map(
        normalizeText
      )
      .filter(Boolean);

  if (!ids.length) {
    return {};
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "referral_events"
      )
      .select("*")
      .in(
        "referral_id",
        ids
      )
      .order(
        "occurred_at",
        {
          ascending: false,
        }
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {};
    }

    throw error;
  }

  return (
    data || []
  ).reduce(
    (
      accumulator,
      row
    ) => {
      const key =
        normalizeText(
          row.referral_id
        );

      if (!key) {
        return accumulator;
      }

      if (
        !accumulator[key]
      ) {
        accumulator[key] =
          [];
      }

      accumulator[key].push(
        mapEventRow(row)
      );

      return accumulator;
    },
    {}
  );
}

/* ==========================================================================
   FILTER REFERRALS
============================================================================ */

function filterReferrals({
  referrals,
  status,
  channel,
  source,
  search,
}) {
  const normalizedSearch =
    normalizeText(
      search
    ).toLowerCase();

  return referrals.filter(
    (item) => {
      if (
        status !== "all" &&
        item.status !== status
      ) {
        return false;
      }

      if (
        channel &&
        normalizeChannel(
          item.channel
        ) !== channel
      ) {
        return false;
      }

      if (
        source &&
        normalizeSource(
          item.source
        ) !== source
      ) {
        return false;
      }

      if (
        normalizedSearch
      ) {
        const haystack = [
          item.referredEmail,
          item.referredFirstName,
          item.referredLastName,
          item.referredName,
          item.inviteCode,
          item.referralCode,
          item.statusLabel,
          item.relationshipLabel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (
          !haystack.includes(
            normalizedSearch
          )
        ) {
          return false;
        }
      }

      return true;
    }
  );
}

/* ==========================================================================
   PORTAL SUMMARY
============================================================================ */

function buildPortalSummary(
  referrals = [],
  member = {}
) {
  /*
   * Use centralized referral helper first.
   */

  const sharedSummary =
    summarizeReferralActivity(
      referrals,
      member
    );

  /*
   * Our rows are already explicitly mapped
   * with direct/team relationships, so calculate
   * the definitive dashboard values from those.
   */

  const direct =
    referrals.filter(
      (item) =>
        item.relationship ===
        "direct"
    );

  const team =
    referrals.filter(
      (item) =>
        item.relationship ===
        "team"
    );

  const approvedDirect =
    direct.filter(
      (item) =>
        item.approved
    );

  const pendingDirect =
    direct.filter(
      (item) =>
        item.pending
    );

  const approvedTeam =
    team.filter(
      (item) =>
        item.approved
    );

  const pendingTeam =
    team.filter(
      (item) =>
        item.pending
    );

  const rewardedDirect =
    direct.filter(
      (item) =>
        item.status ===
        "rewarded"
    );

  const rewardedTeam =
    team.filter(
      (item) =>
        item.status ===
        "rewarded"
    );

  const storedDirectRewards =
    money(
      direct.reduce(
        (
          total,
          item
        ) =>
          total +
          money(
            item.rewardAmount
          ),
        0
      )
    );

  const storedTeamRewards =
    money(
      team.reduce(
        (
          total,
          item
        ) =>
          total +
          money(
            item.rewardAmount
          ),
        0
      )
    );

  const expectedDirectRewards =
    money(
      approvedDirect.length *
        DIRECT_REFERRAL_REWARD
    );

  const expectedTeamRewards =
    money(
      approvedTeam.length *
        TEAM_REFERRAL_REWARD
    );

  const displayDirectRewards =
    storedDirectRewards > 0
      ? storedDirectRewards
      : expectedDirectRewards;

  const displayTeamRewards =
    storedTeamRewards > 0
      ? storedTeamRewards
      : expectedTeamRewards;

  const latest =
    sortByOccurredAtDesc(
      referrals
    )[0];

  const convertedDirectCount =
    direct.filter(
      (item) =>
        [
          "registered",
          "activated",
          "approved",
          "active",
          "reward_pending",
          "rewarded",
        ].includes(
          item.status
        )
    ).length;

  const conversionRate =
    direct.length > 0
      ? Math.round(
          (
            convertedDirectCount /
            direct.length
          ) *
            100
        )
      : 0;

  const approvalRate =
    direct.length > 0
      ? Math.round(
          (
            approvedDirect.length /
            direct.length
          ) *
            100
        )
      : 0;

  const rewardRate =
    direct.length > 0
      ? Math.round(
          (
            rewardedDirect.length /
            direct.length
          ) *
            100
        )
      : 0;

  return {
    totalReferrals:
      direct.length +
      team.length,

    approvedReferrals:
      approvedDirect.length +
      approvedTeam.length,

    pendingReferrals:
      pendingDirect.length +
      pendingTeam.length,

    directReferrals:
      direct.length,

    approvedDirectReferrals:
      approvedDirect.length,

    pendingDirectReferrals:
      pendingDirect.length,

    rewardedDirectReferrals:
      rewardedDirect.length,

    teamReferrals:
      team.length,

    approvedTeamReferrals:
      approvedTeam.length,

    pendingTeamReferrals:
      pendingTeam.length,

    rewardedTeamReferrals:
      rewardedTeam.length,

    directEarnings:
      money(
        displayDirectRewards
      ),

    teamEarnings:
      money(
        displayTeamRewards
      ),

    totalRewardAmount:
      money(
        storedDirectRewards +
        storedTeamRewards
      ),

    expectedRewardAmount:
      money(
        expectedDirectRewards +
        expectedTeamRewards
      ),

    totalReferralEarnings:
      money(
        displayDirectRewards +
        displayTeamRewards
      ),

    conversionRatePercent:
      conversionRate,

    approvalRatePercent:
      approvalRate,

    rewardRatePercent:
      rewardRate,

    latestAt:
      latest?.occurredAt ||
      latest?.createdAt ||
      null,

    shared:
      sharedSummary,
  };
}

/* ==========================================================================
   PORTAL TOWER

   We keep the shared helper available, but construct
   exact portal-level direct/team values because we already
   know the network level of every returned row.

============================================================================ */

function buildPortalTower(
  referrals = [],
  member = {}
) {
  const sharedTower =
    buildReferralTower(
      referrals,
      member
    );

  const direct =
    referrals.filter(
      (item) =>
        item.relationship ===
        "direct"
    );

  const team =
    referrals.filter(
      (item) =>
        item.relationship ===
        "team"
    );

  const approvedDirect =
    direct.filter(
      (item) =>
        item.approved
    );

  const pendingDirect =
    direct.filter(
      (item) =>
        item.pending
    );

  const approvedTeam =
    team.filter(
      (item) =>
        item.approved
    );

  const pendingTeam =
    team.filter(
      (item) =>
        item.pending
    );

  return {
    direct: {
      count:
        direct.length,

      total:
        direct.length,

      approvedCount:
        approvedDirect.length,

      approved:
        approvedDirect.length,

      pendingCount:
        pendingDirect.length,

      pending:
        pendingDirect.length,

      rewardPerApprovedMember:
        DIRECT_REFERRAL_REWARD,

      projectedReward:
        money(
          approvedDirect.length *
            DIRECT_REFERRAL_REWARD
        ),

      members:
        direct,
    },

    team: {
      count:
        team.length,

      total:
        team.length,

      approvedCount:
        approvedTeam.length,

      approved:
        approvedTeam.length,

      pendingCount:
        pendingTeam.length,

      pending:
        pendingTeam.length,

      rewardPerApprovedMember:
        TEAM_REFERRAL_REWARD,

      projectedReward:
        money(
          approvedTeam.length *
            TEAM_REFERRAL_REWARD
        ),

      members:
        team,
    },

    totalMembers:
      direct.length +
      team.length,

    totalApproved:
      approvedDirect.length +
      approvedTeam.length,

    totalPending:
      pendingDirect.length +
      pendingTeam.length,

    projectedReferralRewards:
      money(
        (
          approvedDirect.length *
          DIRECT_REFERRAL_REWARD
        ) +
        (
          approvedTeam.length *
          TEAM_REFERRAL_REWARD
        )
      ),

    shared:
      sharedTower,
  };
}

/* ==========================================================================
   SHARE URL HELPERS
============================================================================ */

function buildSmsShareUrl(
  message
) {
  if (!message) {
    return "";
  }

  return (
    `sms:?body=${encodeURIComponent(
      message
    )}`
  );
}

function buildEmailShareUrl(
  message
) {
  if (!message) {
    return "";
  }

  const subject =
    "Join Card Leo Rewards";

  return (
    `mailto:?subject=${encodeURIComponent(
      subject
    )}` +
    `&body=${encodeURIComponent(
      message
    )}`
  );
}

function buildShareControls({
  member,
  referralCode,
  referralUrl,
}) {
  const message =
    buildReferralShareMessage(
      member,
      {
        referralUrl,

        inviterName:
          getDisplayName(
            member
          ),
      }
    );

  return {
    referralCode,

    shareLink:
      referralUrl,

    referralUrl,

    message,

    copy: {
      enabled:
        Boolean(
          referralUrl
        ),

      label:
        "Copy Referral Link",

      value:
        referralUrl,
    },

    copyMessage: {
      enabled:
        Boolean(
          message
        ),

      label:
        "Copy Message",

      value:
        message,
    },

    text: {
      enabled:
        Boolean(
          referralUrl
        ),

      label:
        "Text Link",

      url:
        buildSmsShareUrl(
          message
        ),
    },

    email: {
      enabled:
        Boolean(
          referralUrl
        ),

      label:
        "Email Link",

      url:
        buildEmailShareUrl(
          message
        ),
    },

    nativeShare: {
      enabled:
        Boolean(
          referralUrl
        ),

      label:
        "Share Link",

      title:
        "Card Leo Rewards",

      text:
        message,

      url:
        referralUrl,
    },

    instructions: {
      title:
        "How To Refer A New Member",

      steps: [
        "Copy or share your personal Card Leo referral link.",

        "Send the exact referral link to your recruit.",

        "Your recruit opens your link and completes signup.",

        "Your recruit completes secure membership activation.",

        "The recruit will stay pending until qualifying membership activation is completed.",

        "Once the recruit becomes a paid and approved member, the referral can become approved.",

        "Direct approved referrals currently earn $7.",

        "Qualifying second-level team referrals currently use the $1 team-reward rule.",
      ],
    },
  };
}

/* ==========================================================================
   EMPTY STATE
============================================================================ */

function buildEmptyReferralGuidance({
  member,
  referralUrl,
}) {
  return {
    referralCode:
      buildReferralCode(
        member
      ),

    shareLink:
      referralUrl,

    headline:
      "Start building your Card Leo referral team.",

    message:
      "Your direct and team activity will appear here as new members join through the Card Leo Rewards referral system.",

    steps: [
      "Copy your personal referral link.",

      "Send it by text, email, social media, or direct message.",

      "Tell your recruit to open the exact link you sent.",

      "Your recruit creates an account and completes membership activation.",

      "Track the recruit under Pending Referrals.",

      "Once the member becomes paid and approved, the referral moves into approved activity.",

      "If that direct member later refers another approved member, that second level can appear as team activity.",
    ],
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
        "portal_referrals",
    }
  );

  if (
    req.method !== "GET"
  ) {
    return methodNotAllowed(
      res,
      ["GET"],
      "Method not allowed. Use GET."
    );
  }

  try {
    /* ----------------------------------------------------------------------
       AUTHENTICATE
    ---------------------------------------------------------------------- */

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

    const origin =
      parseOrigin(req);

    const safeMember =
      sanitizeMember(
        member,
        origin
      );

    const memberId =
      normalizeText(
        member.id
      );

    const referralCode =
      buildReferralCode(
        member
      );

    const referralUrl =
      buildReferralUrl(
        referralCode,
        {
          origin,
        }
      );

    /* ----------------------------------------------------------------------
       FILTERS
    ---------------------------------------------------------------------- */

    const limit =
      toPositiveInteger(
        req.query?.limit,
        DEFAULT_LIMIT
      );

    const status =
      normalizeStatusFilter(
        req.query?.status
      );

    const channel =
      normalizeChannel(
        req.query?.channel
      );

    const source =
      normalizeSource(
        req.query?.source
      );

    const search =
      normalizeText(
        req.query?.search
      );

    /* ----------------------------------------------------------------------
       LOAD DIRECT REFERRALS
    ---------------------------------------------------------------------- */

    const directRows =
      await queryDirectReferralRows({
        memberId,
        referralCode,
      });

    /*
     * These are the member IDs that this
     * logged-in member personally referred.
     */

    const directReferredIds =
      getReferredIds(
        directRows
      );

    /* ----------------------------------------------------------------------
       LOAD TEAM REFERRALS

       Only one level below direct referrals.

       Example:
       Moe -> Marethia -> Monica

       Moe sees:
         Marethia direct
         Monica team

    ---------------------------------------------------------------------- */

    const rawTeamRows =
      await queryTeamReferralRows(
        directReferredIds
      );

    /*
     * Prevent accidental duplication if a row
     * was already counted as direct.
     */

    const directRowIds =
      new Set(
        directRows
          .map(
            (row) =>
              normalizeText(
                row.id
              )
          )
          .filter(Boolean)
      );

    const teamRows =
      rawTeamRows.filter(
        (row) =>
          !directRowIds.has(
            normalizeText(
              row.id
            )
          )
      );

    /* ----------------------------------------------------------------------
       LOAD MEMBER RECORDS FOR ALL REFERRED MEMBERS

       This makes the referral API use real
       signup/payment/member statuses rather than
       guessing from the referral row alone.
    ---------------------------------------------------------------------- */

    const allReferredIds =
      Array.from(
        new Set([
          ...getReferredIds(
            directRows
          ),

          ...getReferredIds(
            teamRows
          ),
        ])
      );

    const referredMembersById =
      await getSignupRecordsByIds(
        allReferredIds
      );

    /* ----------------------------------------------------------------------
       MAP DIRECT ROWS
    ---------------------------------------------------------------------- */

    const directReferrals =
      directRows.map(
        (row) => {
          const referredId =
            getReferredMemberId(
              row
            );

          const referredMember =
            referredMembersById.get(
              normalizeText(
                referredId
              )
            ) ||
            null;

          return mapReferralRow({
            row,
            currentMember:
              member,

            referredMember,

            level:
              "direct",
          });
        }
      );

    /* ----------------------------------------------------------------------
       MAP TEAM ROWS
    ---------------------------------------------------------------------- */

    const teamReferrals =
      teamRows.map(
        (row) => {
          const referredId =
            getReferredMemberId(
              row
            );

          const referredMember =
            referredMembersById.get(
              normalizeText(
                referredId
              )
            ) ||
            null;

          return mapReferralRow({
            row,
            currentMember:
              member,

            referredMember,

            level:
              "team",
          });
        }
      );

    /* ----------------------------------------------------------------------
       FULL NETWORK
    ---------------------------------------------------------------------- */

    const referrals =
      sortByOccurredAtDesc(
        uniqueRowsById([
          ...directReferrals,
          ...teamReferrals,
        ])
      );

    /* ----------------------------------------------------------------------
       SUMMARY
    ---------------------------------------------------------------------- */

    const summary =
      buildPortalSummary(
        referrals,
        member
      );

    /* ----------------------------------------------------------------------
       TOWER
    ---------------------------------------------------------------------- */

    const tower =
      buildPortalTower(
        referrals,
        member
      );

    /* ----------------------------------------------------------------------
       FILTER RESULTS
    ---------------------------------------------------------------------- */

    const filteredReferrals =
      sortByOccurredAtDesc(
        filterReferrals({
          referrals,
          status,
          channel,
          source,
          search,
        })
      );

    const pagedReferrals =
      filteredReferrals.slice(
        0,
        limit
      );

    /* ----------------------------------------------------------------------
       EVENTS / TIMELINES
    ---------------------------------------------------------------------- */

    const visibleReferralIds =
      pagedReferrals
        .map(
          (item) =>
            item.id
        )
        .filter(Boolean);

    const eventsByReferralId =
      await queryReferralEvents(
        visibleReferralIds
      );

    const enrichedReferrals =
      pagedReferrals.map(
        (referral) => ({
          ...referral,

          referralUrl,

          shareLink:
            referralUrl,

          timeline:
            eventsByReferralId[
              referral.id
            ] ||
            [],
        })
      );

    /* ----------------------------------------------------------------------
       GROUPS
    ---------------------------------------------------------------------- */

    const visibleDirect =
      enrichedReferrals.filter(
        (item) =>
          item.relationship ===
          "direct"
      );

    const visibleTeam =
      enrichedReferrals.filter(
        (item) =>
          item.relationship ===
          "team"
      );

    const visibleApproved =
      enrichedReferrals.filter(
        (item) =>
          item.approved
      );

    const visiblePending =
      enrichedReferrals.filter(
        (item) =>
          item.pending
      );

    /* ----------------------------------------------------------------------
       AVAILABLE CHANNEL / SOURCE FILTERS
    ---------------------------------------------------------------------- */

    const allChannels =
      Array.from(
        new Set(
          referrals
            .map(
              (item) =>
                normalizeChannel(
                  item.channel
                )
            )
            .filter(Boolean)
        )
      ).sort();

    const allSources =
      Array.from(
        new Set(
          referrals
            .map(
              (item) =>
                normalizeSource(
                  item.source
                )
            )
            .filter(Boolean)
        )
      ).sort();

    /* ----------------------------------------------------------------------
       SHARE CONTROLS
    ---------------------------------------------------------------------- */

    const shareControls =
      buildShareControls({
        member,

        referralCode,

        referralUrl,
      });

    /* ----------------------------------------------------------------------
       LOG
    ---------------------------------------------------------------------- */

    logRequestSuccess(
      req,
      {
        scope:
          "portal_referrals",

        memberId,

        email:
          safeMember.email,

        referralCode,

        directReferrals:
          summary.directReferrals,

        approvedDirectReferrals:
          summary.approvedDirectReferrals,

        teamReferrals:
          summary.teamReferrals,

        approvedTeamReferrals:
          summary.approvedTeamReferrals,

        pendingReferrals:
          summary.pendingReferrals,

        totalReferrals:
          summary.totalReferrals,

        returnedReferrals:
          enrichedReferrals.length,

        statusFilter:
          status,

        ip:
          getClientIp(req),
      }
    );

    /* ----------------------------------------------------------------------
       RESPONSE
    ---------------------------------------------------------------------- */

    return ok(
      res,
      {
        /* ================================================================
           MEMBER
        ================================================================= */

        member: {
          ...safeMember,

          referralCode,

          referralLink:
            referralUrl,

          referralUrl,

          personalReferralUrl:
            referralUrl,
        },

        /* ================================================================
           DASHBOARD SUMMARY
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

          memberStatus:
            safeMember.status,

          paymentStatus:
            safeMember.paymentStatus,

          membershipStatus:
            safeMember.membershipStatus,

          approvalStatus:
            safeMember.approvalStatus,

          tier:
            safeMember.tier,

          tierLabel:
            safeMember.tierLabel,

          referralCode,

          referralLink:
            referralUrl,

          referralUrl,

          personalReferralUrl:
            referralUrl,

          totalReferrals:
            summary.totalReferrals,

          pendingReferrals:
            summary.pendingReferrals,

          approvedReferrals:
            summary.approvedReferrals,

          directReferrals:
            summary.directReferrals,

          approvedDirectReferrals:
            summary.approvedDirectReferrals,

          pendingDirectReferrals:
            summary.pendingDirectReferrals,

          rewardedDirectReferrals:
            summary.rewardedDirectReferrals,

          teamReferrals:
            summary.teamReferrals,

          approvedTeamReferrals:
            summary.approvedTeamReferrals,

          pendingTeamReferrals:
            summary.pendingTeamReferrals,

          rewardedTeamReferrals:
            summary.rewardedTeamReferrals,

          directEarnings:
            summary.directEarnings,

          teamEarnings:
            summary.teamEarnings,

          totalRewardAmount:
            summary.totalRewardAmount,

          expectedRewardAmount:
            summary.expectedRewardAmount,

          totalReferralEarnings:
            summary.totalReferralEarnings,

          conversionRatePercent:
            summary.conversionRatePercent,

          approvalRatePercent:
            summary.approvalRatePercent,

          rewardRatePercent:
            summary.rewardRatePercent,

          latestAt:
            summary.latestAt,

          /*
           * Backward-compatible aliases used by
           * different portal versions.
           */

          total_referrals:
            summary.totalReferrals,

          pending_referrals:
            summary.pendingReferrals,

          approved_referrals:
            summary.approvedReferrals,

          direct_referrals:
            summary.directReferrals,

          approved_direct_referrals:
            summary.approvedDirectReferrals,

          pending_direct_referrals:
            summary.pendingDirectReferrals,

          team_referrals:
            summary.teamReferrals,

          approved_team_referrals:
            summary.approvedTeamReferrals,

          pending_team_referrals:
            summary.pendingTeamReferrals,

          direct_earnings:
            summary.directEarnings,

          team_earnings:
            summary.teamEarnings,

          total_earned:
            summary.totalReferralEarnings,

          totals:
            summary,
        },

        /* ================================================================
           PERSONAL REFERRAL
        ================================================================= */

        referral: {
          code:
            referralCode,

          referralCode,

          referral_code:
            referralCode,

          shareLink:
            referralUrl,

          referralLink:
            referralUrl,

          referralUrl,

          personalReferralUrl:
            referralUrl,

          signupUrl:
            referralUrl,

          shareMessage:
            shareControls.message,

          directRewardAmount:
            DIRECT_REFERRAL_REWARD,

          teamRewardAmount:
            TEAM_REFERRAL_REWARD,

          controls:
            shareControls,

          emptyState:
            buildEmptyReferralGuidance({
              member,

              referralUrl,
            }),
        },

        /* ================================================================
           SHARE
        ================================================================= */

        share:
          shareControls,

        /* ================================================================
           TOWER
        ================================================================= */

        tower,

        /* ================================================================
           GROUPS
        ================================================================= */

        groups: {
          direct:
            visibleDirect,

          team:
            visibleTeam,

          approved:
            visibleApproved,

          pending:
            visiblePending,
        },

        /* ================================================================
           FULL NETWORK COUNTS
        ================================================================= */

        network: {
          direct: {
            total:
              summary.directReferrals,

            approved:
              summary.approvedDirectReferrals,

            pending:
              summary.pendingDirectReferrals,
          },

          team: {
            total:
              summary.teamReferrals,

            approved:
              summary.approvedTeamReferrals,

            pending:
              summary.pendingTeamReferrals,
          },

          total:
            summary.totalReferrals,

          approved:
            summary.approvedReferrals,

          pending:
            summary.pendingReferrals,
        },

        /* ================================================================
           FILTERS
        ================================================================= */

        filters: {
          statuses:
            VALID_STATUSES,

          activeStatus:
            status,

          channels:
            allChannels,

          activeChannel:
            channel ||
            "",

          sources:
            allSources,

          activeSource:
            source ||
            "",

          search,

          limit,

          totalMatching:
            filteredReferrals.length,

          returned:
            enrichedReferrals.length,

          hasMore:
            filteredReferrals.length >
            enrichedReferrals.length,
        },

        /* ================================================================
           REFERRALS
        ================================================================= */

        referrals:
          enrichedReferrals,
      },

      "Referrals loaded successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "portal_referrals_unexpected",
      }
    );

    return serverError(
      res,
      "Failed to load portal referrals.",

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

            hint:
              error?.hint ||
              null,
          }
        : null
    );
  }
}