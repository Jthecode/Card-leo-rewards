// api/access/sso-link.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const ACCESS_PERKS_URL = process.env.ACCESS_PERKS_URL || "";
const ACCESS_API_BASE_URL = process.env.ACCESS_API_BASE_URL || "";
const ACCESS_ACCOUNT_NUMBER = process.env.ACCESS_ACCOUNT_NUMBER || "";
const ACCESS_PROGRAM_ID = process.env.ACCESS_PROGRAM_ID || "";
const ACCESS_CUSTOMER_SERVICE_PHONE =
  process.env.ACCESS_CUSTOMER_SERVICE_PHONE || "";
const ACCESS_API_TOKEN = process.env.ACCESS_API_TOKEN || "";
const ACCESS_API_USERNAME = process.env.ACCESS_API_USERNAME || "";
const ACCESS_API_PASSWORD = process.env.ACCESS_API_PASSWORD || "";

/**
 * IMPORTANT:
 * Once Access Development gives the exact SSO endpoint,
 * add it to Vercel as:
 *
 * ACCESS_SSO_ENDPOINT=/exact/path/from/access/docs
 *
 * Example only:
 * ACCESS_SSO_ENDPOINT=/api/members/sso
 */
const ACCESS_SSO_ENDPOINT =
  process.env.ACCESS_SSO_ENDPOINT || "/api/members/sso";

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

  return [member?.first_name, member?.last_name]
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");
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

function buildAccessApiUrl(path) {
  const base = normalizeString(ACCESS_API_BASE_URL).replace(/\/+$/, "");
  const cleanPath = normalizeString(path).startsWith("/")
    ? normalizeString(path)
    : `/${normalizeString(path)}`;

  return `${base}${cleanPath}`;
}

function hasRealAccessPassword() {
  const password = normalizeString(ACCESS_API_PASSWORD).toLowerCase();

  if (!password) return false;
  if (password.includes("your_access_password")) return false;
  if (password.includes("your_access_passwor")) return false;

  return true;
}

function buildAccessHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Account-Number": ACCESS_ACCOUNT_NUMBER,
    "X-Program-ID": ACCESS_PROGRAM_ID,
    "X-Program-Id": ACCESS_PROGRAM_ID,
  };

  if (ACCESS_API_TOKEN) {
    headers.Authorization = `Bearer ${ACCESS_API_TOKEN}`;
    headers["X-Access-Token"] = ACCESS_API_TOKEN;
    headers["X-API-Token"] = ACCESS_API_TOKEN;
    headers.Token = ACCESS_API_TOKEN;
  }

  if (ACCESS_API_USERNAME && hasRealAccessPassword()) {
    const basic = Buffer.from(
      `${ACCESS_API_USERNAME}:${ACCESS_API_PASSWORD}`
    ).toString("base64");

    headers.Authorization = headers.Authorization || `Basic ${basic}`;
    headers["X-Access-Username"] = ACCESS_API_USERNAME;
  }

  return headers;
}

function buildAccessSsoPayload(member) {
  const accessMemberId =
    normalizeString(member.access_member_id) || makeExternalMemberId(member);

  const fullName = getFullName(member);
  const firstName = normalizeString(member.first_name);
  const lastName = normalizeString(member.last_name);
  const email = normalizeEmail(member.email);

  return {
    accountNumber: ACCESS_ACCOUNT_NUMBER,
    account_number: ACCESS_ACCOUNT_NUMBER,
    programId: ACCESS_PROGRAM_ID,
    program_id: ACCESS_PROGRAM_ID,

    accessMemberId,
    access_member_id: accessMemberId,
    memberId: accessMemberId,
    member_id: accessMemberId,

    externalMemberId: accessMemberId,
    external_member_id: accessMemberId,
    clientMemberId: member.id,
    client_member_id: member.id,
    signupId: member.id,
    signup_id: member.id,

    firstName,
    first_name: firstName,
    lastName,
    last_name: lastName,
    fullName,
    full_name: fullName,
    email,

    redirectUrl: ACCESS_PERKS_URL,
    redirect_url: ACCESS_PERKS_URL,
    returnUrl: ACCESS_PERKS_URL,
    return_url: ACCESS_PERKS_URL,

    source: "card-leo-rewards",

    metadata: {
      card_leo_signup_id: member.id,
      stripe_customer_id: member.stripe_customer_id || "",
      stripe_subscription_id: member.stripe_subscription_id || "",
      referral_code: member.referral_code || "",
      tier: member.tier || "",
    },
  };
}

