// api/portal/activity.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { getAccessTokenFromRequest } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const VALID_CATEGORIES = ["all", "account", "rewards", "support", "referrals", "system"];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), MAX_LIMIT);
}

function normalizeCategory(value) {
  const category = String(value || "all").trim().toLowerCase();
  return VALID_CATEGORIES.includes(category) ? category : "all";
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function activityTypeToCategory(type) {
  const normalized = String(type || "").toLowerCase();

  if (
    [
      "reward_earned",
      "reward_redeemed",
      "reward_expired",
      "reward_adjusted",
      "reward_bonus",
      "membership_payment_recorded",
      "cardleo_allocation",
      "direct_referral_bonus",
      "override_referral_bonus",
      "company_building_accrual",
      "company_building_release",
      "company_building_forfeit",
      "payout",
    ].includes(normalized)
  ) {
    return "rewards";
  }

  if (["support_ticket_created", "support_ticket_replied", "support_updated"].includes(normalized)) {
    return "support";
  }

  if (
    ["referral_invited", "referral_opened", "referral_registered", "referral_rewarded"].includes(
      normalized
    )
  ) {
    return "referrals";
  }

  if (["system_notice", "admin_note"].includes(normalized)) {
    return "system";
  }

  return "account";
}

function mapMemberActivityRow(row) {
  const category = activityTypeToCategory(row.activity_type);

  return {
    id: `member_activity:${row.id}`,
    source: "member_activity",
    category,
    type: row.activity_type,
    title: row.title || titleCase(row.activity_type),
    description: row.description || null,
    status: null,
    badge: titleCase(category),
    occurredAt: safeDate(row.occurred_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: row.metadata || {},
  };
}

function mapRewardTransactionRow(row) {
  return {
    id: `reward_transaction:${row.id}`,
    source: "reward_transactions",
    category: "rewards",
    type: row.transaction_type || "reward_activity",
    title: row.title || titleCase(row.transaction_type || "reward activity"),
    description:
      row.description ||
      `${money(row.amount)} USD • ${titleCase(row.transaction_status || "posted")}`,
    status: row.transaction_status || null,
    badge: `$${money(row.amount).toFixed(2)}`,
    occurredAt: safeDate(row.posted_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: {
      amount: money(row.amount),
      transactionType: row.transaction_type || null,
      transactionStatus: row.transaction_status || null,
      referenceType: row.reference_type || null,
      referenceId: row.reference_id || null,
      currencyCode: row.currency_code || "USD",
    },
  };
}

function mapSupportTicketRow(row) {
  return {
    id: `support_ticket:${row.id}`,
    source: "support_tickets",
    category: "support",
    type: "support_ticket_created",
    title: row.subject || `Support Ticket ${row.ticket_number || ""}`.trim(),
    description: `Status: ${titleCase(row.status || "open")} • Priority: ${titleCase(
      row.priority || "normal"
    )}`,
    status: row.status || null,
    badge: row.ticket_number || "Ticket",
    occurredAt: safeDate(row.last_message_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: {
      ticketId: row.id,
      ticketNumber: row.ticket_number || null,
      category: row.category || null,
      priority: row.priority || null,
      source: row.source || null,
    },
  };
}

function mapReferralRow(row, profileId) {
  const isReferrer = row.referrer_profile_id === profileId;
  const stateTitleMap = {
    invited: "Referral Invite Sent",
    opened: "Referral Invite Opened",
    registered: "Referral Registered",
    activated: "Referral Activated",
    reward_pending: "Referral Reward Pending",
    rewarded: "Referral Rewarded",
    expired: "Referral Expired",
    cancelled: "Referral Cancelled",
  };

  return {
    id: `referral:${row.id}`,
    source: "referrals",
    category: "referrals",
    type: `referral_${row.status || "updated"}`,
    title: isReferrer
      ? stateTitleMap[row.status] || "Referral Activity"
      : "You Joined Through a Referral",
    description: isReferrer
      ? `Referred: ${row.referred_email || "Member"}`
      : `Referral code: ${row.referral_code || "N/A"}`,
    status: row.status || null,
    badge: row.invite_code || row.referral_code || "Referral",
    occurredAt: safeDate(
      row.rewarded_at ||
        row.activated_at ||
        row.registered_at ||
        row.opened_at ||
        row.invited_at ||
        row.created_at
    ),
    createdAt: safeDate(row.created_at),
    metadata: {
      referralId: row.id,
      isReferrer,
      referredEmail: row.referred_email || null,
      inviteCode: row.invite_code || null,
      referralCode: row.referral_code || null,
      source: row.source || null,
      channel: row.channel || null,
    },
  };
}

function filterByCategory(items, category) {
  if (category === "all") return items;
  return items.filter((item) => item.category === category);
}

function sortByOccurredAtDesc(items) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

function summarizeFeed(items) {
  const summary = {
    total: items.length,
    byCategory: {
      account: 0,
      rewards: 0,
      support: 0,
      referrals: 0,
      system: 0,
    },
    latestAt: null,
  };

  for (const item of items) {
    if (summary.byCategory[item.category] !== undefined) {
      summary.byCategory[item.category] += 1;
    }
  }

  if (items.length > 0) {
    summary.latestAt = items[0].occurredAt || items[0].createdAt || null;
  }

  return summary;
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

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_activity" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { user, error: authError } = await getAuthenticatedUser(req);

    if (!user) {
      return unauthorized(res, authError || "Unauthorized.");
    }

    const profileId = user.id;
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT);
    const category = normalizeCategory(req.query?.category);

    const [
      profileResult,
      memberActivityResult,
      rewardTransactionsResult,
      supportTicketsResult,
      referralsResult,
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select(
          "id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, created_at"
        )
        .eq("id", profileId)
        .maybeSingle(),

      supabaseAdmin
        .from("member_activity")
        .select(
          "id, activity_type, title, description, metadata, occurred_at, created_at"
        )
        .eq("profile_id", profileId)
        .order("occurred_at", { ascending: false })
        .limit(Math.max(limit, 20)),

      supabaseAdmin
        .from("reward_transactions")
        .select(
          "id, transaction_type, transaction_status, amount, currency_code, title, description, reference_type, reference_id, posted_at, created_at"
        )
        .eq("profile_id", profileId)
        .order("posted_at", { ascending: false })
        .limit(Math.max(limit, 20)),

      supabaseAdmin
        .from("support_tickets")
        .select(
          "id, ticket_number, subject, category, priority, status, source, last_message_at, created_at"
        )
        .eq("profile_id", profileId)
        .order("last_message_at", { ascending: false })
        .limit(Math.max(limit, 20)),

      supabaseAdmin
        .from("referrals")
        .select(
          "id, referrer_profile_id, referred_profile_id, referral_code, invite_code, referred_email, status, source, channel, invited_at, opened_at, registered_at, activated_at, rewarded_at, created_at"
        )
        .or(`referrer_profile_id.eq.${profileId},referred_profile_id.eq.${profileId}`)
        .order("created_at", { ascending: false })
        .limit(Math.max(limit, 20)),
    ]);

    if (profileResult.error) {
      return serverError(res, "Unable to load member profile.", {
        error: profileResult.error.message,
      });
    }

    if (!profileResult.data) {
      return notFound(res, "Member profile not found.");
    }

    const queryErrors = [
      memberActivityResult.error,
      rewardTransactionsResult.error,
      supportTicketsResult.error,
      referralsResult.error,
    ].filter(Boolean);

    if (queryErrors.length > 0) {
      return serverError(res, "Unable to load activity feed.", {
        error: queryErrors[0].message || "Unknown activity query error.",
      });
    }

    const memberActivityItems = (memberActivityResult.data || []).map(mapMemberActivityRow);
    const rewardItems = (rewardTransactionsResult.data || []).map(mapRewardTransactionRow);
    const supportItems = (supportTicketsResult.data || []).map(mapSupportTicketRow);
    const referralItems = (referralsResult.data || []).map((row) =>
      mapReferralRow(row, profileId)
    );

    const combinedFeed = sortByOccurredAtDesc([
      ...memberActivityItems,
      ...rewardItems,
      ...supportItems,
      ...referralItems,
    ]);

    const filteredFeed = filterByCategory(combinedFeed, category).slice(0, limit);
    const summary = summarizeFeed(filteredFeed);

    logRequestSuccess(req, {
      scope: "portal_activity",
      profileId,
      requestedCategory: category,
      returnedItems: filteredFeed.length,
    });

    return ok(
      res,
      {
        summary: {
          profileId: profileResult.data.id,
          memberName:
            profileResult.data.full_name ||
            [profileResult.data.first_name, profileResult.data.last_name]
              .filter(Boolean)
              .join(" "),
          email: profileResult.data.email,
          memberStatus: profileResult.data.member_status,
          tier: profileResult.data.tier,
          requestedCategory: category,
          requestedLimit: limit,
          totals: summary,
        },
        filters: {
          categories: VALID_CATEGORIES,
          activeCategory: category,
          limit,
        },
        feed: filteredFeed,
      },
      "Activity loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_activity_unexpected" });

    return serverError(
      res,
      "Failed to load portal activity.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}