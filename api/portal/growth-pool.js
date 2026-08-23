// api/portal/growth-pool.js

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

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
   GROWTH POOL — ADMIN READ-ONLY API

   ROUTE
   -----
   GET /api/portal/growth-pool

   IMPORTANT
   ---------
   Despite the historical /api/portal/ path, this endpoint is now
   ADMIN-ONLY.

   Ordinary Card Leo members must NEVER receive Growth Pool accounting.

   PURPOSE
   -------
   Give authorized Card Leo administrators a read-only view of:

   - Growth Pool balance
   - Total contributions
   - Total qualifying members
   - Contribution count
   - $2 contribution rule
   - Recent Growth Pool ledger transactions
   - Aggregate-vs-ledger reconciliation
   - Last contribution timestamp
   - Database readiness

   SECURITY
   --------
   Admin authentication is based on the Supabase access token supplied
   in:

     Authorization: Bearer <access-token>

   The authenticated Supabase user must also resolve to a Card Leo admin
   through:

     profiles
     admin_roles

   This endpoint NEVER trusts a client-supplied:
   - admin ID
   - profile ID
   - email
   - role
   - permission flag

   READ ONLY
   ---------
   This endpoint DOES NOT:

   - create Growth Pool transactions
   - modify Growth Pool balances
   - process Stripe payments
   - activate members
   - fund cards
   - fund member allowance
   - issue referral rewards

   ALL GROWTH POOL WRITES CONTINUE THROUGH:

     lib/growth-pool.js
     api/billing/webhook.js

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const GROWTH_POOL_ID =
  1;

const GROWTH_POOL_NAME =
  "Card Leo Growth Pool";

const CONTRIBUTION_AMOUNT_CENTS =
  200;

const CONTRIBUTION_AMOUNT =
  2.0;

const DEFAULT_LIMIT =
  25;

const MAX_LIMIT =
  100;

const COMPLETED_TRANSACTION_STATUSES =
  new Set([
    "completed",
    "complete",
    "succeeded",
    "success",
    "paid",
  ]);

const QUALIFYING_TRANSACTION_TYPES =
  new Set([
    "member_activation",
  ]);

const ADMIN_PROFILE_ROLES =
  new Set([
    "admin",
    "administrator",
    "super_admin",
    "superadmin",
    "owner",
  ]);

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeLower(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeEmail(
  value
) {
  return normalizeLower(
    value
  );
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

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}

function normalizeNumber(
  value,
  fallback = 0
) {
  const parsed =
    Number(
      value
    );

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}

function money(
  value
) {
  const parsed =
    Number(
      value || 0
    );

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return 0;
  }

  return Number(
    parsed.toFixed(
      2
    )
  );
}

function centsToDollars(
  value
) {
  return money(
    normalizeNumber(
      value,
      0
    ) / 100
  );
}

function dollarsToCents(
  value
) {
  return Math.round(
    normalizeNumber(
      value,
      0
    ) * 100
  );
}

function safeDate(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
  );
}