async function parseAccessResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }

  const text = await response.text().catch(() => "");

  return {
    raw: text,
  };
}

function readNestedValue(object, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = object;

    for (const part of parts) {
      current = current?.[part];
    }

    const value = normalizeString(current);

    if (value) return value;
  }

  return "";
}

function isSafeAccessUrl(url) {
  const value = normalizeString(url);

  if (!value) return false;

  try {
    const parsed = new URL(value);
    const accessHost = ACCESS_PERKS_URL ? new URL(ACCESS_PERKS_URL).hostname : "";

    return (
      parsed.protocol === "https:" &&
      (
        parsed.hostname === accessHost ||
        parsed.hostname.endsWith(".accessperks.com") ||
        parsed.hostname.endsWith(".accessdevelopment.com")
      )
    );
  } catch {
    return false;
  }
}

function getSsoUrl(accessResult) {
  return readNestedValue(accessResult, [
    "ssoUrl",
    "sso_url",
    "loginUrl",
    "login_url",
    "url",
    "data.ssoUrl",
    "data.sso_url",
    "data.loginUrl",
    "data.login_url",
    "data.url",
    "member.ssoUrl",
    "member.sso_url",
    "member.loginUrl",
    "member.login_url",
    "redirectUrl",
    "redirect_url",
    "data.redirectUrl",
    "data.redirect_url",
  ]);
}

function getSafeAccessResponse(accessResult) {
  if (!isObject(accessResult)) return {};

  const clone = JSON.parse(JSON.stringify(accessResult));

  delete clone.token;
  delete clone.access_token;
  delete clone.password;
  delete clone.secret;
  delete clone.authorization;

  if (clone.data && typeof clone.data === "object") {
    delete clone.data.token;
    delete clone.data.access_token;
    delete clone.data.password;
    delete clone.data.secret;
    delete clone.data.authorization;
  }

  return clone;
}

async function callAccessSso(member) {
  if (!ACCESS_PERKS_URL) {
    return {
      ok: false,
      status: 500,
      message: "Missing ACCESS_PERKS_URL in Vercel Environment Variables.",
      result: null,
    };
  }

  if (!ACCESS_API_BASE_URL) {
    return {
      ok: false,
      status: 500,
      message: "Missing ACCESS_API_BASE_URL in Vercel Environment Variables.",
      result: null,
    };
  }

  if (!ACCESS_ACCOUNT_NUMBER) {
    return {
      ok: false,
      status: 500,
      message: "Missing ACCESS_ACCOUNT_NUMBER in Vercel Environment Variables.",
      result: null,
    };
  }

  if (!ACCESS_PROGRAM_ID) {
    return {
      ok: false,
      status: 500,
      message: "Missing ACCESS_PROGRAM_ID in Vercel Environment Variables.",
      result: null,
    };
  }

  if (!ACCESS_API_TOKEN && (!ACCESS_API_USERNAME || !hasRealAccessPassword())) {
    return {
      ok: false,
      status: 500,
      message:
        "Missing Access API authentication. Add ACCESS_API_TOKEN, or real ACCESS_API_USERNAME and ACCESS_API_PASSWORD in Vercel.",
      result: null,
    };
  }

  const url = buildAccessApiUrl(ACCESS_SSO_ENDPOINT);
  const payload = buildAccessSsoPayload(member);

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildAccessHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: error?.message || "Unable to connect to Access Development SSO API.",
      result: null,
      url,
    };
  }

  const result = await parseAccessResponse(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        readNestedValue(result, [
          "message",
          "error",
          "errors.0.message",
          "data.message",
          "data.error",
        ]) || `Access Development SSO failed with status ${response.status}.`,
      result: getSafeAccessResponse(result),
      url,
    };
  }

  const ssoUrl = getSsoUrl(result);

  if (!isSafeAccessUrl(ssoUrl)) {
    return {
      ok: false,
      status: 502,
      message:
        "Access Development SSO did not return a valid Access Perks login URL.",
      result: getSafeAccessResponse(result),
      url,
    };
  }

  return {
    ok: true,
    status: response.status,
    message: "Access Perks SSO link created.",
    ssoUrl,
    result,
    url,
  };
}

