// api/access/offer.js

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  clearAuthCookies,
  getSessionCookieName,
  safeJsonParse,
} from "../../lib/cookies.js";

/*
 * Card Leo Rewards
 * File #6 — Individual Access offer details
 *
 * GET /api/access/offer?offer_key=...
 *
 * Also accepts:
 *   ?offerKey=...
 *   ?id=...
 *
 * Uses the documented Access Offers search endpoint with an exact
 * offer_key filter. Does not guess an undocumented detail endpoint.
 *
 * Preserves the existing Card Leo session/member lookup pattern.
 *
 * Required server environment:
 *   ACCESS_OFFERS_API_TOKEN
 *
 * Optional server environment:
 *   ACCESS_ENVIRONMENT=stage
 *   ACCESS_OFFERS_API_BASE_URL=https://offer-stage.adcrws.com
 *
 * Production Offers host:
 *   https://offer.adcrws.com
 *
 * This endpoint reads offer details.
 * It does not redeem offers or generate redemption credentials.
 */

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_STAGE_BASE_URL =
  "https://offer-stage.adcrws.com";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://offer.adcrws.com";

const OFFERS_ENDPOINT_PATH = "/v1/offers";

const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_LOGIN_URL = "/login.html";
const DEFAULT_BENEFITS_URL = "/portal/benefits.html";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const ACTIVE_MEMBER_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
  "invited",
]);

const ACTIVE_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
]);

const ACTIVE_APPROVAL_STATUSES = new Set([
  "active",
  "approved",
  "complete",
  "completed",
  "auto_approved",
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
  "payment_failed",
]);

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

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
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getEnv(name, fallback = "") {
  return normalizeString(process.env[name] ?? fallback);
}

function createError(message, code, status = 500) {
  const error = new Error(message);

  error.code = code;
  error.status = status;

  return error;
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function safeText(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return "";
  }

  return normalizeString(value);
}

function safeHttpsUrl(value) {
  const text = safeText(value);

  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password
    ) {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

function applyPrivateHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, payload) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  return res.end(JSON.stringify(payload));
}

function sendFailure(
  res,
  status,
  message,
  code,
  extra = {}
) {
  return sendJson(res, status, {
    success: false,
    ok: false,
    message,
    code,
    ...extra,
  });
}

function unauthorized(res, message) {
  return sendFailure(
    res,
    401,
    message || "Please sign in to continue.",
    "CARDLEO_AUTH_REQUIRED",
    {
      authenticated: false,
      login: DEFAULT_LOGIN_URL,
    }
  );
}

function forbidden(res, message, code, extra = {}) {
  return sendFailure(res, 403, message, code, {
    authenticated: true,
    benefitsPage: DEFAULT_BENEFITS_URL,
    ...extra,
  });
}

function safelyClearAuthCookies(res) {
  try {
    clearAuthCookies(res);
  } catch {
    // Best effort only.
  }
}

// -----------------------------------------------------------------------------
// Existing Card Leo cookie parsing
// -----------------------------------------------------------------------------

function parseCookies(req) {
  if (
    req?.cookies &&
    typeof req.cookies === "object"
  ) {
    return req.cookies;
  }

  const header = req?.headers?.cookie || "";

  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((output, part) => {
      const separator = part.indexOf("=");

      if (separator === -1) {
        return output;
      }

      const name = part.slice(0, separator).trim();
      const rawValue = part.slice(separator + 1).trim();

      if (!name) {
        return output;
      }

      try {
        output[name] = decodeURIComponent(rawValue);
      } catch {
        output[name] = rawValue;
      }

      return output;
    }, {});
}

