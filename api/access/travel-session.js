/**
 * api/access/travel-session.js
 *
 * Card Leo Rewards — Access Travel SDK Session
 *
 * POST /api/access/travel-session
 *
 * 1. Use the existing Card Leo /api/auth/me login flow.
 * 2. Resolve the authenticated member.
 * 3. Confirm membership eligibility.
 * 4. Reuse the permanent Access member identifier.
 * 5. Request a temporary Travel SDK session token.
 * 6. Return the temporary token without exposing the API key.
 *
 * Required Vercel environment variable:
 *
 *   ACCESS_TRAVEL_API_KEY
 *
 * Optional:
 *
 *   ACCESS_TRAVEL_AUTH_URL
 *   CARDLEO_SITE_URL
 *   APP_BASE_URL
 *
 * Default Access authentication endpoint:
 *
 *   https://auth.adcrws.com/api/v1/tokens
 *
 * Member identifiers, email addresses, and names are obtained from
 * the authenticated server response, never from the request body.
 */

const DEFAULT_TRAVEL_AUTH_URL =
  "https://auth.adcrws.com/api/v1/tokens";

const DEFAULT_SITE_URL =
  "https://cardleorewards.com";

const MEMBER_LOOKUP_TIMEOUT_MS = 10000;
const TRAVEL_AUTH_TIMEOUT_MS = 15000;

const BLOCKED_STATUSES = new Set([
  "unpaid",
  "past_due",
  "payment_failed",
  "failed",
  "canceled",
  "cancelled",
  "suspended",
  "inactive",
  "disabled",
  "paused",
  "denied",
  "closed",
  "expired",
  "incomplete",
  "incomplete_expired",
  "payment_pending",
  "pending_payment",
  "requires_payment",
]);

const ACTIVE_STATUSES = new Set([
  "active",
  "trialing",
  "paid",
  "approved",
  "current",
  "complete",
  "completed",
  "succeeded",
  "activated",
  "auto_approved",
]);

const PAID_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStatus(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function getEnv(name, fallback = "") {
  return normalizeString(
    process.env[name] ?? fallback
  );
}

function getHeader(req, name) {
  const value = req?.headers?.[name];

  return normalizeString(
    Array.isArray(value)
      ? value[0]
      : value
  );
}

function createError(message, code, status = 500) {
  const error = new Error(message);

  error.code = code;
  error.status = status;

  return error;
}

function unwrapResponse(payload) {
  return isObject(payload?.data)
    ? payload.data
    : payload;
}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  return res.end(JSON.stringify(body));
}

function sendFailure(
  res,
  status,
  code,
  message
) {
  return sendJson(res, status, {
    ok: false,
    success: false,
    error: code,
    code,
    message,
  });
}

function setPrivateHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.setHeader(
    "Vary",
    "Cookie, Origin"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );
}

// -----------------------------------------------------------------------------
// Fixed Card Leo origin
// -----------------------------------------------------------------------------

function parseConfiguredOrigin(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw createError(
      "Card Leo site URL is not configured correctly.",
      "CARDLEO_SITE_URL_INVALID",
      503
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password
  ) {
    throw createError(
      "Card Leo site URL must use HTTPS without embedded credentials.",
      "CARDLEO_SITE_URL_INVALID",
      503
    );
  }

  return url.origin;
}

function getOrigin() {
  const configuredOrigin =
    getEnv("CARDLEO_SITE_URL") ||
    getEnv("APP_BASE_URL") ||
    DEFAULT_SITE_URL;

  // Never construct a credential-bearing request from Host headers.
  return parseConfiguredOrigin(configuredOrigin);
}

function getAllowedOrigins() {
  const origins = new Set([
    "https://cardleorewards.com",
    "https://www.cardleorewards.com",
  ]);

  const siteUrl = getEnv("CARDLEO_SITE_URL");
  const appUrl = getEnv("APP_BASE_URL");

  if (siteUrl) {
    origins.add(parseConfiguredOrigin(siteUrl));
  }

  if (appUrl) {
    origins.add(parseConfiguredOrigin(appUrl));
  }

  return origins;
}

