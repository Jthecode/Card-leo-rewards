// api/portal/referrals.js

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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = [
  "all",
  "invited",
  "opened",
  "registered",
  "activated",
  "reward_pending",
  "rewarded",
  "expired",
  "cancelled",
];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), MAX_LIMIT);
}

function normalizeStatus(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizeChannel(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSource(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
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

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function getStatusLabel(status) {
  const map = {
    invited: "Invited",
    opened: "Opened",
    registered: "Registered",
    activated: "Activated",
    reward_pending: "Reward Pending",
    rewarded: "Rewarded",
    expired: "Expired",
    cancelled: "Cancelled",
  };

  return map[String(status || "").toLowerCase()] || titleCase(status || "unknown");
}

function getStatusTone(status) {
  const map = {
    invited: "neutral",
    opened: "info",
    registered: "info",
    activated: "success",
    reward_pending: "warning",
    rewarded: "success",
    expired: "muted",
    cancelled: "danger",
  };

  return map[String(status || "").toLowerCase()] || "neutral";
}

function getReferralOccurredAt(row) {
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

function getReferralProgress(status) {
  const map = {
    invited: 15,
    opened: 30,
    registered: 55,
    activated: 75,
    reward_pending: 90,
    rewarded: 100,
    expired: 0,
    cancelled: 0,
  };

  return map[String(status || "").toLowerCase()] ?? 0;
}

function buildShareLink(referralCode, origin) {
  if (!referralCode) return null;

  const safeOrigin =
    String(origin || "").trim() ||
    "https://www.cardleorewards.com";

  try {
    const url = new URL("/signup.html", safeOrigin);
    url.searchParams.set("ref", referralCode);
    return url.toString();
  } catch {
    return `${safeOrigin.replace(/\/+$/, "")}/signup.html?ref=${encodeURIComponent(
      referralCode
    )}`;
  }
}

function parseOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host || "";
  const proto = forwardedProto || (host.includes("localhost") ? "http" : "https");

  if (!host) return "https://www.cardleorewards.com";
  return `${proto}://${host}`;
}

function mapReferralRow(row, profile) {
  const status = String(row.status || "invited").toLowerCase();
  const occurredAt = getReferralOccurredAt(row);

  return {
    id: row.id,
    referralId: row.id,
    referralCode: row.referral_code || profile?.referral_code || null,
    inviteCode: row.invite_code || null,
    referredEmail: row.referred_email || null,
    referredFirstName: row.referred_first_name || null,
    referredLastName: row.referred_last_name || null,
    referredName:
      [row.referred_first_name, row.referred_last_name].filter(Boolean).join(" ") ||
      null,
    referredSignupId: row.referred_signup_id || null,
    referredProfileId: row.referred_profile_id || null,
    rewardTransactionId: row.reward_transaction_id || null,
    rewardAmount: money(row.reward_amount),
    status,
    statusLabel: getStatusLabel(status),
    statusTone: getStatusTone(status),
    progressPercent: getReferralProgress(status),
    source: row.source || null,
    sourceLabel: titleCase(row.source || ""),
    channel: row.channel || null,
    channelLabel: titleCase(row.channel || ""),
    notes: row.notes || null,
    metadata: row.metadata || {},
    invitedAt: safeDate(row.invited_at),
    openedAt: safeDate(row.opened_at),
    registeredAt: safeDate(row.registered_at),
    activatedAt: safeDate(row.activated_at),
    rewardedAt: safeDate(row.rewarded_at),
    expiredAt: safeDate(row.expired_at),
    cancelledAt: safeDate(row.cancelled_at),
    occurredAt: safeDate(occurredAt),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapEventRow(row) {
  return {
    id: row.id,
    referralId: row.referral_id,
    eventType: row.event_type || null,
    eventLabel: titleCase(row.event_type || ""),
    title: row.title || titleCase(row.event_type || "event"),
    description: row.description || null,
    metadata: row.metadata || {},
    occurredAt: safeDate(row.occurred_at),
    createdAt: safeDate(row.created_at),
  };
}

function summarizeReferrals(referrals) {
  const summary = {
    total: referrals.length,
    invited: 0,
    opened: 0,
    registered: 0,
    activated: 0,
    rewardPending: 0,
    rewarded: 0,
    expired: 0,
    cancelled: 0,
    totalRewardAmount: 0,
    conversionRatePercent: 0,
    rewardRatePercent: 0,
    latestAt: null,
  };

  for (const referral of referrals) {
    switch (referral.status) {
      case "invited":
        summary.invited += 1;
        break;
      case "opened":
        summary.opened += 1;
        break;
      case "registered":
        summary.registered += 1;
        break;
      case "activated":
        summary.activated += 1;
        break;
      case "reward_pending":
        summary.rewardPending += 1;
        break;
      case "rewarded":
        summary.rewarded += 1;
        break;
      case "expired":
        summary.expired += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      default:
        break;
    }

    summary.totalRewardAmount += money(referral.rewardAmount);
  }

  const conversionBase = referrals.length;
  const convertedCount =
    summary.registered +
    summary.activated +
    summary.rewardPending +
    summary.rewarded;
  const rewardedCount = summary.rewarded;

  summary.conversionRatePercent =
    conversionBase > 0 ? Math.round((convertedCount / conversionBase) * 100) : 0;

  summary.rewardRatePercent =
    conversionBase > 0 ? Math.round((rewardedCount / conversionBase) * 100) : 0;

  summary.totalRewardAmount = money(summary.totalRewardAmount);

  if (referrals.length > 0) {
    const latest = [...referrals].sort((a, b) => {
      const aTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    })[0];

    summary.latestAt = latest?.occurredAt || latest?.createdAt || null;
  }

  return summary;
}

function filterReferrals(referrals, status, channel, source, search) {
  const normalizedSearch = String(search || "").trim().toLowerCase();

  return referrals.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (channel && normalizeChannel(item.channel) !== channel) return false;
    if (source && normalizeSource(item.source) !== source) return false;

    if (normalizedSearch) {
      const haystack = [
        item.referredEmail,
        item.referredFirstName,
        item.referredLastName,
        item.referredName,
        item.inviteCode,
        item.referralCode,
        item.statusLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(normalizedSearch)) return false;
    }

    return true;
  });
}

function sortReferralsByOccurredAtDesc(referrals) {
  return [...referrals].sort((a, b) => {
    const aTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.occurredAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
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
  logRequestStart(req, { scope: "portal_referrals" });

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
    const status = normalizeStatus(req.query?.status);
    const channel = normalizeChannel(req.query?.channel);
    const source = normalizeSource(req.query?.source);
    const search = String(req.query?.search || "").trim();
    const origin = parseOrigin(req);

    const [profileResult, referralsResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select(
          "id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, created_at"
        )
        .eq("id", profileId)
        .maybeSingle(),

      supabaseAdmin
        .from("referrals")
        .select(
          [
            "id",
            "referrer_profile_id",
            "referred_signup_id",
            "referred_profile_id",
            "reward_transaction_id",
            "reward_amount",
            "referral_code",
            "invite_code",
            "referred_email",
            "referred_first_name",
            "referred_last_name",
            "status",
            "source",
            "channel",
            "notes",
            "metadata",
            "invited_at",
            "opened_at",
            "registered_at",
            "activated_at",
            "rewarded_at",
            "expired_at",
            "cancelled_at",
            "created_at",
            "updated_at",
          ].join(", ")
        )
        .eq("referrer_profile_id", profileId)
        .order("created_at", { ascending: false })
        .limit(MAX_LIMIT),
    ]);

    if (profileResult.error) {
      return serverError(res, "Unable to load member profile.", {
        error: profileResult.error.message,
      });
    }

    if (!profileResult.data) {
      return notFound(res, "Member profile not found.");
    }

    if (referralsResult.error) {
      return serverError(res, "Unable to load referrals.", {
        error: referralsResult.error.message,
      });
    }

    const profile = profileResult.data;
    const referrals = (referralsResult.data || []).map((row) =>
      mapReferralRow(row, profile)
    );

    const filteredReferrals = sortReferralsByOccurredAtDesc(
      filterReferrals(referrals, status, channel, source, search)
    );

    const pagedReferrals = filteredReferrals.slice(0, limit);
    const visibleReferralIds = pagedReferrals.map((item) => item.id);

    let eventsByReferralId = {};

    if (visibleReferralIds.length > 0) {
      const eventsResult = await supabaseAdmin
        .from("referral_events")
        .select("id, referral_id, event_type, title, description, metadata, occurred_at, created_at")
        .in("referral_id", visibleReferralIds)
        .order("occurred_at", { ascending: false });

      if (eventsResult.error) {
        return serverError(res, "Unable to load referral timeline events.", {
          error: eventsResult.error.message,
        });
      }

      eventsByReferralId = (eventsResult.data || []).reduce((acc, row) => {
        const key = row.referral_id;
        if (!acc[key]) acc[key] = [];
        acc[key].push(mapEventRow(row));
        return acc;
      }, {});
    }

    const enrichedReferrals = pagedReferrals.map((referral) => ({
      ...referral,
      shareLink: buildShareLink(referral.referralCode, origin),
      timeline: eventsByReferralId[referral.id] || [],
    }));

    const allChannels = Array.from(
      new Set(
        referrals
          .map((item) => item.channel)
          .filter(Boolean)
          .map((value) => normalizeChannel(value))
      )
    ).sort();

    const allSources = Array.from(
      new Set(
        referrals
          .map((item) => item.source)
          .filter(Boolean)
          .map((value) => normalizeSource(value))
      )
    ).sort();

    const summary = summarizeReferrals(filteredReferrals);

    logRequestSuccess(req, {
      scope: "portal_referrals",
      profileId,
      returnedReferrals: enrichedReferrals.length,
      statusFilter: status,
    });

    return ok(
      res,
      {
        summary: {
          profileId: profile.id,
          memberName:
            profile.full_name ||
            [profile.first_name, profile.last_name].filter(Boolean).join(" "),
          email: profile.email,
          memberStatus: profile.member_status,
          tier: profile.tier,
          referralCode: profile.referral_code || null,
          shareLink: buildShareLink(profile.referral_code, origin),
          totals: summary,
        },
        filters: {
          statuses: VALID_STATUSES,
          activeStatus: status,
          channels: allChannels,
          activeChannel: channel || "",
          sources: allSources,
          activeSource: source || "",
          search,
          limit,
        },
        referrals: enrichedReferrals,
      },
      "Referrals loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_referrals_unexpected" });

    return serverError(
      res,
      "Failed to load portal referrals.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}