// api/auth/me.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { ok, methodNotAllowed, serverError } from "../../lib/responses.js";
import { clearAuthCookies, getSessionCookieName } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";
const LOGIN_REDIRECT = "/login.html";
const SIGNUP_REDIRECT = "/signup.html?status=payment_required";

const SESSION_COOKIE_NAME = "cardleo_session";
const SESSION_TOKEN_COOKIE_NAME = "cardleo_session_token";

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
  "paid",
  "current",
  "complete",
  "completed",
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
  "paid",
  "approved",
  "current",
]);

const PAYMENT_REQUIRED_STATUSES = new Set([
  "unpaid",
  "payment_pending",
  "pending_payment",
  "requires_payment",
  "incomplete",
  "past_due",
  "pending",
  "inactive",
  "",
]);

const BAD_PORTAL_REDIRECTS = new Set([
  "",
  "/",
  "/login",
  "/login.html",
  "login",
  "login.html",
  "/member-login",
  "member-login",
  "/signup",
  "/signup.html",
  "signup",
  "signup.html",
  "/join",
  "join",
]);

const AUTH_COOKIE_ALIASES = [
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  "cardleo_auth",
  "cardleo_member",
  "cardleo_member_id",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
  "token",
  "access_token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
];

const POSSIBLE_SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const POSSIBLE_TOKEN_COOKIE_NAMES = [
  SESSION_TOKEN_COOKIE_NAME,
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeString(value || "").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeString(value || "core").toLowerCase();

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

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader("Set-Cookie");

  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [existing, cookieValue]);
}

function buildExpiredCookie(name, { httpOnly = true } = {}) {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax",
  ];

  if (httpOnly) parts.push("HttpOnly");
  if (process.env.NODE_ENV === "production") parts.push("Secure");

  return parts.join("; ");
}

function clearCookieAliases(res) {
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...AUTH_COOKIE_ALIASES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: true }));
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: false }));
  }
}

function clearEveryAuthCookie(res) {
  try {
    clearAuthCookies(res);
  } catch {
    // Continue clearing aliases below.
  }

  clearCookieAliases(res);
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

      if (!name) return cookies;

      cookies[name] = value;
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

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeBase64JsonParse(value) {
  const raw = String(value || "");

  if (!raw) return null;

  const attempts = [raw, raw.replace(/-/g, "+").replace(/_/g, "/")];

  for (const attempt of attempts) {
    try {
      const padded = attempt.padEnd(Math.ceil(attempt.length / 4) * 4, "=");
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);

      if (isObject(parsed)) return parsed;
    } catch {
      // Try the next format.
    }
  }

  return null;
}

function parseSessionValue(rawValue) {
  const decoded = decodeCookieValue(rawValue);

  if (!decoded) return null;

  const parsedJson = safeJsonParse(decoded);
  if (isObject(parsedJson)) return parsedJson;

  const parsedBase64 = safeBase64JsonParse(decoded);
  if (isObject(parsedBase64)) return parsedBase64;

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_SESSION_COOKIE_NAMES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseSessionValue(cookies[name]);

    if (isObject(parsed)) {
      return {
        name,
        raw: cookies[name],
        value: parsed,
      };
    }
  }

  return null;
}

