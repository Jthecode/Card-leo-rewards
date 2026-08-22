// api/access/offers.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  buildPortalAccessCatalog,
  fetchAccessOffersPage,
  fetchAllAccessOffers,
  filterAccessOffers,
  getAccessOffersConfigForDebug,
  getAccessOffersIntegrationStatus,
  sanitizeAccessOfferForPortal,
  validateAccessOffersConfiguration,
} from "../../lib/access-offers.js";

import {
  clearAuthCookies,
  getSessionCookieName,
  safeJsonParse,
} from "../../lib/cookies.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #15
   ACCESS OFFERS API

   ROUTE
   -----
   GET /api/access/offers

   PURPOSE
   -------
   Secure authenticated proxy between Card Leo members and the
   Access Development Offers API.

   THIS ROUTE:

   - retrieves ALL Access offers through pagination
   - retrieves one Access page when explicitly requested
   - searches offers
   - filters by category
   - filters online/local
   - filters featured
   - filters active
   - supports lat/lng/radius when supported by Access
   - normalizes merchants
   - normalizes locations
   - normalizes categories
   - returns safe portal offer data
   - keeps actual redemption credentials private

   IMPORTANT
   ---------
   This route DOES NOT generate:

   - QR codes
   - barcodes
   - coupon codes
   - redemption URLs

   Actual member redemption belongs to:

     /api/access/redeem-offer

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_PAGE_SIZE = 100;

const MAX_PUBLIC_PAGE_SIZE = 500;

const DEFAULT_MAX_PAGES = 100;

const MAX_PUBLIC_MAX_PAGES = 250;

const DEFAULT_RESPONSE_LIMIT = 0;

/* ==========================================================================
   ACTIVE MEMBERSHIP VALUES
============================================================================ */

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

/* ==========================================================================
   SESSION COOKIE NAMES
============================================================================ */

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   RESPONSE
============================================================================ */

function sendJson(
  res,
  status,
  payload
) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  /*
   * Offers are member-only.
   *
   * Never allow a browser/CDN to cache one member's response
   * and accidentally serve it to another member.
   */

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

  return res.end(
    JSON.stringify(
      payload
    )
  );
}

function badRequest(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    400,
    {
      success: false,
      ok: false,
      message,
      ...extra,
    }
  );
}

function unauthorized(
  res,
  message = "Please sign in to continue."
) {
  return sendJson(
    res,
    401,
    {
      success: false,
      ok: false,
      authenticated: false,
      message,
    }
  );
}

function forbidden(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    403,
    {
      success: false,
      ok: false,
      authenticated: true,
      message,
      ...extra,
    }
  );
}

function serviceUnavailable(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    503,
    {
      success: false,
      ok: false,
      message,
      ...extra,
    }
  );
}

