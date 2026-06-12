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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PORTAL_PATH = "/portal/index.html";

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

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
  "activated",
  "reward_pending",
  "rewarded",
  "expired",
  "cancelled",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeMemberStatus(value) {
  return normalizeText(value || "pending").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeText(value || "core").toLowerCase();

  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) {
    return tier;
  }

  return "core";
}

function normalizeStatus(value) {
  const normalized = normalizeText(value || "all").toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizeChannel(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSource(value) {
  return normalizeText(value).toLowerCase();
}

function toPositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(num), MAX_LIMIT);
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
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

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function parseCookies(req) {
  if (req?.cookies && typeof req.cookies === "object") {
    return req.cookies;
  }

  const header = req?.headers?.cookie || "";

  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!name) return cookies;

      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }

      return cookies;
    }, {});
}

function readSessionCookie(req) {
  const cookies = parseCookies(req);
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    const raw = cookies[name];

    if (!raw) continue;

    const parsed = safeJsonParse(raw, null);

    if (isObject(parsed)) {
      return {
        cookieName: name,
        raw,
        data: parsed,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(sessionMeta) {
  const session = sessionMeta?.data || {};

  const candidates = [
    session.expires_at,
    session.session?.expires_at,
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionMeta) {
  const expiresAt = getSessionExpiresAt(sessionMeta);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionMeta) {
  const session = sessionMeta?.data || {};

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

function getSessionEmail(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeEmail(
    session.member?.email ||
      session.profile?.email ||
      session.user?.email ||
      session.email ||
      session.userEmail
  );
}

function isMissingOptionalTableOrColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

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

function getDisplayName(member) {
  const fullName = normalizeText(member?.full_name);

  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");

  return joined || "Card Leo Member";
}

function getFallbackReferralCode(member) {
  const saved = normalizeText(member?.referral_code);

  if (saved) return saved;

  const id = normalizeText(member?.id).replace(/-/g, "").slice(0, 8);

  if (id) {
    return `CL-${id.toUpperCase()}`;
  }

  const emailPrefix = normalizeText(member?.email).split("@")[0];

  if (emailPrefix) {
    return `CL-${emailPrefix.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
  }

  return "";
}

function sanitizeMember(member) {
  if (!member) return null;

  const status = normalizeMemberStatus(member.status);
  const tier = normalizeTier(member.tier);
  const referralCode = getFallbackReferralCode(member);

  return {
    id: member.id || null,
    signupId: member.id || null,
    portalUserId: member.portal_user_id || null,
    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member),
    name: getDisplayName(member),
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    status: member.status || "",
    memberStatus: ACTIVE_STATUSES.has(status) ? "active" : status,
    tier,
    tierLabel: titleCase(tier),
    referralCode,
    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portalAccess: ACTIVE_STATUSES.has(status),
    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,
    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,
    role: "member",
  };
}

async function getSignupRecord({ signupId, email }) {
  const extendedFields = [
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
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
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

  let query = supabaseAdmin.from("signups").select(extendedFields).limit(1);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.eq("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").select(baseFields).limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    result = await fallbackQuery.maybeSingle();
  }

  return result;
}

async function getAuthenticatedMember(req, res) {
  const sessionMeta = readSessionCookie(req);

  if (!sessionMeta?.data) {
    return {
      member: null,
      response: unauthorized(res, "Unauthorized. Please sign in."),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session expired. Please sign in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session invalid. Please sign in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);

  if (!signupId && !email) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session missing member information."),
    };
  }

  const { data: member, error } = await getSignupRecord({
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
      response: unauthorized(res, "Account not found. Please sign in again."),
    };
  }

  const status = normalizeMemberStatus(member.status || "pending");

  if (!ACTIVE_STATUSES.has(status)) {
    clearAuthCookies(res);

    return {
      member: null,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active."
      ),
    };
  }

  return {
    member,
    response: null,
  };
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

  return map[normalizeText(status).toLowerCase()] || titleCase(status || "Unknown");
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

  return map[normalizeText(status).toLowerCase()] || "neutral";
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

  return map[normalizeText(status).toLowerCase()] ?? 0;
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

function parseOrigin(req) {
  const forwardedProto = req.headers?.["x-forwarded-proto"];
  const forwardedHost = req.headers?.["x-forwarded-host"];
  const host = forwardedHost || req.headers?.host || "";
  const proto = forwardedProto || (host.includes("localhost") ? "http" : "https");

  if (!host) return "https://www.cardleorewards.com";

  return `${proto}://${host}`;
}

function buildShareLink(referralCode, origin) {
  const code = normalizeText(referralCode);

  if (!code) return null;

  const safeOrigin =
    normalizeText(origin) || "https://www.cardleorewards.com";

  try {
    const url = new URL("/signup.html", safeOrigin);
    url.searchParams.set("ref", code);
    return url.toString();
  } catch {
    return `${safeOrigin.replace(/\/+$/, "")}/signup.html?ref=${encodeURIComponent(code)}`;
  }
}

function mapReferralRow(row, member) {
  const status = normalizeText(row.status || "invited").toLowerCase();
  const occurredAt = getReferralOccurredAt(row);
  const referralCode = row.referral_code || getFallbackReferralCode(member);

  return {
    id: row.id,
    referralId: row.id,

    referralCode,
    inviteCode: row.invite_code || null,

    referrerSignupId:
      row.referrer_signup_id ||
      row.referrer_member_id ||
      row.referrer_profile_id ||
      null,

    referredSignupId:
      row.referred_signup_id ||
      row.referred_member_id ||
      row.referred_profile_id ||
      null,

    referredEmail: row.referred_email || null,
    referredFirstName: row.referred_first_name || null,
    referredLastName: row.referred_last_name || null,
    referredName:
      [row.referred_first_name, row.referred_last_name]
        .map(normalizeText)
        .filter(Boolean)
        .join(" ") || null,

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
    metadata: isObject(row.metadata) ? row.metadata : {},

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
    metadata: isObject(row.metadata) ? row.metadata : {},
    occurredAt: safeDate(row.occurred_at || row.created_at),
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

  summary.conversionRatePercent =
    conversionBase > 0 ? Math.round((convertedCount / conversionBase) * 100) : 0;

  summary.rewardRatePercent =
    conversionBase > 0 ? Math.round((summary.rewarded / conversionBase) * 100) : 0;

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
  const normalizedSearch = normalizeText(search).toLowerCase();

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

async function queryReferralsForMember({ memberId, referralCode }) {
  const attempts = [
    {
      type: "or",
      expression: `referrer_signup_id.eq.${memberId},referred_signup_id.eq.${memberId}`,
    },
    {
      type: "or",
      expression: `referrer_member_id.eq.${memberId},referred_member_id.eq.${memberId}`,
    },
    {
      type: "or",
      expression: `referrer_profile_id.eq.${memberId},referred_profile_id.eq.${memberId}`,
    },
  ];

  if (referralCode) {
    attempts.push({
      type: "eq",
      column: "referral_code",
      value: referralCode,
    });
  }

  for (const attempt of attempts) {
    let query = supabaseAdmin
      .from("referrals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(MAX_LIMIT);

    if (attempt.type === "or") {
      query = query.or(attempt.expression);
    } else {
      query = query.eq(attempt.column, attempt.value);
    }

    const { data, error } = await query;

    if (!error) {
      return data || [];
    }

    if (isMissingOptionalTableOrColumn(error)) {
      continue;
    }

    throw error;
  }

  return [];
}

async function queryReferralEvents(referralIds) {
  if (!referralIds.length) return {};

  const { data, error } = await supabaseAdmin
    .from("referral_events")
    .select("*")
    .in("referral_id", referralIds)
    .order("occurred_at", { ascending: false });

  if (error) {
    if (isMissingOptionalTableOrColumn(error)) {
      return {};
    }

    throw error;
  }

  return (data || []).reduce((acc, row) => {
    const key = row.referral_id;

    if (!acc[key]) acc[key] = [];

    acc[key].push(mapEventRow(row));
    return acc;
  }, {});
}

function buildEmptyReferralGuidance(member, origin) {
  const referralCode = getFallbackReferralCode(member);

  return {
    referralCode,
    shareLink: buildShareLink(referralCode, origin),
    headline: "Start sharing your Card Leo Rewards link.",
    message:
      "Your referral activity will appear here once people register through your link or referral code.",
    steps: [
      "Copy your referral link.",
      "Share it with someone interested in Card Leo Rewards.",
      "Track invites, registrations, activations, and rewards from this page.",
    ],
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_referrals" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { member, response } = await getAuthenticatedMember(req, res);

    if (!member) {
      return response;
    }

    const safeMember = sanitizeMember(member);
    const memberId = safeMember.id;
    const referralCode = safeMember.referralCode;

    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT);
    const status = normalizeStatus(req.query?.status);
    const channel = normalizeChannel(req.query?.channel);
    const source = normalizeSource(req.query?.source);
    const search = normalizeText(req.query?.search);
    const origin = parseOrigin(req);

    const referralRows = await queryReferralsForMember({
      memberId,
      referralCode,
    });

    const referrals = referralRows.map((row) => mapReferralRow(row, member));

    const filteredReferrals = sortReferralsByOccurredAtDesc(
      filterReferrals(referrals, status, channel, source, search)
    );

    const pagedReferrals = filteredReferrals.slice(0, limit);
    const visibleReferralIds = pagedReferrals.map((item) => item.id);

    const eventsByReferralId = await queryReferralEvents(visibleReferralIds);

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
    const shareLink = buildShareLink(referralCode, origin);

    logRequestSuccess(req, {
      scope: "portal_referrals",
      memberId,
      email: safeMember.email,
      returnedReferrals: enrichedReferrals.length,
      statusFilter: status,
      ip: getClientIp(req),
    });

    return ok(
      res,
      {
        summary: {
          profileId: safeMember.id,
          memberId: safeMember.id,
          memberName: safeMember.fullName,
          email: safeMember.email,
          memberStatus: safeMember.memberStatus,
          tier: safeMember.tier,
          tierLabel: safeMember.tierLabel,
          referralCode,
          shareLink,
          totals: summary,
        },
        member: safeMember,
        referral: {
          code: referralCode,
          shareLink,
          signupUrl: shareLink,
          emptyState: buildEmptyReferralGuidance(member, origin),
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
    logRequestError(req, error, {
      scope: "portal_referrals_unexpected",
    });

    return serverError(
      res,
      "Failed to load portal referrals.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown error.",
            code: error?.code || null,
          }
        : null
    );
  }
}