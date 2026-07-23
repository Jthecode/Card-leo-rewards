// api/access/get-member-benefits.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const ACCESS_PERKS_URL = process.env.ACCESS_PERKS_URL || "";
const ACCESS_ACCOUNT_NUMBER = process.env.ACCESS_ACCOUNT_NUMBER || "";
const ACCESS_PROGRAM_ID = process.env.ACCESS_PROGRAM_ID || "";
const ACCESS_CUSTOMER_SERVICE_PHONE =
  process.env.ACCESS_CUSTOMER_SERVICE_PHONE || "";

const ACTIVE_STATUSES = new Set(["active", "approved", "paid", "current"]);

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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(payload));
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(value, fallback = null) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
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

  const names = [
    "cardleo_session",
    "card_leo_session",
    "member_session",
    "portal_session",
    "session",
  ];

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseSessionValue(cookies[name]);

    if (isObject(parsed)) {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function isSessionExpired(sessionCookie) {
  const value = sessionCookie?.value || {};

  const expiresAt = Number(
    value.expires_at ||
      value.expiresAt ||
      value.exp ||
      value.session?.expires_at ||
      value.session?.expiresAt ||
      0
  );

  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;

  return expiresAt <= getUnixNow();
}

function getSessionIdentity(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const userMetadata = isObject(user.user_metadata) ? user.user_metadata : {};

  const ids = [
    value.signupId,
    value.signup_id,
    value.memberId,
    value.member_id,
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

function getFullName(member) {
  const fullName = normalizeString(member?.full_name);

  if (fullName) return fullName;

  return (
    [member?.first_name, member?.last_name]
      .map(normalizeString)
      .filter(Boolean)
      .join(" ") || "Card Leo Member"
  );
}

function makeExternalMemberId(member) {
  const raw = `${member.id}:${member.email}:card-leo-rewards`;

  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
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
    "status",
    "payment_status",
    "membership_status",
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
    "referral_name",
    "tier",
    "referral_code",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "access_member_id",
    "access_enrollment_status",
    "access_enrolled_at",
    "access_last_sync_at",
    "access_sso_url",
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

  let lastError = null;

  for (const attempt of uniqueAttempts) {
    let result = await queryMemberBy({
      column: attempt.column,
      value: attempt.value,
      extended: true,
    });

    if (result.error && isMissingOptionalColumn(result.error)) {
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
        member: result.data,
        error: null,
        matchedBy: attempt.column,
      };
    }
  }

  return {
    member: null,
    error: lastError,
    matchedBy: "",
  };
}

function isSafeAccessUrl(url) {
  const value = normalizeString(url);

  if (!value) return false;

  try {
    const parsed = new URL(value);
    const accessHost = ACCESS_PERKS_URL ? new URL(ACCESS_PERKS_URL).hostname : "";

    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === accessHost ||
        parsed.hostname.endsWith(".accessperks.com") ||
        parsed.hostname.endsWith(".accessdevelopment.com"))
    );
  } catch {
    return false;
  }
}

function buildFallbackBenefitsUrl(member) {
  const base = normalizeString(ACCESS_PERKS_URL).replace(/\/+$/, "");

  if (!base) return "";

  const accessMemberId =
    normalizeString(member.access_member_id) || makeExternalMemberId(member);

  const params = new URLSearchParams({
    programId: ACCESS_PROGRAM_ID,
    accountNumber: ACCESS_ACCOUNT_NUMBER,
    memberId: accessMemberId,
    email: normalizeEmail(member.email),
  });

  return `${base}?${params.toString()}`;
}

function getEnrollmentStatus(member) {
  if (member?.access_member_id) {
    return normalizeStatus(member.access_enrollment_status || "enrolled");
  }

  return normalizeStatus(member?.access_enrollment_status || "not_enrolled");
}

function getBenefitsUrl(member) {
  const savedSsoUrl = normalizeString(member?.access_sso_url);

  if (isSafeAccessUrl(savedSsoUrl)) {
    return savedSsoUrl;
  }

  return buildFallbackBenefitsUrl(member);
}

