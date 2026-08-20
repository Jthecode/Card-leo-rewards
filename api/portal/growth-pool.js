// api/portal/growth-pool.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  clearAuthCookies,
  getSessionCookieName,
  safeJsonParse,
} from "../../lib/cookies.js";

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
   STEP #26
   PORTAL GROWTH POOL API

   ROUTE
   -----
   GET /api/portal/growth-pool

   PURPOSE
   -------
   Secure read-only Growth Pool endpoint for the Card Leo member portal.

   RETURNS
   -------
   - Current Growth Pool balance
   - Total contributed
   - Number of contributing members
   - $2 contribution amount
   - Recent qualifying Growth Pool transactions
   - Member's own contribution status
   - Last contribution timestamp

   IMPORTANT
   ---------
   This endpoint DOES NOT:
   - create Growth Pool contributions
   - modify balances
   - process Stripe payments
   - fund Lithic cards
   - modify member allowance

   All Growth Pool writes continue through:
     lib/growth-pool.js
     api/billing/webhook.js

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const GROWTH_POOL_ID = 1;

const GROWTH_POOL_NAME =
  "Card Leo Growth Pool";

const CONTRIBUTION_AMOUNT_CENTS =
  200;

const CONTRIBUTION_AMOUNT =
  2.0;

const DEFAULT_RECENT_LIMIT =
  20;

const MAX_RECENT_LIMIT =
  100;

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
   MEMBER STATUS
============================================================================ */

const ACTIVE_STATUS_VALUES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
]);

