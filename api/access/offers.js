// api/access/offers.js

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  buildPortalAccessCatalog,
  fetchAccessOffersPage,
  fetchAllAccessOffers,
  filterAccessOffers,
  getAccessOffersIntegrationStatus,
  sanitizeAccessOfferForPortal,
  validateAccessOffersConfiguration,
} from "../../lib/access-offers.js";

import {
  clearAuthCookies,
  getSessionCookieName,
  safeJsonParse,
} from "../../lib/cookies.js";

/*
 * Card Leo Rewards
 * File #5 — Access Offers endpoint
 *
 * GET /api/access/offers
 *
 * Preserves:
 * - Existing Card Leo session cookies.
 * - Member lookup by ID, then email.
 * - Existing paid/active membership rules.
 * - Page and full-catalog modes.
 * - Existing offers/benefits response aliases.
 *
 * Adds:
 * - Permanent Access member key passed to the Offers helper.
 * - ZIP/postal-code options.
 * - Official 100-offer maximum page size.
 *
 * Required helper contract in lib/access-offers.js:
 *
 * fetchAccessOffersPage(options)
 * fetchAllAccessOffers(options)
 *
 * Both must forward:
 *   options.memberKey  -> member_key
 *   options.postalCode -> postal_code
 *
 * The browser cannot select another Access member's key.
 * The key always comes from signups.access_member_identifier.
 */

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 100;
const MAX_PUBLIC_PAGE_SIZE = 100;

const DEFAULT_MAX_PAGES = 100;
const MAX_PUBLIC_MAX_PAGES = 250;

const DEFAULT_RESPONSE_LIMIT = 0;

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

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

function sendJson(res, status, payload) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  return res.end(JSON.stringify(payload));
}

function badRequest(res, message, extra = {}) {
  return sendJson(res, 400, {
    success: false,
    ok: false,
    message,
    ...extra,
  });
}

function unauthorized(
  res,
  message = "Please sign in to continue."
) {
  return sendJson(res, 401, {
    success: false,
    ok: false,
    authenticated: false,
    message,
  });
}

function forbidden(res, message, extra = {}) {
  return sendJson(res, 403, {
    success: false,
    ok: false,
    authenticated: true,
    message,
    ...extra,
  });
}

function serviceUnavailable(res, message, extra = {}) {
  return sendJson(res, 503, {
    success: false,
    ok: false,
    message,
    ...extra,
  });
}

function serverError(res, message, extra = {}) {
  return sendJson(res, 500, {
    success: false,
    ok: false,
    message,
    ...extra,
  });
}

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeLower(value);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeLower(value);

  if (
    ["true", "1", "yes", "y", "on"].includes(normalized)
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "n", "off"].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(
    String(value ?? ""),
    10
  );

  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback = null) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// -----------------------------------------------------------------------------
// Existing cookie parsing
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

// -----------------------------------------------------------------------------
// Existing session parser
// -----------------------------------------------------------------------------

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

  try {
    const decoded = Buffer.from(
      raw,
      "base64"
    ).toString("utf8");

    const parsed = safeJsonParse(decoded, null);

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Continue.
  }

  try {
    const normalized = raw
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const padded = normalized.padEnd(
      Math.ceil(normalized.length / 4) * 4,
      "="
    );

    const decoded = Buffer.from(
      padded,
      "base64"
    ).toString("utf8");

    const parsed = safeJsonParse(decoded, null);

    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid session values.
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
// Existing session identity
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

  const member = isObject(session.member)
    ? session.member
    : {};

  const profile = isObject(session.profile)
    ? session.profile
    : {};

  const user = isObject(session.user)
    ? session.user
    : {};

  return normalizeEmail(
    member.email ||
      profile.email ||
      user.email ||
      session.email ||
      session.userEmail
  );
}

// -----------------------------------------------------------------------------
// Existing expiration behavior
// -----------------------------------------------------------------------------

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

  // Preserve older sessions without an explicit expiration field.
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
  const ready = member?.access_perks_ready;

  if (typeof ready === "boolean") {
    return ready;
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
    throw error;
  }

  return data || null;
}

function safelyClearAuthCookies(res) {
  try {
    clearAuthCookies(res);
  } catch {
    // Best effort only.
  }
}

