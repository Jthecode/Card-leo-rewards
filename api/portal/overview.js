// api/portal/overview.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  forbidden,
  notFound,
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

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
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

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
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
  return normalizeText(value || "pending").toLowerCase();
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

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function safeDate(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function getSessionRole(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeText(
    session.role ||
      session.profile?.role ||
      session.user?.role ||
      session.user?.user_metadata?.role ||
      session.member?.role ||
      "member"
  ).toLowerCase();
}

function isAdminRole(role) {
  return ["admin", "support", "owner", "staff"].includes(
    normalizeText(role).toLowerCase()
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

  if (["pending", "reviewing"].includes(status)) return "pending";
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

  const portalAccess = hasPortalAccess(member);
  const safeStatus = normalizeStatus(member.status);
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);
  const approvalStatus = normalizeStatus(member.approval_status);
  const access = buildAccessPayload(member);

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

    status: safeStatus,
    payment_status: paymentStatus,
    membership_status: membershipStatus,
    approval_status: portalAccess ? "approved" : approvalStatus,

    paymentStatus,
    membershipStatus,
    approvalStatus: portalAccess ? "approved" : approvalStatus,

    memberStatus: normalizeMemberStatus(member),

    tier: normalizeTier(member.tier || "core"),
    tierLabel: titleCase(normalizeTier(member.tier || "core")),

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

function buildDefaultOnboarding(member) {
  const emailVerified = Boolean(member?.email_verified || member?.email_verified_at);

  const profileCompleted = Boolean(
    normalizeText(member?.first_name) &&
      normalizeText(member?.last_name) &&
      normalizeText(member?.email) &&
      normalizeText(member?.phone)
  );

  const rewardsActivated = hasPortalAccess(member);

  let percent = 0;

  if (profileCompleted) percent += 40;
  if (emailVerified) percent += 30;
  if (rewardsActivated) percent += 30;

  return {
    signup_id: member?.id || null,
    member_id: member?.id || null,
    accepted_terms: Boolean(member?.agreed),
    accepted_privacy: Boolean(member?.agreed),
    profile_completed: profileCompleted,
    email_verified: emailVerified,
    first_login_completed: true,
    rewards_activated: rewardsActivated,
    onboarding_percent: Math.max(0, Math.min(100, percent)),
    onboarding_status: percent >= 100 ? "complete" : "in_progress",
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

function buildSupportInfo(settings = {}) {
  const support = isObject(settings.support) ? settings.support : {};

  return {
    email: support.email || "support@cardleorewards.com",
    phone: support.phone || "",
    hours: support.hours || "Mon–Fri, 9:00 AM–6:00 PM",
    endpoint: "/api/contact",
  };
}

function buildSecurityInfo(member, settings = {}) {
  const security = isObject(settings.security) ? settings.security : {};

  return {
    emailVerified:
      security.emailVerified ??
      Boolean(member?.email_verified || member?.email_verified_at),
    twoFactorEnabled: security.twoFactorEnabled ?? false,
    passwordLastChangedAt: security.passwordLastChangedAt || null,
    changePasswordEndpoint: "/api/portal/change-password",
    sessionsEndpoint: "/api/portal/sessions",
    settingsEndpoint: "/api/portal/settings",
  };
}

function buildPreferences(settings = {}) {
  const preferences = isObject(settings.preferences) ? settings.preferences : {};

  return {
    emailNotifications: preferences.emailNotifications ?? true,
    smsNotifications: preferences.smsNotifications ?? false,
    productUpdates: preferences.productUpdates ?? true,
    marketingEmails: preferences.marketingEmails ?? true,
    rewardAlerts: preferences.rewardAlerts ?? true,
    securityAlerts: preferences.securityAlerts ?? true,
    theme: preferences.theme || "dark",
  };
}

function buildQuickActions(member) {
  const safeMember = sanitizeMember(member);
  const access = buildAccessPayload(member);

  return [
    {
      id: "view_benefits",
      label: access.perks_ready ? "Open Benefits" : "View Benefits",
      href: "/portal/benefits.html",
      icon: "rewards",
      enabled: Boolean(safeMember?.portalAccess),
      status: access.perks_ready ? "active" : "syncing",
    },
    {
      id: "activity",
      label: "View Activity",
      href: "/portal/activity.html",
      icon: "activity",
      enabled: true,
    },
    {
      id: "settings",
      label: "Account Settings",
      href: "/portal/settings.html",
      icon: "settings",
      enabled: true,
    },
    {
      id: "referrals",
      label: "Referral Tools",
      href: "/portal/leaderboard.html",
      icon: "referrals",
      enabled: true,
    },
    {
      id: "support",
      label: "Contact Support",
      href: "/portal/support.html",
      icon: "support",
      enabled: true,
    },
  ];
}

function buildAccountActivity(member) {
  const items = [];

  if (member?.created_at) {
    items.push({
      id: `account_created:${member.id}`,
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
      },
    });
  }

  if (member?.access_synced_at) {
    items.push({
      id: `access_synced:${member.id}`,
      source: "access_amt",
      category: "benefits",
      type: "access_synced",
      title: "Access Perks Sync Updated",
      description:
        getAccessMemberStatus(member).toUpperCase() === "OPEN"
          ? "Your Access Perks member record is active."
          : "Your Access Perks member record was updated.",
      status: getAccessMemberStatus(member),
      badge: "Benefits",
      occurredAt: safeDate(member.access_synced_at),
      createdAt: safeDate(member.access_synced_at),
      metadata: {
        accessMemberIdentifier: member.access_member_identifier || "",
        accessMemberStatus: member.access_member_status || "",
      },
    });
  }

  if (member?.email_verified_at) {
    items.push({
      id: `email_verified:${member.id}`,
      source: "signups",
      category: "account",
      type: "email_verified",
      title: "Email Verified",
      description: "Your email address was verified.",
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

  if (member?.updated_at && member.updated_at !== member.created_at) {
    items.push({
      id: `account_updated:${member.id}`,
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

  return items;
}

function mapMemberActivityRow(row) {
  const type = row.activity_type || row.type || "account_activity";

  return {
    id: `member_activity:${row.id}`,
    source: "member_activity",
    category: row.category || "account",
    type,
    title: row.title || titleCase(type),
    description: row.description || null,
    status: row.status || null,
    badge: row.badge || titleCase(row.category || "Activity"),
    occurredAt: safeDate(row.occurred_at || row.created_at),
    createdAt: safeDate(row.created_at),
    metadata: row.metadata || {},
  };
}

function getExtendedSignupFields() {
  return [
    "id",
    "email",
    "status",
    "payment_status",
    "membership_status",
    "approval_status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "interest",
    "goals",
    "agreed",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
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
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
    "portal_settings",
    "portal_sessions",
  ].join(", ");
}

function getBaseSignupFields() {
  return [
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
    "agreed",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");
}

async function getSignupRecord({ signupId, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select(getExtendedSignupFields())
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
      .select(getBaseSignupFields())
      .limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else {
      fallbackQuery = fallbackQuery.ilike("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            payment_status: "",
            membership_status: "",
            approval_status: "",
            access_member_identifier: "",
            access_member_status: "pending",
            access_synced_at: null,
            access_suspended_at: null,
            access_sync_error: "",
            access_perks_ready: false,
            portal_settings: {},
            portal_sessions: [],
          }
        : null,
      error: fallback.error,
    };
  }

  return result;
}

async function queryOptionalSingleByMemberColumns({ table, memberId, columns }) {
  for (const column of columns) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .maybeSingle();

    if (!error) return data || null;

    if (isMissingOptionalTableOrColumn(error)) continue;

    throw error;
  }

  return null;
}

async function queryOptionalListByMemberColumns({
  table,
  memberId,
  columns,
  limit = 10,
  orderColumn = "created_at",
}) {
  for (const column of columns) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .order(orderColumn, { ascending: false })
      .limit(limit);

    if (!error) return data || [];

    if (isMissingOptionalTableOrColumn(error)) continue;

    throw error;
  }

  return [];
}

async function getFeatureFlags() {
  const fallback = {
    rewards_enabled: true,
    referrals_enabled: true,
    support_enabled: true,
    benefits_enabled: true,
    access_perks_enabled: true,
  };

  try {
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", "portal.features")
      .maybeSingle();

    if (error && isMissingOptionalTableOrColumn(error)) return fallback;
    if (error) throw error;

    return {
      rewards_enabled: data?.value?.rewards_enabled !== false,
      referrals_enabled: data?.value?.referrals_enabled !== false,
      support_enabled: data?.value?.support_enabled !== false,
      benefits_enabled: data?.value?.benefits_enabled !== false,
      access_perks_enabled: data?.value?.access_perks_enabled !== false,
    };
  } catch {
    return fallback;
  }
}

function buildStats({ onboarding, rewardAccount, recentActivity }) {
  return {
    onboardingPercent: Number(onboarding?.onboarding_percent || 0),
    totalRewardsEarned: money(rewardAccount?.total_rewards_earned),
    totalRewardsPaid: money(rewardAccount?.total_rewards_paid),
    companyBuildingPending: money(rewardAccount?.company_building_pending),
    companyBuildingReleased: money(rewardAccount?.company_building_released),
    directReferralEarned: money(rewardAccount?.total_direct_referral_earned),
    overrideEarned: money(rewardAccount?.total_override_earned),
    recentActivityCount: recentActivity.length,
  };
}

function buildAlerts({ member, onboarding }) {
  const alerts = [];
  const access = buildAccessPayload(member);

  if (!member?.email_verified && !member?.email_verified_at) {
    alerts.push({
      id: "verify_email",
      type: "warning",
      title: "Verify your email",
      message: "Verify your email address to complete your account setup.",
      actionLabel: "Resend Verification",
      actionHref: "/forgot-password.html",
    });
  }

  if (Number(onboarding?.onboarding_percent || 0) < 100) {
    alerts.push({
      id: "complete_onboarding",
      type: "info",
      title: "Finish onboarding",
      message: "Complete your profile and account setup to unlock more benefits.",
      actionLabel: "Go to Settings",
      actionHref: "/portal/settings.html",
    });
  }

  if (hasPortalAccess(member) && !access.perks_ready) {
    alerts.push({
      id: "access_perks_sync",
      type: access.sync_error ? "warning" : "info",
      title: access.sync_error
        ? "Access Perks sync pending"
        : "Access Perks is being connected",
      message: access.sync_error
        ? "Your membership is active, but Access Perks member sync is waiting on the correct Access AMT endpoint."
        : "Your membership is active. Access Perks will show as active once your member record syncs.",
      actionLabel: "View Benefits",
      actionHref: "/portal/benefits.html",
    });
  }

  return alerts;
}

function createPortalPayload({
  member,
  onboarding,
  rewardAccount,
  featureFlags,
  recentActivity,
}) {
  const settings = isObject(member.portal_settings) ? member.portal_settings : {};
  const safeMember = sanitizeMember(member);
  const access = buildAccessPayload(member);
  const preferences = buildPreferences(settings);
  const security = buildSecurityInfo(member, settings);
  const support = buildSupportInfo(settings);
  const stats = buildStats({ onboarding, rewardAccount, recentActivity });
  const alerts = buildAlerts({ member, onboarding });

  return {
    member: safeMember,

    access,

    benefits: {
      enabled: featureFlags.benefits_enabled !== false,
      access_perks_enabled: featureFlags.access_perks_enabled !== false,
      ready: access.perks_ready,
      status: access.member_status,
      member_identifier: access.member_identifier,
      synced_at: access.synced_at,
      sync_error: access.sync_error,
      portal_url: "/portal/benefits.html",
    },

    overview: {
      member: safeMember,
      access,
      benefits: {
        ready: access.perks_ready,
        status: access.member_status,
        href: "/portal/benefits.html",
      },
      stats,
      alerts,
      quickActions: buildQuickActions(member),
      recentActivity,
      timezone: DEFAULT_TIMEZONE,
    },

    portal: {
      access: safeMember.portalAccess,
      path: DEFAULT_PORTAL_PATH,
      loginUrl: safeMember.portalLoginUrl,
      accessLevel: safeMember.accessLevel,
    },

    onboarding,
    rewardAccount,
    featureFlags,
    preferences,
    security,
    support,

    sessions: Array.isArray(member.portal_sessions) ? member.portal_sessions : [],

    summary: {
      memberId: safeMember.id,
      profileId: safeMember.id,
      memberName: safeMember.fullName,
      email: safeMember.email,
      status: safeMember.status,
      payment_status: safeMember.paymentStatus,
      membership_status: safeMember.membershipStatus,
      approval_status: safeMember.approvalStatus,
      memberStatus: safeMember.memberStatus,
      tier: safeMember.tier,
      tierLabel: safeMember.tierLabel,
      portalAccess: safeMember.portalAccess,
      accessMemberIdentifier: access.member_identifier,
      accessMemberStatus: access.member_status,
      accessPerksReady: access.perks_ready,
      benefitsReady: access.benefits_ready,
      timezone: DEFAULT_TIMEZONE,
    },
  };
}

async function getAuthenticatedMember(req, res) {
  const sessionMeta = readSessionCookie(req);

  if (!sessionMeta?.data) {
    return {
      member: null,
      role: "",
      response: unauthorized(
        res,
        "Authentication required. Please log in to continue."
      ),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      member: null,
      role: "",
      response: unauthorized(res, "Session expired. Please log in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      member: null,
      role: "",
      response: unauthorized(res, "Invalid session. Please log in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);
  const role = getSessionRole(sessionMeta);

  if (!signupId && !email) {
    clearAuthCookies(res);

    return {
      member: null,
      role,
      response: unauthorized(
        res,
        "Your session is missing member identity details. Please log in again."
      ),
    };
  }

  const { data: signupRecord, error } = await getSignupRecord({
    signupId,
    email,
  });

  if (error) {
    throw error;
  }

  if (!signupRecord?.id) {
    clearAuthCookies(res);

    return {
      member: null,
      role,
      response: notFound(
        res,
        "We could not locate your Card Leo Rewards member record.",
        {
          member: null,
          overview: null,
        }
      ),
    };
  }

  if (!hasPortalAccess(signupRecord) && !isAdminRole(role)) {
    clearAuthCookies(res);

    const status = normalizeStatus(signupRecord.status || "pending");

    return {
      member: null,
      role,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active.",
        {
          member: sanitizeMember(signupRecord),
        }
      ),
    };
  }

  return {
    member: signupRecord,
    role,
    response: null,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_overview" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { member, role, response } = await getAuthenticatedMember(req, res);

    if (!member) {
      return response;
    }

    const memberId = member.id;

    const [featureFlags, onboardingOptional, rewardAccountOptional, activityRows] =
      await Promise.all([
        getFeatureFlags(),

        queryOptionalSingleByMemberColumns({
          table: "member_onboarding",
          memberId,
          columns: ["member_id", "signup_id", "profile_id"],
        }),

        queryOptionalSingleByMemberColumns({
          table: "reward_accounts",
          memberId,
          columns: ["member_id", "signup_id", "profile_id"],
        }),

        queryOptionalListByMemberColumns({
          table: "member_activity",
          memberId,
          columns: ["member_id", "signup_id", "profile_id"],
          limit: 8,
          orderColumn: "created_at",
        }),
      ]);

    const onboarding = onboardingOptional || buildDefaultOnboarding(member);
    const rewardAccount = rewardAccountOptional || buildDefaultRewardAccount(member);

    const recentActivity = [
      ...activityRows.map(mapMemberActivityRow),
      ...buildAccountActivity(member),
    ]
      .sort((a, b) => {
        const aTime = new Date(a.occurredAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.occurredAt || b.createdAt || 0).getTime();

        return bTime - aTime;
      })
      .slice(0, 8);

    const payload = createPortalPayload({
      member,
      onboarding,
      rewardAccount,
      featureFlags,
      recentActivity,
    });

    logRequestSuccess(req, {
      scope: "portal_overview",
      memberId,
      email: member.email,
      role,
      accessMemberStatus: payload.access.member_status,
      accessPerksReady: payload.access.perks_ready,
      ip: getClientIp(req),
    });

    return ok(res, payload, "Portal overview loaded successfully.");
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_overview_unexpected",
    });

    return serverError(
      res,
      "We were unable to load the member portal overview.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown error.",
            code: error?.code || null,
          }
        : null
    );
  }
}