// api/admin/overview.js

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
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   ADMIN PORTAL
   STEP #2
   ADMIN OVERVIEW API

   ROUTE
   -----
   GET /api/admin/overview

   PURPOSE
   -------
   Provides the main Card Leo administration dashboard with a unified
   operational snapshot.

   RETURNS
   -------
   - Total member count
   - Active paid members
   - Pending payment members
   - Estimated recurring monthly membership revenue
   - New signup count
   - Growth Pool balance
   - Growth Pool member contribution count
   - Rewards / allowance totals
   - Card issuance totals
   - Access Perks sync readiness
   - Referral statistics
   - Support statistics
   - Recent signups
   - Recent activity
   - Platform health

   SECURITY
   --------
   This endpoint FAILS CLOSED.

   A user must:
   1. Have an active Card Leo session
   2. Resolve to a Card Leo account
   3. Be explicitly recognized as an admin

   Admin recognition supports:
   - ADMIN_EMAILS
   - SUPER_ADMIN_EMAILS
   - CARDLEO_ADMIN_EMAILS
   - database role/admin fields when present

   IMPORTANT
   ---------
   Missing optional Card Leo tables do NOT crash the entire dashboard.
   Instead that individual module reports unavailable.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_MONTHLY_MEMBERSHIP_FEE = 20;

const GROWTH_POOL_ID = 1;

const MAX_RECENT_SIGNUPS = 8;

const MAX_RECENT_ACTIVITY = 12;

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   MEMBER STATUS VALUES
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

const PENDING_PAYMENT_STATUSES = new Set([
  "",
  "unpaid",
  "payment_pending",
  "pending_payment",
  "requires_payment",
  "incomplete",
  "past_due",
  "payment_failed",
  "failed",
]);

const OPEN_SUPPORT_STATUSES = new Set([
  "open",
  "in_progress",
  "in progress",
  "waiting",
  "waiting_on_member",
  "pending",
  "new",
]);