function serverError(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    500,
    {
      success: false,
      ok: false,
      message,
      ...extra,
    }
  );
}

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeLower(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeStatus(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    typeof value === "number"
  ) {
    return value !== 0;
  }

  const normalized =
    normalizeLower(
      value
    );

  if (
    [
      "true",
      "1",
      "yes",
      "y",
      "on",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "n",
      "off",
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function normalizeInteger(
  value,
  fallback = 0
) {
  const parsed =
    Number.parseInt(
      String(
        value ?? ""
      ),
      10
    );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function normalizeNumber(
  value,
  fallback = null
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const parsed =
    Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    Math.max(
      value,
      min
    ),
    max
  );
}

function safeDate(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date.toISOString();
}

/* ==========================================================================
   COOKIE PARSING
============================================================================ */

function parseCookies(
  req
) {
  if (
    req?.cookies &&
    typeof req.cookies === "object"
  ) {
    return req.cookies;
  }

  const header =
    req?.headers?.cookie ||
    "";

  return String(header)
    .split(";")
    .map(
      (part) =>
        part.trim()
    )
    .filter(Boolean)
    .reduce(
      (
        output,
        part
      ) => {
        const separator =
          part.indexOf("=");

        if (
          separator === -1
        ) {
          return output;
        }

        const name =
          part
            .slice(
              0,
              separator
            )
            .trim();

        const rawValue =
          part
            .slice(
              separator + 1
            )
            .trim();

        if (!name) {
          return output;
        }

        try {
          output[name] =
            decodeURIComponent(
              rawValue
            );
        } catch {
          output[name] =
            rawValue;
        }

        return output;
      },
      {}
    );
}

/* ==========================================================================
   SESSION PARSER
============================================================================ */

function parseSessionValue(
  value
) {
  if (
    isObject(value)
  ) {
    return value;
  }

  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return null;
  }

  const direct =
    safeJsonParse(
      raw,
      null
    );

  if (
    isObject(direct)
  ) {
    return direct;
  }

  /*
   * Compatibility with older encoded Card Leo sessions.
   */

  try {
    const decoded =
      Buffer
        .from(
          raw,
          "base64"
        )
        .toString(
          "utf8"
        );

    const parsed =
      safeJsonParse(
        decoded,
        null
      );

    if (
      isObject(parsed)
    ) {
      return parsed;
    }
  } catch {
    // Ignore.
  }

  try {
    const normalized =
      raw
        .replace(
          /-/g,
          "+"
        )
        .replace(
          /_/g,
          "/"
        );

    const padded =
      normalized.padEnd(
        Math.ceil(
          normalized.length / 4
        ) * 4,
        "="
      );

    const decoded =
      Buffer
        .from(
          padded,
          "base64"
        )
        .toString(
          "utf8"
        );

    const parsed =
      safeJsonParse(
        decoded,
        null
      );

    if (
      isObject(parsed)
    ) {
      return parsed;
    }
  } catch {
    // Ignore.
  }

  return null;
}

/* ==========================================================================
   SESSION LOOKUP
============================================================================ */

function readSessionCookie(
  req
) {
  const cookies =
    parseCookies(
      req
    );

  const configuredName =
    typeof getSessionCookieName === "function"
      ? normalizeString(
          getSessionCookieName()
        )
      : "";

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...SESSION_COOKIE_NAMES,
        ].filter(Boolean)
      )
    );

  for (
    const name
    of names
  ) {
    const raw =
      cookies[name];

    if (!raw) {
      continue;
    }

    const data =
      parseSessionValue(
        raw
      );

    if (
      isObject(data)
    ) {
      return {
        name,
        raw,
        data,
      };
    }
  }

  return null;
}

/* ==========================================================================
   SESSION MEMBER ID
============================================================================ */

