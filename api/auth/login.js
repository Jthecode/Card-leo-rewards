// api/auth/login.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";
import { validateLoginInput } from "../../lib/validation.js";
import { clearAuthCookies } from "../../lib/cookies.js";
import { loginRateLimit } from "../../lib/rate-limit.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";
const LOGIN_PATH = "/login.html";
const PAYMENT_REQUIRED_REDIRECT = "/signup.html?status=payment_required";

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

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (typeof req.body === "object") return req.body;

  return {};
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = normalizeString(value).toLowerCase();

  return ["true", "1", "yes", "y", "on"].includes(normalized);
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

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password || ""))
    .digest("hex");
}

function safeCompareHash(inputHash, storedHash) {
  const cleanInput = normalizeString(inputHash);
  const cleanStored = normalizeString(storedHash);

  if (!cleanInput || !cleanStored) return false;

  let left;
  let right;

  try {
    left = Buffer.from(cleanInput, "hex");
    right = Buffer.from(cleanStored, "hex");
  } catch {
    return false;
  }

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function getDisplayName(member) {
  const fullName = normalizeString(member?.full_name || member?.fullName);

  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");

  return joined || "Card Leo Member";
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

function getSafeRedirect(value) {
  const raw = normalizeString(value);

  if (!raw) return DEFAULT_REDIRECT;
  if (raw === LOGIN_PATH) return DEFAULT_REDIRECT;
  if (raw.startsWith("//")) return DEFAULT_REDIRECT;

  try {
    const url = new URL(raw, "https://cardleorewards.local");

    if (!url.pathname.startsWith("/portal")) {
      return DEFAULT_REDIRECT;
    }

    return `${url.pathname}${url.search || ""}`;
  } catch {
    return DEFAULT_REDIRECT;
  }
}

function resolvePortalLoginUrl(member) {
  const portalLoginUrl = normalizeString(member?.portal_login_url);

  if (portalLoginUrl.startsWith("/") && !portalLoginUrl.startsWith("//")) {
    return getSafeRedirect(portalLoginUrl);
  }

  return DEFAULT_REDIRECT;
}

function sanitizeMember(member) {
  if (!member) return null;

  const portalAccess = hasPortalAccessForMember(member);
  const requiresPayment = doesMemberRequirePayment(member);
  const status = normalizeStatus(member.status || "pending");
  const paymentStatus = normalizeStatus(member.payment_status || "");
  const membershipStatus = normalizeStatus(member.membership_status || "");
  const approvalStatus = portalAccess
    ? "approved"
    : normalizeStatus(member.approval_status || status);
  const tier = normalizeTier(member.tier || "core");

  return {
    id: member.id || null,
    signupId: member.id || null,
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
    approval_status: approvalStatus,

    paymentStatus,
    membershipStatus,
    approvalStatus,

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

    portalUserId: member.portal_user_id || null,
    portalLoginUrl: resolvePortalLoginUrl(member),
    portalAccess,

    stripeCustomerId: member.stripe_customer_id || "",
    stripeSubscriptionId: member.stripe_subscription_id || "",
    stripeCheckoutSessionId: member.stripe_checkout_session_id || "",

    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,

    role: "member",
    accessLevel: "member",
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
    created_at: safeMember.createdAt,
    updated_at: safeMember.updatedAt,
  };
}

function isMissingOptionalColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
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
    "password_hash",
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
    "payment_status",
    "membership_status",
    "approval_status",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_checkout_session_id",
    "session_token",
    "auth_token",
    "login_token",
    "portal_token",
    "session_expires_at",
    "last_login_at",
  ].join(", ");
}

async function findMemberByEmail(email) {
  let result = await supabaseAdmin
    .from("signups")
    .select(getSelectFields({ extended: true }))
    .ilike("email", email)
    .maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    result = await supabaseAdmin
      .from("signups")
      .select(getSelectFields({ extended: false }))
      .ilike("email", email)
      .maybeSingle();
  }

  return result;
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function encodeSessionCookiePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSessionCookiePayload(value) {
  try {
    const raw = Buffer.from(String(value || ""), "base64url").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSmallSessionPayload(member, remember, sessionToken, maxAge) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + maxAge;
  const safeMember = sanitizeMember(member);

  return {
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    role: "member",
    token: sessionToken,
    member_id: safeMember?.id || member.id,
    signup_id: safeMember?.id || member.id,
    email: safeMember?.email || member.email,
    remember: Boolean(remember),
    created_at: now,
    checked_at: now,
    expires_at: expiresAt,
    redirectTo: safeMember?.portalLoginUrl || DEFAULT_REDIRECT,
  };
}

function getCookieOptions({ maxAge = 86400, httpOnly = true } = {}) {
  const parts = [
    "Path=/",
    `Max-Age=${Math.max(0, Number(maxAge || 0))}`,
    "SameSite=Lax",
  ];

  if (httpOnly) parts.push("HttpOnly");

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");

  if (!current) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
    return;
  }

  res.setHeader("Set-Cookie", [current, cookie]);
}

