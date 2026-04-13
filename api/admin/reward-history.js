// api/admin/reward-history.js

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
import { getAccessTokenFromRequest } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const VALID_TRANSACTION_TYPES = [
  "all",
  "earn",
  "redeem",
  "adjustment",
  "expire",
  "reversal",
  "bonus",
];

const VALID_STATUSES = [
  "all",
  "pending",
  "posted",
  "voided",
];

const VALID_REFERENCE_TYPES = [
  "all",
  "signup",
  "purchase",
  "referral",
  "support_ticket",
  "manual",
  "promo",
  "redemption",
  "system",
  "other",
];

const VALID_SORTS = [
  "newest",
  "oldest",
  "points_desc",
  "points_asc",
  "status",
  "type",
];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), max);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTransactionType(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_TRANSACTION_TYPES.includes(normalized) ? normalized : "all";
}

function normalizeStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizeReferenceType(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_REFERENCE_TYPES.includes(normalized) ? normalized : "all";
}

function normalizeSort(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_SORTS.includes(normalized) ? normalized : "newest";
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getFullName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || null;
}

function buildRange(page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const from = (safePage - 1) * limit;
  const to = from + limit - 1;
  return { page: safePage, from, to };
}

function getSortConfig(sort) {
  switch (sort) {
    case "oldest":
      return { column: "posted_at", ascending: true };
    case "points_desc":
      return { column: "points", ascending: false };
    case "points_asc":
      return { column: "points", ascending: true };
    case "status":
      return { column: "transaction_status", ascending: true };
    case "type":
      return { column: "transaction_type", ascending: true };
    case "newest":
    default:
      return { column: "posted_at", ascending: false };
  }
}