function titleCase(
  value
) {
  return normalizeString(
    value
  )
    .replace(
      /[_-]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .replace(
      /\b\w/g,
      (
        character
      ) =>
        character.toUpperCase()
    );
}

function toPositiveInteger(
  value,
  fallback =
    DEFAULT_LIMIT
) {
  const parsed =
    normalizeInteger(
      value,
      fallback
    );

  if (
    parsed <= 0
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    MAX_LIMIT
  );
}

function getClientIp(
  req
) {
  const forwarded =
    req?.headers?.[
      "x-forwarded-for"
    ];

  if (
    typeof forwarded ===
      "string" &&
    forwarded.trim()
  ) {
    return forwarded
      .split(",")[0]
      .trim();
  }

  return (
    req?.socket?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   OPTIONAL SCHEMA SUPPORT
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
    code ===
      "42P01" ||

    code ===
      "42703" ||

    code ===
      "PGRST204" ||

    code ===
      "PGRST205" ||

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
   ACCESS TOKEN
============================================================================ */

function getAccessTokenFromRequest(
  req
) {
  const authorization =
    normalizeString(
      req?.headers
        ?.authorization
    );

  if (!authorization) {
    return "";
  }

  const match =
    authorization.match(
      /^Bearer\s+(.+)$/i
    );

  return normalizeString(
    match?.[1]
  );
}

/* ==========================================================================
   AUTHENTICATED SUPABASE USER
============================================================================ */

async function getAuthenticatedUser(
  req
) {
  const accessToken =
    getAccessTokenFromRequest(
      req
    );

  if (!accessToken) {
    return {
      user:
        null,

      accessToken:
        "",

      error:
        "Administrator access token is required.",
    };
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
    return {
      user:
        null,

      accessToken,

      error:
        error?.message ||
        "Unable to authenticate administrator.",
    };
  }

  return {
    user:
      data.user,

    accessToken,

    error:
      null,
  };
}

/* ==========================================================================
   ADMIN PROFILE
============================================================================ */

async function getAdminContext(
  user
) {
  const profileId =
    normalizeString(
      user?.id
    );

  if (!profileId) {
    return {
      profile:
        null,

      adminRole:
        null,

      profileError:
        null,

      adminRoleError:
        null,
    };
  }

  const [
    profileResult,
    adminRoleResult,
  ] =
    await Promise.all([
      supabaseAdmin
        .from(
          "profiles"
        )
        .select(
          [
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "role",
            "member_status",
            "created_at",
            "updated_at",
          ].join(", ")
        )
        .eq(
          "id",
          profileId
        )
        .maybeSingle(),

      supabaseAdmin
        .from(
          "admin_roles"
        )
        .select(
          [
            "profile_id",
            "is_super_admin",
            "can_manage_members",
            "can_manage_rewards",
            "can_manage_support",
            "can_manage_referrals",
            "can_view_audit_logs",
            "can_manage_settings",
          ].join(", ")
        )
        .eq(
          "profile_id",
          profileId
        )
        .maybeSingle(),
    ]);

  return {
    profile:
      profileResult.data ||
      null,

    profileError:
      profileResult.error ||
      null,

    adminRole:
      adminRoleResult.data ||
      null,

    adminRoleError:
      adminRoleResult.error ||
      null,
  };
}

/* ==========================================================================
   ADMIN AUTHORIZATION
============================================================================ */

function isAuthorizedAdmin({
  profile,
  adminRole,
}) {
  const profileRole =
    normalizeLower(
      profile?.role
    );

  /*
   * A recognized admin role on the profile is sufficient.
   */

  if (
    ADMIN_PROFILE_ROLES.has(
      profileRole
    )
  ) {
    return true;
  }

  /*
   * A row in admin_roles means the user has explicitly been provisioned
   * as an administrator.
   */

  if (
    adminRole?.profile_id
  ) {
    return true;
  }

  return false;
}

/* ==========================================================================
   ADMIN DISPLAY PAYLOAD
============================================================================ */

function sanitizeAdmin({
  user,
  profile,
  adminRole,
}) {
  const fullName =
    normalizeString(
      profile?.full_name
    ) ||
    [
      profile?.first_name,
      profile?.last_name,
    ]
      .map(
        normalizeString
      )
      .filter(Boolean)
      .join(" ");

  return {
    id:
      profile?.id ||
      user?.id ||
      null,

    email:
      normalizeEmail(
        profile?.email ||
        user?.email
      ),

    firstName:
      normalizeString(
        profile?.first_name
      ),

    lastName:
      normalizeString(
        profile?.last_name
      ),

    fullName:
      fullName ||
      "Card Leo Admin",

    role:
      normalizeString(
        profile?.role ||
        "admin"
      ),

    isSuperAdmin:
      Boolean(
        adminRole
          ?.is_super_admin
      ),

    permissions: {
      canManageMembers:
        Boolean(
          adminRole
            ?.can_manage_members
        ),

      canManageRewards:
        Boolean(
          adminRole
            ?.can_manage_rewards
        ),

      canManageSupport:
        Boolean(
          adminRole
            ?.can_manage_support
        ),

      canManageReferrals:
        Boolean(
          adminRole
            ?.can_manage_referrals
        ),

      canViewAuditLogs:
        Boolean(
          adminRole
            ?.can_view_audit_logs
        ),

      canManageSettings:
        Boolean(
          adminRole
            ?.can_manage_settings
        ),
    },
  };
}

/* ==========================================================================
   AUTHENTICATE ADMIN
============================================================================ */

async function authenticateAdmin(
  req,
  res
) {
  const {
    user,
    error:
      authError,
  } =
    await getAuthenticatedUser(
      req
    );

  if (!user) {
    return {
      admin:
        null,

      response:
        unauthorized(
          res,
          authError ||
          "Administrator authentication required."
        ),
    };
  }

  const context =
    await getAdminContext(
      user
    );

  /*
   * Database failures are server failures, not logout events.
   */

  if (
    context.profileError
  ) {
    throw context
      .profileError;
  }

  /*
   * If admin_roles does not exist yet, profile.role can still provide
   * authorization.
   *
   * Other admin_roles failures should surface.
   */

  if (
    context.adminRoleError &&
    !isMissingOptionalTableOrColumn(
      context.adminRoleError
    )
  ) {
    throw context
      .adminRoleError;
  }

  const authorized =
    isAuthorizedAdmin({
      profile:
        context.profile,

      adminRole:
        context.adminRole,
    });

  if (!authorized) {
    return {
      admin:
        null,

      response:
        forbidden(
          res,
          "Administrator permission is required to view the Card Leo Growth Pool.",
          {
            authenticated:
              true,

            admin:
              false,

            code:
              "ADMIN_REQUIRED",
          }
        ),
    };
  }

  return {
    admin:
      sanitizeAdmin({
        user,

        profile:
          context.profile,

        adminRole:
          context.adminRole,
      }),

    response:
      null,
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
      .from(
        "growth_pool"
      )
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
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        databaseReady:
          false,

        exists:
          false,

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
      };
    }

    throw error;
  }

  if (!data) {
    return {
      databaseReady:
        true,

      exists:
        false,

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
    };
  }

  const balance =
    money(
      data.balance
    );

  const totalContributed =
    money(
      data
        .total_contributed
    );

  return {
    databaseReady:
      true,

    exists:
      true,

    id:
      data.id,

    poolName:
      normalizeString(
        data.pool_name ||
        GROWTH_POOL_NAME
      ),

    balance,

    balanceCents:
      dollarsToCents(
        balance
      ),

    totalContributed,

    totalContributedCents:
      dollarsToCents(
        totalContributed
      ),

    totalMembersContributed:
      normalizeInteger(
        data
          .total_members_contributed,
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
  };
}

/* ==========================================================================
   LEDGER ROWS
============================================================================ */

async function getGrowthPoolLedger() {
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
          "growth_pool_id",
          "member_id",
          "member_email",
          "transaction_type",
          "status",
          "amount_cents",
          "amount",
          "currency",
          "provider",
          "provider_event_id",
          "provider_payment_id",
          "description",
          "metadata",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        }
      );

  if (error) {
    if (
      isMissingOptionalTableOrColumn(
        error
      )
    ) {
      return {
        databaseReady:
          false,

        rows:
          [],
      };
    }

    throw error;
  }

  return {
    databaseReady:
      true,

    rows:
      Array.isArray(
        data
      )
        ? data
        : [],
  };
}