function setCookie(res, name, value, options = {}) {
  const encodedValue = encodeURIComponent(String(value || ""));
  appendSetCookie(
    res,
    `${name}=${encodedValue}; ${getCookieOptions(options)}`
  );
}

function expireCookie(res, name) {
  appendSetCookie(
    res,
    `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`
  );
}

function clearAllAuthCookies(res) {
  try {
    clearAuthCookies(res);
  } catch {
    // Keep clearing the known cookies below.
  }

  [
    SESSION_COOKIE_NAME,
    SESSION_TOKEN_COOKIE_NAME,
    "cardleo_auth",
    "cardleo_member",
    "cardleo_member_id",
    "cardleo_portal_session",
    "session",
    "token",
  ].forEach((name) => expireCookie(res, name));
}

async function saveSessionToken(memberId, sessionToken, expiresAtIso) {
  const fullPayload = {
    session_token: sessionToken,
    auth_token: sessionToken,
    login_token: sessionToken,
    portal_token: sessionToken,
    session_expires_at: expiresAtIso,
    last_login_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", memberId);

  if (!result.error) return;

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Session token save failed:", result.error);
    return;
  }

  const fallbackPayload = {
    updated_at: new Date().toISOString(),
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", memberId);

  if (result.error) {
    console.error("Fallback last login update failed:", result.error);
  }
}

function setAuthCookies(res, member, remember) {
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
  const sessionToken = makeSessionToken();
  const sessionPayload = buildSmallSessionPayload(
    member,
    remember,
    sessionToken,
    maxAge
  );
  const encodedSession = encodeSessionCookiePayload(sessionPayload);

  setCookie(res, SESSION_COOKIE_NAME, encodedSession, {
    httpOnly: true,
    maxAge,
  });

  setCookie(res, SESSION_TOKEN_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    maxAge,
  });

  setCookie(res, "cardleo_auth", encodedSession, {
    httpOnly: true,
    maxAge,
  });

  return {
    sessionToken,
    encodedSession,
    sessionPayload,
    maxAge,
    expiresAtIso: new Date(sessionPayload.expires_at * 1000).toISOString(),
  };
}