/* ==========================================================================
   HELPERS
============================================================================ */

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeEmail(value) {
  return normalizeLower(value);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeLower(value);

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

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function normalizeInteger(value, fallback = 0) {
  const number = Number.parseInt(
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
      normalizeNumber(value, 0) /
      100
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

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
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

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
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
   DATABASE ERROR HELPERS
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
        const separator =
          part.indexOf("=");

        if (
          separator === -1
        ) {
          return cookies;
        }

        const name =
          part
            .slice(
              0,
              separator
            )
            .trim();

        const value =
          part
            .slice(
              separator + 1
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

function parseJsonValue(value) {
  if (isObject(value)) {
    return value;
  }

  const raw =
    normalizeString(value);

  if (!raw) {
    return null;
  }

  const decoded =
    decodeCookieValue(raw);

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

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Continue.
  }

  return null;
}

function readSession(req) {
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
      parseJsonValue(
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

/* ==========================================================================
   SESSION IDENTITY
============================================================================ */

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

function getSessionMemberId(session) {
  const value =
    session?.value ||
    {};

  return normalizeString(
    value.member_id ||
    value.memberId ||

    value.signup_id ||
    value.signupId ||

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

function getSessionExpiresAt(session) {
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

function sessionIsExpired(session) {
  const expiresAt =
    getSessionExpiresAt(
      session
    );

  if (!expiresAt) {
    return false;
  }

  return (
    expiresAt <=
    Math.floor(
      Date.now() / 1000
    )
  );
}

/* ==========================================================================
   ADMIN EMAIL ENVIRONMENT
============================================================================ */

function parseEmailList(value) {
  return normalizeString(value)
    .split(/[,\n;]/)
    .map(
      normalizeEmail
    )
    .filter(Boolean);
}

function getConfiguredAdminEmails() {
  return new Set([
    ...parseEmailList(
      process.env.ADMIN_EMAILS
    ),

    ...parseEmailList(
      process.env.SUPER_ADMIN_EMAILS
    ),

    ...parseEmailList(
      process.env.CARDLEO_ADMIN_EMAILS
    ),

    ...parseEmailList(
      process.env.CARD_LEO_ADMIN_EMAILS
    ),
  ]);
}

/* ==========================================================================
   ADMIN DETECTION
============================================================================ */

function memberHasAdminRole(member) {
  if (!member) {
    return false;
  }

  const roleValues = [
    member.role,
    member.user_role,
    member.account_role,
    member.portal_role,
    member.admin_role,
  ]
    .map(
      normalizeLower
    )
    .filter(Boolean);

  if (
    roleValues.some(
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

  const adminFlags = [
    member.is_admin,
    member.admin,
    member.is_super_admin,
    member.super_admin,
    member.can_manage_members,
  ];

  return adminFlags.some(
    (value) =>
      normalizeBoolean(
        value,
        false
      )
  );
}

function memberIsSuperAdmin(member) {
  if (!member) {
    return false;
  }

  const roleValues = [
    member.role,
    member.user_role,
    member.account_role,
    member.portal_role,
    member.admin_role,
  ]
    .map(
      normalizeLower
    )
    .filter(Boolean);

  return (
    roleValues.some(
      (role) =>
        [
          "super_admin",
          "superadmin",
          "owner",
        ].includes(role)
    ) ||

    normalizeBoolean(
      member.is_super_admin,
      false
    ) ||

    normalizeBoolean(
      member.super_admin,
      false
    )
  );
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findAdminMember({
  memberId,
  email,
}) {
  if (memberId) {
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

    if (data?.id) {
      return data;
    }
  }

  if (email) {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("signups")
        .select("*")
        .ilike(
          "email",
          email
        )
        .limit(1)
        .maybeSingle();

    if (error) {
      throw error;
    }

    return data || null;
  }

  return null;
}

/* ==========================================================================
   ADMIN AUTH
============================================================================ */

async function authenticateAdmin(
  req,
  res
) {
  const session =
    readSession(req);

  if (!session?.value) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Admin session required."
        ),
    };
  }

  if (
    sessionIsExpired(
      session
    )
  ) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Admin session expired."
        ),
    };
  }

  if (
    session.value
      .authenticated !== true
  ) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Invalid Card Leo session."
        ),
    };
  }

  const memberId =
    getSessionMemberId(
      session
    );

  const email =
    getSessionEmail(
      session
    );

  if (
    !memberId &&
    !email
  ) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Admin identity missing from session."
        ),
    };
  }

  const member =
    await findAdminMember({
      memberId,
      email,
    });

  if (!member?.id) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Card Leo administrator account not found."
        ),
    };
  }

  const safeEmail =
    normalizeEmail(
      member.email
    );

  const configuredAdmins =
    getConfiguredAdminEmails();

  const emailIsConfigured =
    configuredAdmins.has(
      safeEmail
    );

  const roleIsAdmin =
    memberHasAdminRole(
      member
    );

  if (
    !emailIsConfigured &&
    !roleIsAdmin
  ) {
    return {
      member: null,

      response:
        forbidden(
          res,
          "Administrator access required."
        ),
    };
  }

  return {
    member,

    admin: {
      id:
        member.id,

      email:
        safeEmail,

      fullName:
        normalizeString(
          member.full_name
        ) ||
        [
          member.first_name,
          member.last_name,
        ]
          .map(
            normalizeString
          )
          .filter(Boolean)
          .join(" ") ||
        safeEmail,

      role:
        memberIsSuperAdmin(
          member
        )
          ? "super_admin"
          : "admin",

      isSuperAdmin:
        memberIsSuperAdmin(
          member
        ),

      canManageMembers:
        true,

      canManageSupport:
        true,

      canManageRewards:
        true,

      canManageCards:
        true,

      canManageGrowthPool:
        true,

      canManageAccessPerks:
        true,
    },

    response: null,
  };
}

/* ==========================================================================
   MEMBER QUALIFICATION
============================================================================ */

function isPaidMember(member) {
  const paymentStatus =
    normalizeLower(
      member?.payment_status
    );

  return (
    PAID_PAYMENT_STATUSES.has(
      paymentStatus
    )
  );
}