function validateRequestOrigin(req) {
  const origin = getHeader(req, "origin");
  const fetchSite = getHeader(req, "sec-fetch-site");

  if (
    origin &&
    !getAllowedOrigins().has(origin)
  ) {
    return {
      valid: false,
      code: "ORIGIN_NOT_ALLOWED",
      message:
        "Open Card Leo Travel from your member portal.",
    };
  }

  // Preserve support for server requests that have neither header.
  if (
    !origin &&
    fetchSite &&
    !["same-origin", "none"].includes(fetchSite)
  ) {
    return {
      valid: false,
      code: "CROSS_SITE_REQUEST_BLOCKED",
      message:
        "Open Card Leo Travel from your member portal.",
    };
  }

  return {
    valid: true,
  };
}

// -----------------------------------------------------------------------------
// Existing Card Leo authentication endpoint
// -----------------------------------------------------------------------------

async function loadAuthenticatedMember(req) {
  const origin = getOrigin();

  let response;

  try {
    response = await fetch(
      `${origin}/api/auth/me`,
      {
        method: "GET",

        headers: {
          cookie: getHeader(req, "cookie"),
          accept: "application/json",
        },

        cache: "no-store",

        // Do not forward session cookies through an HTTP redirect.
        redirect: "error",

        signal: AbortSignal.timeout(
          MEMBER_LOOKUP_TIMEOUT_MS
        ),
      }
    );
  } catch {
    return {
      error: "MEMBER_LOOKUP_FAILED",
      status: 502,
      message:
        "Unable to verify your Card Leo membership right now.",
    };
  }

  if (response.status === 401) {
    return {
      error: "AUTH_REQUIRED",
      status: 401,
      message:
        "Please sign in before opening Card Leo Travel.",
    };
  }

  if (response.status === 403) {
    return {
      error: "MEMBERSHIP_NOT_ACTIVE",
      status: 403,
      message:
        "Your membership does not currently have access to Card Leo Travel.",
    };
  }

  if (!response.ok) {
    return {
      error: "MEMBER_LOOKUP_FAILED",
      status: 502,
      message:
        "Unable to verify your Card Leo membership right now.",
    };
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    return {
      error: "MEMBER_LOOKUP_INVALID_RESPONSE",
      status: 502,
      message:
        "Card Leo could not read your membership information.",
    };
  }

  const data = unwrapResponse(payload);

  if (!isObject(data)) {
    return {
      error: "MEMBER_LOOKUP_INVALID_RESPONSE",
      status: 502,
      message:
        "Card Leo could not read your membership information.",
    };
  }

  if (
    payload?.authenticated === false ||
    data.authenticated === false
  ) {
    return {
      error: "AUTH_REQUIRED",
      status: 401,
      message:
        "Please sign in before opening Card Leo Travel.",
    };
  }

  if (
    payload?.success === false ||
    payload?.ok === false ||
    data.success === false ||
    data.ok === false
  ) {
    return {
      error: "MEMBER_LOOKUP_FAILED",
      status: 502,
      message:
        "Unable to verify your Card Leo membership right now.",
    };
  }

  return {
    data,
  };
}

// -----------------------------------------------------------------------------
// Resolve existing member response formats
// -----------------------------------------------------------------------------