async function updateSignupSsoFields({ memberId, accessSsoUrl }) {
  const updatePayload = {
    access_sso_url: accessSsoUrl || null,
    access_last_sync_at: new Date().toISOString(),
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", memberId)
    .select("*")
    .maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    const fallbackPayload = {
      updated_at: new Date().toISOString(),
    };

    result = await supabaseAdmin
      .from("signups")
      .update(fallbackPayload)
      .eq("id", memberId)
      .select("*")
      .maybeSingle();
  }

  return result;
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

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET or POST.",
    });
  }

  try {
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value || sessionCookie.value.authenticated !== true) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Please log in before opening benefits.",
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
      console.error("Access SSO member lookup error:", error);

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
          "Your membership must be paid and active before opening benefits.",
        redirectTo: "/signup.html?status=payment_required",
      });
    }

    if (!member.access_member_id) {
      return sendJson(res, 409, {
        success: false,
        ok: false,
        needs_enrollment: true,
        message:
          "Member is not enrolled in Access Perks yet. Run enrollment first.",
        enrollEndpoint: "/api/access/enroll-member",
      });
    }

    if (member.access_sso_url && isSafeAccessUrl(member.access_sso_url)) {
      return sendJson(res, 200, {
        success: true,
        ok: true,
        cached: true,
        access_sso_url: member.access_sso_url,
        sso_url: member.access_sso_url,
        url: member.access_sso_url,
        access_perks_url: ACCESS_PERKS_URL,
        customer_service_phone: ACCESS_CUSTOMER_SERVICE_PHONE,
        message: "Access Perks link ready.",
      });
    }

    const accessSso = await callAccessSso(member);

    if (!accessSso.ok) {
      console.error("Access SSO failed:", accessSso);

      const fallbackUrl = buildFallbackBenefitsUrl(member);

      return sendJson(res, 502, {
        success: false,
        ok: false,
        message: accessSso.message,
        access_status: accessSso.status,
        access_endpoint: ACCESS_SSO_ENDPOINT,
        access_url: accessSso.url,
        access_result: accessSso.result,
        fallback_url: fallbackUrl,
        access_perks_url: ACCESS_PERKS_URL,
      });
    }

    const updateResult = await updateSignupSsoFields({
      memberId: member.id,
      accessSsoUrl: accessSso.ssoUrl,
    });

    if (updateResult.error) {
      console.error("Access SSO Supabase update failed:", updateResult.error);
    }

    return sendJson(res, 200, {
      success: true,
      ok: true,
      cached: false,
      access_sso_url: accessSso.ssoUrl,
      sso_url: accessSso.ssoUrl,
      url: accessSso.ssoUrl,
      access_perks_url: ACCESS_PERKS_URL,
      customer_service_phone: ACCESS_CUSTOMER_SERVICE_PHONE,
      message: "Access Perks link ready.",
    });
  } catch (error) {
    console.error("Card Leo Access SSO error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message ||
        "Something went wrong while creating the Access Perks link.",
    });
  }
}