function isActiveMember(member) {
  const status =
    normalizeLower(
      member?.status
    );

  const membershipStatus =
    normalizeLower(
      member
        ?.membership_status
    );

  return (
    ACTIVE_ACCOUNT_STATUSES.has(
      status
    ) ||

    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    )
  );
}

function isActivePaidMember(member) {
  return (
    isPaidMember(member) &&
    isActiveMember(member)
  );
}

function needsPayment(member) {
  const paymentStatus =
    normalizeLower(
      member
        ?.payment_status
    );

  return (
    !PAID_PAYMENT_STATUSES.has(
      paymentStatus
    )
  );
}

/* ==========================================================================
   SIGNUPS / MEMBERS
============================================================================ */

async function loadMembers() {
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

function buildMemberSummary(
  members
) {
  const activePaid =
    members.filter(
      isActivePaidMember
    );

  const pendingPayment =
    members.filter(
      needsPayment
    );

  const accessReady =
    members.filter(
      (member) =>
        normalizeBoolean(
          member.access_perks_ready,
          false
        ) ||

        normalizeLower(
          member
            .access_member_status
        ) ===
          "open"
    );

  const monthlyRevenue =
    activePaid.reduce(
      (
        total,
        member
      ) => {
        const monthlyFee =
          normalizeNumber(
            member
              .monthly_fee_amount,
            DEFAULT_MONTHLY_MEMBERSHIP_FEE
          );

        return (
          total +
          monthlyFee
        );
      },
      0
    );

  return {
    total:
      members.length,

    activePaid:
      activePaid.length,

    pendingPayment:
      pendingPayment.length,

    accessReady:
      accessReady.length,

    monthlyRevenue:
      money(
        monthlyRevenue
      ),

    defaultMonthlyFee:
      DEFAULT_MONTHLY_MEMBERSHIP_FEE,
  };
}

/* ==========================================================================
   RECENT SIGNUPS
============================================================================ */

function buildRecentSignups(
  members
) {
  return members
    .slice(
      0,
      MAX_RECENT_SIGNUPS
    )
    .map(
      (member) => ({
        id:
          member.id,

        email:
          normalizeEmail(
            member.email
          ),

        firstName:
          normalizeString(
            member.first_name
          ),

        lastName:
          normalizeString(
            member.last_name
          ),

        fullName:
          normalizeString(
            member.full_name
          ) ||
          [
            member.first_name,
            member.last_name,
          ]
            .map(
              normalizeString
            )
            .filter(Boolean)
            .join(" "),

        status:
          normalizeString(
            member.status
          ),

        statusLabel:
          titleCase(
            member.status ||
            "new"
          ),

        paymentStatus:
          normalizeString(
            member.payment_status
          ),

        membershipStatus:
          normalizeString(
            member.membership_status
          ),

        accessPerksReady:
          normalizeBoolean(
            member
              .access_perks_ready,
            false
          ),

        accessMemberStatus:
          normalizeString(
            member
              .access_member_status
          ),

        createdAt:
          safeDate(
            member.created_at
          ),
      })
    );
}

/* ==========================================================================
   GROWTH POOL
============================================================================ */

async function loadGrowthPool() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "growth_pool"
      )
      .select("*")
      .eq(
        "id",
        GROWTH_POOL_ID
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
        available: false,

        balance: 0,

        totalContributed: 0,

        totalMembersContributed: 0,
      };
    }

    throw error;
  }

  if (!data) {
    return {
      available: true,

      exists: false,

      id:
        GROWTH_POOL_ID,

      balance:
        0,

      totalContributed:
        0,

      totalMembersContributed:
        0,
    };
  }

  return {
    available: true,

    exists: true,

    id:
      data.id,

    poolName:
      normalizeString(
        data.pool_name ||
        "Card Leo Growth Pool"
      ),

    balance:
      money(
        data.balance
      ),

    totalContributed:
      money(
        data.total_contributed
      ),

    totalMembersContributed:
      normalizeInteger(
        data
          .total_members_contributed,
        0
      ),

    updatedAt:
      safeDate(
        data.updated_at
      ),
  };
}