function sanitizeMember(member) {
  return {
    id: member.id,
    email: member.email,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getFullName(member),
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    tier: member.tier || "core",
    referralCode: member.referral_code || "",
    status: normalizeStatus(member.status),
    paymentStatus: normalizeStatus(member.payment_status),
    membershipStatus: normalizeStatus(member.membership_status),
    portalAccess: hasPortalAccessForMember(member),
    accessMemberId: member.access_member_id || "",
    accessEnrollmentStatus: getEnrollmentStatus(member),
    accessEnrolledAt: member.access_enrolled_at || null,
    accessLastSyncAt: member.access_last_sync_at || null,
  };
}

function buildBenefitsPayload(member) {
  const portalAccess = hasPortalAccessForMember(member);
  const enrollmentStatus = getEnrollmentStatus(member);
  const enrolled = Boolean(member.access_member_id);
  const benefitsUrl = enrolled ? getBenefitsUrl(member) : "";
  const fallbackBenefitsUrl = buildFallbackBenefitsUrl(member);

  return {
    success: true,
    ok: true,
    authenticated: true,

    member: sanitizeMember(member),

    access: {
      enabled: portalAccess,
      enrolled,
      needs_enrollment: portalAccess && !enrolled,
      enrollment_status: enrollmentStatus,
      access_member_id: member.access_member_id || "",
      access_enrolled_at: member.access_enrolled_at || null,
      access_last_sync_at: member.access_last_sync_at || null,

      benefits_url: benefitsUrl,
      sso_url: benefitsUrl,
      fallback_url: fallbackBenefitsUrl,

      access_perks_url: ACCESS_PERKS_URL,
      customer_service_phone: ACCESS_CUSTOMER_SERVICE_PHONE,

      program_id: ACCESS_PROGRAM_ID,
      account_number: ACCESS_ACCOUNT_NUMBER,
    },

    benefits_card: {
      title: "Card Leo Lifestyle Benefits",
      subtitle:
        "Access restaurants, travel, shopping, entertainment, fitness, and local savings.",
      button_text: enrolled ? "Open My Benefits" : "Activate My Benefits",
      status_label: enrolled ? "Benefits Active" : "Benefits Not Activated",
      support_text: ACCESS_CUSTOMER_SERVICE_PHONE
        ? `Need help? Call ${ACCESS_CUSTOMER_SERVICE_PHONE}.`
        : "Need help? Contact Card Leo Rewards support.",
    },

    actions: {
      enroll_endpoint: "/api/access/enroll-member",
      sso_endpoint: "/api/access/sso-link",
    },

    message: enrolled
      ? "Access Perks benefits are ready."
      : "Access Perks enrollment is required before opening benefits.",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET.",
    });
  }

  try {
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value || sessionCookie.value.authenticated !== true) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Please log in before viewing benefits.",
        redirectTo: "/login.html",
      });
    }

    if (isSessionExpired(sessionCookie)) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Your session expired. Please log in again.",
        redirectTo: "/login.html",
      });
    }

    const { member, error } = await findMemberFromSession(sessionCookie);

    if (error) {
      console.error("Get member benefits lookup error:", error);

      return sendJson(res, 500, {
        success: false,
        ok: false,
        message: "Unable to verify your Card Leo Rewards account.",
      });
    }

    if (!member?.id) {
      return sendJson(res, 404, {
        success: false,
        ok: false,
        message: "Member account not found. Please log in again.",
        redirectTo: "/login.html",
      });
    }

    if (!hasPortalAccessForMember(member)) {
      return sendJson(res, 402, {
        success: false,
        ok: false,
        authenticated: true,
        requires_payment: true,
        payment_required: true,
        message:
          "Your membership must be paid and active before viewing benefits.",
        redirectTo: "/signup.html?status=payment_required",
      });
    }

    return sendJson(res, 200, buildBenefitsPayload(member));
  } catch (error) {
    console.error("Card Leo get member benefits error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message ||
        "Something went wrong while loading your Access Perks benefits.",
    });
  }
}