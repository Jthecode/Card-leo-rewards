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
import { getAccessTokenFromRequest } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const VALID_STATUSES = [
  "all",
  "pending",
  "active",
  "paused",
  "suspended",
  "closed",
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
  "tier",
];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), max);
}

function normalizeStatus(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizeTier(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return VALID_TIERS.includes(normalized) ? normalized : "all";
}

function normalizeRole(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return VALID_ROLES.includes(normalized) ? normalized : "all";
}

function normalizeSort(value) {
  const normalized = String(value || "newest").trim().toLowerCase();
  return VALID_SORTS.includes(normalized) ? normalized : "newest";
}

function normalizeSearch(value) {
  return String(value || "").trim();
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
      return { column: "created_at", ascending: true };
    case "name":
      return { column: "first_name", ascending: true };
    case "status":
      return { column: "member_status", ascending: true };
    case "tier":
      return { column: "tier", ascending: true };
    case "newest":
    default:
      return { column: "created_at", ascending: false };
  }
}

function mapRewardAccount(row) {
  if (!row) return null;

  return {
    profileId: row.profile_id,
    accountStatus: row.account_status || "active",
    pointsAvailable: Number(row.points_available || 0),
    pointsPending: Number(row.points_pending || 0),
    pointsLifetimeEarned: Number(row.points_lifetime_earned || 0),
    pointsLifetimeRedeemed: Number(row.points_lifetime_redeemed || 0),
    pointsLifetimeExpired: Number(row.points_lifetime_expired || 0),
    lastEarnedAt: safeDate(row.last_earned_at),
    lastRedeemedAt: safeDate(row.last_redeemed_at),
    lastExpiredAt: safeDate(row.last_expired_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapOnboarding(row) {
  if (!row) return null;

  return {
    profileId: row.profile_id,
    acceptedTerms: Boolean(row.accepted_terms),
    acceptedTermsAt: safeDate(row.accepted_terms_at),
    acceptedPrivacy: Boolean(row.accepted_privacy),
    acceptedPrivacyAt: safeDate(row.accepted_privacy_at),
    profileCompleted: Boolean(row.profile_completed),
    profileCompletedAt: safeDate(row.profile_completed_at),
    emailVerified: Boolean(row.email_verified),
    emailVerifiedAt: safeDate(row.email_verified_at),
    firstLoginCompleted: Boolean(row.first_login_completed),
    firstLoginCompletedAt: safeDate(row.first_login_completed_at),
    rewardsActivated: Boolean(row.rewards_activated),
    rewardsActivatedAt: safeDate(row.rewards_activated_at),
    onboardingPercent: Number(row.onboarding_percent || 0),
    onboardingStatus: row.onboarding_status || "not_started",
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapSignup(row) {
  if (!row) return null;

  return {
    id: row.id,
    source: row.source || "website",
    sourceLabel: titleCase(row.source || "website"),
    status: row.status || "new",
    statusLabel: titleCase(row.status || "new"),
    signupPage: row.signup_page || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapAdminRole(row) {
  if (!row) return null;

  return {
    profileId: row.profile_id,
    isSuperAdmin: Boolean(row.is_super_admin),
    canManageMembers: Boolean(row.can_manage_members),
    canManageRewards: Boolean(row.can_manage_rewards),
    canManageSupport: Boolean(row.can_manage_support),
    canManageReferrals: Boolean(row.can_manage_referrals),
    canViewAuditLogs: Boolean(row.can_view_audit_logs),
    canManageSettings: Boolean(row.can_manage_settings),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapMemberRow(
  row,
  {
    rewardAccount,
    onboarding,
    signup,
    adminRole,
    noteCount,
    openSupportCount,
  }
) {
  const fullName =
    row.full_name || getFullName(row.first_name, row.last_name) || null;

  return {
    id: row.id,
    signupId: row.signup_id || null,
    email: row.email || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName,
    phone: row.phone || null,
    avatarUrl: row.avatar_url || null,
    city: row.city || null,
    state: row.state || null,
    memberStatus: row.member_status || "pending",
    memberStatusLabel: titleCase(row.member_status || "pending"),
    role: row.role || "member",
    roleLabel: titleCase(row.role || "member"),
    tier: row.tier || "core",
    tierLabel: titleCase(row.tier || "core"),
    referralCode: row.referral_code || null,
    referredByProfileId: row.referred_by_profile_id || null,
    portalLoginUrl: row.portal_login_url || null,
    lastLoginAt: safeDate(row.last_login_at),
    emailVerifiedAt: safeDate(row.email_verified_at),
    phoneVerifiedAt: safeDate(row.phone_verified_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),

    flags: {
      hasVerifiedEmail:
        Boolean(row.email_verified_at) || Boolean(onboarding?.emailVerified),
      hasVerifiedPhone: Boolean(row.phone_verified_at),
      hasCompletedOnboarding: Boolean(onboarding?.onboardingPercent >= 100),
      hasCompletedProfile: Boolean(onboarding?.profileCompleted),
      hasRewardsActivated: Boolean(onboarding?.rewardsActivated),
      hasPortalLoginUrl: Boolean(row.portal_login_url),
      isAdminOperator: Boolean(adminRole),
      isSuperAdmin: Boolean(adminRole?.isSuperAdmin),
      hasOpenSupportTickets: Number(openSupportCount || 0) > 0,
    },

    metrics: {
      onboardingPercent: Number(onboarding?.onboardingPercent || 0),
      pointsAvailable: Number(rewardAccount?.pointsAvailable || 0),
      pointsPending: Number(rewardAccount?.pointsPending || 0),
      lifetimeEarned: Number(rewardAccount?.pointsLifetimeEarned || 0),
      lifetimeRedeemed: Number(rewardAccount?.pointsLifetimeRedeemed || 0),
      openSupportTickets: Number(openSupportCount || 0),
      noteCount: Number(noteCount || 0),
    },

    rewardAccount,
    onboarding,
    signup,
    adminRole,
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
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `full_name.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`,
      `phone.ilike.%${escaped}%`,
      `city.ilike.%${escaped}%`,
      `state.ilike.%${escaped}%`,
      `member_status.ilike.%${escaped}%`,
      `role.ilike.%${escaped}%`,
      `tier.ilike.%${escaped}%`,
      `referral_code.ilike.%${escaped}%`,
    ].join(",")
  );
}

function applyMemberFilters(query, { status, tier, role, search }) {
  let nextQuery = query;

  if (status && status !== "all") {
    nextQuery = nextQuery.eq("member_status", status);
  }

  if (tier && tier !== "all") {
    nextQuery = nextQuery.eq("tier", tier);
  }

  if (role && role !== "all") {
    nextQuery = nextQuery.eq("role", role);
  }

  nextQuery = applySearch(nextQuery, search);
  return nextQuery;
}

async function getStatusCounts({ search, tier, role }) {
  const statuses = ["pending", "active", "paused", "suspended", "closed"];

  const entries = await Promise.all(
    statuses.map(async (status) => {
      let query = supabaseAdmin
        .from("profiles")
        .select("id", { count: "exact", head: true });

      query = applyMemberFilters(query, {
        status,
        tier,
        role,
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

async function getRoleCounts({ search, status, tier }) {
  const roles = ["member", "admin", "support"];

  const entries = await Promise.all(
    roles.map(async (role) => {
      let query = supabaseAdmin
        .from("profiles")
        .select("id", { count: "exact", head: true });

      query = applyMemberFilters(query, {
        status,
        tier,
        role,
        search,
      });

      const { count, error } = await query;

      return {
        role,
        count: error ? 0 : Number(count || 0),
      };
    })
  );

  return entries.reduce((acc, entry) => {
    acc[entry.role] = entry.count;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_members" });

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

    if (!adminContext.adminRole.can_manage_members && !adminContext.adminRole.is_super_admin) {
      return forbidden(res, "You do not have permission to manage members.");
    }

    const status = normalizeStatus(req.query?.status);
    const tier = normalizeTier(req.query?.tier);
    const role = normalizeRole(req.query?.role);
    const sort = normalizeSort(req.query?.sort);
    const search = normalizeSearch(req.query?.search);
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const { page, from, to } = buildRange(req.query?.page, limit);
    const sortConfig = getSortConfig(sort);

    let query = supabaseAdmin
      .from("profiles")
      .select(
        [
          "id",
          "signup_id",
          "email",
          "first_name",
          "last_name",
          "full_name",
          "phone",
          "avatar_url",
          "city",
          "state",
          "member_status",
          "role",
          "tier",
          "referral_code",
          "referred_by_profile_id",
          "portal_login_url",
          "last_login_at",
          "email_verified_at",
          "phone_verified_at",
          "created_at",
          "updated_at",
        ].join(", "),
        { count: "exact" }
      );

    query = applyMemberFilters(query, { status, tier, role, search });
    query = query.order(sortConfig.column, { ascending: sortConfig.ascending });
    query = query.range(from, to);

    const [profilesResult, statusCounts, roleCounts] = await Promise.all([
      query,
      getStatusCounts({ search, tier, role }),
      getRoleCounts({ search, status, tier }),
    ]);

    if (profilesResult.error) {
      return serverError(res, "Unable to load members.", {
        error: profilesResult.error.message,
      });
    }

    const rows = profilesResult.data || [];
    const profileIds = rows.map((row) => row.id);
    const signupIds = rows.map((row) => row.signup_id).filter(Boolean);

    let rewardAccountMap = {};
    let onboardingMap = {};
    let signupMap = {};
    let adminRoleMap = {};
    let noteCountMap = {};
    let supportCountMap = {};

    if (profileIds.length > 0) {
      const [
        rewardAccountsResult,
        onboardingResult,
        adminRolesResult,
        adminNotesResult,
        supportTicketsResult,
      ] = await Promise.all([
        supabaseAdmin
          .from("reward_accounts")
          .select(
            "profile_id, account_status, points_available, points_pending, points_lifetime_earned, points_lifetime_redeemed, points_lifetime_expired, last_earned_at, last_redeemed_at, last_expired_at, created_at, updated_at"
          )
          .in("profile_id", profileIds),

        supabaseAdmin
          .from("member_onboarding")
          .select(
            "profile_id, accepted_terms, accepted_terms_at, accepted_privacy, accepted_privacy_at, profile_completed, profile_completed_at, email_verified, email_verified_at, first_login_completed, first_login_completed_at, rewards_activated, rewards_activated_at, onboarding_percent, onboarding_status, created_at, updated_at"
          )
          .in("profile_id", profileIds),

        supabaseAdmin
          .from("admin_roles")
          .select(
            "profile_id, is_super_admin, can_manage_members, can_manage_rewards, can_manage_support, can_manage_referrals, can_view_audit_logs, can_manage_settings, created_at, updated_at"
          )
          .in("profile_id", profileIds),

        supabaseAdmin
          .from("admin_notes")
          .select("target_profile_id")
          .in("target_profile_id", profileIds),

        supabaseAdmin
          .from("support_tickets")
          .select("profile_id, status")
          .in("profile_id", profileIds)
          .in("status", ["open", "in_progress", "waiting_on_member"]),
      ]);

      if (rewardAccountsResult.error) {
        return serverError(res, "Unable to load reward account data.", {
          error: rewardAccountsResult.error.message,
        });
      }

      if (onboardingResult.error) {
        return serverError(res, "Unable to load onboarding data.", {
          error: onboardingResult.error.message,
        });
      }

      if (adminRolesResult.error) {
        return serverError(res, "Unable to load member admin roles.", {
          error: adminRolesResult.error.message,
        });
      }

      if (adminNotesResult.error) {
        return serverError(res, "Unable to load member notes.", {
          error: adminNotesResult.error.message,
        });
      }

      if (supportTicketsResult.error) {
        return serverError(res, "Unable to load member support counts.", {
          error: supportTicketsResult.error.message,
        });
      }

      rewardAccountMap = (rewardAccountsResult.data || []).reduce((acc, row) => {
        acc[row.profile_id] = mapRewardAccount(row);
        return acc;
      }, {});

      onboardingMap = (onboardingResult.data || []).reduce((acc, row) => {
        acc[row.profile_id] = mapOnboarding(row);
        return acc;
      }, {});

      adminRoleMap = (adminRolesResult.data || []).reduce((acc, row) => {
        acc[row.profile_id] = mapAdminRole(row);
        return acc;
      }, {});

      noteCountMap = (adminNotesResult.data || []).reduce((acc, row) => {
        const key = row.target_profile_id;
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {});

      supportCountMap = (supportTicketsResult.data || []).reduce((acc, row) => {
        const key = row.profile_id;
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {});
    }

    if (signupIds.length > 0) {
      const signupsResult = await supabaseAdmin
        .from("signups")
        .select("id, source, status, signup_page, created_at, updated_at")
        .in("id", signupIds);

      if (signupsResult.error) {
        return serverError(res, "Unable to load member signup links.", {
          error: signupsResult.error.message,
        });
      }

      signupMap = (signupsResult.data || []).reduce((acc, row) => {
        acc[row.id] = mapSignup(row);
        return acc;
      }, {});
    }

    const members = rows.map((row) =>
      mapMemberRow(row, {
        rewardAccount: rewardAccountMap[row.id] || null,
        onboarding: onboardingMap[row.id] || null,
        signup: row.signup_id ? signupMap[row.signup_id] || null : null,
        adminRole: adminRoleMap[row.id] || null,
        noteCount: noteCountMap[row.id] || 0,
        openSupportCount: supportCountMap[row.id] || 0,
      })
    );

    const total = Number(profilesResult.count || 0);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

    logRequestSuccess(req, {
      scope: "admin_members",
      adminId: adminContext.profile.id,
      returned: members.length,
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
          canManageMembers: Boolean(adminContext.adminRole.can_manage_members),
        },

        filters: {
          statuses: VALID_STATUSES,
          activeStatus: status,
          tiers: VALID_TIERS,
          activeTier: tier,
          roles: VALID_ROLES,
          activeRole: role,
          sorts: VALID_SORTS,
          activeSort: sort,
          search,
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
          statusCounts: {
            pending: Number(statusCounts.pending || 0),
            active: Number(statusCounts.active || 0),
            paused: Number(statusCounts.paused || 0),
            suspended: Number(statusCounts.suspended || 0),
            closed: Number(statusCounts.closed || 0),
          },
          roleCounts: {
            member: Number(roleCounts.member || 0),
            admin: Number(roleCounts.admin || 0),
            support: Number(roleCounts.support || 0),
          },
          activeMembers: Number(statusCounts.active || 0),
          adminOperators: Number(roleCounts.admin || 0),
          supportOperators: Number(roleCounts.support || 0),
        },

        members,
      },
      "Admin members loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_members_unexpected" });

    return serverError(
      res,
      "Failed to load admin members.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}