/* ==========================================================================
   QUALIFYING LEDGER ROW
============================================================================ */

function isQualifyingContribution(
  row
) {
  const type =
    normalizeLower(
      row
        ?.transaction_type
    );

  const status =
    normalizeLower(
      row?.status
    );

  return (
    QUALIFYING_TRANSACTION_TYPES
      .has(type) &&
    COMPLETED_TRANSACTION_STATUSES
      .has(status)
  );
}

/* ==========================================================================
   TRANSACTION AMOUNT
============================================================================ */

function getTransactionAmountCents(
  row
) {
  const amountCents =
    normalizeInteger(
      row?.amount_cents,
      0
    );

  if (
    amountCents !== 0
  ) {
    return amountCents;
  }

  return dollarsToCents(
    row?.amount
  );
}

/* ==========================================================================
   LEDGER TOTALS
============================================================================ */

function calculateLedgerTotals(
  rows
) {
  const qualifyingRows =
    rows.filter(
      isQualifyingContribution
    );

  const memberIds =
    new Set();

  let totalCents =
    0;

  let lastContributionAt =
    null;

  for (
    const row
    of qualifyingRows
  ) {
    totalCents +=
      getTransactionAmountCents(
        row
      );

    const memberId =
      normalizeString(
        row.member_id
      );

    if (memberId) {
      memberIds.add(
        memberId
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
      qualifyingRows.length,

    memberCount:
      memberIds.size,

    totalCents,

    total:
      centsToDollars(
        totalCents
      ),

    lastContributionAt,

    qualifyingRows,
  };
}

/* ==========================================================================
   TRANSACTION SANITIZER
============================================================================ */

function sanitizeGrowthPoolTransaction(
  row
) {
  const amountCents =
    getTransactionAmountCents(
      row
    );

  const transactionType =
    normalizeString(
      row
        .transaction_type
    );

  return {
    id:
      row.id ||
      null,

    growthPoolId:
      row
        .growth_pool_id ||
      GROWTH_POOL_ID,

    memberId:
      row.member_id ||
      null,

    memberEmail:
      normalizeEmail(
        row.member_email
      ),

    transactionType,

    transactionLabel:
      titleCase(
        transactionType
      ),

    status:
      normalizeString(
        row.status
      ),

    amountCents,

    amount:
      centsToDollars(
        amountCents
      ),

    currency:
      normalizeString(
        row.currency ||
        "USD"
      ),

    provider:
      normalizeString(
        row.provider ||
        "stripe"
      ),

    providerEventId:
      normalizeString(
        row
          .provider_event_id
      ) ||
      null,

    providerPaymentId:
      normalizeString(
        row
          .provider_payment_id
      ) ||
      null,

    description:
      normalizeString(
        row.description
      ) ||
      null,

    metadata:
      isObject(
        row.metadata
      )
        ? row.metadata
        : {},

    qualifies:
      isQualifyingContribution(
        row
      ),

    createdAt:
      safeDate(
        row.created_at
      ),

    updatedAt:
      safeDate(
        row.updated_at
      ),
  };
}

/* ==========================================================================
   RECENT TRANSACTIONS
============================================================================ */

function getRecentTransactions(
  rows,
  limit
) {
  return rows
    .slice(
      0,
      limit
    )
    .map(
      sanitizeGrowthPoolTransaction
    );
}

/* ==========================================================================
   RECONCILIATION
============================================================================ */

function buildReconciliation({
  summary,
  ledger,
}) {
  const summaryBalanceCents =
    normalizeInteger(
      summary
        .balanceCents,
      0
    );

  const summaryContributedCents =
    normalizeInteger(
      summary
        .totalContributedCents,
      0
    );

  const summaryMemberCount =
    normalizeInteger(
      summary
        .totalMembersContributed,
      0
    );

  const ledgerTotalCents =
    normalizeInteger(
      ledger
        .totalCents,
      0
    );

  const ledgerMemberCount =
    normalizeInteger(
      ledger
        .memberCount,
      0
    );

  const balanceMatches =
    summaryBalanceCents ===
    ledgerTotalCents;

  const contributionTotalMatches =
    summaryContributedCents ===
    ledgerTotalCents;

  const memberCountMatches =
    summaryMemberCount ===
    ledgerMemberCount;

  const summaryMatchesLedger =
    (
      balanceMatches &&
      contributionTotalMatches &&
      memberCountMatches
    );

  return {
    healthy:
      summaryMatchesLedger,

    summaryMatchesLedger,

    balanceMatches,

    contributionTotalMatches,

    memberCountMatches,

    summary: {
      balance:
        summary.balance,

      balanceCents:
        summaryBalanceCents,

      totalContributed:
        summary
          .totalContributed,

      totalContributedCents:
        summaryContributedCents,

      totalMembersContributed:
        summaryMemberCount,
    },

    ledger: {
      balance:
        ledger.total,

      balanceCents:
        ledgerTotalCents,

      contributionCount:
        ledger
          .contributionCount,

      uniqueMembers:
        ledgerMemberCount,

      lastContributionAt:
        ledger
          .lastContributionAt,
    },

    difference:
      money(
        summary.balance -
        ledger.total
      ),

    differenceCents:
      summaryBalanceCents -
      ledgerTotalCents,
  };
}

/* ==========================================================================
   BUSINESS RULES
============================================================================ */

function buildBusinessRules() {
  return {
    contributionPerQualifiedMember:
      CONTRIBUTION_AMOUNT,

    contributionPerQualifiedMemberCents:
      CONTRIBUTION_AMOUNT_CENTS,

    currency:
      "USD",

    trigger:
      "initial_paid_membership_activation",

    transactionType:
      "member_activation",

    recurringMonthlyPaymentAddsContribution:
      false,

    contributionFrequency:
      "once_per_qualifying_new_member",

    memberReward:
      false,

    memberAllowance:
      false,

    referralReward:
      false,

    companyGrowthPool:
      true,

    visibility:
      "admin_only",

    writesHandledBy: [
      "lib/growth-pool.js",
      "api/billing/webhook.js",
    ],
  };
}

/* ==========================================================================
   DATABASE STATUS
============================================================================ */

function buildDatabaseStatus({
  summary,
  ledgerState,
}) {
  return {
    growthPoolTable:
      Boolean(
        summary
          .databaseReady
      ),

    growthPoolTransactionsTable:
      Boolean(
        ledgerState
          .databaseReady
      ),

    ready:
      Boolean(
        summary
          .databaseReady &&
        ledgerState
          .databaseReady
      ),
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
        "admin_growth_pool",
    }
  );

  /* ========================================================================
     GET ONLY
  ======================================================================== */

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
       LIMIT
    ====================================================================== */

    const limit =
      toPositiveInteger(
        req.query?.limit,
        DEFAULT_LIMIT
      );

    /* ======================================================================
       LOAD GROWTH POOL + LEDGER
    ====================================================================== */

    const [
      summary,
      ledgerState,
    ] =
      await Promise.all([
        getGrowthPoolSummary(),

        getGrowthPoolLedger(),
      ]);

    /* ======================================================================
       LEDGER TOTALS
    ====================================================================== */

    const ledger =
      calculateLedgerTotals(
        ledgerState.rows
      );

    /* ======================================================================
       RECENT TRANSACTIONS
    ====================================================================== */

    const recentTransactions =
      getRecentTransactions(
        ledgerState.rows,
        limit
      );

    /* ======================================================================
       RECONCILIATION
    ====================================================================== */

    const reconciliation =
      buildReconciliation({
        summary,
        ledger,
      });

    /* ======================================================================
       DATABASE
    ====================================================================== */

    const database =
      buildDatabaseStatus({
        summary,
        ledgerState,
      });

    /* ======================================================================
       ADMIN AUDIT LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "admin_growth_pool",

        adminId:
          admin.id,

        adminEmail:
          admin.email,

        balance:
          summary.balance,

        balanceCents:
          summary
            .balanceCents,

        totalContributed:
          summary
            .totalContributed,

        totalMembers:
          summary
            .totalMembersContributed,

        ledgerContributionCount:
          ledger
            .contributionCount,

        ledgerTotal:
          ledger.total,

        reconciliationHealthy:
          reconciliation
            .healthy,

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

        adminAccess:
          true,

        visibility:
          "admin_only",

        /* ================================================================
           ADMIN
        ================================================================= */

        admin,

        /* ================================================================
           GROWTH POOL
        ================================================================= */

        growthPool: {
          id:
            summary.id,

          name:
            summary.poolName,

          balance:
            summary.balance,

          balanceCents:
            summary
              .balanceCents,

          totalContributed:
            summary
              .totalContributed,

          totalContributedCents:
            summary
              .totalContributedCents,

          totalMembersContributed:
            summary
              .totalMembersContributed,

          contributionAmount:
            CONTRIBUTION_AMOUNT,

          contributionAmountCents:
            CONTRIBUTION_AMOUNT_CENTS,

          currency:
            "USD",

          exists:
            summary.exists,

          updatedAt:
            summary.updatedAt,

          createdAt:
            summary.createdAt,
        },

        /* ================================================================
           LEDGER
        ================================================================= */

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

        /* ================================================================
           RECENT TRANSACTIONS
        ================================================================= */

        recentTransactions,

        transactions:
          recentTransactions,

        /* ================================================================
           RECONCILIATION
        ================================================================= */

        reconciliation,

        /* ================================================================
           BUSINESS RULES
        ================================================================= */

        businessRule:
          buildBusinessRules(),

        /* ================================================================
           DATABASE READINESS
        ================================================================= */

        database,

        /* ================================================================
           FILTERS
        ================================================================= */

        filters: {
          limit,
        },

        /* ================================================================
           LINKS

           No member portal links are returned here.
        ================================================================= */

        links: {
          adminDashboard:
            "/admin/index.html",

          adminGrowthPool:
            "/admin/growth-pool.html",
        },

        fetchedAt:
          new Date()
            .toISOString(),
      },

      "Growth Pool loaded successfully."
    );
  } catch (
    error
  ) {
    logRequestError(
      req,
      error,
      {
        scope:
          "admin_growth_pool_unexpected",
      }
    );

    console.error(
      "Card Leo Growth Pool admin API error:",
      error
    );

    return serverError(
      res,
      "Failed to load Card Leo Growth Pool.",
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