const INACTIVE_STATUS_VALUES = new Set([
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

function normalizeInteger(
  value,
  fallback = 0
) {
  const parsed = Number.parseInt(
    String(value ?? ""),
    10
  );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function normalizeNumber(
  value,
  fallback = 0
) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function money(value) {
  const parsed = Number(value || 0);

  return Number.isFinite(parsed)
    ? Number(parsed.toFixed(2))
    : 0;
}

function centsToDollars(value) {
  return money(
    normalizeNumber(value, 0) / 100
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

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
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

/* ==========================================================================
   OPTIONAL SCHEMA ERROR
============================================================================ */

function isMissingOptionalTableOrColumn(
  error
) {
  const code = String(
    error?.code || ""
  );

  const message = String(
    error?.message || ""
  ).toLowerCase();

  const details = String(
    error?.details || ""
  ).toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache") ||
    details.includes("does not exist") ||
    details.includes("could not find") ||
    details.includes("schema cache")
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
    .map((part) => part.trim())
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
          cookies[name] = value;
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
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseJsonObject(value) {
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

  const direct =
    safeJsonParse(
      decoded,
      null
    );

  if (isObject(direct)) {
    return direct;
  }

  try {
    const base64Decoded =
      Buffer
        .from(
          decoded,
          "base64"
        )
        .toString("utf8");

    const parsed =
      safeJsonParse(
        base64Decoded,
        null
      );

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid base64.
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

    const decodedUrl =
      Buffer
        .from(
          padded,
          "base64"
        )
        .toString("utf8");

    const parsed =
      safeJsonParse(
        decodedUrl,
        null
      );

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid base64url.
  }

  return null;
}

function readSessionCookie(req) {
  const cookies =
    parseCookieHeader(req);

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
        ].filter(Boolean)
      )
    );

  for (const name of names) {
    if (!cookies[name]) {
      continue;
    }

    const parsed =
      parseJsonObject(
        cookies[name]
      );

    if (isObject(parsed)) {
      return {
        name,
        value: parsed,
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
    sessionCookie?.value || {};

  const candidates = [
    value.expires_at,
    value.expiresAt,
    value.exp,
    value.session?.expires_at,
    value.session?.expiresAt,
  ];

  for (const candidate of candidates) {
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
    return false;
  }

  return (
    expiresAt <=
    Math.floor(
      Date.now() / 1000
    )
  );
}

function getSessionMemberId(
  sessionCookie
) {
  const value =
    sessionCookie?.value || {};

  return normalizeString(
    value.member?.id ||
      value.profile?.id ||
      value.user?.id ||
      value.member_id ||
      value.memberId ||
      value.signup_id ||
      value.signupId ||
      value.id
  );
}

function getSessionEmail(
  sessionCookie
) {
  const value =
    sessionCookie?.value || {};

  return normalizeEmail(
    value.member?.email ||
      value.profile?.email ||
      value.user?.email ||
      value.email ||
      value.userEmail
  );
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findMember({
  memberId,
  email,
}) {
  let query =
    supabaseAdmin
      .from("signups")
      .select("*")
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

  const {
    data,
    error,
  } =
    await query
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

/* ==========================================================================
   MEMBER ACCESS
============================================================================ */

function memberHasPortalAccess(member) {
  if (!member) {
    return false;
  }

  const status =
    normalizeLower(
      member.status
    );

  const paymentStatus =
    normalizeLower(
      member.payment_status
    );

  const membershipStatus =
    normalizeLower(
      member.membership_status
    );

  if (
    INACTIVE_STATUS_VALUES.has(
      status
    ) ||
    INACTIVE_STATUS_VALUES.has(
      paymentStatus
    ) ||
    INACTIVE_STATUS_VALUES.has(
      membershipStatus
    )
  ) {
    return false;
  }

  return (
    ACTIVE_STATUS_VALUES.has(
      status
    ) ||
    ACTIVE_STATUS_VALUES.has(
      paymentStatus
    ) ||
    ACTIVE_STATUS_VALUES.has(
      membershipStatus
    )
  );
}

function sanitizeMember(member) {
  if (!member) {
    return null;
  }

  const fullName =
    normalizeString(
      member.full_name
    ) ||
    [
      member.first_name,
      member.last_name,
    ]
      .map(normalizeString)
      .filter(Boolean)
      .join(" ");

  return {
    id:
      member.id || null,

    email:
      normalizeEmail(
        member.email
      ),

    fullName,

    firstName:
      normalizeString(
        member.first_name
      ),

    lastName:
      normalizeString(
        member.last_name
      ),

    status:
      normalizeString(
        member.status
      ),

    paymentStatus:
      normalizeString(
        member.payment_status
      ),

    membershipStatus:
      normalizeString(
        member.membership_status
      ),

    portalAccess:
      memberHasPortalAccess(
        member
      ),
  };
}

/* ==========================================================================
   AUTHENTICATE
============================================================================ */

async function authenticateMember(
  req,
  res
) {
  const sessionCookie =
    readSessionCookie(req);

  if (!sessionCookie?.value) {
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
      sessionCookie
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
    sessionCookie
      .value
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

  const memberId =
    getSessionMemberId(
      sessionCookie
    );

  const email =
    getSessionEmail(
      sessionCookie
    );

  if (!memberId && !email) {
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

  const member =
    await findMember({
      memberId,
      email,
    });

  if (!member?.id) {
    clearAuthCookies(res);

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Card Leo member record not found."
        ),
    };
  }

  if (
    !memberHasPortalAccess(
      member
    )
  ) {
    return {
      member: null,

      response:
        forbidden(
          res,
          "Your Card Leo membership must be active before viewing the Growth Pool.",
          {
            authenticated: true,

            requiresPayment: true,

            member:
              sanitizeMember(
                member
              ),
          }
        ),
    };
  }

  return {
    member,
    response: null,
  };
}

/* ==========================================================================
   GROWTH POOL SUMMARY
============================================================================ */

async function getGrowthPoolSummary() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("growth_pool")
      .select(
        [
          "id",
          "pool_name",
          "balance",
          "total_contributed",
          "total_members_contributed",
          "updated_at",
          "created_at",
        ].join(", ")
      )
      .eq(
        "id",
        GROWTH_POOL_ID
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return {
      id:
        GROWTH_POOL_ID,

      poolName:
        GROWTH_POOL_NAME,

      balance:
        0,

      balanceCents:
        0,

      totalContributed:
        0,

      totalContributedCents:
        0,

      totalMembersContributed:
        0,

      contributionAmount:
        CONTRIBUTION_AMOUNT,

      contributionAmountCents:
        CONTRIBUTION_AMOUNT_CENTS,

      updatedAt:
        null,

      createdAt:
        null,

      exists:
        false,
    };
  }

  const balance =
    money(
      data.balance
    );

  const totalContributed =
    money(
      data.total_contributed
    );

  return {
    id:
      data.id,

    poolName:
      normalizeString(
        data.pool_name ||
        GROWTH_POOL_NAME
      ),

    balance,

    balanceCents:
      Math.round(
        balance * 100
      ),

    totalContributed,

    totalContributedCents:
      Math.round(
        totalContributed * 100
      ),

    totalMembersContributed:
      normalizeInteger(
        data.total_members_contributed,
        0
      ),

    contributionAmount:
      CONTRIBUTION_AMOUNT,

    contributionAmountCents:
      CONTRIBUTION_AMOUNT_CENTS,

    updatedAt:
      safeDate(
        data.updated_at
      ),

    createdAt:
      safeDate(
        data.created_at
      ),

    exists:
      true,
  };
}

/* ==========================================================================
   LEDGER TOTALS
============================================================================ */

async function getLedgerTotals() {
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
          "member_id",
          "amount_cents",
          "status",
          "transaction_type",
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
          "succeeded",
          "paid",
        ]
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        contributionCount: 0,
        memberCount: 0,
        totalCents: 0,
        total: 0,
        lastContributionAt: null,
      };
    }

    throw error;
  }

  const rows =
    Array.isArray(data)
      ? data
      : [];

  let totalCents =
    0;

  let lastContributionAt =
    null;

  const memberIds =
    new Set();

  for (const row of rows) {
    totalCents +=
      normalizeInteger(
        row.amount_cents,
        0
      );

    if (row.member_id) {
      memberIds.add(
        String(row.member_id)
      );
    }

    const createdAt =
      safeDate(
        row.created_at
      );

    if (
      createdAt &&
      (
        !lastContributionAt ||
        createdAt >
          lastContributionAt
      )
    ) {
      lastContributionAt =
        createdAt;
    }
  }

  return {
    contributionCount:
      rows.length,

    memberCount:
      memberIds.size,

    totalCents,

    total:
      centsToDollars(
        totalCents
      ),

    lastContributionAt,
  };
}

/* ==========================================================================
   MEMBER CONTRIBUTION
============================================================================ */

async function getMemberContribution(
  memberId
) {
  const safeMemberId =
    normalizeString(
      memberId
    );

  if (!safeMemberId) {
    return {
      contributed: false,
      amount: 0,
      amountCents: 0,
      transaction: null,
    };
  }

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
          "transaction_type",
          "status",
          "amount_cents",
          "amount",
          "provider",
          "created_at",
        ].join(", ")
      )
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "member_id",
        safeMemberId
      )
      .eq(
        "transaction_type",
        "member_activation"
      )
      .in(
        "status",
        [
          "completed",
          "succeeded",
          "paid",
        ]
      )
      .order(
        "created_at",
        {
          ascending: true,
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
      return {
        contributed: false,
        amount: 0,
        amountCents: 0,
        transaction: null,
      };
    }

    throw error;
  }

  if (!data) {
    return {
      contributed: false,
      amount: 0,
      amountCents: 0,
      transaction: null,
    };
  }

  const amountCents =
    normalizeInteger(
      data.amount_cents,
      Math.round(
        normalizeNumber(
          data.amount,
          0
        ) * 100
      )
    );

  return {
    contributed: true,

    amount:
      centsToDollars(
        amountCents
      ),

    amountCents,

    transaction: {
      id:
        data.id,

      status:
        normalizeString(
          data.status
        ),

      transactionType:
        normalizeString(
          data.transaction_type
        ),

      provider:
        normalizeString(
          data.provider
        ),

      createdAt:
        safeDate(
          data.created_at
        ),
    },
  };
}