function readSessionTokenCookie(req) {
  const cookies = parseCookieHeader(req);

  for (const name of POSSIBLE_TOKEN_COOKIE_NAMES) {
    const raw = cookies[name];

    if (!raw) continue;

    const token = normalizeString(decodeCookieValue(raw));

    if (token) {
      return {
        name,
        token,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(sessionCookie) {
  const value = sessionCookie?.value || sessionCookie || {};

  const candidates = [
    value.expires_at,
    value.expiresAt,
    value.exp,
    value.session?.expires_at,
    value.session?.expiresAt,
  ];

  for (const candidate of candidates) {
    const number = Number(candidate);

    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return 0;
}

function isSessionExpired(sessionCookie) {
  const expiresAt = getSessionExpiresAt(sessionCookie);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionIdentity(sessionCookie) {
  const value = sessionCookie?.value || sessionCookie || {};

  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const userMetadata = isObject(user.user_metadata) ? user.user_metadata : {};

  const ids = [
    value.signupId,
    value.signup_id,
    value.memberId,
    value.member_id,
    value.recordId,
    value.id,

    member.id,
    member.signupId,
    member.signup_id,
    member.memberId,
    member.member_id,

    profile.id,
    profile.signupId,
    profile.signup_id,
    profile.memberId,
    profile.member_id,

    userMetadata.signupId,
    userMetadata.signup_id,
    userMetadata.memberId,
    userMetadata.member_id,

    user.id,
  ]
    .map(normalizeString)
    .filter(Boolean);

  const portalUserIds = [
    value.portalUserId,
    value.portal_user_id,

    member.portalUserId,
    member.portal_user_id,

    profile.portalUserId,
    profile.portal_user_id,

    user.portalUserId,
    user.portal_user_id,

    userMetadata.portalUserId,
    userMetadata.portal_user_id,
  ]
    .map(normalizeString)
    .filter(Boolean);

  const email = normalizeEmail(
    value.email ||
      value.userEmail ||
      member.email ||
      profile.email ||
      user.email ||
      userMetadata.email
  );

  const token = normalizeString(
    value.token ||
      value.sessionToken ||
      value.session_token ||
      value.authToken ||
      value.auth_token ||
      value.loginToken ||
      value.login_token ||
      value.portalToken ||
      value.portal_token ||
      value.session?.token ||
      value.session?.access_token
  );

  return {
    ids: Array.from(new Set(ids)),
    portalUserIds: Array.from(new Set(portalUserIds)),
    email,
    token,
  };
}

function getDisplayName(member) {
  const fullName = normalizeString(member?.full_name || member?.fullName);

  if (fullName) return fullName;

  return (
    [member?.first_name, member?.last_name]
      .map(normalizeString)
      .filter(Boolean)
      .join(" ") || "Card Leo Member"
  );
}

function hasPortalAccessForMember(member) {
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

function doesMemberRequirePayment(member) {
  if (!member) return true;
  if (hasPortalAccessForMember(member)) return false;

  const status = normalizeStatus(member.status);
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);

  return (
    PAYMENT_REQUIRED_STATUSES.has(status) ||
    PAYMENT_REQUIRED_STATUSES.has(paymentStatus) ||
    PAYMENT_REQUIRED_STATUSES.has(membershipStatus)
  );
}

function normalizeMemberStatus(member) {
  if (!member) return "pending";
  if (hasPortalAccessForMember(member)) return "active";

  const status = normalizeStatus(member.status);

  if (["pending", "reviewing"].includes(status)) return "pending";
  if (["disabled", "suspended", "paused"].includes(status)) return "suspended";
  if (["denied", "closed", "cancelled", "canceled"].includes(status)) {
    return status;
  }

  return status || "pending";
}

function resolvePortalLoginUrl(member) {
  const rawPortalLoginUrl = normalizeString(member?.portal_login_url);
  const portalLoginUrl = rawPortalLoginUrl.toLowerCase();

  if (BAD_PORTAL_REDIRECTS.has(portalLoginUrl)) {
    return DEFAULT_REDIRECT;
  }

  if (!rawPortalLoginUrl) {
    return DEFAULT_REDIRECT;
  }

  if (rawPortalLoginUrl.startsWith("/") && !rawPortalLoginUrl.startsWith("//")) {
    if (!rawPortalLoginUrl.startsWith("/portal")) {
      return DEFAULT_REDIRECT;
    }

    return rawPortalLoginUrl;
  }

  return DEFAULT_REDIRECT;
}

function getAccessMemberStatus(member) {
  return normalizeString(member?.access_member_status || "pending");
}

function getAccessPerksReady(member) {
  const raw = member?.access_perks_ready;

  if (typeof raw === "boolean") return raw;

  const status = getAccessMemberStatus(member).toUpperCase();

  return status === "OPEN";
}

function sanitizeMember(member) {
  if (!member) return null;

  const tier = normalizeTier(member.tier || "core");
  const status = normalizeStatus(member.status || "pending");
  const paymentStatus = normalizeStatus(member.payment_status || "");
  const membershipStatus = normalizeStatus(member.membership_status || "");
  const approvalStatus = normalizeStatus(member.approval_status || status);

  const portalAccess = hasPortalAccessForMember(member);
  const requiresPayment = doesMemberRequirePayment(member);
  const portalLoginUrl = resolvePortalLoginUrl(member);

  const accessMemberIdentifier = normalizeString(member.access_member_identifier);
  const accessMemberStatus = getAccessMemberStatus(member);
  const accessSyncedAt = member.access_synced_at || null;
  const accessSuspendedAt = member.access_suspended_at || null;
  const accessSyncError = normalizeString(member.access_sync_error);
  const accessPerksReady = getAccessPerksReady(member);

  return {
    id: member.id || null,
    signupId: member.id || null,
    portalUserId: member.portal_user_id || null,

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

    referralName: member.referral_name || "",
    referral_name: member.referral_name || "",

    referralEmail: member.referral_email || "",
    referral_email: member.referral_email || "",

    referralCode: member.referral_code || "",
    referral_code: member.referral_code || "",

    status,
    payment_status: paymentStatus,
    membership_status: membershipStatus,
    approval_status: portalAccess ? "approved" : approvalStatus,

    paymentStatus,
    membershipStatus,
    approvalStatus: portalAccess ? "approved" : approvalStatus,

    memberStatus: normalizeMemberStatus(member),

    requires_payment: requiresPayment,
    requiresPayment,
    payment_required: requiresPayment,
    paymentRequired: requiresPayment,

    activation_fee_amount: Number(member.activation_fee_amount || 25),
    monthly_fee_amount: Number(member.monthly_fee_amount || 20),
    billing_day: Number(member.billing_day || 10),

    activationFeeAmount: Number(member.activation_fee_amount || 25),
    monthlyFeeAmount: Number(member.monthly_fee_amount || 20),
    billingDay: Number(member.billing_day || 10),

    tier,
    tierLabel: titleCase(tier),

    portalLoginUrl,
    portal_login_url: portalLoginUrl,
    portalAccess,
    accessLevel: "member",

    stripeCustomerId: member.stripe_customer_id || "",
    stripeSubscriptionId: member.stripe_subscription_id || "",
    stripeCheckoutSessionId: member.stripe_checkout_session_id || "",

    accessMemberIdentifier,
    access_member_identifier: accessMemberIdentifier,

    accessMemberStatus,
    access_member_status: accessMemberStatus,

    accessSyncedAt,
    access_synced_at: accessSyncedAt,

    accessSuspendedAt,
    access_suspended_at: accessSuspendedAt,

    accessSyncError,
    access_sync_error: accessSyncError,

    accessPerksReady,
    access_perks_ready: accessPerksReady,

    benefitsReady: accessPerksReady,
    benefits_ready: accessPerksReady,

    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,

    createdAt: member.created_at || null,
    joinedAt: member.created_at || null,
    updatedAt: member.updated_at || null,

    role: "member",
  };
}

function buildUser(member) {
  const safeMember = sanitizeMember(member);

  if (!safeMember) return null;

  return {
    id: safeMember.id,
    email: safeMember.email,
    role: "member",
    user_metadata: {
      full_name: safeMember.fullName,
      first_name: safeMember.firstName,
      last_name: safeMember.lastName,
      status: safeMember.status,
      payment_status: safeMember.paymentStatus,
      membership_status: safeMember.membershipStatus,
      approval_status: safeMember.approvalStatus,
      requires_payment: safeMember.requiresPayment,
      signup_id: safeMember.id,
      member_id: safeMember.id,
      portal_user_id: safeMember.portalUserId,
      access_member_identifier: safeMember.accessMemberIdentifier,
      access_member_status: safeMember.accessMemberStatus,
      access_perks_ready: safeMember.accessPerksReady,
    },
    app_metadata: {
      provider: "cardleo-signups",
      role: "member",
    },
  };
}

function buildProfile(member) {
  const safeMember = sanitizeMember(member);

  if (!safeMember) return null;

  return {
    id: safeMember.id,
    email: safeMember.email,
    full_name: safeMember.fullName,
    first_name: safeMember.firstName,
    last_name: safeMember.lastName,
    phone: safeMember.phone,
    city: safeMember.city,
    state: safeMember.state,
    interest: safeMember.interest,
    goals: safeMember.goals,
    referral_name: safeMember.referralName,
    referral_email: safeMember.referralEmail,
    referral_code: safeMember.referralCode,
    tier: safeMember.tier,
    role: "member",
    status: safeMember.status,
    payment_status: safeMember.paymentStatus,
    membership_status: safeMember.membershipStatus,
    approval_status: safeMember.approvalStatus,
    requires_payment: safeMember.requiresPayment,
    activation_fee_amount: safeMember.activationFeeAmount,
    monthly_fee_amount: safeMember.monthlyFeeAmount,
    billing_day: safeMember.billingDay,
    portal_login_url: safeMember.portalLoginUrl,

    access_member_identifier: safeMember.accessMemberIdentifier,
    access_member_status: safeMember.accessMemberStatus,
    access_synced_at: safeMember.accessSyncedAt,
    access_suspended_at: safeMember.accessSuspendedAt,
    access_sync_error: safeMember.accessSyncError,
    access_perks_ready: safeMember.accessPerksReady,
    benefits_ready: safeMember.benefitsReady,

    email_verified: safeMember.emailVerified,
    email_verified_at: safeMember.emailVerifiedAt,
    created_at: safeMember.createdAt,
    updated_at: safeMember.updatedAt,
  };
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

function getSelectFields({ extended = true } = {}) {
  const base = [
    "id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "city",
    "state",
    "interest",
    "agreed",
    "status",
    "portal_user_id",
    "portal_login_url",
    "created_at",
    "updated_at",
  ];

  if (!extended) {
    return base.join(", ");
  }

  return [
    ...base,
    "full_name",
    "goals",
    "referral_name",
    "referral_email",
    "referral_code",
    "tier",
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
    "session_token",
    "auth_token",
    "login_token",
    "portal_token",
    "session_expires_at",
    "last_login_at",
  ].join(", ");
}

async function queryMemberBy({ column, value, extended = true }) {
  if (!value) {
    return {
      data: null,
      error: null,
    };
  }

  return supabaseAdmin
    .from("signups")
    .select(getSelectFields({ extended }))
    .eq(column, value)
    .maybeSingle();
}

async function queryMemberByIlikeEmail(email, extended = true) {
  if (!email) {
    return {
      data: null,
      error: null,
    };
  }

  return supabaseAdmin
    .from("signups")
    .select(getSelectFields({ extended }))
    .ilike("email", email)
    .maybeSingle();
}

async function queryMemberByToken(token, extended = true) {
  if (!token) {
    return {
      data: null,
      error: null,
    };
  }

  return supabaseAdmin
    .from("signups")
    .select(getSelectFields({ extended }))
    .or(
      [
        `session_token.eq.${token}`,
        `auth_token.eq.${token}`,
        `login_token.eq.${token}`,
        `portal_token.eq.${token}`,
      ].join(",")
    )
    .maybeSingle();
}

function hydrateMember(row) {
  if (!row?.id) return null;

  return {
    full_name:
      row.full_name ||
      [row.first_name, row.last_name]
        .map(normalizeString)
        .filter(Boolean)
        .join(" "),
    goals: row.goals || "",
    referral_name: row.referral_name || "",
    referral_email: row.referral_email || "",
    referral_code: row.referral_code || "",
    tier: row.tier || "core",
    email_verified: Boolean(row.email_verified),
    email_verified_at: row.email_verified_at || null,
    payment_status: row.payment_status || "",
    membership_status: row.membership_status || "",
    approval_status: row.approval_status || "",
    activation_fee_amount: row.activation_fee_amount || 25,
    monthly_fee_amount: row.monthly_fee_amount || 20,
    billing_day: row.billing_day || 10,

    access_member_identifier: row.access_member_identifier || "",
    access_member_status: row.access_member_status || "pending",
    access_synced_at: row.access_synced_at || null,
    access_suspended_at: row.access_suspended_at || null,
    access_sync_error: row.access_sync_error || "",
    access_perks_ready: Boolean(row.access_perks_ready),

    ...row,
  };
}

async function findMemberFromSession(req, sessionCookie) {
  const tokenCookie = readSessionTokenCookie(req);
  const identity = getSessionIdentity(sessionCookie);
  const sessionToken = normalizeString(tokenCookie?.token || identity.token);

  if (sessionToken) {
    let result = await queryMemberByToken(sessionToken, true);

    if (result.error && isMissingOptionalTableOrColumn(result.error)) {
      result = await queryMemberByToken(sessionToken, false);
    }

    if (!result.error && result.data?.id) {
      return {
        member: hydrateMember(result.data),
        error: null,
        identity,
        matchedBy: "session_token",
      };
    }

    if (result.error && !isMissingOptionalTableOrColumn(result.error)) {
      return {
        member: null,
        error: result.error,
        identity,
        matchedBy: "session_token",
      };
    }
  }

  const attempts = [];

  for (const id of identity.ids) {
    attempts.push({
      column: "id",
      value: id,
    });
  }

  for (const portalUserId of identity.portalUserIds) {
    attempts.push({
      column: "portal_user_id",
      value: portalUserId,
    });
  }

  const uniqueAttempts = [];
  const seen = new Set();

  for (const attempt of attempts) {
    const key = `${attempt.column}:${attempt.value}`;

    if (!attempt.value || seen.has(key)) continue;

    seen.add(key);
    uniqueAttempts.push(attempt);
  }

  let lastError = null;

  for (const attempt of uniqueAttempts) {
    let result = await queryMemberBy({
      column: attempt.column,
      value: attempt.value,
      extended: true,
    });

    if (result.error && isMissingOptionalTableOrColumn(result.error)) {
      result = await queryMemberBy({
        column: attempt.column,
        value: attempt.value,
        extended: false,
      });
    }

    if (result.error) {
      lastError = result.error;
      continue;
    }

    if (result.data?.id) {
      return {
        member: hydrateMember(result.data),
        error: null,
        identity,
        matchedBy: attempt.column,
      };
    }
  }

  if (identity.email) {
    let result = await queryMemberByIlikeEmail(identity.email, true);

    if (result.error && isMissingOptionalTableOrColumn(result.error)) {
      result = await queryMemberByIlikeEmail(identity.email, false);
    }

    if (result.error) {
      lastError = result.error;
    }

    if (result.data?.id) {
      return {
        member: hydrateMember(result.data),
        error: null,
        identity,
        matchedBy: "email",
      };
    }
  }

  return {
    member: null,
    error: lastError,
    identity,
    matchedBy: "",
  };
}

function unauthenticatedResponse(res, message = "No active session.", extra = {}) {
  return ok(
    res,
    {
      authenticated: false,
      user: null,
      profile: null,
      member: null,
      session: null,
      role: "",
      redirectTo: LOGIN_REDIRECT,
      ...extra,
    },
    message
  );
}

function paymentRequiredResponse(
  res,
  member,
  message = "Membership payment is required."
) {
  const safeMember = sanitizeMember(member);

  return ok(
    res,
    {
      authenticated: false,
      user: null,
      profile: safeMember ? buildProfile(member) : null,
      member: safeMember,
      session: null,
      role: "",
      status: safeMember?.status || "",
      payment_status: safeMember?.paymentStatus || "",
      membership_status: safeMember?.membershipStatus || "",
      approval_status: safeMember?.approvalStatus || "",
      requires_payment: true,
      requiresPayment: true,
      payment_required: true,
      paymentRequired: true,
      redirectTo: SIGNUP_REDIRECT,
    },
    message,
    {
      redirectTo: SIGNUP_REDIRECT,
    }
  );
}

function activeSessionResponse(res, member, sessionCookie) {
  const safeMember = sanitizeMember(member);
  const user = buildUser(member);
  const profile = buildProfile(member);

  const value = sessionCookie?.value || {};
  const now = getUnixNow();
  const expiresAt = getSessionExpiresAt(sessionCookie);
  const redirectTo = resolvePortalLoginUrl(member);

  return ok(
    res,
    {
      authenticated: true,
      user,
      profile,
      member: safeMember,
      role: "member",
      status: safeMember?.status || "",
      payment_status: safeMember?.paymentStatus || "",
      membership_status: safeMember?.membershipStatus || "",
      approval_status: safeMember?.approvalStatus || "",
      requires_payment: false,
      requiresPayment: false,
      payment_required: false,
      paymentRequired: false,

      access: {
        member_identifier: safeMember?.accessMemberIdentifier || "",
        member_status: safeMember?.accessMemberStatus || "pending",
        synced_at: safeMember?.accessSyncedAt || null,
        suspended_at: safeMember?.accessSuspendedAt || null,
        sync_error: safeMember?.accessSyncError || "",
        perks_ready: Boolean(safeMember?.accessPerksReady),
        benefits_ready: Boolean(safeMember?.benefitsReady),
      },

      session: {
        provider: "cardleo-signups",
        token_type: "custom",
        remember: Boolean(value.remember),
        expires_at: expiresAt || null,
        expires_in: expiresAt ? Math.max(0, expiresAt - now) : 0,
      },
      redirectTo,
    },
    "Session active.",
    {
      redirectTo,
    }
  );
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_me" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value) {
      return unauthenticatedResponse(res, "No active session.");
    }

    if (isSessionExpired(sessionCookie)) {
      clearEveryAuthCookie(res);

      logAuthEvent("Session expired.", {
        reason: "custom_session_expired",
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Session expired. Please sign in again."
      );
    }

    if (sessionCookie.value.authenticated !== true) {
      clearEveryAuthCookie(res);

      logAuthEvent("Invalid session cookie.", {
        reason: "not_authenticated",
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Session invalid. Please sign in again."
      );
    }

    const {
      member,
      error: memberLookupError,
      identity,
      matchedBy,
    } = await findMemberFromSession(req, sessionCookie);

    if (memberLookupError) {
      logRequestError(req, memberLookupError, {
        scope: "auth_me_member_lookup",
        sessionCookieName: sessionCookie.name,
      });

      return serverError(res, "Unable to verify your account right now.");
    }

    if (!member?.id) {
      clearEveryAuthCookie(res);

      logAuthEvent("Session member not found.", {
        email: identity?.email || "",
        ids: identity?.ids || [],
        portalUserIds: identity?.portalUserIds || [],
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Account not found. Please sign in again."
      );
    }

    if (!hasPortalAccessForMember(member)) {
      const requiresPayment = doesMemberRequirePayment(member);

      logAuthEvent("Session blocked for inactive or unpaid account.", {
        email: member.email,
        memberId: member.id,
        status: normalizeStatus(member.status),
        paymentStatus: normalizeStatus(member.payment_status),
        membershipStatus: normalizeStatus(member.membership_status),
        requiresPayment,
        ip: getClientIp(req),
      });

      if (requiresPayment) {
        return paymentRequiredResponse(
          res,
          member,
          "Membership payment is required before portal access."
        );
      }

      clearEveryAuthCookie(res);

      return unauthenticatedResponse(res, "Your account is not active.", {
        status: normalizeStatus(member.status),
        payment_status: normalizeStatus(member.payment_status),
        membership_status: normalizeStatus(member.membership_status),
        redirectTo: LOGIN_REDIRECT,
      });
    }

    logAuthEvent("Session check successful.", {
      email: member.email,
      memberId: member.id,
      matchedBy: matchedBy || "",
      status: normalizeStatus(member.status),
      paymentStatus: normalizeStatus(member.payment_status),
      membershipStatus: normalizeStatus(member.membership_status),
      accessMemberStatus: getAccessMemberStatus(member),
      accessPerksReady: getAccessPerksReady(member),
      ip: getClientIp(req),
    });

    logRequestSuccess(req, {
      scope: "auth_me",
      memberId: member.id,
      email: member.email,
      matchedBy: matchedBy || "",
    });

    return activeSessionResponse(res, member, sessionCookie);
  } catch (error) {
    clearEveryAuthCookie(res);

    logRequestError(req, error, {
      scope: "auth_me_unexpected",
    });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while checking the current session."
    );
  }
}