function resolveMember(data) {
  const candidates = [
    data?.member,
    data?.profile,
    data?.user,
    data?.data?.member,
    data?.data?.profile,
    data?.data?.user,
  ];

  for (const candidate of candidates) {
    if (isObject(candidate)) {
      return candidate;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Membership eligibility
// -----------------------------------------------------------------------------

function isEligibleMember(member) {
  if (!isObject(member)) {
    return false;
  }

  const membershipStatus = normalizeStatus(
    member.membership_status ||
      member.membershipStatus
  );

  const subscriptionStatus = normalizeStatus(
    member.subscription_status ||
      member.subscriptionStatus
  );

  const paymentStatus = normalizeStatus(
    member.payment_status ||
      member.paymentStatus
  );

  const accountStatus = normalizeStatus(
    member.status ||
      member.account_status ||
      member.accountStatus
  );

  const approvalStatus = normalizeStatus(
    member.approval_status ||
      member.approvalStatus
  );

  const statuses = [
    membershipStatus,
    subscriptionStatus,
    paymentStatus,
    accountStatus,
    approvalStatus,
  ].filter(Boolean);

  // A blocked field overrides a stale positive field.
  // Example: active membership plus past_due payment is not eligible.
  if (
    statuses.some((status) =>
      BLOCKED_STATUSES.has(status)
    )
  ) {
    return false;
  }

  // When the auth endpoint provides payment status, respect it.
  if (
    paymentStatus &&
    !PAID_STATUSES.has(paymentStatus)
  ) {
    return false;
  }

  // Preserve the original requirement for a positive entitlement.
  return statuses.some((status) =>
    ACTIVE_STATUSES.has(status)
  );
}

// -----------------------------------------------------------------------------
// Permanent Access member identifier
// -----------------------------------------------------------------------------

function getAccessMemberKey(member, data = {}) {
  const access =
    isObject(data.access)
      ? data.access
      : isObject(data.accessPerks)
        ? data.accessPerks
        : {};

  const candidates = [
    // Primary Card Leo database field.
    member.access_member_identifier,

    // Existing portal response format.
    member.accessMemberIdentifier,

    // Other existing integration aliases.
    member.member_customer_identifier,
    member.memberCustomerIdentifier,
    member.access_member_key,
    member.accessMemberKey,
    member.access_member_id,

    // Access metadata from the authenticated server response.
    access.member_identifier,
    access.memberIdentifier,
    access.member_customer_identifier,
    access.memberCustomerIdentifier,
    access.access_member_identifier,
  ];

  for (const value of candidates) {
    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  // Do not generate a random ID or substitute an email address.
  return null;
}

// -----------------------------------------------------------------------------
// Travel configuration
// -----------------------------------------------------------------------------

function getTravelConfiguration() {
  const apiKey = getEnv(
    "ACCESS_TRAVEL_API_KEY"
  );

  if (!apiKey) {
    throw createError(
      "Card Leo Travel is not configured yet.",
      "TRAVEL_NOT_CONFIGURED",
      503
    );
  }

  const configuredUrl = getEnv(
    "ACCESS_TRAVEL_AUTH_URL",
    DEFAULT_TRAVEL_AUTH_URL
  );

  let url;

  try {
    url = new URL(configuredUrl);
  } catch {
    throw createError(
      "Card Leo Travel authentication URL is invalid.",
      "TRAVEL_AUTH_URL_INVALID",
      503
    );
  }

  // Send the Travel API key only to the documented authentication endpoint.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.adcrws.com" ||
    url.pathname !== "/api/v1/tokens" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw createError(
      "Card Leo Travel must use the approved Access authentication endpoint.",
      "TRAVEL_AUTH_URL_INVALID",
      503
    );
  }

  return {
    apiKey,
    authUrl: url.toString(),
  };
}

// -----------------------------------------------------------------------------
// Travel payload
// -----------------------------------------------------------------------------

function buildTravelPayload(member, memberKey) {
  const payload = {
    member_key: memberKey,
    scope: "travel",
  };

  const email = normalizeString(
    member.email ||
      member.email_address ||
      member.emailAddress
  );

  let firstName = normalizeString(
    member.first_name ||
      member.firstName
  );

  let lastName = normalizeString(
    member.last_name ||
      member.lastName
  );

  const fullName = normalizeString(
    member.full_name ||
      member.fullName ||
      member.name
  );

  if ((!firstName || !lastName) && fullName) {
    const parts = fullName
      .split(/\s+/)
      .filter(Boolean);

    firstName ||= parts[0] || "";
    lastName ||= parts.slice(1).join(" ");
  }

  if (email) {
    payload.email = email;
  }

  if (firstName) {
    payload.first_name = firstName;
  }

  if (lastName) {
    payload.last_name = lastName;
  }

  return payload;
}

// -----------------------------------------------------------------------------
// Request temporary Access Travel session
// -----------------------------------------------------------------------------

async function requestTravelSession({
  member,
  memberKey,
  configuration,
}) {
  const payload = buildTravelPayload(
    member,
    memberKey
  );

  let response;

  try {
    response = await fetch(
      configuration.authUrl,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization:
            `Bearer ${configuration.apiKey}`,
        },

        body: JSON.stringify(payload),

        cache: "no-store",

        // Never forward the API key through a redirect.
        redirect: "error",

        signal: AbortSignal.timeout(
          TRAVEL_AUTH_TIMEOUT_MS
        ),
      }
    );
  } catch {
    throw createError(
      "Unable to connect to Access Travel right now.",
      "ACCESS_TRAVEL_CONNECTION_FAILED",
      502
    );
  }

  if (!response.ok) {
    // Status only: no tokens, payloads, or credential-bearing headers.
    console.error(
      "Access Travel authentication failed",
      {
        status: response.status,
      }
    );

    if (response.status === 429) {
      throw createError(
        "Access Travel is busy. Please try again shortly.",
        "ACCESS_TRAVEL_RATE_LIMITED",
        429
      );
    }

    throw createError(
      "Access Travel could not create your session.",
      "ACCESS_TRAVEL_AUTH_FAILED",
      502
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw createError(
      "Access Travel returned an unreadable response.",
      "INVALID_ACCESS_TRAVEL_RESPONSE",
      502
    );
  }

  if (
    typeof data?.session_token !== "string" ||
    !data.session_token.trim()
  ) {
    throw createError(
      "Access Travel did not return a session token.",
      "INVALID_ACCESS_TRAVEL_RESPONSE",
      502
    );
  }

  return {
    sessionToken: data.session_token,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  setPrivateHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendFailure(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Method not allowed. Use POST."
    );
  }

  try {
    const originCheck =
      validateRequestOrigin(req);

    if (!originCheck.valid) {
      return sendFailure(
        res,
        403,
        originCheck.code,
        originCheck.message
      );
    }

    const auth =
      await loadAuthenticatedMember(req);

    if (auth.error) {
      return sendFailure(
        res,
        auth.status,
        auth.error,
        auth.message
      );
    }

    const member = resolveMember(auth.data);

    if (!member) {
      return sendFailure(
        res,
        401,
        "MEMBER_NOT_FOUND",
        "Please sign in again to open Card Leo Travel."
      );
    }

    if (!isEligibleMember(member)) {
      return sendFailure(
        res,
        403,
        "MEMBERSHIP_NOT_ACTIVE",
        "Your Card Leo membership must be active and current before Travel can be opened."
      );
    }

    const memberKey = getAccessMemberKey(
      member,
      auth.data
    );

    if (!memberKey) {
      return sendFailure(
        res,
        409,
        "ACCESS_MEMBER_KEY_MISSING",
        "Your permanent Access member identifier must finish synchronizing before Travel can be opened."
      );
    }

    const configuration =
      getTravelConfiguration();

    const result =
      await requestTravelSession({
        member,
        memberKey,
        configuration,
      });

    // Return only the temporary member session credential.
    // Never return the Access Travel API key.
    return sendJson(res, 200, {
      ok: true,
      success: true,
      session_token: result.sessionToken,
    });
  } catch (error) {
    const status =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;

    const code =
      normalizeString(error?.code) ||
      "TRAVEL_SESSION_ERROR";

    console.error(
      "Card Leo Travel session error",
      {
        code,
        status,
      }
    );

    return sendFailure(
      res,
      status,
      code,
      status === 500
        ? "Unable to open Card Leo Travel right now."
        : error.message
    );
  }
}