/* ==========================================================================
   RECENT TRANSACTIONS
============================================================================ */

async function getRecentTransactions(
  limit
) {
  const safeLimit =
    Math.min(
      Math.max(
        normalizeInteger(
          limit,
          DEFAULT_RECENT_LIMIT
        ),
        1
      ),
      MAX_RECENT_LIMIT
    );

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
          "transaction_type",
          "status",
          "amount_cents",
          "amount",
          "currency",
          "provider",
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
          "succeeded",
          "paid",
        ]
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(
        safeLimit
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return [];
    }

    throw error;
  }

  return (
    Array.isArray(data)
      ? data
      : []
  ).map(
    (transaction) => {
      const amountCents =
        normalizeInteger(
          transaction
            .amount_cents,
          Math.round(
            normalizeNumber(
              transaction.amount,
              0
            ) * 100
          )
        );

      return {
        id:
          transaction.id,

        memberId:
          transaction
            .member_id ||
          null,

        memberEmail:
          normalizeEmail(
            transaction
              .member_email
          ),

        transactionType:
          normalizeString(
            transaction
              .transaction_type
          ),

        transactionLabel:
          titleCase(
            transaction
              .transaction_type
          ),

        status:
          normalizeString(
            transaction.status
          ),

        amountCents,

        amount:
          centsToDollars(
            amountCents
          ),

        currency:
          normalizeString(
            transaction.currency ||
            "USD"
          ),

        provider:
          normalizeString(
            transaction.provider ||
            "stripe"
          ),

        createdAt:
          safeDate(
            transaction
              .created_at
          ),
      };
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
  setNoStore(res);

  logRequestStart(
    req,
    {
      scope:
        "portal_growth_pool",
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
    /* ======================================================================
       AUTH
    ====================================================================== */

    const {
      member,
      response,
    } =
      await authenticateMember(
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

    /* ======================================================================
       QUERY PARAMS
    ====================================================================== */

    const recentLimit =
      Math.min(
        Math.max(
          normalizeInteger(
            req.query?.limit,
            DEFAULT_RECENT_LIMIT
          ),
          1
        ),
        MAX_RECENT_LIMIT
      );

    /* ======================================================================
       LOAD DATA
    ====================================================================== */

    const [
      summary,
      ledger,
      memberContribution,
      recentTransactions,
    ] =
      await Promise.all([
        getGrowthPoolSummary(),

        getLedgerTotals(),

        getMemberContribution(
          safeMember.id
        ),

        getRecentTransactions(
          recentLimit
        ),
      ]);

    /* ======================================================================
       RECONCILIATION
    ====================================================================== */

    const summaryMatchesLedger =
      (
        summary.balanceCents ===
          ledger.totalCents
      ) &&
      (
        summary.totalContributedCents ===
          ledger.totalCents
      ) &&
      (
        summary.totalMembersContributed ===
          ledger.memberCount
      );

    /* ======================================================================
       LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "portal_growth_pool",

        memberId:
          safeMember.id,

        email:
          safeMember.email,

        balance:
          summary.balance,

        ledgerTotal:
          ledger.total,

        totalMembers:
          ledger.memberCount,

        summaryMatchesLedger,
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

        member:
          safeMember,

        growthPool: {
          id:
            summary.id,

          name:
            summary.poolName,

          balance:
            summary.balance,

          balanceCents:
            summary.balanceCents,

          totalContributed:
            summary.totalContributed,

          totalContributedCents:
            summary
              .totalContributedCents,

          totalMembersContributed:
            summary
              .totalMembersContributed,

          contributionAmount:
            summary
              .contributionAmount,

          contributionAmountCents:
            summary
              .contributionAmountCents,

          currency:
            "USD",

          updatedAt:
            summary.updatedAt,

          createdAt:
            summary.createdAt,
        },

        ledger: {
          contributionCount:
            ledger
              .contributionCount,

          uniqueMembers:
            ledger
              .memberCount,

          total:
            ledger.total,

          totalCents:
            ledger
              .totalCents,

          lastContributionAt:
            ledger
              .lastContributionAt,
        },

        memberContribution,

        recentTransactions,

        reconciliation: {
          summaryMatchesLedger,

          summaryBalance:
            summary.balance,

          ledgerBalance:
            ledger.total,

          summaryMemberCount:
            summary
              .totalMembersContributed,

          ledgerMemberCount:
            ledger
              .memberCount,

          difference:
            money(
              summary.balance -
              ledger.total
            ),

          differenceCents:
            summary.balanceCents -
            ledger.totalCents,
        },

        businessRule: {
          contributionPerQualifiedMember:
            CONTRIBUTION_AMOUNT,

          contributionPerQualifiedMemberCents:
            CONTRIBUTION_AMOUNT_CENTS,

          contributionTrigger:
            "initial_paid_membership_activation",

          recurringMonthlyPaymentAddsAnotherContribution:
            false,

          memberAllowance:
            false,

          companyGrowthPool:
            true,
        },

        links: {
          portal:
            "/portal/index.html",

          rewards:
            "/portal/rewards.html",

          benefits:
            "/portal/benefits.html",
        },

        fetchedAt:
          new Date()
            .toISOString(),
      },

      "Growth Pool loaded successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "portal_growth_pool_unexpected",
      }
    );

    console.error(
      "Card Leo portal Growth Pool error:",
      error
    );

    return serverError(
      res,
      "Failed to load Growth Pool.",
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