/* ==========================================================================
   GROWTH POOL LEDGER
============================================================================ */

async function loadGrowthPoolLedger() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "growth_pool_transactions"
      )
      .select(
        [
          "id",
          "member_id",
          "member_email",
          "amount_cents",
          "amount",
          "transaction_type",
          "status",
          "created_at",
        ].join(", ")
      )
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
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
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        available: false,

        contributionCount: 0,

        uniqueMembers: 0,

        totalCents: 0,

        total: 0,
      };
    }

    throw error;
  }

  const rows =
    Array.isArray(data)
      ? data
      : [];

  let totalCents = 0;

  const memberIds =
    new Set();

  for (const row of rows) {
    let cents =
      normalizeInteger(
        row.amount_cents,
        0
      );

    if (
      cents <= 0
    ) {
      cents =
        Math.round(
          normalizeNumber(
            row.amount,
            0
          ) *
          100
        );
    }

    totalCents += cents;

    if (
      normalizeString(
        row.member_id
      )
    ) {
      memberIds.add(
        normalizeString(
          row.member_id
        )
      );
    }
  }

  return {
    available: true,

    contributionCount:
      rows.length,

    uniqueMembers:
      memberIds.size,

    totalCents,

    total:
      centsToDollars(
        totalCents
      ),
  };
}

/* ==========================================================================
   OPTIONAL MEMBER CARDS
============================================================================ */

async function loadCards() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "member_cards"
      )
      .select("*");

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        available: false,

        total: 0,

        active: 0,

        paused: 0,

        closed: 0,
      };
    }

    throw error;
  }

  const cards =
    Array.isArray(data)
      ? data
      : [];

  const active =
    cards.filter(
      (card) =>
        [
          "active",
          "open",
          "created",
          "ready",
        ].includes(
          normalizeLower(
            card.card_status ||
            card.status
          )
        )
    );

  const paused =
    cards.filter(
      (card) =>
        normalizeLower(
          card.card_status ||
          card.status
        ) ===
          "paused" ||

        normalizeBoolean(
          card.card_paused,
          false
        )
    );

  const closed =
    cards.filter(
      (card) =>
        [
          "closed",
          "terminated",
          "cancelled",
          "canceled",
        ].includes(
          normalizeLower(
            card.card_status ||
            card.status
          )
        )
    );

  const loadedCents =
    cards.reduce(
      (
        total,
        card
      ) =>
        total +
        normalizeInteger(
          card
            .total_allowance_loaded_cents ??
          card
            .lifetime_loaded_cents,
          0
        ),
      0
    );

  return {
    available: true,

    total:
      cards.length,

    active:
      active.length,

    paused:
      paused.length,

    closed:
      closed.length,

    totalAllowanceLoadedCents:
      loadedCents,

    totalAllowanceLoaded:
      centsToDollars(
        loadedCents
      ),
  };
}

/* ==========================================================================
   ALLOWANCE TABLES
============================================================================ */

async function queryAllowanceTable(
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
        available: false,

        rows: [],
      };
    }

    throw error;
  }

  return {
    available: true,

    rows:
      Array.isArray(data)
        ? data
        : [],
  };
}