async function authenticateMember(req, res) {
  const session = readSessionCookie(req);

  if (!session?.data) {
    return {
      member: null,
      response: unauthorized(
        res,
        "Please sign in before viewing Card Leo benefits."
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

  // Preserve the existing email fallback for older sessions.
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

  // Payment problems do not clear a valid login.
  if (!isMemberActive(member)) {
    return {
      member: null,
      response: forbidden(
        res,
        "Your Card Leo membership must be active and paid before benefits can be viewed.",
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
// Safe member response
// -----------------------------------------------------------------------------

function sanitizeMember(member) {
  return {
    id: member?.id || null,
    email: normalizeEmail(member?.email),
    firstName: normalizeString(member?.first_name),
    lastName: normalizeString(member?.last_name),
    fullName:
      normalizeString(member?.full_name) ||
      [
        member?.first_name,
        member?.last_name,
      ]
        .map(normalizeString)
        .filter(Boolean)
        .join(" "),
    membershipStatus:
      normalizeString(member?.membership_status),
    paymentStatus:
      normalizeString(member?.payment_status),
    approvalStatus:
      normalizeString(member?.approval_status),
    accessMemberIdentifier:
      normalizeString(member?.access_member_identifier),
    accessMemberStatus:
      normalizeString(member?.access_member_status),
    accessPerksReady: isAccessMemberReady(member),
  };
}

// -----------------------------------------------------------------------------
// Query options
// -----------------------------------------------------------------------------

function buildQueryOptions(req) {
  const query = req.query || {};

  const mode = normalizeLower(
    firstValue(query.mode) ||
      (
        normalizeBoolean(firstValue(query.all), true)
          ? "all"
          : "page"
      )
  );

  return {
    mode: mode === "page" ? "page" : "all",

    page: clamp(
      normalizeInteger(firstValue(query.page), 1),
      1,
      100000
    ),

    pageSize: clamp(
      normalizeInteger(
        firstValue(
          query.per_page ??
            query.page_size ??
            query.pageSize ??
            query.limit
        ),
        DEFAULT_PAGE_SIZE
      ),
      1,
      MAX_PUBLIC_PAGE_SIZE
    ),

    maxPages: clamp(
      normalizeInteger(
        firstValue(query.max_pages ?? query.maxPages),
        DEFAULT_MAX_PAGES
      ),
      1,
      MAX_PUBLIC_MAX_PAGES
    ),

    resultLimit: Math.max(
      normalizeInteger(
        firstValue(
          query.result_limit ??
            query.resultLimit ??
            query.return_limit ??
            query.returnLimit
        ),
        DEFAULT_RESPONSE_LIMIT
      ),
      0
    ),

    cursor: normalizeString(firstValue(query.cursor)),

    search: normalizeString(
      firstValue(
        query.search ??
          query.q ??
          query.query
      )
    ),

    category: normalizeString(
      firstValue(
        query.category_key ??
          query.category
      )
    ),

    postalCode: normalizeString(
      firstValue(
        query.postal_code ??
          query.postalCode ??
          query.zip_code ??
          query.zip
      )
    ),

    latitude: normalizeNumber(
      firstValue(query.latitude ?? query.lat),
      null
    ),

    longitude: normalizeNumber(
      firstValue(
        query.longitude ??
          query.lng ??
          query.lon
      ),
      null
    ),

    radius: normalizeNumber(
      firstValue(query.radius),
      null
    ),

    online:
      query.online !== undefined
        ? normalizeBoolean(firstValue(query.online))
        : undefined,

    local:
      query.local !== undefined
        ? normalizeBoolean(firstValue(query.local))
        : undefined,

    featured:
      query.featured !== undefined
        ? normalizeBoolean(firstValue(query.featured))
        : undefined,

    active:
      query.active !== undefined
        ? normalizeBoolean(firstValue(query.active), true)
        : true,
  };
}

function validateQueryOptions(options) {
  if (
    options.latitude !== null &&
    (
      options.latitude < -90 ||
      options.latitude > 90
    )
  ) {
    return "Latitude must be between -90 and 90.";
  }

  if (
    options.longitude !== null &&
    (
      options.longitude < -180 ||
      options.longitude > 180
    )
  ) {
    return "Longitude must be between -180 and 180.";
  }

  if (
    (options.latitude === null) !==
    (options.longitude === null)
  ) {
    return "Provide both latitude and longitude, or use a ZIP code.";
  }

  if (
    options.radius !== null &&
    options.radius <= 0
  ) {
    return "Radius must be greater than zero.";
  }

  return "";
}

// -----------------------------------------------------------------------------
// Provider options
// -----------------------------------------------------------------------------

function buildAccessFetchOptions(options, memberKey) {
  return {
    page: options.page,
    pageSize: options.pageSize,
    maxPages: options.maxPages,
    cursor: options.cursor || undefined,
    search: options.search || undefined,
    category: options.category || undefined,
    latitude: options.latitude ?? undefined,
    longitude: options.longitude ?? undefined,
    radius: options.radius ?? undefined,
    online: options.online,
    featured: options.featured,

    // Always supplied from the database, never request query parameters.
    memberKey,
    member_key: memberKey,

    postalCode: options.postalCode || undefined,
    postal_code: options.postalCode || undefined,
  };
}

// -----------------------------------------------------------------------------
// Existing portal filters
// -----------------------------------------------------------------------------

function applyPortalFilters(offers, options) {
  return filterAccessOffers(offers, {
    search: options.search,
    category: options.category,
    online: options.online,
    local: options.local,
    featured: options.featured,
    active: options.active,
  });
}

function limitOffers(offers, limit) {
  return limit > 0 ? offers.slice(0, limit) : offers;
}

function sanitizeOffers(offers) {
  return offers
    .map((offer) => sanitizeAccessOfferForPortal(offer))
    .filter(Boolean);
}

// -----------------------------------------------------------------------------
// Single-page mode
// -----------------------------------------------------------------------------

async function loadSinglePage(options, memberKey) {
  const result = await fetchAccessOffersPage(
    buildAccessFetchOptions(options, memberKey)
  );

  const rawOffers = Array.isArray(result.offers)
    ? result.offers
    : [];

  const filteredOffers = applyPortalFilters(
    rawOffers,
    options
  );

  const safeOffers = sanitizeOffers(filteredOffers);

  const offers = limitOffers(
    safeOffers,
    options.resultLimit
  );

  return {
    mode: "page",
    offers,
    count: offers.length,
    fullFilteredCount: safeOffers.length,
    rawCatalogCount: rawOffers.length,
    totalCatalogCount:
      result.pagination?.total ??
      result.pagination?.total_results ??
      null,
    pagesFetched: 1,
    page: result.pagination?.page ?? options.page,
    pageSize: options.pageSize,
    pagination: result.pagination || null,
    hitSafetyLimit: false,
  };
}

// -----------------------------------------------------------------------------
// Full-catalog mode
// -----------------------------------------------------------------------------

async function loadFullCatalog(options, memberKey) {
  const result = await fetchAllAccessOffers(
    buildAccessFetchOptions(options, memberKey)
  );

  const rawOffers = Array.isArray(result.offers)
    ? result.offers
    : [];

  const filteredOffers = applyPortalFilters(
    rawOffers,
    options
  );

  const catalog = buildPortalAccessCatalog(
    filteredOffers
  );

  const safeOffers = sanitizeOffers(
    Array.isArray(catalog.offers)
      ? catalog.offers
      : []
  );

  const offers = limitOffers(
    safeOffers,
    options.resultLimit
  );

  return {
    mode: "all",
    offers,
    count: offers.length,
    fullFilteredCount: safeOffers.length,
    rawCatalogCount: rawOffers.length,
    categories: catalog.categories || [],
    merchants: catalog.merchants || [],
    pagesFetched: result.pagesFetched,
    pageSize: result.pageSize ?? options.pageSize,
    hitSafetyLimit: Boolean(result.hitSafetyLimit),
    pagination: result.pagination || null,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

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
    const {
      member,
      response,
    } = await authenticateMember(req, res);

    if (!member) {
      return response;
    }

    const options = buildQueryOptions(req);

    const queryError = validateQueryOptions(options);

    if (queryError) {
      return badRequest(res, queryError, {
        code: "ACCESS_OFFERS_QUERY_INVALID",
      });
    }

    const validation =
      validateAccessOffersConfiguration();

    if (!validation.valid) {
      return serviceUnavailable(
        res,
        "Access Offers API is not fully configured yet.",
        {
          code: "ACCESS_OFFERS_CONFIGURATION_REQUIRED",
          nextStep:
            "Check the approved Access Offers configuration in Vercel.",
        }
      );
    }

    const accessReady = isAccessMemberReady(member);

    if (!accessReady) {
      return forbidden(
        res,
        "Your Card Leo membership is active, but Access Perks enrollment is not ready yet.",
        {
          code: "ACCESS_MEMBER_NOT_READY",
          member: sanitizeMember(member),
          access: {
            ready: false,
            memberStatus:
              normalizeString(
                member.access_member_status
              ) || "pending",
            syncedAt: safeDate(
              member.access_synced_at
            ),
            syncEndpoint: "/api/access/sync-member",
          },
        }
      );
    }

    // Reuse the permanent identifier saved by Access AMT enrollment.
    // Do not generate a different identity while requesting offers.
    const memberKey = normalizeString(
      member.access_member_identifier
    );

    if (!memberKey) {
      return forbidden(
        res,
        "Your Access Perks member profile must finish synchronizing before offers can be loaded.",
        {
          code: "ACCESS_MEMBER_IDENTIFIER_MISSING",
          member: sanitizeMember(member),
          access: {
            ready: false,
            syncEndpoint: "/api/access/sync-member",
          },
        }
      );
    }

    const catalog =
      options.mode === "page"
        ? await loadSinglePage(options, memberKey)
        : await loadFullCatalog(options, memberKey);

    const integrationStatus =
      getAccessOffersIntegrationStatus();

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,

      message: catalog.hitSafetyLimit
        ? `Loaded ${catalog.count} Card Leo benefit offers. Additional offers may remain beyond the configured pagination limit.`
        : `Loaded ${catalog.count} Card Leo benefit offers from Access.`,

      member: sanitizeMember(member),

      access: {
        ready: true,
        memberStatus:
          normalizeString(
            member.access_member_status
          ) || "OPEN",
        perksReady: true,
        environment: integrationStatus.environment,
      },

      catalog: {
        mode: catalog.mode,
        count: catalog.count,
        fullFilteredCount:
          catalog.fullFilteredCount ?? catalog.count,
        rawCatalogCount:
          catalog.rawCatalogCount ??
          catalog.totalCatalogCount ??
          null,
        totalCatalogCount:
          catalog.totalCatalogCount ?? null,
        pagesFetched: catalog.pagesFetched,
        pageSize: catalog.pageSize,
        hitSafetyLimit: catalog.hitSafetyLimit,
        pagination: catalog.pagination,
        categories: catalog.categories || [],
        merchants: catalog.merchants || [],
      },

      filters: {
        search: options.search || "",
        category: options.category || "",
        postalCode: options.postalCode || "",
        online: options.online ?? null,
        local: options.local ?? null,
        featured: options.featured ?? null,
        active: options.active,
        latitude: options.latitude,
        longitude: options.longitude,
        radius: options.radius,
        resultLimit: options.resultLimit || null,
      },

      offers: catalog.offers,

      // Preserve the alias used by the existing Benefits frontend.
      benefits: catalog.offers,

      links: {
        syncMember: "/api/access/sync-member",
        offers: "/api/access/offers",
        offer: "/api/access/offer",
        redeemOffer: "/api/access/redeem-offer",
        sso: "/api/access/sso",
        portalBenefits: "/portal/benefits.html",
      },

      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const providerStatus = Number(error?.status);

    // Avoid logging raw provider URLs/responses that may contain tokens.
    console.error("Card Leo Access offers error:", {
      code: normalizeString(error?.code) ||
        "ACCESS_OFFERS_REQUEST_FAILED",
      status: Number.isFinite(providerStatus)
        ? providerStatus
        : null,
    });

    if (
      Number.isInteger(providerStatus) &&
      providerStatus >= 400 &&
      providerStatus <= 599
    ) {
      return sendJson(res, providerStatus, {
        success: false,
        ok: false,
        message:
          "Access could not complete the benefits request. Please try again.",
        code: "ACCESS_OFFERS_REQUEST_FAILED",
        access: {
          status: providerStatus,
        },
      });
    }

    return serverError(
      res,
      "Unable to load Card Leo benefits right now.",
      {
        code: "ACCESS_OFFERS_FAILED",
      }
    );
  }
}