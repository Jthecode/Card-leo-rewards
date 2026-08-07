// api/portal/activity.js
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

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_PORTAL_PATH = "/portal/index.html";
const DEFAULT_TIMEZONE = "America/New_York";

const VALID_CATEGORIES = [
  "all",
  "account",
  "rewards",
  "support",
  "referrals",
  "benefits",
  "system",
];

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
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
  "succeeded",
  "complete",
  "completed",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
]);

const INACTIVE_STATUSES = new Set([
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
]);

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
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

function normalizeStatus(value) {
  return normalizeText(value || "").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeText(value || "core").toLowerCase();

  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) {
    return tier;
  }

  return "core";
}

function toPositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(num), MAX_LIMIT);
}

function normalizeCategory(value) {
  const category = normalizeText(value || "all").toLowerCase();
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

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function getClientIp(req) {
  const forwardedFor =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (name) {
        cookies[name] = value;
      }

      return cookies;
    }, {});
}

function decodeCookieValue(value) {
  const raw = String(value || "");

  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseJsonObject(value) {
  if (isObject(value)) return value;

  const raw = normalizeText(value);

  if (!raw) return null;

  const decoded = decodeCookieValue(raw);
  const parsed = safeJsonParse(decoded, null);

  if (isObject(parsed)) return parsed;

  try {
    const base64Decoded = Buffer.from(decoded, "base64").toString("utf8");
    const parsedBase64 = safeJsonParse(base64Decoded, null);

    if (isObject(parsedBase64)) return parsedBase64;
  } catch {
    // Ignore invalid base64.
  }

  try {
    const normalized = decoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const base64UrlDecoded = Buffer.from(padded, "base64").toString("utf8");
    const parsedBase64Url = safeJsonParse(base64UrlDecoded, null);

    if (isObject(parsedBase64Url)) return parsedBase64Url;
  } catch {
    // Ignore invalid base64url.
  }

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseJsonObject(cookies[name]);

    if (isObject(parsed)) {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(sessionCookie) {
  const value = sessionCookie?.value || {};

  const candidates = [
    value.expires_at,
    value.expiresAt,
    value.exp,
    value.session?.expires_at,
    value.session?.expiresAt,
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionCookie) {
  const expiresAt = getSessionExpiresAt(sessionCookie);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const metadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return normalizeText(
    member.id ||
      member.signupId ||
      member.signup_id ||
      member.memberId ||
      member.member_id ||
      profile.id ||
      profile.signupId ||
      profile.signup_id ||
      profile.memberId ||
      profile.member_id ||
      user.id ||
      metadata.signupId ||
      metadata.signup_id ||
      metadata.memberId ||
      metadata.member_id ||
      value.signupId ||
      value.signup_id ||
      value.memberId ||
      value.member_id ||
      value.id
  );
}

function getSessionEmail(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const metadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return normalizeEmail(
    member.email ||
      profile.email ||
      user.email ||
      metadata.email ||
      value.email ||
      value.userEmail
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

function hasPortalAccess(member) {
  if (!member) return false;

  const status = normalizeStatus(member.status);
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);
  const approvalStatus = normalizeStatus(member.approval_status);

  if (
    INACTIVE_STATUSES.has(status) ||
    INACTIVE_STATUSES.has(paymentStatus) ||
    INACTIVE_STATUSES.has(membershipStatus) ||
    INACTIVE_STATUSES.has(approvalStatus)
  ) {
    return false;
  }

  return (
    ACTIVE_STATUSES.has(status) ||
    PAID_PAYMENT_STATUSES.has(paymentStatus) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
}

function normalizeMemberStatus(member) {
  if (!member) return "pending";

  if (hasPortalAccess(member)) return "active";

  const status = normalizeStatus(member.status);

  if (["pending", "reviewing", ""].includes(status)) return "pending";
  if (["disabled", "suspended", "paused"].includes(status)) return "suspended";
  if (["denied", "closed", "cancelled", "canceled"].includes(status)) {
    return status;
  }

  return status || "pending";
}

function getAccessMemberStatus(member) {
  return normalizeText(member?.access_member_status || "pending");
}

function getAccessPerksReady(member) {
  const raw = member?.access_perks_ready;

  if (typeof raw === "boolean") return raw;

  return getAccessMemberStatus(member).toUpperCase() === "OPEN";
}

function buildAccessPayload(member) {
  const accessMemberStatus = getAccessMemberStatus(member);
  const accessPerksReady = getAccessPerksReady(member);

  return {
    member_identifier: normalizeText(member?.access_member_identifier),
    member_customer_identifier: normalizeText(member?.access_member_identifier),
    member_status: accessMemberStatus,
    status: accessMemberStatus,
    synced_at: member?.access_synced_at || null,
    suspended_at: member?.access_suspended_at || null,
    sync_error: normalizeText(member?.access_sync_error),
    perks_ready: accessPerksReady,
    benefits_ready: accessPerksReady,
    ready: accessPerksReady,
  };
}

function sanitizeMember(member) {
  if (!member) return null;

  const tier = normalizeTier(member.tier || "core");
  const portalAccess = hasPortalAccess(member);
  const access = buildAccessPayload(member);

  const status = normalizeStatus(member.status) || "pending";
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);
  const approvalStatus = normalizeStatus(member.approval_status);

  return {
    id: member.id || null,
    signupId: member.id || null,
    signup_id: member.id || null,

    email: member.email || null,

    firstName: member.first_name || "",
    first_name: member.first_name || "",

    lastName: member.last_name || "",
    last_name: member.last_name || "",

    fullName: getDisplayName(member),
    full_name: getDisplayName(member),
    name: getDisplayName(member),

    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    goals: member.goals || "",

    status: portalAccess ? "active" : status,
    payment_status: paymentStatus,
    membership_status: portalAccess ? "active" : membershipStatus,
    approval_status: portalAccess ? "approved" : approvalStatus,

    paymentStatus,
    membershipStatus: portalAccess ? "active" : membershipStatus,
    approvalStatus: portalAccess ? "approved" : approvalStatus,

    memberStatus: normalizeMemberStatus(member),

    tier,
    tierLabel: titleCase(tier),

    referralCode: member.referral_code || "",
    referral_code: member.referral_code || "",

    portalUserId: member.portal_user_id || null,
    portal_user_id: member.portal_user_id || null,

    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portal_login_url: member.portal_login_url || DEFAULT_PORTAL_PATH,

    portalAccess,
    portal_access: portalAccess,
    accessLevel: "member",
    access_level: "member",

    stripeCustomerId: member.stripe_customer_id || "",
    stripe_customer_id: member.stripe_customer_id || "",
    stripeSubscriptionId: member.stripe_subscription_id || "",
    stripe_subscription_id: member.stripe_subscription_id || "",
    stripeCheckoutSessionId: member.stripe_checkout_session_id || "",
    stripe_checkout_session_id: member.stripe_checkout_session_id || "",

    accessMemberIdentifier: access.member_identifier,
    access_member_identifier: access.member_identifier,
    accessMemberStatus: access.member_status,
    access_member_status: access.member_status,
    accessSyncedAt: access.synced_at,
    access_synced_at: access.synced_at,
    accessSuspendedAt: access.suspended_at,
    access_suspended_at: access.suspended_at,
    accessSyncError: access.sync_error,
    access_sync_error: access.sync_error,
    accessPerksReady: access.perks_ready,
    access_perks_ready: access.perks_ready,

    benefitsReady: access.benefits_ready,
    benefits_ready: access.benefits_ready,

    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,
    email_verified: Boolean(member.email_verified),
    email_verified_at: member.email_verified_at || null,

    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,
    created_at: member.created_at || null,
    updated_at: member.updated_at || null,

    role: "member",
  };
}

function getSignupSelectFields({ extended = true } = {}) {
  const base = [
    "id",
    "first_name",
    "last_name",
    "full_name",
    "email",
    "phone",
    "city",
    "state",
    "interest",
    "agreed",
    "status",
    "created_at",
    "updated_at",
    "portal_user_id",
    "portal_login_url",
  ];

  if (!extended) {
    return base.join(", ");
  }

  return [
    ...base,
    "goals",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "payment_status",
    "membership_status",
    "approval_status",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_checkout_session_id",
    "access_member_identifier",
    "access_member_status",
    "access_synced_at",
    "access_suspended_at",
    "access_sync_error",
    "access_perks_ready",
  ].join(", ");
}

function hydrateFallbackSignupRecord(row) {
  if (!row) return null;

  return {
    ...row,
    goals: "",
    tier: "core",
    referral_code: "",
    email_verified: false,
    email_verified_at: null,
    payment_status: "",
    membership_status: "",
    approval_status: "",
    activation_fee_amount: 25,
    monthly_fee_amount: 20,
    billing_day: 10,
    stripe_customer_id: "",
    stripe_subscription_id: "",
    stripe_checkout_session_id: "",
    access_member_identifier: "",
    access_member_status: "pending",
    access_synced_at: null,
    access_suspended_at: null,
    access_sync_error: "",
    access_perks_ready: false,
  };
}

async function getSignupRecord({ memberId, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select(getSignupSelectFields({ extended: true }))
    .limit(1);

  if (memberId) {
    query = query.eq("id", memberId);
  } else {
    query = query.ilike("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin
      .from("signups")
      .select(getSignupSelectFields({ extended: false }))
      .limit(1);

    if (memberId) {
      fallbackQuery = fallbackQuery.eq("id", memberId);
    } else {
      fallbackQuery = fallbackQuery.ilike("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: hydrateFallbackSignupRecord(fallback.data),
      error: fallback.error,
    };
  }

  return result;
}

async function getAuthenticatedMember(req, res) {
  const sessionCookie = readSessionCookie(req);

  if (!sessionCookie?.value) {
    return {
      member: null,
      response: unauthorized(res, "Unauthorized. Please sign in."),
    };
  }

  if (isSessionExpired(sessionCookie)) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session expired. Please sign in again."),
    };
  }

  if (sessionCookie.value.authenticated !== true) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session invalid. Please sign in again."),
    };
  }

  const memberId = getSessionMemberId(sessionCookie);
  const email = getSessionEmail(sessionCookie);

  if (!memberId && !email) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session missing member information."),
    };
  }

  const { data, error } = await getSignupRecord({
    memberId,
    email,
  });

  if (error) {
    throw error;
  }

  if (!data?.id) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Account not found. Please sign in again."),
    };
  }

  if (!hasPortalAccess(data)) {
    return {
      member: null,
      response: forbidden(
        res,
        "Your account is pending approval or payment.",
        {
          authenticated: true,
          member: sanitizeMember(data),
          requires_payment: true,
          requiresPayment: true,
          redirectTo: "/signup.html?status=payment_required",
        }
      ),
    };
  }

  return {
    member: data,
    response: null,
  };
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

  if (
    [
      "access_perks_sync",
      "access_perks_open",
      "access_perks_pending",
      "benefit_viewed",
      "benefit_redeemed",
    ].includes(normalized)
  ) {
    return "benefits";
  }

  if (
    ["support_ticket_created", "support_ticket_replied", "support_updated"].includes(
      normalized
    )
  ) {
    return "support";
  }

  if (
    [
      "referral_invited",
      "referral_opened",
      "referral_registered",
      "referral_activated",
      "referral_rewarded",
    ].includes(normalized)
  ) {
    return "referrals";
  }

  if (["system_notice", "admin_note"].includes(normalized)) {
    return "system";
  }

  return "account";
}