async function loadAllowance() {
  const tableNames = [
    "member_allowances",
    "member_allowance",
  ];

  for (
    const table
    of tableNames
  ) {
    const result =
      await queryAllowanceTable(
        table
      );

    if (!result.available) {
      continue;
    }

    let pendingCents = 0;

    let approvedCents = 0;

    let availableCents = 0;

    let processingCents = 0;

    let loadedCents = 0;

    let spentCents = 0;

    for (
      const row
      of result.rows
    ) {
      pendingCents +=
        normalizeInteger(
          row
            .pending_earnings_cents ??
          row.pending_cents,
          0
        );

      approvedCents +=
        normalizeInteger(
          row
            .approved_waiting_cents ??
          row
            .approved_allowance_cents,
          0
        );

      availableCents +=
        normalizeInteger(
          row
            .available_balance_cents ??
          row
            .allowance_balance_cents,
          0
        );

      processingCents +=
        normalizeInteger(
          row.processing_cents,
          0
        );

      loadedCents +=
        normalizeInteger(
          row
            .lifetime_loaded_cents,
          0
        );

      spentCents +=
        normalizeInteger(
          row
            .lifetime_spent_cents,
          0
        );
    }

    return {
      available: true,

      table,

      memberRecords:
        result.rows.length,

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

      availableAmount:
        centsToDollars(
          availableCents
        ),

      processingCents,

      processing:
        centsToDollars(
          processingCents
        ),

      lifetimeLoadedCents:
        loadedCents,

      lifetimeLoaded:
        centsToDollars(
          loadedCents
        ),

      lifetimeSpentCents:
        spentCents,

      lifetimeSpent:
        centsToDollars(
          spentCents
        ),
    };
  }

  return {
    available: false,

    memberRecords: 0,

    pendingCents: 0,

    pending: 0,

    approvedCents: 0,

    approved: 0,

    availableCents: 0,

    availableAmount: 0,

    processingCents: 0,

    processing: 0,

    lifetimeLoadedCents: 0,

    lifetimeLoaded: 0,

    lifetimeSpentCents: 0,

    lifetimeSpent: 0,
  };
}

/* ==========================================================================
   REFERRALS
============================================================================ */

async function loadReferrals() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "referrals"
      )
      .select("*");

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        available: false,

        total: 0,

        direct: 0,

        team: 0,

        pending: 0,

        rewarded: 0,

        estimatedRewardAmount: 0,
      };
    }

    throw error;
  }

  const rows =
    Array.isArray(data)
      ? data
      : [];

  let direct = 0;

  let team = 0;

  let pending = 0;

  let rewarded = 0;

  let explicitRewardAmount = 0;

  for (const row of rows) {
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
        "level_2"
      ) ||
      type ===
        "indirect"
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
        "rewarded",
        "approved",
        "active",
        "paid",
        "completed",
      ].includes(status)
    ) {
      rewarded += 1;
    }

    explicitRewardAmount +=
      normalizeNumber(
        row.reward_amount ??
        row.amount ??
        row.earned,
        0
      );
  }

  const estimatedRewardAmount =
    explicitRewardAmount >
    0
      ? explicitRewardAmount
      : (
          direct *
            7 +
          team *
            1
        );

  return {
    available: true,

    total:
      rows.length,

    direct,

    team,

    pending,

    rewarded,

    estimatedRewardAmount:
      money(
        estimatedRewardAmount
      ),
  };
}

/* ==========================================================================
   SUPPORT
============================================================================ */

async function loadSupport() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "support_tickets"
      )
      .select("*")
      .order(
        "updated_at",
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
      return {
        available: false,

        total: 0,

        open: 0,

        urgent: 0,

        tickets: [],
      };
    }

    throw error;
  }

  const tickets =
    Array.isArray(data)
      ? data
      : [];

  const openTickets =
    tickets.filter(
      (ticket) =>
        OPEN_SUPPORT_STATUSES.has(
          normalizeLower(
            ticket.status
          )
        )
    );

  const urgent =
    tickets.filter(
      (ticket) =>
        normalizeLower(
          ticket.priority
        ) ===
          "urgent"
    );

  return {
    available: true,

    total:
      tickets.length,

    open:
      openTickets.length,

    urgent:
      urgent.length,

    tickets:
      tickets
        .slice(
          0,
          8
        )
        .map(
          (ticket) => ({
            id:
              ticket.id,

            ticketNumber:
              normalizeString(
                ticket.ticket_number
              ),

            subject:
              normalizeString(
                ticket.subject
              ),

            status:
              normalizeString(
                ticket.status
              ),

            statusLabel:
              titleCase(
                ticket.status ||
                "open"
              ),

            priority:
              normalizeString(
                ticket.priority
              ),

            priorityLabel:
              titleCase(
                ticket.priority ||
                "normal"
              ),

            memberId:
              normalizeString(
                ticket.member_id ||
                ticket.signup_id
              ),

            createdAt:
              safeDate(
                ticket.created_at
              ),

            updatedAt:
              safeDate(
                ticket.updated_at
              ),

            lastMessageAt:
              safeDate(
                ticket.last_message_at
              ),
          })
        ),
  };
}