function parseSessionValue(value) {
  if (isObject(value)) {
    return value;
  }

  const raw = normalizeString(value);

  if (!raw) {
    return null;
  }

  const direct = safeJsonParse(raw, null);

  if (isObject(direct)) {
    return direct;
  }

  for (const encoding of ["base64", "base64url"]) {
    try {
      const decoded = Buffer.from(
        raw,
        encoding
      ).toString("utf8");

      const parsed = safeJsonParse(decoded, null);

      if (isObject(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next supported representation.
    }
  }

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookies(req);

  const configuredName =
    typeof getSessionCookieName === "function"
      ? normalizeString(getSessionCookieName())
      : "";

  const names = Array.from(
    new Set(
      [
        configuredName,
        ...SESSION_COOKIE_NAMES,
      ].filter(Boolean)
    )
  );

  for (const name of names) {
    const raw = cookies[name];

    if (!raw) {
      continue;
    }

    const data = parseSessionValue(raw);

    if (isObject(data)) {
      return {
        name,
        raw,
        data,
      };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Existing session identity and expiration
// -----------------------------------------------------------------------------

function getSessionMemberId(sessionMeta) {
  const session = sessionMeta?.data || {};

  const member = isObject(session.member)
    ? session.member
    : {};

  const profile = isObject(session.profile)
    ? session.profile
    : {};

  const user = isObject(session.user)
    ? session.user
    : {};

  return normalizeString(
    member.id ||
      member.member_id ||
      member.memberId ||
      member.signup_id ||
      member.signupId ||
      profile.id ||
      profile.member_id ||
      profile.memberId ||
      profile.signup_id ||
      profile.signupId ||
      user.id ||
      session.id ||
      session.member_id ||
      session.memberId ||
      session.signup_id ||
      session.signupId
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

function getSessionExpiresAt(sessionMeta) {
  const session = sessionMeta?.data || {};

  const candidates = [
    session.expires_at,
    session.expiresAt,
    session.exp,
    session.session?.expires_at,
    session.session?.expiresAt,
  ];

  for (const value of candidates) {
    const numeric = Number(value);

    if (
      Number.isFinite(numeric) &&
      numeric > 0
    ) {
      return numeric;
    }
  }

  return 0;
}

function isSessionExpired(sessionMeta) {
  const expiresAt = getSessionExpiresAt(sessionMeta);

  if (!expiresAt) {
    return false;
  }

  return expiresAt <= Math.floor(Date.now() / 1000);
}

// -----------------------------------------------------------------------------
// Existing membership rules
// -----------------------------------------------------------------------------

function isMemberActive(member) {
  if (!member) {
    return false;
  }

  const status = normalizeStatus(member.status);

  const paymentStatus = normalizeStatus(
    member.payment_status
  );

  const membershipStatus = normalizeStatus(
    member.membership_status
  );

  const approvalStatus = normalizeStatus(
    member.approval_status
  );

  if (
    INACTIVE_STATUSES.has(status) ||
    INACTIVE_STATUSES.has(paymentStatus) ||
    INACTIVE_STATUSES.has(membershipStatus) ||
    INACTIVE_STATUSES.has(approvalStatus)
  ) {
    return false;
  }

  const paid = ACTIVE_PAYMENT_STATUSES.has(
    paymentStatus
  );

  const active =
    ACTIVE_MEMBER_STATUSES.has(status) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus) ||
    ACTIVE_APPROVAL_STATUSES.has(approvalStatus);

  return paid && active;
}

function isAccessMemberReady(member) {
  if (
    typeof member?.access_perks_ready === "boolean"
  ) {
    return member.access_perks_ready;
  }

  return (
    normalizeString(
      member?.access_member_status
    ).toUpperCase() === "OPEN"
  );
}

// -----------------------------------------------------------------------------
// Existing member lookup
// -----------------------------------------------------------------------------

async function findMember({ memberId, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select("*")
    .limit(1);

  if (memberId) {
    query = query.eq("id", memberId);
  } else if (email) {
    query = query.ilike("email", email);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw createError(
      "Unable to load your Card Leo membership.",
      "CARDLEO_MEMBER_LOOKUP_FAILED",
      503
    );
  }

  return data || null;
}

async function authenticateMember(req, res) {
  const session = readSessionCookie(req);

  if (!session?.data) {
    return {
      member: null,
      response: unauthorized(
        res,
        "Please sign in before viewing this offer."
      ),
    };
  }

  if (isSessionExpired(session)) {
    safelyClearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(
        res,
        "Your Card Leo session expired. Please sign in again."
      ),
    };
  }

  const memberId = getSessionMemberId(session);
  const email = getSessionEmail(session);

  if (!memberId && !email) {
    safelyClearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(
        res,
        "Member information is missing from your login session."
      ),
    };
  }

  let member = null;

  if (memberId) {
    member = await findMember({
      memberId,
      email: "",
    });
  }

  if (!member?.id && email) {
    member = await findMember({
      memberId: "",
      email,
    });
  }

  if (!member?.id) {
    safelyClearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(
        res,
        "Your Card Leo member record could not be found."
      ),
    };
  }

  if (!isMemberActive(member)) {
    return {
      member: null,
      response: forbidden(
        res,
        "Your Card Leo membership must be active and paid before offers can be viewed.",
        "CARDLEO_MEMBERSHIP_NOT_ELIGIBLE",
        {
          requiresPayment: true,
          requires_payment: true,
          redirectTo:
            "/signup.html?status=payment_required",
        }
      ),
    };
  }

  return {
    member,
    response: null,
  };
}

// -----------------------------------------------------------------------------
// Official Offers API configuration
// -----------------------------------------------------------------------------

function getAccessEnvironment() {
  const environment = getEnv(
    "ACCESS_ENVIRONMENT",
    "stage"
  ).toLowerCase();

  return ["production", "prod", "live"].includes(environment)
    ? "production"
    : "stage";
}

function getOffersConfiguration() {
  const environment = getAccessEnvironment();

  const expectedHost =
    environment === "production"
      ? "offer.adcrws.com"
      : "offer-stage.adcrws.com";

  const configuredBaseUrl = getEnv(
    "ACCESS_OFFERS_API_BASE_URL"
  );

  const baseUrl =
    configuredBaseUrl ||
    (
      environment === "production"
        ? DEFAULT_PRODUCTION_BASE_URL
        : DEFAULT_STAGE_BASE_URL
    );

  let url;

  try {
    url = new URL(baseUrl);
  } catch {
    throw createError(
      "Access Offers base URL is invalid.",
      "ACCESS_OFFERS_CONFIGURATION_REQUIRED",
      503
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/v1", "/v1/", "/v1/offers", "/v1/offers/"]
      .includes(url.pathname)
  ) {
    throw createError(
      "Access Offers must use the approved Offers host for the configured environment.",
      "ACCESS_OFFERS_CONFIGURATION_REQUIRED",
      503
    );
  }

  const token = getEnv("ACCESS_OFFERS_API_TOKEN");

  if (!token) {
    throw createError(
      "Access Offers API token is not configured.",
      "ACCESS_OFFERS_CONFIGURATION_REQUIRED",
      503
    );
  }

  url.pathname = OFFERS_ENDPOINT_PATH;

  return {
    environment,
    token,
    url,
  };
}

// -----------------------------------------------------------------------------
// Offer key
// -----------------------------------------------------------------------------

function getRequestedOfferKey(req) {
  const query = req.query || {};

  return normalizeString(
    firstValue(
      query.offer_key ??
        query.offerKey ??
        query.id
    )
  );
}

function isValidOfferKey(value) {
  // Access examples use numeric keys.
  // Allow ordinary opaque keys without allowing search-list operators.
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

// -----------------------------------------------------------------------------
// Provider request
// -----------------------------------------------------------------------------

async function fetchMemberOffer({
  configuration,
  memberKey,
  offerKey,
}) {
  const url = new URL(configuration.url.toString());

  // Access credentials remain server-side.
  url.searchParams.set(
    "access_token",
    configuration.token
  );

  url.searchParams.set("member_key", memberKey);
  url.searchParams.set("offer_key", offerKey);
  url.searchParams.set("all_offers", "true");
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("sanitize_html", "true");

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw createError(
          "This offer is not available.",
          "ACCESS_OFFER_NOT_FOUND",
          404
        );
      }

      if (response.status === 429) {
        throw createError(
          "Access is receiving too many requests. Please try again shortly.",
          "ACCESS_OFFERS_RATE_LIMITED",
          429
        );
      }

      throw createError(
        "Access could not load this offer.",
        "ACCESS_OFFER_PROVIDER_ERROR",
        502
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw createError(
        "Access returned an unreadable offer response.",
        "ACCESS_OFFER_RESPONSE_INVALID",
        502
      );
    }

    const rows = Array.isArray(data?.offers)
      ? data.offers
      : Array.isArray(data?.data?.offers)
        ? data.data.offers
        : null;

    if (!rows) {
      throw createError(
        "Access returned an unexpected offer response.",
        "ACCESS_OFFER_RESPONSE_INVALID",
        502
      );
    }

    const offer = rows.find(
      (row) =>
        isObject(row) &&
        normalizeString(row.offer_key) === offerKey
    );

    if (!offer) {
      throw createError(
        "This offer is not available to your Access membership.",
        "ACCESS_OFFER_NOT_FOUND",
        404
      );
    }

    return offer;
  } catch (error) {
    if (controller.signal.aborted) {
      throw createError(
        "Access took too long to load this offer.",
        "ACCESS_OFFER_TIMEOUT",
        504
      );
    }

    if (
      typeof error?.code === "string" &&
      error.code.startsWith("ACCESS_")
    ) {
      throw error;
    }

    throw createError(
      "Unable to connect to Access right now.",
      "ACCESS_OFFER_CONNECTION_FAILED",
      502
    );
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Safe provider-data mapping
//
// Only selected display fields are returned.
// Provider HTML is requested as sanitized text.
// The frontend should still render text with textContent.
// -----------------------------------------------------------------------------

function normalizeLocation(value) {
  if (!isObject(value)) {
    return null;
  }

  return {
    id: safeText(
      value.location_key || value.id
    ),
    name: safeText(value.name),
    address: safeText(
      value.address ||
        value.address_1 ||
        value.address1 ||
        value.street_address
    ),
    address2: safeText(
      value.address_2 || value.address2
    ),
    city: safeText(
      value.city_locality || value.city
    ),
    state: safeText(
      value.state_region || value.state
    ),
    postalCode: safeText(
      value.postal_code || value.zip
    ),
    country: safeText(value.country),
    phone: safeText(value.phone),
  };
}

function normalizeCategories(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((category) => {
      if (
        typeof category === "string" ||
        typeof category === "number"
      ) {
        return {
          id: safeText(category),
          name: safeText(category),
        };
      }

      if (!isObject(category)) {
        return null;
      }

      return {
        id: safeText(
          category.category_key ||
            category.id ||
            category.key
        ),
        name: safeText(
          category.name || category.title
        ),
      };
    })
    .filter(Boolean);
}

function mapOfferForPortal(raw) {
  const merchant = isObject(raw.merchant)
    ? raw.merchant
    : isObject(raw.store)
      ? raw.store
      : {};

  const offerKey = normalizeString(raw.offer_key);

  const merchantName = safeText(
    raw.store_name ||
      raw.merchant_name ||
      merchant.name
  );

  const title = safeText(
    raw.title || raw.name
  );

  const description = safeText(
    raw.description ||
      raw.long_description ||
      raw.short_description
  );

  const terms = safeText(
    raw.terms ||
      raw.terms_and_conditions ||
      raw.disclaimer
  );

  const imageUrl = safeHttpsUrl(
    raw.image_url ||
      raw.image ||
      merchant.image_url ||
      merchant.logo_url
  );

  const categoryName = safeText(
    raw.category_name ||
      (
        typeof raw.category === "string"
          ? raw.category
          : raw.category?.name
      )
  );

  const categories = normalizeCategories(raw.categories);

  const sourceLocations = Array.isArray(raw.locations)
    ? raw.locations
    : isObject(raw.location)
      ? [raw.location]
      : [];

  const locations = sourceLocations
    .map(normalizeLocation)
    .filter(Boolean);

  const redemptionMethod = safeText(
    raw.redemption_method
  );

  const instructions = safeText(
    raw.redemption_instructions ||
      raw.instructions
  );

  return {
    id: offerKey,
    offerKey,
    offer_key: offerKey,

    title,
    name: title,
    description,
    shortDescription: safeText(
      raw.short_description
    ),

    terms,
    termsAndConditions: terms,

    imageUrl,
    image_url: imageUrl,

    merchantName,
    storeName: merchantName,

    merchant: {
      id: safeText(
        raw.store_key ||
          merchant.store_key ||
          merchant.id
      ),
      name: merchantName,
      logoUrl: safeHttpsUrl(
        merchant.logo_url
      ),
    },

    category: categoryName,
    categories,

    locations,

    national: raw.national_offer === true,

    startDate: safeDate(
      raw.start_date || raw.starts_at
    ),

    endDate: safeDate(
      raw.end_date || raw.expires_at
    ),

    redemptionMethod,

    redemption: {
      method: redemptionMethod,
      instructions,
      endpoint: "/api/access/redeem-offer",
      offerKey,
    },

    detailsUrl:
      `/portal/offer.html?offer_key=${encodeURIComponent(offerKey)}`,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  applyPrivateHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return sendFailure(
      res,
      405,
      "Method not allowed. Use GET.",
      "METHOD_NOT_ALLOWED"
    );
  }

  try {
    const {
      member,
      response,
    } = await authenticateMember(req, res);

    if (!member) {
      return response;
    }

    const offerKey = getRequestedOfferKey(req);

    if (!offerKey || !isValidOfferKey(offerKey)) {
      return sendFailure(
        res,
        400,
        "Provide a valid offer_key.",
        "ACCESS_OFFER_KEY_INVALID"
      );
    }

    if (!isAccessMemberReady(member)) {
      return forbidden(
        res,
        "Your Access Perks enrollment is not ready yet.",
        "ACCESS_MEMBER_NOT_READY",
        {
          access: {
            ready: false,
            syncEndpoint: "/api/access/sync-member",
          },
        }
      );
    }

    const memberKey = normalizeString(
      member.access_member_identifier
    );

    if (!memberKey) {
      return forbidden(
        res,
        "Your Access Perks member identifier must finish synchronizing before this offer can be viewed.",
        "ACCESS_MEMBER_IDENTIFIER_MISSING",
        {
          access: {
            ready: false,
            syncEndpoint: "/api/access/sync-member",
          },
        }
      );
    }

    const configuration = getOffersConfiguration();

    const rawOffer = await fetchMemberOffer({
      configuration,
      memberKey,
      offerKey,
    });

    const offer = mapOfferForPortal(rawOffer);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      message: "Access offer loaded.",

      access: {
        ready: true,
        environment: configuration.environment,
        memberStatus:
          normalizeString(
            member.access_member_status
          ) || "OPEN",
      },

      offer,

      // Compatibility alias for a frontend using "benefit".
      benefit: offer,

      links: {
        offers: "/api/access/offers",
        offer:
          `/api/access/offer?offer_key=${encodeURIComponent(offerKey)}`,
        redeemOffer: "/api/access/redeem-offer",
        benefits: DEFAULT_BENEFITS_URL,
        offerPage: offer.detailsUrl,
        sso: "/api/access/sso",
      },

      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;

    // Never log the upstream request URL: it contains the Access token.
    console.error("Card Leo Access offer details failed:", {
      code: error?.code || "ACCESS_OFFER_FAILED",
      status,
    });

    return sendFailure(
      res,
      status,
      status === 500
        ? "Unable to load this Card Leo offer right now."
        : error.message,
      error?.code || "ACCESS_OFFER_FAILED"
    );
  }
}