function mapMemberActivityRow(row) {
  const activityType = row.activity_type || row.type || "account_activity";
  const category = row.category || activityTypeToCategory(activityType);

  return {
    id: `member_activity:${row.id}`,
    source: "member_activity",
    category,
    type: activityType,
    title: row.title || titleCase(activityType),
    description: row.description || null,
    status: row.status || null,
    badge: row.badge || titleCase(category),
    occurredAt: safeDate(row.occurred_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: isObject(row.metadata) ? row.metadata : {},
  };
}

function mapRewardTransactionRow(row) {
  const amount = money(row.amount);

  return {
    id: `reward_transaction:${row.id}`,
    source: "reward_transactions",
    category: "rewards",
    type: row.transaction_type || row.type || "reward_activity",
    title:
      row.title ||
      titleCase(row.transaction_type || row.type || "reward activity"),
    description:
      row.description ||
      `$${amount.toFixed(2)} USD • ${titleCase(
        row.transaction_status || row.status || "posted"
      )}`,
    status: row.transaction_status || row.status || null,
    badge: `$${amount.toFixed(2)}`,
    occurredAt: safeDate(row.posted_at || row.occurred_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: {
      amount,
      transactionType: row.transaction_type || row.type || null,
      transactionStatus: row.transaction_status || row.status || null,
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
    occurredAt: safeDate(row.last_message_at || row.updated_at || row.created_at),
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

function mapReferralRow(row, memberId) {
  const isReferrer =
    row.referrer_profile_id === memberId ||
    row.referrer_member_id === memberId ||
    row.referrer_signup_id === memberId;

  const stateTitleMap = {
    invited: "Referral Invite Sent",
    opened: "Referral Invite Opened",
    registered: "Referral Registered",
    activated: "Referral Activated",
    reward_pending: "Referral Reward Pending",
    rewarded: "Referral Rewarded",
    expired: "Referral Expired",
    cancelled: "Referral Cancelled",
    canceled: "Referral Cancelled",
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
      ? `Referred: ${row.referred_email || row.referred_name || "Member"}`
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
      referredName: row.referred_name || null,
      inviteCode: row.invite_code || null,
      referralCode: row.referral_code || null,
      source: row.source || null,
      channel: row.channel || null,
    },
  };
}

function buildAccountLifecycleItems(member) {
  const items = [];

  if (member.created_at) {
    items.push({
      id: `account:created:${member.id}`,
      source: "signups",
      category: "account",
      type: "account_created",
      title: "Account Created",
      description: "Your Card Leo Rewards account was created.",
      status: member.status || null,
      badge: "Account",
      occurredAt: safeDate(member.created_at),
      createdAt: safeDate(member.created_at),
      metadata: {
        memberId: member.id,
        email: member.email,
        source: "signups",
      },
    });
  }

  if (member.email_verified_at) {
    items.push({
      id: `account:email_verified:${member.id}`,
      source: "signups",
      category: "account",
      type: "email_verified",
      title: "Email Verified",
      description: "Your email address was verified successfully.",
      status: "verified",
      badge: "Verified",
      occurredAt: safeDate(member.email_verified_at),
      createdAt: safeDate(member.email_verified_at),
      metadata: {
        memberId: member.id,
        email: member.email,
      },
    });
  }

  if (member.updated_at && member.updated_at !== member.created_at) {
    items.push({
      id: `account:updated:${member.id}`,
      source: "signups",
      category: "account",
      type: "account_updated",
      title: "Account Updated",
      description: "Your account information was updated.",
      status: member.status || null,
      badge: titleCase(member.status || "Updated"),
      occurredAt: safeDate(member.updated_at),
      createdAt: safeDate(member.updated_at),
      metadata: {
        memberId: member.id,
      },
    });
  }

  if (member.status) {
    items.push({
      id: `account:status:${member.id}:${member.status}`,
      source: "signups",
      category: "account",
      type: "account_status",
      title: `Account ${titleCase(member.status)}`,
      description:
        normalizeStatus(member.status) === "active"
          ? "Your member account is active."
          : `Your current account status is ${titleCase(member.status)}.`,
      status: member.status,
      badge: titleCase(member.status),
      occurredAt: safeDate(member.updated_at || member.created_at),
      createdAt: safeDate(member.created_at),
      metadata: {
        memberId: member.id,
        status: member.status,
      },
    });
  }

  return items;
}

function buildAccessPerksItems(member) {
  const access = buildAccessPayload(member);
  const items = [];

  if (access.member_identifier || access.member_status || access.sync_error) {
    items.push({
      id: `benefits:access_perks:${member.id}`,
      source: "signups",
      category: "benefits",
      type: access.perks_ready ? "access_perks_sync" : "access_perks_pending",
      title: access.perks_ready
        ? "Access Perks Active"
        : access.sync_error
          ? "Access Perks Sync Needs Attention"
          : "Access Perks Sync Pending",
      description: access.perks_ready
        ? "Your Access Perks member record is active and benefits are ready."
        : access.sync_error
          ? "Your membership is active, but Access Perks member sync is waiting on the correct Access AMT endpoint."
          : "Your membership is active. Access Perks will show as active once your member record syncs.",
      status: access.member_status || "pending",
      badge: access.perks_ready
        ? "Active"
        : access.sync_error
          ? "Endpoint Pending"
          : "Syncing",
      occurredAt: safeDate(access.synced_at || member.updated_at || member.created_at),
      createdAt: safeDate(member.created_at),
      metadata: {
        accessMemberIdentifier: access.member_identifier,
        accessMemberStatus: access.member_status,
        accessPerksReady: access.perks_ready,
        accessSyncError: access.sync_error,
      },
    });
  }

  return items;
}

async function queryOptionalByColumns({
  table,
  memberId,
  columns,
  limit,
}) {
  for (const column of columns) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .limit(limit);

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

async function queryOptionalReferrals({ memberId, limit }) {
  const expressions = [
    `referrer_profile_id.eq.${memberId},referred_profile_id.eq.${memberId}`,
    `referrer_member_id.eq.${memberId},referred_member_id.eq.${memberId}`,
    `referrer_signup_id.eq.${memberId},referred_signup_id.eq.${memberId}`,
  ];

  for (const expression of expressions) {
    const { data, error } = await supabaseAdmin
      .from("referrals")
      .select("*")
      .or(expression)
      .limit(limit);

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
      benefits: 0,
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

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_activity" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { member, response } = await getAuthenticatedMember(req, res);

    if (!member) {
      return response;
    }

    const memberId = member.id;
    const safeMember = sanitizeMember(member);
    const access = buildAccessPayload(member);

    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT);
    const category = normalizeCategory(req.query?.category);
    const queryLimit = Math.max(limit, 20);

    const [
      memberActivityRows,
      rewardTransactionRows,
      supportTicketRows,
      referralRows,
    ] = await Promise.all([
      queryOptionalByColumns({
        table: "member_activity",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
      }),

      queryOptionalByColumns({
        table: "reward_transactions",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
      }),

      queryOptionalByColumns({
        table: "support_tickets",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
      }),

      queryOptionalReferrals({
        memberId,
        limit: queryLimit,
      }),
    ]);

    const accountItems = buildAccountLifecycleItems(member);
    const accessPerksItems = buildAccessPerksItems(member);
    const memberActivityItems = memberActivityRows.map(mapMemberActivityRow);
    const rewardItems = rewardTransactionRows.map(mapRewardTransactionRow);
    const supportItems = supportTicketRows.map(mapSupportTicketRow);
    const referralItems = referralRows.map((row) => mapReferralRow(row, memberId));

    const combinedFeed = sortByOccurredAtDesc([
      ...accountItems,
      ...accessPerksItems,
      ...memberActivityItems,
      ...rewardItems,
      ...supportItems,
      ...referralItems,
    ]);

    const filteredFeed = filterByCategory(combinedFeed, category).slice(0, limit);
    const fullSummary = summarizeFeed(combinedFeed);
    const filteredSummary = summarizeFeed(filteredFeed);

    logRequestSuccess(req, {
      scope: "portal_activity",
      memberId,
      email: member.email,
      requestedCategory: category,
      returnedItems: filteredFeed.length,
      accessMemberStatus: access.member_status,
      accessPerksReady: access.perks_ready,
      ip: getClientIp(req),
    });

    return ok(
      res,
      {
        authenticated: true,

        summary: {
          memberId: safeMember.id,
          profileId: safeMember.id,
          memberName: safeMember.fullName,
          email: safeMember.email,
          memberStatus: safeMember.memberStatus,
          payment_status: safeMember.paymentStatus,
          membership_status: safeMember.membershipStatus,
          approval_status: safeMember.approvalStatus,
          tier: safeMember.tier || "core",
          requestedCategory: category,
          requestedLimit: limit,
          totals: filteredSummary,
          allTotals: fullSummary,
          timezone: DEFAULT_TIMEZONE,
        },

        member: safeMember,

        access,

        accessPerks: {
          ready: access.perks_ready,
          status: access.member_status,
          member_identifier: access.member_identifier,
          synced_at: access.synced_at,
          suspended_at: access.suspended_at,
          sync_error: access.sync_error,
          portal_url: "/portal/benefits.html",
        },

        benefits: {
          access_perks_ready: access.perks_ready,
          benefits_ready: access.benefits_ready,
          href: "/portal/benefits.html",
        },

        filters: {
          categories: VALID_CATEGORIES,
          activeCategory: category,
          limit,
        },

        feed: filteredFeed,
        timezone: DEFAULT_TIMEZONE,
        fetchedAt: new Date().toISOString(),
      },
      "Activity loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_activity_unexpected",
    });

    return serverError(
      res,
      "Failed to load portal activity.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown error.",
            code: error?.code || null,
          }
        : null
    );
  }
}