/* ==========================================================================
   RECENT ACTIVITY
============================================================================ */

async function loadRecentActivity() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "member_activity"
      )
      .select("*")
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(
        MAX_RECENT_ACTIVITY
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        available: false,

        items: [],
      };
    }

    throw error;
  }

  const rows =
    Array.isArray(data)
      ? data
      : [];

  return {
    available: true,

    items:
      rows.map(
        (row) => ({
          id:
            row.id,

          memberId:
            normalizeString(
              row.member_id ||
              row.signup_id
            ),

          type:
            normalizeString(
              row.activity_type ||
              row.type ||
              "activity"
            ),

          title:
            normalizeString(
              row.title
            ) ||
            titleCase(
              row.activity_type ||
              row.type ||
              "Activity"
            ),

          description:
            normalizeString(
              row.description
            ),

          status:
            normalizeString(
              row.status
            ),

          createdAt:
            safeDate(
              row.created_at
            ),

          occurredAt:
            safeDate(
              row.occurred_at ||
              row.created_at
            ),
        })
      ),
  };
}

/* ==========================================================================
   ACCESS PERKS
============================================================================ */

function buildAccessSummary(
  members
) {
  let ready = 0;

  let open = 0;

  let suspended = 0;

  let syncErrors = 0;

  let pending = 0;

  for (
    const member
    of members
  ) {
    const status =
      normalizeLower(
        member
          .access_member_status
      );

    const perksReady =
      normalizeBoolean(
        member
          .access_perks_ready,
        false
      );

    const error =
      normalizeString(
        member
          .access_sync_error
      );

    if (
      perksReady ||
      status ===
        "open"
    ) {
      ready += 1;
    }

    if (
      status ===
      "open"
    ) {
      open += 1;
    }

    if (
      status ===
      "suspend"
    ) {
      suspended += 1;
    }

    if (error) {
      syncErrors += 1;
    }

    if (
      !perksReady &&
      status !==
        "open" &&
      status !==
        "suspend"
    ) {
      pending += 1;
    }
  }

  return {
    ready,

    open,

    suspended,

    syncErrors,

    pending,

    total:
      members.length,
  };
}

/* ==========================================================================
   PLATFORM HEALTH
============================================================================ */