function mapProfileSummary(row) {
  if (!row) return null;

  return {
    id: row.id,
    email: row.email || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName:
      row.full_name || getFullName(row.first_name, row.last_name) || null,
    memberStatus: row.member_status || null,
    role: row.role || null,
    tier: row.tier || null,
    referralCode: row.referral_code || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapRewardRule(row) {
  if (!row) return null;

  return {
    id: row.id,
    ruleCode: row.rule_code || null,
    title: row.title || null,
    description: row.description || null,
    eventType: row.event_type || null,
    eventTypeLabel: titleCase(row.event_type || ""),
    pointsAmount: Number(row.points_amount || 0),
    isActive: Boolean(row.is_active),
    stackable: Boolean(row.stackable),
    requiresApproval: Boolean(row.requires_approval),
    startsAt: safeDate(row.starts_at),
    endsAt: safeDate(row.ends_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapRedemption(row) {
  if (!row) return null;

  return {
    id: row.id,
    rewardTransactionId: row.reward_transaction_id || null,
    redemptionCode: row.redemption_code || null,
    rewardName: row.reward_name || null,
    rewardDescription: row.reward_description || null,
    pointsCost: Number(row.points_cost || 0),
    redemptionStatus: row.redemption_status || null,
    redemptionStatusLabel: titleCase(row.redemption_status || ""),
    fulfillmentMethod: row.fulfillment_method || null,
    fulfilledAt: safeDate(row.fulfilled_at),
    requestedAt: safeDate(row.requested_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
    metadata: row.metadata || {},
  };
}

function getTransactionDirection(type) {
  return type === "redeem" || type === "expire" ? "debit" : "credit";
}

function mapTransactionRow(
  row,
  {
    profile,
    rewardRule,
    redemption,
  }
) {
  const transactionType = row.transaction_type || "earn";
  const transactionStatus = row.transaction_status || "posted";
  const points = Number(row.points || 0);
  const direction = getTransactionDirection(transactionType);

  return {
    id: row.id,
    profileId: row.profile_id,
    rewardRuleId: row.reward_rule_id || null,
    transactionType,
    transactionTypeLabel: titleCase(transactionType),
    transactionStatus,
    transactionStatusLabel: titleCase(transactionStatus),
    points,
    signedPoints: direction === "debit" ? -points : points,
    direction,
    title: row.title || null,
    description: row.description || null,
    referenceType: row.reference_type || null,
    referenceTypeLabel: titleCase(row.reference_type || ""),
    referenceId: row.reference_id || null,
    expiresAt: safeDate(row.expires_at),
    postedAt: safeDate(row.posted_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
    metadata: row.metadata || {},

    flags: {
      isPending: transactionStatus === "pending",
      isPosted: transactionStatus === "posted",
      isVoided: transactionStatus === "voided",
      isCredit: direction === "credit",
      isDebit: direction === "debit",
      hasRule: Boolean(row.reward_rule_id),
      hasReference: Boolean(row.reference_type || row.reference_id),
      hasRedemption: Boolean(redemption),
    },

    profile,
    rewardRule,
    redemption,
  };
}

async function getAuthenticatedUser(req) {
  const accessToken = getAccessTokenFromRequest(req);

  if (!accessToken) {
    return { user: null, error: "Missing access token." };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !data?.user) {
    return {
      user: null,
      error: error?.message || "Unable to authenticate this request.",
    };
  }

  return { user: data.user, error: null };
}

async function getAdminContext(profileId) {
  const [profileResult, adminRoleResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, email, first_name, last_name, full_name, role, member_status")
      .eq("id", profileId)
      .maybeSingle(),

    supabaseAdmin
      .from("admin_roles")
      .select(
        "profile_id, is_super_admin, can_manage_members, can_manage_rewards, can_manage_support, can_manage_referrals, can_view_audit_logs, can_manage_settings"
      )
      .eq("profile_id", profileId)
      .maybeSingle(),
  ]);

  return {
    profile: profileResult.data || null,
    profileError: profileResult.error || null,
    adminRole: adminRoleResult.data || null,
    adminRoleError: adminRoleResult.error || null,
  };
}

function applySearch(query, search) {
  if (!search) return query;

  const escaped = search.replaceAll(",", " ").replaceAll("%", "");
  return query.or(
    [
      `title.ilike.%${escaped}%`,
      `description.ilike.%${escaped}%`,
      `transaction_type.ilike.%${escaped}%`,
      `transaction_status.ilike.%${escaped}%`,
      `reference_type.ilike.%${escaped}%`,
    ].join(",")
  );
}

function applyFilters(query, { transactionType, status, referenceType, profileId, rewardRuleId, search }) {
  let nextQuery = query;

  if (transactionType !== "all") {
    nextQuery = nextQuery.eq("transaction_type", transactionType);
  }

  if (status !== "all") {
    nextQuery = nextQuery.eq("transaction_status", status);
  }

  if (referenceType !== "all") {
    nextQuery = nextQuery.eq("reference_type", referenceType);
  }

  if (profileId) {
    nextQuery = nextQuery.eq("profile_id", profileId);
  }

  if (rewardRuleId) {
    nextQuery = nextQuery.eq("reward_rule_id", rewardRuleId);
  }

  nextQuery = applySearch(nextQuery, search);

  return nextQuery;
}

async function getStatusCounts({ transactionType, referenceType, profileId, rewardRuleId, search }) {
  const statuses = ["pending", "posted", "voided"];

  const entries = await Promise.all(
    statuses.map(async (status) => {
      let query = supabaseAdmin
        .from("reward_transactions")
        .select("id", { count: "exact", head: true });

      query = applyFilters(query, {
        transactionType,
        status,
        referenceType,
        profileId,
        rewardRuleId,
        search,
      });

      const { count, error } = await query;

      return {
        status,
        count: error ? 0 : Number(count || 0),
      };
    })
  );

  return entries.reduce((acc, entry) => {
    acc[entry.status] = entry.count;
    return acc;
  }, {});
}

async function getTypeCounts({ status, referenceType, profileId, rewardRuleId, search }) {
  const transactionTypes = ["earn", "redeem", "adjustment", "expire", "reversal", "bonus"];

  const entries = await Promise.all(
    transactionTypes.map(async (transactionType) => {
      let query = supabaseAdmin
        .from("reward_transactions")
        .select("id", { count: "exact", head: true });

      query = applyFilters(query, {
        transactionType,
        status,
        referenceType,
        profileId,
        rewardRuleId,
        search,
      });

      const { count, error } = await query;

      return {
        transactionType,
        count: error ? 0 : Number(count || 0),
      };
    })
  );

  return entries.reduce((acc, entry) => {
    acc[entry.transactionType] = entry.count;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_reward_history" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const rate = adminRateLimit(req, res);

    if (!rate.allowed) {
      return forbidden(res, "Too many admin requests. Please try again later.", {
        retryAfter: rate.retryAfter,
        error: "rate_limited",
      });
    }

    const { user, error: authError } = await getAuthenticatedUser(req);

    if (!user) {
      return unauthorized(res, authError || "Unauthorized.");
    }

    const adminContext = await getAdminContext(user.id);

    if (adminContext.profileError) {
      return serverError(res, "Unable to load admin profile.", {
        error: adminContext.profileError.message,
      });
    }

    if (adminContext.adminRoleError) {
      return serverError(res, "Unable to load admin permissions.", {
        error: adminContext.adminRoleError.message,
      });
    }

    if (!adminContext.profile || !adminContext.adminRole) {
      return forbidden(res, "Admin access is required.");
    }

    if (!adminContext.adminRole.can_manage_rewards && !adminContext.adminRole.is_super_admin) {
      return forbidden(res, "You do not have permission to view reward history.");
    }

    const transactionType = normalizeTransactionType(req.query?.transactionType || req.query?.type);
    const status = normalizeStatus(req.query?.status);
    const referenceType = normalizeReferenceType(req.query?.referenceType);
    const sort = normalizeSort(req.query?.sort);
    const search = normalizeString(req.query?.search);
    const profileId = normalizeString(req.query?.profileId);
    const rewardRuleId = normalizeString(req.query?.rewardRuleId);
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const { page, from, to } = buildRange(req.query?.page, limit);
    const sortConfig = getSortConfig(sort);

    let query = supabaseAdmin
      .from("reward_transactions")
      .select(
        [
          "id",
          "profile_id",
          "reward_rule_id",
          "transaction_type",
          "transaction_status",
          "points",
          "title",
          "description",
          "reference_type",
          "reference_id",
          "metadata",
          "expires_at",
          "posted_at",
          "created_at",
          "updated_at",
        ].join(", "),
        { count: "exact" }
      );

    query = applyFilters(query, {
      transactionType,
      status,
      referenceType,
      profileId,
      rewardRuleId,
      search,
    });

    query = query.order(sortConfig.column, { ascending: sortConfig.ascending });
    query = query.range(from, to);

    const [transactionsResult, statusCounts, typeCounts] = await Promise.all([
      query,
      getStatusCounts({
        transactionType,
        referenceType,
        profileId,
        rewardRuleId,
        search,
      }),
      getTypeCounts({
        status,
        referenceType,
        profileId,
        rewardRuleId,
        search,
      }),
    ]);

    if (transactionsResult.error) {
      return serverError(res, "Unable to load reward history.", {
        error: transactionsResult.error.message,
      });
    }

    const rows = transactionsResult.data || [];
    const profileIds = Array.from(new Set(rows.map((row) => row.profile_id).filter(Boolean)));
    const rewardRuleIds = Array.from(new Set(rows.map((row) => row.reward_rule_id).filter(Boolean)));
    const transactionIds = rows.map((row) => row.id);

    let profileMap = {};
    let rewardRuleMap = {};
    let redemptionMap = {};

    if (profileIds.length > 0) {
      const profilesResult = await supabaseAdmin
        .from("profiles")
        .select(
          "id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, created_at, updated_at"
        )
        .in("id", profileIds);

      if (profilesResult.error) {
        return serverError(res, "Unable to load reward member profiles.", {
          error: profilesResult.error.message,
        });
      }

      profileMap = (profilesResult.data || []).reduce((acc, row) => {
        acc[row.id] = mapProfileSummary(row);
        return acc;
      }, {});
    }

    if (rewardRuleIds.length > 0) {
      const rewardRulesResult = await supabaseAdmin
        .from("reward_rules")
        .select(
          "id, rule_code, title, description, event_type, points_amount, is_active, stackable, requires_approval, starts_at, ends_at, created_at, updated_at"
        )
        .in("id", rewardRuleIds);

      if (rewardRulesResult.error) {
        return serverError(res, "Unable to load reward rules.", {
          error: rewardRulesResult.error.message,
        });
      }

      rewardRuleMap = (rewardRulesResult.data || []).reduce((acc, row) => {
        acc[row.id] = mapRewardRule(row);
        return acc;
      }, {});
    }

    if (transactionIds.length > 0) {
      const redemptionsResult = await supabaseAdmin
        .from("reward_redemptions")
        .select(
          "id, reward_transaction_id, redemption_code, reward_name, reward_description, points_cost, redemption_status, fulfillment_method, fulfilled_at, requested_at, metadata, created_at, updated_at"
        )
        .in("reward_transaction_id", transactionIds);

      if (redemptionsResult.error) {
        return serverError(res, "Unable to load linked redemptions.", {
          error: redemptionsResult.error.message,
        });
      }

      redemptionMap = (redemptionsResult.data || []).reduce((acc, row) => {
        acc[row.reward_transaction_id] = mapRedemption(row);
        return acc;
      }, {});
    }

    const transactions = rows.map((row) =>
      mapTransactionRow(row, {
        profile: profileMap[row.profile_id] || null,
        rewardRule: row.reward_rule_id ? rewardRuleMap[row.reward_rule_id] || null : null,
        redemption: redemptionMap[row.id] || null,
      })
    );

    const total = Number(transactionsResult.count || 0);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

    const summary = transactions.reduce(
      (acc, item) => {
        acc.totalPoints += item.signedPoints;

        if (item.flags.isCredit) {
          acc.creditPoints += item.points;
        }

        if (item.flags.isDebit) {
          acc.debitPoints += item.points;
        }

        if (item.transactionStatus === "posted") {
          acc.postedPoints += item.signedPoints;
        }

        if (item.transactionStatus === "pending") {
          acc.pendingPoints += item.signedPoints;
        }

        if (item.transactionStatus === "voided") {
          acc.voidedCount += 1;
        }

        if (item.transactionType === "redeem") {
          acc.redemptionCount += 1;
        }

        return acc;
      },
      {
        totalPoints: 0,
        creditPoints: 0,
        debitPoints: 0,
        postedPoints: 0,
        pendingPoints: 0,
        voidedCount: 0,
        redemptionCount: 0,
      }
    );

    logRequestSuccess(req, {
      scope: "admin_reward_history",
      adminId: adminContext.profile.id,
      returned: transactions.length,
      total,
      page,
    });

    return ok(
      res,
      {
        admin: {
          id: adminContext.profile.id,
          email: adminContext.profile.email,
          fullName:
            adminContext.profile.full_name ||
            getFullName(
              adminContext.profile.first_name,
              adminContext.profile.last_name
            ) ||
            null,
          isSuperAdmin: Boolean(adminContext.adminRole.is_super_admin),
          canManageRewards: Boolean(adminContext.adminRole.can_manage_rewards),
        },

        filters: {
          transactionTypes: VALID_TRANSACTION_TYPES,
          activeTransactionType: transactionType,
          statuses: VALID_STATUSES,
          activeStatus: status,
          referenceTypes: VALID_REFERENCE_TYPES,
          activeReferenceType: referenceType,
          sorts: VALID_SORTS,
          activeSort: sort,
          search,
          profileId: profileId || "",
          rewardRuleId: rewardRuleId || "",
          limit,
          page,
        },

        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
          from: total === 0 ? 0 : from + 1,
          to: Math.min(to + 1, total),
        },

        summary: {
          total,
          totalPointsNet: summary.totalPoints,
          creditPoints: summary.creditPoints,
          debitPoints: summary.debitPoints,
          postedPointsNet: summary.postedPoints,
          pendingPointsNet: summary.pendingPoints,
          voidedCount: summary.voidedCount,
          redemptionCount: summary.redemptionCount,
          statusCounts: {
            pending: Number(statusCounts.pending || 0),
            posted: Number(statusCounts.posted || 0),
            voided: Number(statusCounts.voided || 0),
          },
          typeCounts: {
            earn: Number(typeCounts.earn || 0),
            redeem: Number(typeCounts.redeem || 0),
            adjustment: Number(typeCounts.adjustment || 0),
            expire: Number(typeCounts.expire || 0),
            reversal: Number(typeCounts.reversal || 0),
            bonus: Number(typeCounts.bonus || 0),
          },
        },

        transactions,
      },
      "Admin reward history loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_reward_history_unexpected" });

    return serverError(
      res,
      "Failed to load admin reward history.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}