function getSessionMemberId(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  const member =
    isObject(
      session.member
    )
      ? session.member
      : {};

  const profile =
    isObject(
      session.profile
    )
      ? session.profile
      : {};

  const user =
    isObject(
      session.user
    )
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

/* ==========================================================================
   SESSION EMAIL
============================================================================ */

function getSessionEmail(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  const member =
    isObject(
      session.member
    )
      ? session.member
      : {};

  const profile =
    isObject(
      session.profile
    )
      ? session.profile
      : {};

  const user =
    isObject(
      session.user
    )
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

/* ==========================================================================
   SESSION EXPIRATION
============================================================================ */

function getSessionExpiresAt(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  const candidates = [
    session.expires_at,
    session.expiresAt,
    session.exp,
    session.session?.expires_at,
    session.session?.expiresAt,
  ];

  for (
    const value
    of candidates
  ) {
    const numeric =
      Number(value);

    if (
      Number.isFinite(numeric) &&
      numeric > 0
    ) {
      return numeric;
    }
  }

  return 0;
}

function isSessionExpired(
  sessionMeta
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionMeta
    );

  /*
   * Preserve compatibility with older Card Leo sessions that
   * may not have an expires_at field.
   */

  if (!expiresAt) {
    return false;
  }

  return (
    expiresAt <=
    Math.floor(
      Date.now() / 1000
    )
  );
}

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

function isMemberActive(
  member
) {
  if (!member) {
    return false;
  }

  const status =
    normalizeStatus(
      member.status
    );

  const paymentStatus =
    normalizeStatus(
      member.payment_status
    );

  const membershipStatus =
    normalizeStatus(
      member.membership_status
    );

  const approvalStatus =
    normalizeStatus(
      member.approval_status
    );

  /*
   * Explicit inactive state always wins.
   */

  if (
    INACTIVE_STATUSES.has(
      status
    ) ||
    INACTIVE_STATUSES.has(
      paymentStatus
    ) ||
    INACTIVE_STATUSES.has(
      membershipStatus
    ) ||
    INACTIVE_STATUSES.has(
      approvalStatus
    )
  ) {
    return false;
  }

  /*
   * Payment must actually be current.
   */

  const paid =
    ACTIVE_PAYMENT_STATUSES.has(
      paymentStatus
    );

  const active =
    ACTIVE_MEMBER_STATUSES.has(
      status
    ) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_APPROVAL_STATUSES.has(
      approvalStatus
    );

  return (
    paid &&
    active
  );
}

/* ==========================================================================
   ACCESS PERKS STATUS
============================================================================ */

function isAccessMemberReady(
  member
) {
  const ready =
    member
      ?.access_perks_ready;

  if (
    typeof ready === "boolean"
  ) {
    return ready;
  }

  const status =
    normalizeString(
      member
        ?.access_member_status
    ).toUpperCase();

  return (
    status === "OPEN"
  );
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findMember({
  memberId,
  email,
}) {
  let query =
    supabaseAdmin
      .from(
        "signups"
      )
      .select("*")
      .limit(1);

  if (memberId) {
    query =
      query.eq(
        "id",
        memberId
      );
  } else if (email) {
    query =
      query.ilike(
        "email",
        email
      );
  } else {
    return null;
  }

  const {
    data,
    error,
  } =
    await query
      .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   AUTHENTICATION

   IMPORTANT
   ---------
   We do NOT require:

     session.data.authenticated === true

   Older/newer Card Leo session versions may not all contain that exact
   boolean. Instead, we resolve the real member from the server-side
   Supabase record using session identity.

============================================================================ */

async function authenticateMember(
  req,
  res
) {
  const session =
    readSessionCookie(
      req
    );

  if (
    !session?.data
  ) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Please sign in to view Card Leo benefits."
        ),
    };
  }

  if (
    isSessionExpired(
      session
    )
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Your session has expired. Please sign in again."
        ),
    };
  }

  const memberId =
    getSessionMemberId(
      session
    );

  const email =
    getSessionEmail(
      session
    );

  if (
    !memberId &&
    !email
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Member information is missing from your login session."
        ),
    };
  }

  let member =
    null;

  /*
   * Try the immutable member ID first.
   */

  if (memberId) {
    member =
      await findMember({
        memberId,
        email: "",
      });
  }

  /*
   * Compatibility fallback:
   *
   * If an older session contains an ID that no longer resolves but has
   * the member email, try the email before declaring the session invalid.
   */

  if (
    !member?.id &&
    email
  ) {
    member =
      await findMember({
        memberId: "",
        email,
      });
  }

  if (
    !member?.id
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Your Card Leo member record could not be found."
        ),
    };
  }

  /*
   * IMPORTANT:
   *
   * Membership/payment problems are authorization failures, NOT
   * authentication failures. Do not clear the member's login cookies.
   */

  if (
    !isMemberActive(
      member
    )
  ) {
    return {
      member: null,

      response:
        forbidden(
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

/* ==========================================================================
   SAFE MEMBER
============================================================================ */

function sanitizeMember(
  member
) {
  return {
    id:
      member?.id ||
      null,

    email:
      normalizeEmail(
        member?.email
      ),

    firstName:
      normalizeString(
        member?.first_name
      ),

    lastName:
      normalizeString(
        member?.last_name
      ),

    fullName:
      normalizeString(
        member?.full_name
      ) ||
      [
        member?.first_name,
        member?.last_name,
      ]
        .map(
          normalizeString
        )
        .filter(Boolean)
        .join(" "),

    membershipStatus:
      normalizeString(
        member
          ?.membership_status
      ),

    paymentStatus:
      normalizeString(
        member
          ?.payment_status
      ),

    approvalStatus:
      normalizeString(
        member
          ?.approval_status
      ),

    accessMemberIdentifier:
      normalizeString(
        member
          ?.access_member_identifier
      ),

    accessMemberStatus:
      normalizeString(
        member
          ?.access_member_status
      ),

    accessPerksReady:
      isAccessMemberReady(
        member
      ),
  };
}

/* ==========================================================================
   QUERY OPTIONS
============================================================================ */

function buildQueryOptions(
  req
) {
  const query =
    req.query ||
    {};

  const mode =
    normalizeLower(
      query.mode ||
      (
        normalizeBoolean(
          query.all,
          true
        )
          ? "all"
          : "page"
      )
    );

  const page =
    clamp(
      normalizeInteger(
        query.page,
        1
      ),
      1,
      100000
    );

  const pageSize =
    clamp(
      normalizeInteger(
        query.page_size ??
        query.pageSize ??
        query.limit,
        DEFAULT_PAGE_SIZE
      ),
      1,
      MAX_PUBLIC_PAGE_SIZE
    );

  const maxPages =
    clamp(
      normalizeInteger(
        query.max_pages ??
        query.maxPages,
        DEFAULT_MAX_PAGES
      ),
      1,
      MAX_PUBLIC_MAX_PAGES
    );

  const resultLimit =
    Math.max(
      normalizeInteger(
        query.result_limit ??
        query.resultLimit ??
        query.return_limit ??
        query.returnLimit,
        DEFAULT_RESPONSE_LIMIT
      ),
      0
    );

  const latitude =
    normalizeNumber(
      query.latitude ??
      query.lat,
      null
    );

  const longitude =
    normalizeNumber(
      query.longitude ??
      query.lng ??
      query.lon,
      null
    );

  const radius =
    normalizeNumber(
      query.radius,
      null
    );

  const hasOnlineFilter =
    query.online !==
    undefined;

  const hasLocalFilter =
    query.local !==
    undefined;

  const hasFeaturedFilter =
    query.featured !==
    undefined;

  const hasActiveFilter =
    query.active !==
    undefined;

  return {
    mode:
      mode === "page"
        ? "page"
        : "all",

    page,

    pageSize,

    maxPages,

    resultLimit,

    cursor:
      normalizeString(
        query.cursor
      ),

    search:
      normalizeString(
        query.search ??
        query.q ??
        query.query
      ),

    category:
      normalizeString(
        query.category
      ),

    latitude,

    longitude,

    radius,

    online:
      hasOnlineFilter
        ? normalizeBoolean(
            query.online
          )
        : undefined,

    local:
      hasLocalFilter
        ? normalizeBoolean(
            query.local
          )
        : undefined,

    featured:
      hasFeaturedFilter
        ? normalizeBoolean(
            query.featured
          )
        : undefined,

    active:
      hasActiveFilter
        ? normalizeBoolean(
            query.active,
            true
          )
        : true,

    debug:
      normalizeBoolean(
        query.debug,
        false
      ),
  };
}

/* ==========================================================================
   SERVER SEARCH / FILTER
============================================================================ */

function buildAccessFetchOptions(
  options
) {
  return {
    page:
      options.page,

    pageSize:
      options.pageSize,

    maxPages:
      options.maxPages,

    cursor:
      options.cursor ||
      undefined,

    search:
      options.search ||
      undefined,

    category:
      options.category ||
      undefined,

    latitude:
      options.latitude ??
      undefined,

    longitude:
      options.longitude ??
      undefined,

    radius:
      options.radius ??
      undefined,

    online:
      options.online,

    featured:
      options.featured,
  };
}

/* ==========================================================================
   APPLY PORTAL FILTERS
============================================================================ */

function applyPortalFilters(
  offers,
  options
) {
  return filterAccessOffers(
    offers,
    {
      search:
        options.search,

      category:
        options.category,

      online:
        options.online,

      local:
        options.local,

      featured:
        options.featured,

      active:
        options.active,
    }
  );
}

/* ==========================================================================
   LIMIT RESPONSE
============================================================================ */

function limitOffers(
  offers,
  limit
) {
  if (
    !limit ||
    limit <= 0
  ) {
    return offers;
  }

  return offers.slice(
    0,
    limit
  );
}

/* ==========================================================================
   FETCH PAGE MODE
============================================================================ */

async function loadSinglePage(
  options
) {
  const result =
    await fetchAccessOffersPage(
      buildAccessFetchOptions(
        options
      )
    );

  let offers =
    result.offers ||
    [];

  offers =
    applyPortalFilters(
      offers,
      options
    );

  offers =
    offers
      .map(
        sanitizeAccessOfferForPortal
      )
      .filter(Boolean);

  offers =
    limitOffers(
      offers,
      options.resultLimit
    );

  return {
    mode:
      "page",

    offers,

    count:
      offers.length,

    totalCatalogCount:
      result.pagination?.total ||
      null,

    pagesFetched:
      1,

    page:
      result.pagination?.page ||
      options.page,

    pageSize:
      options.pageSize,

    pagination:
      result.pagination ||
      null,

    hitSafetyLimit:
      false,
  };
}

/* ==========================================================================
   FETCH ALL MODE

   This fixes the old small/fixed benefits catalog behavior.
============================================================================ */

async function loadFullCatalog(
  options
) {
  const result =
    await fetchAllAccessOffers(
      buildAccessFetchOptions(
        options
      )
    );

  let offers =
    result.offers ||
    [];

  const rawCatalogCount =
    offers.length;

  /*
   * Apply Card Leo filters after every Access page has been combined.
   */

  offers =
    applyPortalFilters(
      offers,
      options
    );

  /*
   * Build normalized catalog before optional result limit.
   */

  const catalog =
    buildPortalAccessCatalog(
      offers
    );

  const fullFilteredCount =
    catalog.offers.length;

  const returnedOffers =
    limitOffers(
      catalog.offers,
      options.resultLimit
    );

  return {
    mode:
      "all",

    offers:
      returnedOffers,

    count:
      returnedOffers.length,

    fullFilteredCount,

    rawCatalogCount,

    categories:
      catalog.categories,

    merchants:
      catalog.merchants,

    pagesFetched:
      result.pagesFetched,

    pageSize:
      result.pageSize,

    hitSafetyLimit:
      Boolean(
        result.hitSafetyLimit
      ),

    pagination:
      result.pagination ||
      null,
  };
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  /* ========================================================================
     METHOD
  ======================================================================== */

  if (
    req.method !== "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET"
    );

    return sendJson(
      res,
      405,
      {
        success: false,
        ok: false,
        message:
          "Method not allowed. Use GET.",
      }
    );
  }

  try {
    /* ======================================================================
       AUTHENTICATION
    ====================================================================== */

    const {
      member,
      response,
    } =
      await authenticateMember(
        req,
        res
      );

    if (!member) {
      return response;
    }

    /* ======================================================================
       OPTIONS
    ====================================================================== */

    const options =
      buildQueryOptions(
        req
      );

    /* ======================================================================
       ACCESS CONFIGURATION
    ====================================================================== */

    const validation =
      validateAccessOffersConfiguration();

    if (
      !validation.valid
    ) {
      return serviceUnavailable(
        res,
        "Access Offers API is not fully configured yet.",
        {
          code:
            "ACCESS_OFFERS_CONFIGURATION_REQUIRED",

          errors:
            validation.errors,

          config:
            options.debug
              ? validation.config
              : undefined,

          nextStep:
            "Add the approved Access Offers endpoint configuration to Vercel.",
        }
      );
    }

    /* ======================================================================
       ACCESS ENROLLMENT
    ====================================================================== */

    const accessReady =
      isAccessMemberReady(
        member
      );

    /*
     * Member may be paid/active while Access is still syncing.
     *
     * Do not expose catalog access until their Access membership is OPEN.
     */

    if (!accessReady) {
      return forbidden(
        res,
        "Your Card Leo membership is active, but Access Perks enrollment is not ready yet.",
        {
          code:
            "ACCESS_MEMBER_NOT_READY",

          member:
            sanitizeMember(
              member
            ),

          access: {
            ready:
              false,

            memberStatus:
              normalizeString(
                member
                  .access_member_status
              ) ||
              "pending",

            syncError:
              normalizeString(
                member
                  .access_sync_error
              ) ||
              null,

            syncedAt:
              safeDate(
                member
                  .access_synced_at
              ),

            syncEndpoint:
              "/api/access/sync-member",
          },
        }
      );
    }

    /* ======================================================================
       FETCH ACCESS OFFERS
    ====================================================================== */

    let catalog;

    if (
      options.mode ===
      "page"
    ) {
      catalog =
        await loadSinglePage(
          options
        );
    } else {
      /*
       * DEFAULT:
       *
       * Full catalog mode.
       */

      catalog =
        await loadFullCatalog(
          options
        );
    }

    /* ======================================================================
       RESPONSE
    ====================================================================== */

    const integrationStatus =
      getAccessOffersIntegrationStatus();

    return sendJson(
      res,
      200,
      {
        success:
          true,

        ok:
          true,

        authenticated:
          true,

        message:
          options.mode === "all"
            ? `Loaded ${catalog.count} Card Leo benefit offers from the Access catalog.`
            : `Loaded ${catalog.count} Card Leo benefit offers from Access.`,

        member:
          sanitizeMember(
            member
          ),

        access: {
          ready:
            true,

          memberStatus:
            normalizeString(
              member
                .access_member_status
            ) ||
            "OPEN",

          perksReady:
            true,

          environment:
            integrationStatus
              .environment,
        },

        catalog: {
          mode:
            catalog.mode,

          /*
           * Number actually returned to the browser.
           */

          count:
            catalog.count,

          /*
           * Total after Card Leo filtering but before result_limit.
           */

          fullFilteredCount:
            catalog.fullFilteredCount ??
            catalog.count,

          /*
           * Total retrieved from Access before Card Leo filters.
           */

          rawCatalogCount:
            catalog.rawCatalogCount ??
            catalog.totalCatalogCount ??
            null,

          pagesFetched:
            catalog.pagesFetched,

          pageSize:
            catalog.pageSize,

          hitSafetyLimit:
            catalog.hitSafetyLimit,

          pagination:
            catalog.pagination,

          categories:
            catalog.categories ||
            [],

          merchants:
            catalog.merchants ||
            [],
        },

        filters: {
          search:
            options.search ||
            "",

          category:
            options.category ||
            "",

          online:
            options.online ??
            null,

          local:
            options.local ??
            null,

          featured:
            options.featured ??
            null,

          active:
            options.active,

          latitude:
            options.latitude,

          longitude:
            options.longitude,

          radius:
            options.radius,

          resultLimit:
            options.resultLimit ||
            null,
        },

        offers:
          catalog.offers,

        /*
         * Backward-compatible alias for older Benefits frontend code.
         */

        benefits:
          catalog.offers,

        links: {
          syncMember:
            "/api/access/sync-member",

          offers:
            "/api/access/offers",

          redeemOffer:
            "/api/access/redeem-offer",

          portalBenefits:
            "/portal/benefits.html",
        },

        config:
          options.debug
            ? getAccessOffersConfigForDebug()
            : undefined,

        fetchedAt:
          new Date()
            .toISOString(),
      }
    );
  } catch (
    error
  ) {
    console.error(
      "Card Leo Access offers error:",
      error
    );

    /* ======================================================================
       KNOWN ACCESS ERROR
    ====================================================================== */

    const providerStatus =
      Number(
        error?.status
      );

    if (
      Number.isFinite(
        providerStatus
      ) &&
      providerStatus >= 400 &&
      providerStatus <= 599
    ) {
      return sendJson(
        res,
        providerStatus,
        {
          success:
            false,

          ok:
            false,

          message:
            error?.message ||
            "Access rejected the benefits request.",

          code:
            error?.code ||
            "ACCESS_OFFERS_REQUEST_FAILED",

          access: {
            status:
              providerStatus,

            statusText:
              normalizeString(
                error?.statusText
              ),

            /*
             * URL is useful for endpoint debugging.
             * No Access token is included.
             */

            url:
              normalizeString(
                error?.url
              ),
          },
        }
      );
    }

    /* ======================================================================
       UNKNOWN ERROR
    ====================================================================== */

    return serverError(
      res,
      "Unable to load Card Leo benefits right now.",
      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,

            config:
              getAccessOffersConfigForDebug(),
          }
        : {}
    );
  }
}