function buildHealth({
  growthPool,
  growthPoolLedger,
  cards,
  allowance,
  referrals,
  support,
}) {
  const growthPoolMatchesLedger =
    growthPool.available &&
    growthPoolLedger.available
      ? (
          Math.round(
            normalizeNumber(
              growthPool.balance,
              0
            ) *
            100
          ) ===
            growthPoolLedger
              .totalCents &&

          normalizeInteger(
            growthPool
              .totalMembersContributed,
            0
          ) ===
            growthPoolLedger
              .uniqueMembers
        )
      : null;

  return {
    database: {
      status:
        "online",

      healthy:
        true,
    },

    members: {
      status:
        "online",

      healthy:
        true,
    },

    growthPool: {
      status:
        !growthPool.available
          ? "unavailable"
          : growthPoolMatchesLedger ===
              false
            ? "reconciliation_required"
            : "online",

      healthy:
        growthPool.available &&
        growthPoolMatchesLedger !==
          false,

      summaryMatchesLedger:
        growthPoolMatchesLedger,
    },

    cards: {
      status:
        cards.available
          ? "online"
          : "not_configured",

      healthy:
        cards.available,
    },

    allowance: {
      status:
        allowance.available
          ? "online"
          : "not_configured",

      healthy:
        allowance.available,
    },

    referrals: {
      status:
        referrals.available
          ? "online"
          : "not_configured",

      healthy:
        referrals.available,
    },

    support: {
      status:
        support.available
          ? "online"
          : "not_configured",

      healthy:
        support.available,
    },
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
        "admin_overview",
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
       ADMIN AUTH
    ====================================================================== */

    const {
      member:
        adminMember,

      admin,

      response,
    } =
      await authenticateAdmin(
        req,
        res
      );

    if (!adminMember) {
      return response;
    }

    /* ======================================================================
       MEMBERS

       Members are our primary dataset because many dashboard KPIs can be
       calculated directly from the real signups table.
    ====================================================================== */

    const members =
      await loadMembers();

    const memberSummary =
      buildMemberSummary(
        members
      );

    const recentSignups =
      buildRecentSignups(
        members
      );

    const access =
      buildAccessSummary(
        members
      );

    /* ======================================================================
       OPTIONAL / EXTENDED SYSTEMS
    ====================================================================== */

    const [
      growthPool,
      growthPoolLedger,
      cards,
      allowance,
      referrals,
      support,
      activity,
    ] =
      await Promise.all([
        loadGrowthPool(),

        loadGrowthPoolLedger(),

        loadCards(),

        loadAllowance(),

        loadReferrals(),

        loadSupport(),

        loadRecentActivity(),
      ]);

    /* ======================================================================
       HEALTH
    ====================================================================== */

    const health =
      buildHealth({
        growthPool,

        growthPoolLedger,

        cards,

        allowance,

        referrals,

        support,
      });

    /* ======================================================================
       EXECUTIVE SUMMARY
    ====================================================================== */

    const summary = {
      totalMembers:
        memberSummary.total,

      activePaidMembers:
        memberSummary
          .activePaid,

      pendingPayments:
        memberSummary
          .pendingPayment,

      monthlyMembershipRevenue:
        memberSummary
          .monthlyRevenue,

      growthPoolBalance:
        growthPool.balance,

      growthPoolMembers:
        growthPool
          .totalMembersContributed,

      allowanceOutstanding:
        allowance
          .availableAmount,

      cardsIssued:
        cards.active,

      accessPerksReady:
        access.ready,

      directReferrals:
        referrals.direct,

      teamReferrals:
        referrals.team,

      pendingReferralRewards:
        referrals.pending,

      estimatedReferralRewards:
        referrals
          .estimatedRewardAmount,

      openSupportTickets:
        support.open,

      urgentSupportTickets:
        support.urgent,
    };

    /* ======================================================================
       LOG SUCCESS
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "admin_overview",

        adminId:
          admin.id,

        adminEmail:
          admin.email,

        totalMembers:
          memberSummary.total,

        activePaid:
          memberSummary
            .activePaid,

        pendingPayments:
          memberSummary
            .pendingPayment,

        monthlyRevenue:
          memberSummary
            .monthlyRevenue,

        growthPool:
          growthPool.balance,

        cards:
          cards.active,

        accessReady:
          access.ready,

        supportOpen:
          support.open,

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
           EXECUTIVE SUMMARY
        ------------------------------------------------------------------ */

        summary,

        /* ------------------------------------------------------------------
           MEMBERS
        ------------------------------------------------------------------ */

        members: {
          total:
            memberSummary.total,

          activePaid:
            memberSummary
              .activePaid,

          activeMembers:
            memberSummary
              .activePaid,

          active_members:
            memberSummary
              .activePaid,

          pendingPayment:
            memberSummary
              .pendingPayment,

          pendingPayments:
            memberSummary
              .pendingPayment,

          pending_payments:
            memberSummary
              .pendingPayment,

          monthlyRevenue:
            memberSummary
              .monthlyRevenue,

          monthly_revenue:
            memberSummary
              .monthlyRevenue,

          monthlyFee:
            DEFAULT_MONTHLY_MEMBERSHIP_FEE,
        },

        /* ------------------------------------------------------------------
           REVENUE
        ------------------------------------------------------------------ */

        revenue: {
          estimatedMonthlyMembership:
            memberSummary
              .monthlyRevenue,

          estimatedMonthlyMembershipCents:
            Math.round(
              memberSummary
                .monthlyRevenue *
              100
            ),

          activePaidMembers:
            memberSummary
              .activePaid,

          defaultMonthlyFee:
            DEFAULT_MONTHLY_MEMBERSHIP_FEE,

          source:
            "active_paid_membership_estimate",

          note:
            "Estimated recurring membership revenue based on active paid members and stored monthly fee amounts. This is not a Stripe payout report.",
        },

        /* ------------------------------------------------------------------
           SIGNUPS
        ------------------------------------------------------------------ */

        signups: {
          total:
            memberSummary.total,

          recent:
            recentSignups,
        },

        recentSignups,

        /* ------------------------------------------------------------------
           GROWTH POOL
        ------------------------------------------------------------------ */

        growthPool: {
          ...growthPool,

          ledger:
            growthPoolLedger,

          reconciliation: {
            summaryBalance:
              growthPool.balance,

            ledgerBalance:
              growthPoolLedger
                .total,

            summaryMemberCount:
              growthPool
                .totalMembersContributed,

            ledgerMemberCount:
              growthPoolLedger
                .uniqueMembers,

            difference:
              money(
                normalizeNumber(
                  growthPool.balance,
                  0
                ) -
                normalizeNumber(
                  growthPoolLedger
                    .total,
                  0
                )
              ),

            matches:
              health
                .growthPool
                .summaryMatchesLedger,
          },
        },

        /* ------------------------------------------------------------------
           ALLOWANCE
        ------------------------------------------------------------------ */

        allowance,

        rewards: {
          pending:
            allowance.pending,

          pendingCents:
            allowance.pendingCents,

          approved:
            allowance.approved,

          approvedCents:
            allowance.approvedCents,

          available:
            allowance
              .availableAmount,

          availableCents:
            allowance
              .availableCents,

          processing:
            allowance.processing,

          processingCents:
            allowance
              .processingCents,

          lifetimeLoaded:
            allowance
              .lifetimeLoaded,

          lifetimeSpent:
            allowance
              .lifetimeSpent,
        },

        /* ------------------------------------------------------------------
           CARDS
        ------------------------------------------------------------------ */

        cards,

        /* ------------------------------------------------------------------
           ACCESS
        ------------------------------------------------------------------ */

        access: {
          available:
            true,

          ...access,
        },

        accessPerks: {
          ready:
            access.ready,

          open:
            access.open,

          suspended:
            access.suspended,

          pending:
            access.pending,

          syncErrors:
            access.syncErrors,

          total:
            access.total,
        },

        /* ------------------------------------------------------------------
           REFERRALS
        ------------------------------------------------------------------ */

        referrals: {
          ...referrals,

          directReferrals:
            referrals.direct,

          teamReferrals:
            referrals.team,

          pendingReferrals:
            referrals.pending,

          pendingRewards:
            referrals.pending,

          estimatedRewardAmount:
            referrals
              .estimatedRewardAmount,
        },

        /* ------------------------------------------------------------------
           SUPPORT
        ------------------------------------------------------------------ */

        support,

        /* ------------------------------------------------------------------
           ACTIVITY
        ------------------------------------------------------------------ */

        activity,

        /* ------------------------------------------------------------------
           HEALTH
        ------------------------------------------------------------------ */

        health,

        /* ------------------------------------------------------------------
           LINKS
        ------------------------------------------------------------------ */

        links: {
          dashboard:
            "/admin/index.html",

          signups:
            "/admin/signups.html",

          members:
            "/admin/members.html",

          referrals:
            "/admin/referrals.html",

          rewards:
            "/admin/rewards.html",

          cards:
            "/admin/cards.html",

          growthPool:
            "/admin/growth-pool.html",

          accessPerks:
            "/admin/access-perks.html",

          activity:
            "/admin/activity.html",

          support:
            "/admin/support.html",
        },

        fetchedAt:
          new Date()
            .toISOString(),
      },

      "Admin overview loaded successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "admin_overview_unexpected",
      }
    );

    console.error(
      "Card Leo admin overview error:",
      error
    );

    return serverError(
      res,

      "Failed to load the Card Leo admin overview.",

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