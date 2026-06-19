// api/auth/me.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { ok, methodNotAllowed, serverError } from "../../lib/responses.js";
import {
  setSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";
const LOGIN_REDIRECT = "/login.html";
const SIGNUP_REDIRECT = "/signup.html?status=payment_required";

const ACTIVE_STATUSES = new Set(["active", "approved", "invited", "paid"]);
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
]);

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const AUTH_COOKIE_ALIASES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
  "access_token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
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
  const configuredName = getSessionCookieName?.();

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
  clearAuthCookies(res);
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

function safeBase64JsonParse(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSessionValue(rawValue) {
  const decoded = decodeCookieValue(rawValue);

  if (!decoded) return null;

  const parsedJson = safeJsonParse(decoded, null);

  if (isObject(parsedJson)) return parsedJson;

  const parsedBase64 = safeBase64JsonParse(decoded);

  if (isObject(parsedBase64)) return parsedBase64;

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName = getSessionCookieName?.();

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

  return {
    ids: Array.from(new Set(ids)),
    portalUserIds: Array.from(new Set(portalUserIds)),
    email,
  };
}

function getDisplayName(member) {
  const fullName = normalizeString(member?.full_name);

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

  return (
    ACTIVE_STATUSES.has(status) ||
    PAID_PAYMENT_STATUSES.has(paymentStatus) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus)
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
  if (["denied", "closed"].includes(status)) return status;

  return status || "pending";
}

function resolvePortalLoginUrl(member) {
  const portalLoginUrl = normalizeString(member?.portal_login_url);

  if (portalLoginUrl.startsWith("/") && !portalLoginUrl.startsWith("//")) {
    return portalLoginUrl;
  }

  return DEFAULT_REDIRECT;
}

function sanitizeMember(member) {
  if (!member) return null;

  const tier = normalizeTier(member.tier || "core");
  const status = normalizeStatus(member.status || "pending");
  const paymentStatus = normalizeStatus(member.payment_status || "");
  const membershipStatus = normalizeStatus(member.membership_status || "");
  const portalAccess = hasPortalAccessForMember(member);
  const requiresPayment = doesMemberRequirePayment(member);

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
    goals: member.goals || "",
    referralName: member.referral_name || "",

    status,
    payment_status: paymentStatus,
    membership_status: membershipStatus,
    approval_status: portalAccess ? "approved" : status,

    paymentStatus,
    membershipStatus,
    approvalStatus: portalAccess ? "approved" : status,

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
    referralCode: member.referral_code || "",

    portalLoginUrl: resolvePortalLoginUrl(member),
    portalAccess,
    accessLevel: "member",

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
    tier: safeMember.tier,
    referral_code: safeMember.referralCode,
    role: "member",
    status: safeMember.status,
    payment_status: safeMember.paymentStatus,
    membership_status: safeMember.membershipStatus,
    approval_status: safeMember.approvalStatus,
    requires_payment: safeMember.requiresPayment,
    activation_fee_amount: safeMember.activationFeeAmount,
    monthly_fee_amount: safeMember.monthlyFeeAmount,
    billing_day: safeMember.billingDay,
    email_verified: safeMember.emailVerified,
    email_verified_at: safeMember.emailVerifiedAt,
    created_at: safeMember.createdAt,
    updated_at: safeMember.updatedAt,
  };
}

function buildSessionId(member, oldValue = {}) {
  const existing = normalizeString(
    oldValue.sessionId ||
      oldValue.session_id ||
      oldValue.sid ||
      oldValue.jti ||
      oldValue.tokenId
  );

  if (existing) return existing;

  return crypto
    .createHash("sha256")
    .update(
      [
        member?.id,
        member?.email,
        oldValue.created_at,
        oldValue.expires_at,
        Date.now(),
      ]
        .filter(Boolean)
        .join("|")
    )
    .digest("hex")
    .slice(0, 24);
}