function getOrigin(req) {
  const proto =
    req.headers?.["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req.headers?.["x-forwarded-host"] ||
    req.headers?.host ||
    "www.cardleorewards.com";

  return `${proto}://${host}`;
}

async function createCheckoutForUnpaidMember(req, member) {
  try {
    const origin = getOrigin(req);

    const response = await fetch(
      `${origin}/api/billing/create-checkout-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          signup_id: member.id,
          signupId: member.id,
          email: member.email,
          firstName: member.first_name || "",
          first_name: member.first_name || "",
          lastName: member.last_name || "",
          last_name: member.last_name || "",
          fullName: getDisplayName(member),
          full_name: getDisplayName(member),
          phone: member.phone || "",
          referralName: member.referral_name || "",
          referral_name: member.referral_name || "",
          activation_fee_amount: 25,
          monthly_fee_amount: 20,
          billing_day: 10,
          success_url: "/thank-you.html?payment=success&membership=activated",
          cancel_url: "/login.html?payment=cancelled",
        }),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.success === false || data?.ok === false) {
      return {
        checkoutUrl: "",
        error: data?.message || data?.error || "Checkout could not be created.",
      };
    }

    return {
      checkoutUrl:
        data.checkout_url ||
        data.checkoutUrl ||
        data.url ||
        data.payment_url ||
        data.paymentUrl ||
        "",
      error: "",
    };
  } catch (error) {
    console.error("Unable to create checkout during login:", error);

    return {
      checkoutUrl: "",
      error: error?.message || "Checkout could not be created.",
    };
  }
}

function paymentRequiredPayload(member, checkoutUrl = "") {
  const safeMember = sanitizeMember(member);

  return {
    authenticated: false,
    member: safeMember,
    user: null,
    profile: buildProfile(member),
    role: "",
    status: safeMember?.status || "",
    payment_status: safeMember?.paymentStatus || "",
    membership_status: safeMember?.membershipStatus || "",
    approval_status: safeMember?.approvalStatus || "",
    requires_payment: true,
    requiresPayment: true,
    payment_required: true,
    paymentRequired: true,
    checkout_url: checkoutUrl,
    checkoutUrl,
    payment_url: checkoutUrl,
    paymentUrl: checkoutUrl,
    redirectTo: checkoutUrl || PAYMENT_REQUIRED_REDIRECT,
  };
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_login" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = loginRateLimit(req, res);

    if (rateLimit && !rateLimit.allowed) {
      clearAllAuthCookies(res);

      return badRequest(
        res,
        "Too many login attempts. Please try again later.",
        {
          retryAfter: rateLimit.retryAfter ?? null,
        },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);
    const validation = validateLoginInput(body);

    if (!validation?.valid) {
      clearAllAuthCookies(res);

      return badRequest(
        res,
        "Email and password are required.",
        validation?.errors || {}
      );
    }

    const safeEmail = normalizeEmail(validation.values.email);
    const password = String(validation.values.password || "");
    const remember = normalizeBoolean(body.remember);

    const { data: member, error: lookupError } = await findMemberByEmail(
      safeEmail
    );

    if (lookupError) {
      clearAllAuthCookies(res);

      logRequestError(req, lookupError, {
        scope: "auth_login_lookup",
        email: safeEmail,
      });

      return serverError(res, "Unable to check your account right now.");
    }

    if (!member?.id) {
      clearAllAuthCookies(res);

      logAuthEvent("Login failed.", {
        email: safeEmail,
        reason: "account_not_found",
        ip: getClientIp(req),
      });

      return unauthorized(res, "Invalid email or password.");
    }

    if (!member.password_hash) {
      clearAllAuthCookies(res);

      logAuthEvent("Login blocked because password is missing.", {
        email: safeEmail,
        memberId: member.id,
        ip: getClientIp(req),
      });

      return forbidden(
        res,
        "This account does not have a password yet. Please reset the account password or create a new signup."
      );
    }

    const inputHash = hashPassword(password);
    const passwordMatches = safeCompareHash(inputHash, member.password_hash);

    if (!passwordMatches) {
      clearAllAuthCookies(res);

      logAuthEvent("Login failed.", {
        email: safeEmail,
        memberId: member.id,
        reason: "invalid_password",
        ip: getClientIp(req),
      });

      return unauthorized(res, "Invalid email or password.");
    }

    if (!hasPortalAccessForMember(member)) {
      clearAllAuthCookies(res);

      const requiresPayment = doesMemberRequirePayment(member);

      logAuthEvent("Login blocked for inactive or unpaid account.", {
        email: safeEmail,
        memberId: member.id,
        status: normalizeStatus(member.status),
        paymentStatus: normalizeStatus(member.payment_status),
        membershipStatus: normalizeStatus(member.membership_status),
        requiresPayment,
        ip: getClientIp(req),
      });

      if (requiresPayment) {
        const { checkoutUrl } = await createCheckoutForUnpaidMember(req, member);

        return forbidden(
          res,
          "Membership payment is required before portal access.",
          paymentRequiredPayload(member, checkoutUrl),
          {
            statusCode: 402,
            error: "payment_required",
            redirectTo: checkoutUrl || PAYMENT_REQUIRED_REDIRECT,
          }
        );
      }

      const status = normalizeStatus(member.status || "pending");

      if (status === "disabled" || status === "suspended") {
        return forbidden(
          res,
          "This account has been disabled. Please contact support."
        );
      }

      if (status === "denied") {
        return forbidden(
          res,
          "This account was not approved. Please contact support for more information."
        );
      }

      return forbidden(
        res,
        "Your account is not active yet. Please contact support."
      );
    }

    const safeMember = sanitizeMember(member);
    const redirectTo = safeMember.portalLoginUrl || DEFAULT_REDIRECT;

    const sessionInfo = setAuthCookies(res, member, remember);

    await saveSessionToken(
      member.id,
      sessionInfo.sessionToken,
      sessionInfo.expiresAtIso
    );

    const decodedSession = decodeSessionCookiePayload(sessionInfo.encodedSession);

    logAuthEvent("Login successful.", {
      email: safeEmail,
      memberId: member.id,
      status: normalizeStatus(member.status),
      paymentStatus: normalizeStatus(member.payment_status),
      membershipStatus: normalizeStatus(member.membership_status),
      ip: getClientIp(req),
    });

    logRequestSuccess(req, {
      scope: "auth_login",
      memberId: member.id,
      email: safeEmail,
    });

    return ok(
      res,
      {
        authenticated: true,
        member: safeMember,
        user: buildUser(member),
        profile: buildProfile(member),
        role: "member",
        status: safeMember.status,
        payment_status: safeMember.paymentStatus,
        membership_status: safeMember.membershipStatus,
        approval_status: safeMember.approvalStatus,
        requires_payment: false,
        requiresPayment: false,
        payment_required: false,
        paymentRequired: false,
        redirectTo,
        session: {
          provider: "cardleo-signups",
          token_type: "custom",
          remember,
          expires_in: sessionInfo.maxAge,
          expires_at: decodedSession?.expires_at || null,
        },
      },
      "Login successful.",
      {
        redirectTo,
      }
    );
  } catch (error) {
    clearAllAuthCookies(res);

    logRequestError(req, error, {
      scope: "auth_login_unexpected",
    });

    return serverError(
      res,
      error?.message || "Something went wrong while trying to sign you in."
    );
  }
}