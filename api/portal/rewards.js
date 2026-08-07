// api/portal/rewards.js
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

const DEFAULT_PORTAL_PATH = "/portal/index.html";
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

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

const SESSION_COOKIE_NAMES = [
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

function safeDate(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function toPositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(num), MAX_LIMIT);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
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

function parseJsonObject(value) {
  if (isObject(value)) return value;

  const raw = normalizeText(value);

  if (!raw) return null;

  const parsed = safeJsonParse(raw, null);

  if (isObject(parsed)) return parsed;

  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsedBase64 = safeJsonParse(decoded, null);

    if (isObject(parsedBase64)) return parsedBase64;
  } catch {
    // Ignore invalid base64.
  }

  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsedBase64Url = safeJsonParse(decoded, null);

    if (isObject(parsedBase64Url)) return parsedBase64Url;
  } catch {
    // Ignore invalid base64url.
  }

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookies(req);
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

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

    const parsed = parseJsonObject(raw);

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
    session.expiresAt,
    session.exp,
    session.session?.expires_at,
    session.session?.expiresAt,
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
  const member = isObject(session.member) ? session.member : {};
  const profile = isObject(session.profile) ? session.profile : {};
  const user = isObject(session.user) ? session.user : {};
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
      session.signupId ||
      session.signup_id ||
      session.memberId ||
      session.member_id ||
      session.id
  );
}

