// api/admin/adjust-rewards.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
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

const VALID_DIRECTIONS = ["credit", "debit"];
const VALID_STATUSES = ["posted", "pending"];
const VALID_REFERENCE_TYPES = [
  "manual",
  "promo",
  "system",
  "support_ticket",
  "other",
];

function getRequestBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeDirection(value) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_DIRECTIONS.includes(normalized) ? normalized : "credit";
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "posted";
}

function normalizeReferenceType(value) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_REFERENCE_TYPES.includes(normalized) ? normalized : "manual";
}

function toPositiveInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }

  return fallback;
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

function parseIsoDate(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (Array.isArray(forwardedFor)) {
    return forwardedFor[0] || null;
  }

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim() || null;
  }

  return null;
}

function mapProfileSummary(row) {
  if (!row) return null;

  return {
    id: row.id,
    signupId: row.signup_id || null,
    email: row.email || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName:
      row.full_name || getFullName(row.first_name, row.last_name) || null,
    memberStatus: row.member_status || null,
    role: row.role || null,
    tier: row.tier || null,
    referralCode: row.referral_code || null,
    portalLoginUrl: row.portal_login_url || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
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

function mapTransaction(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileId: row.profile_id,
    rewardRuleId: row.reward_rule_id || null,
    transactionType: row.transaction_type || null,
    transactionTypeLabel: titleCase(row.transaction_type || ""),
    transactionStatus: row.transaction_status || null,
    transactionStatusLabel: titleCase(row.transaction_status || ""),
    points: Number(row.points || 0),
    title: row.title || null,
    description: row.description || null,
    referenceType: row.reference_type || null,
    referenceTypeLabel: titleCase(row.reference_type || ""),
    referenceId: row.reference_id || null,
    metadata: row.metadata || {},
    expiresAt: safeDate(row.expires_at),
    postedAt: safeDate(row.posted_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
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

async function loadMember(profileId) {
  const [profileResult, rewardAccountResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select(
        "id, signup_id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, portal_login_url, created_at, updated_at"
      )
      .eq("id", profileId)
      .maybeSingle(),

    supabaseAdmin
      .from("reward_accounts")
      .select(
        "profile_id, account_status, points_available, points_pending, points_lifetime_earned, points_lifetime_redeemed, points_lifetime_expired, last_earned_at, last_redeemed_at, last_expired_at, created_at, updated_at"
      )
      .eq("profile_id", profileId)
      .maybeSingle(),
  ]);

  return {
    profile: profileResult.data || null,
    profileError: profileResult.error || null,
    rewardAccount: rewardAccountResult.data || null,
    rewardAccountError: rewardAccountResult.error || null,
  };
}

async function ensureRewardAccount(profileId) {
  const result = await supabaseAdmin.rpc("ensure_reward_account", {
    p_profile_id: profileId,
  });

  if (result.error) {
    throw new Error(`Unable to ensure reward account: ${result.error.message}`);
  }
}

async function syncRewardAccount(profileId) {
  const result = await supabaseAdmin.rpc("sync_reward_account", {
    p_profile_id: profileId,
  });

  if (result.error) {
    throw new Error(`Unable to sync reward account: ${result.error.message}`);
  }
}

async function createMemberActivity({
  profileId,
  direction,
  points,
  title,
  description,
  adminProfileId,
  transactionId,
}) {
  const activityType = direction === "debit" ? "reward_redeemed" : "reward_earned";

  const result = await supabaseAdmin.from("member_activity").insert({
    profile_id: profileId,
    activity_type: activityType,
    title:
      title ||
      (direction === "debit" ? "Manual Rewards Debit" : "Manual Rewards Credit"),
    description:
      description ||
      `${direction === "debit" ? "-" : "+"}${Number(points || 0).toLocaleString()} points adjusted by support.`,
    metadata: {
      source: "admin_adjust_rewards",
      adjusted_by_profile_id: adminProfileId,
      transaction_id: transactionId,
      direction,
      points: Number(points || 0),
    },
  });

  if (result.error) {
    throw new Error(`Unable to create member activity: ${result.error.message}`);
  }
}

async function createAdminNote({
  actorProfileId,
  targetProfileId,
  points,
  direction,
  title,
  note,
}) {
  const cleanNote = normalizeText(note);
  if (!cleanNote) return;

  const result = await supabaseAdmin.from("admin_notes").insert({
    author_profile_id: actorProfileId,
    target_profile_id: targetProfileId,
    entity_type: "reward_account",
    entity_id: targetProfileId,
    title:
      normalizeText(title) ||
      (direction === "debit" ? "Manual Rewards Debit" : "Manual Rewards Credit"),
    note: `${direction === "debit" ? "-" : "+"}${Number(points || 0).toLocaleString()} pts — ${cleanNote}`,
    is_internal: true,
  });

  if (result.error) {
    throw new Error(`Unable to create admin note: ${result.error.message}`);
  }
}

async function createAuditLog({
  actorProfileId,
  targetProfileId,
  transactionId,
  direction,
  points,
  req,
  status,
  title,
  description,
  metadata,
}) {
  const result = await supabaseAdmin.from("admin_audit_logs").insert({
    actor_profile_id: actorProfileId,
    target_profile_id: targetProfileId,
    entity_type: "reward_transaction",
    entity_id: transactionId,
    action: direction === "debit" ? "manual_reward_debit" : "manual_reward_credit",
    title:
      title ||
      (direction === "debit" ? "Manual rewards debit" : "Manual rewards credit"),
    description:
      description ||
      `${direction === "debit" ? "-" : "+"}${Number(points || 0).toLocaleString()} points (${status}).`,
    metadata: {
      direction,
      points: Number(points || 0),
      transaction_status: status,
      ...(metadata || {}),
    },
    ip_address: getClientIp(req),
    user_agent: req.headers["user-agent"] || null,
  });

  if (result.error) {
    throw new Error(`Unable to create admin audit log: ${result.error.message}`);
  }
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_adjust_rewards" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rate = adminRateLimit(req, res);

    if (!rate.allowed) {
      return badRequest(
        res,
        "Too many admin reward adjustment requests. Please try again later.",
        { retryAfter: rate.retryAfter },
        { statusCode: 429, error: "rate_limited" }
      );
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
      return forbidden(res, "You do not have permission to adjust rewards.");
    }

    const body = getRequestBody(req);

    const profileId = normalizeText(body.profileId);
    const direction = normalizeDirection(body.direction);
    const points = toPositiveInteger(body.points);
    const status = normalizeStatus(body.status);
    const referenceType = normalizeReferenceType(body.referenceType);
    const referenceId = normalizeText(body.referenceId) || null;
    const title =
      normalizeText(body.title) ||
      (direction === "debit" ? "Manual Rewards Debit" : "Manual Rewards Credit");
    const description = normalizeText(body.description);
    const note = normalizeText(body.note || body.adminNote);
    const expiresAt = parseIsoDate(body.expiresAt);
    const allowInsufficientBalance = normalizeBoolean(body.allowInsufficientBalance, false);
    const createActivity = normalizeBoolean(body.createActivity, true);

    if (!profileId) {
      return badRequest(res, "profileId is required.");
    }

    if (!points) {
      return badRequest(res, "points must be a positive whole number.");
    }

    if (!title) {
      return badRequest(res, "title is required.");
    }

    const memberContext = await loadMember(profileId);

    if (memberContext.profileError) {
      return serverError(res, "Unable to load member profile.", {
        error: memberContext.profileError.message,
      });
    }

    if (memberContext.rewardAccountError) {
      return serverError(res, "Unable to load reward account.", {
        error: memberContext.rewardAccountError.message,
      });
    }

    if (!memberContext.profile) {
      return notFound(res, "Member profile not found.");
    }

    await ensureRewardAccount(profileId);

    const rewardAccountBefore =
      memberContext.rewardAccount ||
      (await loadMember(profileId)).rewardAccount ||
      null;

    if (direction === "debit" && status === "posted") {
      const available = Number(rewardAccountBefore?.points_available || 0);

      if (!allowInsufficientBalance && points > available) {
        return badRequest(
          res,
          "This debit exceeds the member's available reward balance.",
          {
            availablePoints: available,
            requestedDebitPoints: points,
          }
        );
      }
    }

    const transactionType = direction === "debit" ? "expire" : "adjustment";

    const transactionInsert = await supabaseAdmin
      .from("reward_transactions")
      .insert({
        profile_id: profileId,
        reward_rule_id: null,
        transaction_type: transactionType,
        transaction_status: status,
        points,
        title,
        description:
          description ||
          (direction === "debit"
            ? "Manual reward debit created by admin."
            : "Manual reward credit created by admin."),
        reference_type: referenceType,
        reference_id: referenceId,
        expires_at: expiresAt,
        metadata: {
          source: "admin_adjust_rewards",
          adjusted_by_profile_id: adminContext.profile.id,
          direction,
          manual: true,
          allow_insufficient_balance: allowInsufficientBalance,
        },
      })
      .select(
        "id, profile_id, reward_rule_id, transaction_type, transaction_status, points, title, description, reference_type, reference_id, metadata, expires_at, posted_at, created_at, updated_at"
      )
      .maybeSingle();

    if (transactionInsert.error) {
      return serverError(res, "Unable to create reward adjustment.", {
        error: transactionInsert.error.message,
      });
    }

    const transaction = transactionInsert.data;

    if (!transaction) {
      return serverError(res, "Reward adjustment was not created.");
    }

    await syncRewardAccount(profileId);

    const rewardAccountAfterResult = await supabaseAdmin
      .from("reward_accounts")
      .select(
        "profile_id, account_status, points_available, points_pending, points_lifetime_earned, points_lifetime_redeemed, points_lifetime_expired, last_earned_at, last_redeemed_at, last_expired_at, created_at, updated_at"
      )
      .eq("profile_id", profileId)
      .maybeSingle();

    if (rewardAccountAfterResult.error) {
      return serverError(res, "Unable to load updated reward account.", {
        error: rewardAccountAfterResult.error.message,
      });
    }

    const rewardAccountAfter = rewardAccountAfterResult.data || null;

    if (createActivity && status === "posted") {
      await createMemberActivity({
        profileId,
        direction,
        points,
        title,
        description,
        adminProfileId: adminContext.profile.id,
        transactionId: transaction.id,
      });
    }

    if (note) {
      await createAdminNote({
        actorProfileId: adminContext.profile.id,
        targetProfileId: profileId,
        points,
        direction,
        title,
        note,
      });
    }

    await createAuditLog({
      actorProfileId: adminContext.profile.id,
      targetProfileId: profileId,
      transactionId: transaction.id,
      direction,
      points,
      req,
      status,
      title,
      description,
      metadata: {
        profile_id: profileId,
        reference_type: referenceType,
        reference_id: referenceId,
        before_points_available: Number(rewardAccountBefore?.points_available || 0),
        after_points_available: Number(rewardAccountAfter?.points_available || 0),
      },
    });

    logRequestSuccess(req, {
      scope: "admin_adjust_rewards",
      adminId: adminContext.profile.id,
      profileId,
      transactionId: transaction.id,
      direction,
      points,
      status,
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

        member: mapProfileSummary(memberContext.profile),

        adjustment: {
          direction,
          directionLabel: titleCase(direction),
          status,
          statusLabel: titleCase(status),
          points,
          signedPoints: direction === "debit" ? -points : points,
        },

        transaction: mapTransaction(transaction),

        rewardAccountBefore: mapRewardAccount(rewardAccountBefore),
        rewardAccountAfter: mapRewardAccount(rewardAccountAfter),
      },
      direction === "debit"
        ? "Rewards debit created successfully."
        : "Rewards credit created successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_adjust_rewards_unexpected" });

    return serverError(
      res,
      "Failed to adjust rewards.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}