function buildSessionCookieValue(member, oldSessionCookie) {
  const oldValue = oldSessionCookie?.value || {};
  const remember = Boolean(oldValue.remember);

  const now = getUnixNow();
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;

  let expiresAt = Number(
    oldValue.expires_at ||
      oldValue.expiresAt ||
      oldValue.session?.expires_at ||
      0
  );

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    expiresAt = now + maxAge;
  }

  const sessionId = buildSessionId(member, oldValue);

  const safeMember = sanitizeMember(member);
  const user = buildUser(member);
  const profile = buildProfile(member);

  return {
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember,
    sessionId,
    session_id: sessionId,
    created_at: Number(oldValue.created_at || now),
    checked_at: now,
    expires_at: expiresAt,
    redirectTo: safeMember?.portalLoginUrl || DEFAULT_REDIRECT,
    role: "member",
    member: safeMember,
    user,
    profile,
    session: {
      access_token: null,
      refresh_token: null,
      expires_at: expiresAt,
      expires_in: Math.max(0, expiresAt - now),
      token_type: "custom",
    },
  };
}

function getSessionMaxAge(sessionCookie) {
  const value = sessionCookie?.value || {};
  const remember = Boolean(value.remember);

  return remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
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
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "payment_status",
    "membership_status",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "portal_settings",
    "portal_sessions",
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

async function findMemberFromSession(sessionCookie) {
  const identity = getSessionIdentity(sessionCookie);

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

  if (identity.email) {
    attempts.push({
      column: "email",
      value: identity.email,
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

  if (!uniqueAttempts.length) {
    return {
      member: null,
      error: null,
      identity,
    };
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
        member: {
          full_name:
            result.data.full_name ||
            [result.data.first_name, result.data.last_name]
              .map(normalizeString)
              .filter(Boolean)
              .join(" "),
          goals: result.data.goals || "",
          referral_name: result.data.referral_name || "",
          tier: result.data.tier || "core",
          referral_code: result.data.referral_code || "",
          email_verified: Boolean(result.data.email_verified),
          email_verified_at: result.data.email_verified_at || null,
          payment_status: result.data.payment_status || "",
          membership_status: result.data.membership_status || "",
          activation_fee_amount: result.data.activation_fee_amount || 25,
          monthly_fee_amount: result.data.monthly_fee_amount || 20,
          billing_day: result.data.billing_day || 10,
          portal_settings: isObject(result.data.portal_settings)
            ? result.data.portal_settings
            : {},
          portal_sessions: Array.isArray(result.data.portal_sessions)
            ? result.data.portal_sessions
            : [],
          ...result.data,
        },
        error: null,
        identity,
        matchedBy: attempt.column,
      };
    }
  }

  return {
    member: null,
    error: lastError,
    identity,
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

function paymentRequiredResponse(res, member, message = "Membership payment is required.") {
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
      payment_required: true,
      redirectTo: SIGNUP_REDIRECT,
    },
    message,
    {
      redirectTo: SIGNUP_REDIRECT,
    }
  );
}

function activeSessionResponse(res, member, sessionCookie) {
  const sessionPayload = buildSessionCookieValue(member, sessionCookie);
  const maxAge = getSessionMaxAge(sessionCookie);
  const redirectTo = sessionPayload.member?.portalLoginUrl || DEFAULT_REDIRECT;

  setSessionCookie(res, JSON.stringify(sessionPayload), {
    httpOnly: true,
    maxAge,
  });

  return ok(
    res,
    {
      authenticated: true,
      user: sessionPayload.user,
      profile: sessionPayload.profile,
      member: sessionPayload.member,
      role: "member",
      status: sessionPayload.member?.status || "",
      payment_status: sessionPayload.member?.paymentStatus || "",
      membership_status: sessionPayload.member?.membershipStatus || "",
      approval_status: sessionPayload.member?.approvalStatus || "",
      requires_payment: false,
      payment_required: false,
      session: sessionPayload.session,
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
    } = await findMemberFromSession(sessionCookie);

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