function getSessionEmail(sessionMeta) {
  const session = sessionMeta?.data || {};
  const member = isObject(session.member) ? session.member : {};
  const profile = isObject(session.profile) ? session.profile : {};
  const user = isObject(session.user) ? session.user : {};
  const metadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return normalizeEmail(
    member.email ||
      profile.email ||
      user.email ||
      metadata.email ||
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

    portalUserId: member.portal_user_id || null,
    portal_user_id: member.portal_user_id || null,

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

    joinedAt: member.created_at || null,
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

async function getSignupRecord({ signupId, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select(getSignupSelectFields({ extended: true }))
    .limit(1);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.ilike("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin
      .from("signups")
      .select(getSignupSelectFields({ extended: false }))
      .limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
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
  const sessionMeta = readSessionCookie(req);

  if (!sessionMeta?.data) {
    return {
      member: null,
      response: unauthorized(res, "You must be logged in to view rewards."),
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
      response: unauthorized(res, "Your session is missing a valid portal identity."),
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
      response: unauthorized(res, "No member record was found for this account."),
    };
  }

  if (!hasPortalAccess(member)) {
    return {
      member: null,
      response: forbidden(
        res,
        "Your account is pending approval or payment.",
        {
          authenticated: true,
          member: sanitizeMember(member),
          requires_payment: true,
          requiresPayment: true,
          redirectTo: "/signup.html?status=payment_required",
        }
      ),
    };
  }

  return {
    member,
    response: null,
  };
}

async function queryOptionalSingleByMemberColumns({ table, memberId, columns }) {
  for (const column of columns) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .maybeSingle();

    if (!error) {
      return data || null;
    }

    if (isMissingOptionalTableOrColumn(error)) {
      continue;
    }

    throw error;
  }

  return null;
}

async function queryOptionalListByMemberColumns({
  table,
  memberId,
  columns,
  limit = DEFAULT_LIMIT,
  orderColumn = "created_at",
}) {
  for (const column of columns) {
    let query = supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .limit(limit);

    if (orderColumn) {
      query = query.order(orderColumn, { ascending: false });
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

function sortByDateDesc(items, keys = ["postedAt", "paidAt", "createdAt"]) {
  return [...items].sort((a, b) => {
    const aValue = keys.map((key) => a?.[key]).find(Boolean);
    const bValue = keys.map((key) => b?.[key]).find(Boolean);

    const aTime = new Date(aValue || 0).getTime();
    const bTime = new Date(bValue || 0).getTime();

    return bTime - aTime;
  });
}

function normalizeRewardStatus(value) {
  const status = normalizeText(value).toLowerCase();

  if (!status) return "posted";

  return status;
}

function mapRewardTransactionRow(row, index = 0) {
  const amount = money(row.amount);

  return {
    id: firstNonEmpty(row.id, `reward-tx-${index + 1}`),
    title: firstNonEmpty(
      row.title,
      titleCase(row.transaction_type || row.type || "reward activity")
    ),
    description: firstNonEmpty(
      row.description,
      `${amount.toFixed(2)} ${row.currency_code || "USD"} • ${titleCase(
        row.transaction_status || row.status || "posted"
      )}`
    ),
    status: normalizeRewardStatus(row.transaction_status || row.status || "posted"),
    amount,
    type: firstNonEmpty(row.transaction_type, row.type, "manual_adjustment"),
    referenceType: firstNonEmpty(row.reference_type, row.referenceType, ""),
    referenceId: firstNonEmpty(row.reference_id, row.referenceId, ""),
    currencyCode: row.currency_code || "USD",
    postedAt: safeDate(row.posted_at || row.occurred_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: isObject(row.metadata) ? row.metadata : {},
    sourceProfileId: firstNonEmpty(row.source_profile_id, row.sourceProfileId, ""),
    relatedProfileId: firstNonEmpty(row.related_profile_id, row.relatedProfileId, ""),
  };
}

function mapPayoutRow(row, index = 0) {
  return {
    id: firstNonEmpty(row.id, `reward-payout-${index + 1}`),
    payoutType: firstNonEmpty(row.payout_type, row.payoutType, row.type, "manual"),
    payoutStatus: firstNonEmpty(row.payout_status, row.payoutStatus, row.status, "pending"),
    amount: money(row.amount),
    periodStart: safeDate(row.period_start || row.periodStart),
    periodEnd: safeDate(row.period_end || row.periodEnd),
    paidAt: safeDate(row.paid_at || row.paidAt || row.created_at),
    notes: firstNonEmpty(row.notes, ""),
    externalPayoutId: firstNonEmpty(row.external_payout_id, row.externalPayoutId, ""),
    metadata: isObject(row.metadata) ? row.metadata : {},
    createdAt: safeDate(row.created_at),
  };
}

function mapPaymentRow(row, index = 0) {
  return {
    id: firstNonEmpty(row.id, `membership-payment-${index + 1}`),
    paymentMonth: Number(row.payment_month || row.paymentMonth || 0),
    amountCharged: money(row.amount_charged || row.amountCharged || row.amount),
    cardleoAmount: money(row.cardleo_amount || row.cardleoAmount),
    directReferralAmount: money(row.direct_referral_amount || row.directReferralAmount),
    overrideAmount: money(row.override_amount || row.overrideAmount),
    companyBuildingAmount: money(row.company_building_amount || row.companyBuildingAmount),
    paymentStatus: firstNonEmpty(row.payment_status, row.paymentStatus, row.status, "paid"),
    billingPeriodStart: safeDate(row.billing_period_start || row.billingPeriodStart),
    billingPeriodEnd: safeDate(row.billing_period_end || row.billingPeriodEnd),
    paidAt: safeDate(row.paid_at || row.paidAt || row.created_at),
    externalPaymentId: firstNonEmpty(row.external_payment_id, row.externalPaymentId, ""),
    createdAt: safeDate(row.created_at),
  };
}

function mapCycleRow(row, index = 0) {
  return {
    id: firstNonEmpty(row.id, `membership-cycle-${index + 1}`),
    cycleNumber: Number(row.cycle_number || row.cycleNumber || index + 1),
    cycleStartDate: safeDate(row.cycle_start_date || row.cycleStartDate),
    cycleEndDate: safeDate(row.cycle_end_date || row.cycleEndDate),
    paidMonthsCount: Number(row.paid_months_count || row.paidMonthsCount || 0),
    requiredPaidMonths: Number(row.required_paid_months || row.requiredPaidMonths || 4),
    companyBuildingAccrued: money(row.company_building_accrued || row.companyBuildingAccrued),
    companyBuildingReleased: money(row.company_building_released || row.companyBuildingReleased),
    cycleStatus: firstNonEmpty(row.cycle_status, row.cycleStatus, row.status, "open"),
    completedAt: safeDate(row.completed_at || row.completedAt),
    releasedAt: safeDate(row.released_at || row.releasedAt),
    forfeitedAt: safeDate(row.forfeited_at || row.forfeitedAt),
    createdAt: safeDate(row.created_at),
  };
}

function buildDefaultRewardAccount(member) {
  return {
    signup_id: member?.id || null,
    member_id: member?.id || null,
    account_status: hasPortalAccess(member) ? "active" : "pending",
    total_cardleo_allocated: 0,
    total_direct_referral_earned: 0,
    total_override_earned: 0,
    company_building_pending: 0,
    company_building_released: 0,
    company_building_forfeited: 0,
    total_member_revenue_processed: 0,
    total_rewards_earned: 0,
    total_rewards_paid: 0,
    last_membership_paid_at: null,
    last_direct_referral_at: null,
    last_override_at: null,
    last_company_building_release_at: null,
  };
}

function normalizeRewardAccount(account, member) {
  const base = account || buildDefaultRewardAccount(member);

  return {
    signupId: base.signup_id || base.signupId || member?.id || null,
    memberId: base.member_id || base.memberId || member?.id || null,
    accountStatus: base.account_status || base.accountStatus || "active",
    totalCardleoAllocated: money(base.total_cardleo_allocated || base.totalCardleoAllocated),
    totalDirectReferralEarned: money(
      base.total_direct_referral_earned || base.totalDirectReferralEarned
    ),
    totalOverrideEarned: money(base.total_override_earned || base.totalOverrideEarned),
    companyBuildingPending: money(
      base.company_building_pending || base.companyBuildingPending
    ),
    companyBuildingReleased: money(
      base.company_building_released || base.companyBuildingReleased
    ),
    companyBuildingForfeited: money(
      base.company_building_forfeited || base.companyBuildingForfeited
    ),
    totalMemberRevenueProcessed: money(
      base.total_member_revenue_processed || base.totalMemberRevenueProcessed
    ),
    totalRewardsEarned: money(base.total_rewards_earned || base.totalRewardsEarned),
    totalRewardsPaid: money(base.total_rewards_paid || base.totalRewardsPaid),
    lastMembershipPaidAt: safeDate(
      base.last_membership_paid_at || base.lastMembershipPaidAt
    ),
    lastDirectReferralAt: safeDate(
      base.last_direct_referral_at || base.lastDirectReferralAt
    ),
    lastOverrideAt: safeDate(base.last_override_at || base.lastOverrideAt),
    lastCompanyBuildingReleaseAt: safeDate(
      base.last_company_building_release_at || base.lastCompanyBuildingReleaseAt
    ),
  };
}

function sumTransactionsByType(transactions, typeIncludes) {
  return transactions.reduce((total, tx) => {
    const type = normalizeText(tx.type).toLowerCase();
    const matches = typeIncludes.some((part) => type.includes(part));
    return matches ? total + money(tx.amount) : total;
  }, 0);
}

function buildSummary({
  rewardAccount,
  transactions,
  payouts,
  payments,
  cycles,
  member,
}) {
  const txTotal = transactions.reduce((total, tx) => total + money(tx.amount), 0);
  const payoutTotal = payouts.reduce((total, payout) => total + money(payout.amount), 0);

  const accountRewardsEarned =
    rewardAccount.totalRewardsEarned > 0
      ? rewardAccount.totalRewardsEarned
      : txTotal;

  const accountRewardsPaid =
    rewardAccount.totalRewardsPaid > 0
      ? rewardAccount.totalRewardsPaid
      : payoutTotal;

  const totalDirectReferralEarned =
    rewardAccount.totalDirectReferralEarned ||
    sumTransactionsByType(transactions, ["direct_referral", "direct referral", "direct"]);

  const totalOverrideEarned =
    rewardAccount.totalOverrideEarned ||
    sumTransactionsByType(transactions, ["override", "team_referral", "team referral"]);

  const totalCardleoAllocated =
    rewardAccount.totalCardleoAllocated ||
    sumTransactionsByType(transactions, ["cardleo", "card leo"]);

  return {
    membershipMonthlyAmount: 20,
    cardleoAmount: 10,
    directReferralAmount: 7,
    overrideReferralAmount: 1,
    companyBuildingAmount: 2,
    companyBuildingCycleMonths: 4,

    totalCardleoAllocated: money(totalCardleoAllocated),
    totalDirectReferralEarned: money(totalDirectReferralEarned),
    totalOverrideEarned: money(totalOverrideEarned),

    companyBuildingPending: rewardAccount.companyBuildingPending,
    companyBuildingReleased: rewardAccount.companyBuildingReleased,
    companyBuildingForfeited: rewardAccount.companyBuildingForfeited,

    totalRewardsEarned: money(accountRewardsEarned),
    totalRewardsPaid: money(accountRewardsPaid),
    availableRewardsBalance: money(accountRewardsEarned - accountRewardsPaid),

    transactionCount: transactions.length,
    payoutCount: payouts.length,
    paymentCount: payments.length,
    cycleCount: cycles.length,

    accessLevel: "Premium Access",
    statusLabel: titleCase(member?.status || "Active"),

    allowanceRules: {
      directReferral: "Member A referred Member B +$7.00",
      teamReferral: "Member B referred Member C +$1.00",
      companyGrowthAllowance:
        "Existing tiers allowances are released after Member A recruits 4 new active team members.",
      payoutWindow: "Allowances are dispersed on the 1st and 3rd of every month.",
    },
  };
}

function buildNotices({ member, rewardAccount, access }) {
  const notices = [];

  if (!member?.email_verified && !member?.email_verified_at) {
    notices.push({
      id: "verify-email",
      type: "warning",
      title: "Verify Your Email",
      body: "Verify your email address to complete account setup and strengthen reward eligibility.",
    });
  }

  if (rewardAccount.totalRewardsEarned <= 0) {
    notices.push({
      id: "rewards-start",
      type: "info",
      title: "Rewards Will Appear Here",
      body: "Your rewards dashboard is ready. Earnings will show once eligible activity is recorded.",
    });
  }

  if (rewardAccount.companyBuildingPending > 0) {
    notices.push({
      id: "company-building-pending",
      type: "info",
      title: "Company-Building Earnings Pending",
      body: "Existing tier allowances are released after Member A recruits 4 new active team members. Tiers stay the same or increase with active members.",
    });
  }

  if (!access.perks_ready) {
    notices.push({
      id: "access-perks-sync",
      type: access.sync_error ? "warning" : "info",
      title: access.sync_error
        ? "Access Perks Sync Pending"
        : "Access Perks Is Being Connected",
      body: access.sync_error
        ? "Your membership is active, but Access Perks member sync is waiting on the correct Access AMT endpoint."
        : "Your membership is active. Benefits will show as active once the Access Perks member record is confirmed.",
    });
  }

  return notices;
}

function buildSupportPayload() {
  return {
    email: "support@cardleorewards.com",
    phone: "",
    hours: "Mon–Fri, 9:00 AM–6:00 PM",
    endpoint: "/api/contact",
  };
}

function buildProfilePayload(member) {
  const safeMember = sanitizeMember(member);

  return {
    id: safeMember.id,
    email: safeMember.email,
    first_name: safeMember.firstName,
    last_name: safeMember.lastName,
    full_name: safeMember.fullName,
    status: safeMember.status,
    payment_status: safeMember.paymentStatus,
    membership_status: safeMember.membershipStatus,
    approval_status: safeMember.approvalStatus,
    tier: safeMember.tier,
    role: "member",
    access_member_identifier: safeMember.accessMemberIdentifier,
    access_member_status: safeMember.accessMemberStatus,
    access_perks_ready: safeMember.accessPerksReady,
    benefits_ready: safeMember.benefitsReady,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_rewards" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { member, response } = await getAuthenticatedMember(req, res);

    if (!member) {
      return response;
    }

    const safeMember = sanitizeMember(member);
    const access = buildAccessPayload(member);

    const memberId = safeMember.id;
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT);
    const queryLimit = Math.max(limit, DEFAULT_LIMIT);

    const [
      rewardAccountRaw,
      rewardTransactionRows,
      payoutRows,
      paymentRows,
      cycleRows,
    ] = await Promise.all([
      queryOptionalSingleByMemberColumns({
        table: "reward_accounts",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
      }),

      queryOptionalListByMemberColumns({
        table: "reward_transactions",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
        orderColumn: "created_at",
      }),

      queryOptionalListByMemberColumns({
        table: "reward_payouts",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
        orderColumn: "created_at",
      }),

      queryOptionalListByMemberColumns({
        table: "membership_payments",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
        orderColumn: "created_at",
      }),

      queryOptionalListByMemberColumns({
        table: "membership_cycles",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
        limit: queryLimit,
        orderColumn: "created_at",
      }),
    ]);

    const rewardAccount = normalizeRewardAccount(rewardAccountRaw, member);

    const transactions = sortByDateDesc(
      rewardTransactionRows.map(mapRewardTransactionRow),
      ["postedAt", "createdAt"]
    ).slice(0, limit);

    const payouts = sortByDateDesc(
      payoutRows.map(mapPayoutRow),
      ["paidAt", "createdAt"]
    ).slice(0, limit);

    const payments = sortByDateDesc(
      paymentRows.map(mapPaymentRow),
      ["paidAt", "createdAt"]
    ).slice(0, limit);

    const cycles = sortByDateDesc(
      cycleRows.map(mapCycleRow),
      ["cycleStartDate", "createdAt"]
    ).slice(0, limit);

    const summary = buildSummary({
      rewardAccount,
      transactions,
      payouts,
      payments,
      cycles,
      member,
    });

    const notices = buildNotices({
      member,
      rewardAccount,
      access,
    });

    logRequestSuccess(req, {
      scope: "portal_rewards",
      memberId,
      email: safeMember.email,
      transactionCount: transactions.length,
      payoutCount: payouts.length,
      accessMemberStatus: access.member_status,
      accessPerksReady: access.perks_ready,
      ip: getClientIp(req),
    });

    return ok(
      res,
      {
        authenticated: true,

        member: safeMember,
        profile: buildProfilePayload(member),

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

        rewardAccount,
        rewards: transactions,
        transactions,
        payouts,
        membershipPayments: payments,
        cycles,
        summary,
        notices,
        support: buildSupportPayload(),

        filters: {
          limit,
        },

        timezone: DEFAULT_TIMEZONE,
        fetchedAt: new Date().toISOString(),
      },
      "Rewards loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_rewards_unexpected",
    });

    return serverError(
      res,
      "Something went wrong while loading member rewards.",
      process.env.NODE_ENV === "development"
        ? {
            error: String(error?.message || error),
            code: error?.code || null,
          }
        : null
    );
  }
}