// lib/access-offers.js

/* ==========================================================================
   CARD LEO REWARDS
   ACCESS DEVELOPMENT — OFFERS API HELPER

   STEP #15

   PURPOSE
   -------
   Central server-only helper for the Access Development Offers API.

   RESPONSIBILITIES
   ----------------
   - Access Offers environment configuration
   - Offers API authentication
   - Search / catalog requests
   - Pagination
   - Full-catalog retrieval
   - Merchant normalization
   - Location normalization
   - Offer normalization
   - Category normalization
   - Redemption metadata normalization
   - Safe API errors
   - Safe debug configuration

   IMPORTANT
   ---------
   This file does NOT:

   - enroll/suspend Access members
   - replace lib/access-amt.js
   - perform Card Leo referral accounting
   - create member allowance
   - fund Lithic cards
   - manufacture redemption codes
   - guess an Access redemption URL

   MEMBER ENROLLMENT:
     lib/access-amt.js

   OFFER CATALOG:
     lib/access-offers.js

   REDEMPTION:
     Step #18 / api/access/redeem-offer.js

============================================================================ */

/* ==========================================================================
   DEFAULT ENVIRONMENT
============================================================================ */

const DEFAULT_ACCESS_ENVIRONMENT =
  "stage";

const DEFAULT_STAGE_BASE_URL =
  "https://api-stage.accessdevelopment.com";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://api.accessdevelopment.com";

/*
 * IMPORTANT:
 *
 * We know your Stage Offers base URL is:
 *
 * https://api-stage.accessdevelopment.com
 *
 * We DO NOT hard-code a guessed private endpoint path.
 *
 * Configure ACCESS_OFFERS_ENDPOINT_PATH in Vercel once the approved
 * Access endpoint path is confirmed.
 *
 * Example ONLY if Access documentation specifically says it is correct:
 *
 * ACCESS_OFFERS_ENDPOINT_PATH=/offers
 */

const DEFAULT_OFFERS_ENDPOINT_PATH =
  "";

/* ==========================================================================
   PROGRAM
============================================================================ */

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER =
  "2002479";

const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER =
  "200783";

/* ==========================================================================
   PAGINATION
============================================================================ */

const DEFAULT_PAGE_SIZE =
  100;

const MAX_PAGE_SIZE =
  500;

const DEFAULT_MAX_PAGES =
  100;

const DEFAULT_REQUEST_TIMEOUT_MS =
  25000;

/* ==========================================================================
   GENERAL HELPERS
============================================================================ */

function normalizeString(value) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(value) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeLower(value) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeUpper(value) {
  return normalizeString(
    value
  ).toUpperCase();
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (
    typeof value ===
    "boolean"
  ) {
    return value;
  }

  if (
    typeof value ===
    "number"
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
    ].includes(
      normalized
    )
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
    ].includes(
      normalized
    )
  ) {
    return false;
  }

  return fallback;
}

function normalizeNumber(
  value,
  fallback = 0
) {
  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
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

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}

function positiveInteger(
  value,
  fallback
) {
  const parsed =
    normalizeInteger(
      value,
      fallback
    );

  return parsed > 0
    ? parsed
    : fallback;
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    Math.max(
      value,
      minimum
    ),
    maximum
  );
}

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value ===
      "object" &&
    !Array.isArray(
      value
    )
  );
}

function firstNonEmpty(
  ...values
) {
  for (
    const value
    of values
  ) {
    if (
      value !== undefined &&
      value !== null &&
      normalizeString(
        value
      )
    ) {
      return value;
    }
  }

  return "";
}

function firstArray(
  ...values
) {
  for (
    const value
    of values
  ) {
    if (
      Array.isArray(
        value
      )
    ) {
      return value;
    }
  }

  return [];
}

function uniqueStrings(
  values = []
) {
  return Array.from(
    new Set(
      values
        .map(
          normalizeString
        )
        .filter(Boolean)
    )
  );
}

function cleanBaseUrl(
  value
) {
  return normalizeString(
    value
  ).replace(
    /\/+$/,
    ""
  );
}

function normalizePath(
  value
) {
  const clean =
    normalizeString(
      value
    );

  if (
    !clean ||
    clean === "/" ||
    normalizeLower(
      clean
    ) === "root" ||
    normalizeLower(
      clean
    ) === "base"
  ) {
    return "";
  }

  return clean.startsWith("/")
    ? clean
    : `/${clean}`;
}

function safeJsonStringify(
  value
) {
  try {
    return JSON.stringify(
      value
    );
  } catch {
    return "";
  }
}

function safeDate(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function centsToDollars(
  value
) {
  const cents =
    normalizeNumber(
      value,
      0
    );

  return Number(
    (
      cents / 100
    ).toFixed(2)
  );
}

/* ==========================================================================
   ENV
============================================================================ */

function getEnv(
  name,
  fallback = ""
) {
  return normalizeString(
    process.env[name] ??
    fallback
  );
}

/* ==========================================================================
   ENVIRONMENT
============================================================================ */

function getAccessOffersEnvironment() {
  const environment =
    normalizeLower(
      getEnv(
        "ACCESS_ENVIRONMENT",
        DEFAULT_ACCESS_ENVIRONMENT
      )
    );

  if (
    [
      "production",
      "prod",
      "live",
    ].includes(
      environment
    )
  ) {
    return "production";
  }

  return "stage";
}

function isAccessOffersProduction() {
  return (
    getAccessOffersEnvironment() ===
    "production"
  );
}

function isAccessOffersStage() {
  return !isAccessOffersProduction();
}

/* ==========================================================================
   BASE URL
============================================================================ */

function getAccessOffersBaseUrl() {
  const configured =
    getEnv(
      "ACCESS_OFFERS_API_BASE_URL"
    ) ||
    getEnv(
      "ACCESS_OFFERS_BASE_URL"
    );

  if (configured) {
    return cleanBaseUrl(
      configured
    );
  }

  return isAccessOffersProduction()
    ? DEFAULT_PRODUCTION_BASE_URL
    : DEFAULT_STAGE_BASE_URL;
}

/* ==========================================================================
   TOKEN
============================================================================ */

function getAccessOffersToken() {
  return (
    getEnv(
      "ACCESS_OFFERS_API_TOKEN"
    ) ||
    getEnv(
      "ACCESS_API_TOKEN"
    ) ||
    getEnv(
      "ACCESS_CURRENT_ACCESS_TOKEN"
    ) ||
    getEnv(
      "ACCESS_AMT_API_TOKEN"
    )
  );
}

function hasAccessOffersToken() {
  return Boolean(
    getAccessOffersToken()
  );
}

/* ==========================================================================
   ORGANIZATION / PROGRAM
============================================================================ */

function getOrganizationCustomerIdentifier() {
  return (
    getEnv(
      "ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER"
    ) ||
    getEnv(
      "ACCESS_ORGANIZATION_ID"
    ) ||
    DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER
  );
}

function getProgramCustomerIdentifier() {
  return (
    getEnv(
      "ACCESS_PROGRAM_CUSTOMER_IDENTIFIER"
    ) ||
    getEnv(
      "ACCESS_PROGRAM_ID"
    ) ||
    DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER
  );
}

/* ==========================================================================
   OFFERS ENDPOINT
============================================================================ */

function getAccessOffersEndpointPath() {
  const configured =
    getEnv(
      "ACCESS_OFFERS_ENDPOINT_PATH"
    );

  if (configured) {
    return normalizePath(
      configured
    );
  }

  return DEFAULT_OFFERS_ENDPOINT_PATH;
}

function getAccessOffersUrl() {
  return `${getAccessOffersBaseUrl()}${getAccessOffersEndpointPath()}`;
}

/* ==========================================================================
   OPTIONAL DETAIL ENDPOINT TEMPLATE

   Example pattern after Access confirms:

   /offers/{offerId}

   Configure:

   ACCESS_OFFERS_DETAIL_PATH_TEMPLATE=/offers/{offerId}

============================================================================ */

function getAccessOfferDetailPathTemplate() {
  return normalizeString(
    getEnv(
      "ACCESS_OFFERS_DETAIL_PATH_TEMPLATE"
    )
  );
}

function buildAccessOfferDetailPath(
  offerId
) {
  const id =
    normalizeString(
      offerId
    );

  if (!id) {
    throw new Error(
      "An Access offer ID is required."
    );
  }

  const template =
    getAccessOfferDetailPathTemplate();

  if (!template) {
    return "";
  }

  return normalizePath(
    template.replace(
      /\{offerId\}/g,
      encodeURIComponent(
        id
      )
    )
  );
}

/* ==========================================================================
   PAGINATION CONFIG
============================================================================ */

function getAccessOffersDefaultPageSize() {
  return clamp(
    positiveInteger(
      getEnv(
        "ACCESS_OFFERS_PAGE_SIZE"
      ),
      DEFAULT_PAGE_SIZE
    ),
    1,
    MAX_PAGE_SIZE
  );
}

function getAccessOffersMaxPages() {
  return clamp(
    positiveInteger(
      getEnv(
        "ACCESS_OFFERS_MAX_PAGES"
      ),
      DEFAULT_MAX_PAGES
    ),
    1,
    1000
  );
}

/* ==========================================================================
   PAGINATION PARAMETER NAMES

   Different APIs may use:
   page
   page_number
   offset
   cursor
   page_size
   limit

   We keep these configurable rather than guessing the private Access schema.
============================================================================ */

function getPageParameterName() {
  return (
    getEnv(
      "ACCESS_OFFERS_PAGE_PARAM"
    ) ||
    "page"
  );
}

function getPageSizeParameterName() {
  return (
    getEnv(
      "ACCESS_OFFERS_PAGE_SIZE_PARAM"
    ) ||
    "page_size"
  );
}

function getCursorParameterName() {
  return (
    getEnv(
      "ACCESS_OFFERS_CURSOR_PARAM"
    ) ||
    "cursor"
  );
}

/* ==========================================================================
   AUTH HEADER MODE
============================================================================ */

function getAccessOffersAuthMode() {
  return normalizeLower(
    getEnv(
      "ACCESS_OFFERS_AUTH_MODE",
      "both"
    )
  );
}

function getAccessOffersHeaders(
  token,
  extraHeaders = {}
) {
  const cleanToken =
    normalizeString(
      token
    );

  if (!cleanToken) {
    const error =
      new Error(
        "Missing Access Offers API token. Add ACCESS_OFFERS_API_TOKEN in Vercel."
      );

    error.code =
      "ACCESS_OFFERS_TOKEN_MISSING";

    throw error;
  }

  const mode =
    getAccessOffersAuthMode();

  const headers = {
    Accept:
      "application/json",

    "Content-Type":
      "application/json",
  };

  /*
   * Configurable because private Access credentials may require
   * one or both header formats.
   */

  if (
    mode === "bearer" ||
    mode === "both"
  ) {
    headers.Authorization =
      `Bearer ${cleanToken}`;
  }

  if (
    mode === "access-token" ||
    mode === "x-access-token" ||
    mode === "both"
  ) {
    headers["X-Access-Token"] =
      cleanToken;
  }

  return {
    ...headers,
    ...extraHeaders,
  };
}

/* ==========================================================================
   RESPONSE PARSER
============================================================================ */

async function parseAccessOffersResponse(
  response
) {
  const text =
    await response
      .text()
      .catch(
        () => ""
      );

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(
      text
    );
  } catch {
    return {
      raw:
        text,
    };
  }
}

/* ==========================================================================
   ERROR MESSAGE
============================================================================ */

function getAccessOffersErrorMessage(
  data,
  status
) {
  const direct =
    firstNonEmpty(
      data?.message,
      data?.error,
      data?.error_description,
      data?.detail,
      data?.details
    );

  if (
    typeof direct ===
      "string" &&
    normalizeString(
      direct
    )
  ) {
    return normalizeString(
      direct
    );
  }

  if (
    typeof data?.error?.message ===
      "string"
  ) {
    return normalizeString(
      data.error.message
    );
  }

  if (
    Array.isArray(
      data?.errors
    ) &&
    data.errors.length
  ) {
    const first =
      data.errors[0];

    if (
      typeof first ===
      "string"
    ) {
      return first;
    }

    if (
      typeof first?.message ===
      "string"
    ) {
      return first.message;
    }
  }

  return (
    `Access Offers API request failed with status ${status}.`
  );
}

/* ==========================================================================
   URL BUILDER
============================================================================ */

function buildAccessOffersRequestUrl(
  path = "",
  query = {}
) {
  const base =
    getAccessOffersBaseUrl();

  const endpoint =
    normalizePath(
      path
    );

  const url =
    new URL(
      `${base}${endpoint}`
    );

  for (
    const [
      key,
      value,
    ] of Object.entries(
      query || {}
    )
  ) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (
      Array.isArray(
        value
      )
    ) {
      for (
        const item
        of value
      ) {
        if (
          item !== undefined &&
          item !== null &&
          normalizeString(
            item
          )
        ) {
          url.searchParams.append(
            key,
            String(item)
          );
        }
      }

      continue;
    }

    url.searchParams.set(
      key,
      String(value)
    );
  }

  return url.toString();
}

/* ==========================================================================
   REQUEST
============================================================================ */

async function accessOffersRequest(
  path,
  options = {}
) {
  const token =
    normalizeString(
      options.token
    ) ||
    getAccessOffersToken();

  const method =
    normalizeUpper(
      options.method ||
      "GET"
    );

  const timeoutMs =
    positiveInteger(
      options.timeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );

  const url =
    options.url
      ? normalizeString(
          options.url
        )
      : buildAccessOffersRequestUrl(
          path,
          options.query ||
          {}
        );

  if (!url) {
    const error =
      new Error(
        "Access Offers request URL is missing."
      );

    error.code =
      "ACCESS_OFFERS_URL_MISSING";

    throw error;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      timeoutMs
    );

  try {
    const fetchOptions = {
      method,

      headers:
        getAccessOffersHeaders(
          token,
          options.headers ||
          {}
        ),

      signal:
        controller.signal,
    };

    if (
      options.body !== undefined &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      fetchOptions.body =
        typeof options.body ===
        "string"
          ? options.body
          : JSON.stringify(
              options.body
            );
    }

    const response =
      await fetch(
        url,
        fetchOptions
      );

    const data =
      await parseAccessOffersResponse(
        response
      );

    if (!response.ok) {
      const error =
        new Error(
          getAccessOffersErrorMessage(
            data,
            response.status
          )
        );

      error.name =
        "AccessOffersError";

      error.code =
        "ACCESS_OFFERS_REQUEST_FAILED";

      error.status =
        response.status;

      error.statusText =
        response.statusText;

      error.url =
        url;

      error.response =
        data;

      throw error;
    }

    return {
      success:
        true,

      ok:
        true,

      status:
        response.status,

      statusText:
        response.statusText,

      url,

      response:
        data,

      headers: {
        contentType:
          response.headers.get(
            "content-type"
          ),

        link:
          response.headers.get(
            "link"
          ),
      },
    };
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          "Access Offers API request timed out."
        );

      timeoutError.name =
        "AccessOffersTimeoutError";

      timeoutError.code =
        "ACCESS_OFFERS_TIMEOUT";

      timeoutError.status =
        504;

      timeoutError.url =
        url;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

/* ==========================================================================
   RAW DATA EXTRACTION
============================================================================ */

function unwrapAccessResponse(
  result
) {
  if (
    isObject(
      result?.response
    )
  ) {
    return result.response;
  }

  if (
    isObject(
      result
    )
  ) {
    return result;
  }

  return {};
}

function extractOfferRows(
  result
) {
  const data =
    unwrapAccessResponse(
      result
    );

  return firstArray(
    data.offers,
    data.results,
    data.items,
    data.data?.offers,
    data.data?.results,
    data.data?.items,
    data.data,
    data.records,
    data.response?.offers,
    data.response?.results,
    data.response?.items
  );
}

/* ==========================================================================
   PAGINATION METADATA
============================================================================ */

function extractPaginationMeta(
  result
) {
  const data =
    unwrapAccessResponse(
      result
    );

  const pagination =
    isObject(
      data.pagination
    )
      ? data.pagination
      : isObject(
          data.meta?.pagination
        )
        ? data.meta.pagination
        : {};

  const meta =
    isObject(
      data.meta
    )
      ? data.meta
      : {};

  const nextCursor =
    normalizeString(
      firstNonEmpty(
        pagination.next_cursor,
        pagination.nextCursor,
        meta.next_cursor,
        meta.nextCursor,
        data.next_cursor,
        data.nextCursor,
        data.cursor?.next,
        data.next
      )
    );

  const nextPageRaw =
    firstNonEmpty(
      pagination.next_page,
      pagination.nextPage,
      meta.next_page,
      meta.nextPage,
      data.next_page,
      data.nextPage
    );

  const pageRaw =
    firstNonEmpty(
      pagination.page,
      pagination.current_page,
      pagination.currentPage,
      meta.page,
      data.page
    );

  const totalPagesRaw =
    firstNonEmpty(
      pagination.total_pages,
      pagination.totalPages,
      meta.total_pages,
      meta.totalPages,
      data.total_pages,
      data.totalPages
    );

  const totalRaw =
    firstNonEmpty(
      pagination.total,
      pagination.total_count,
      pagination.totalCount,
      meta.total,
      meta.total_count,
      meta.totalCount,
      data.total,
      data.total_count,
      data.totalCount
    );

  const hasMoreRaw =
    firstNonEmpty(
      pagination.has_more,
      pagination.hasMore,
      meta.has_more,
      meta.hasMore,
      data.has_more,
      data.hasMore
    );

  const nextPage =
    normalizeInteger(
      nextPageRaw,
      0
    );

  const page =
    normalizeInteger(
      pageRaw,
      0
    );

  const totalPages =
    normalizeInteger(
      totalPagesRaw,
      0
    );

  const total =
    normalizeInteger(
      totalRaw,
      0
    );

  const hasMore =
    normalizeBoolean(
      hasMoreRaw,
      Boolean(
        nextCursor ||
        nextPage
      )
    );

  return {
    nextCursor:
      nextCursor ||
      null,

    nextPage:
      nextPage ||
      null,

    page:
      page ||
      null,

    totalPages:
      totalPages ||
      null,

    total:
      total ||
      null,

    hasMore,
  };
}

/* ==========================================================================
   IMAGE NORMALIZATION
============================================================================ */

function normalizeImageUrl(
  value
) {
  if (
    typeof value ===
    "string"
  ) {
    return normalizeString(
      value
    );
  }

  if (
    isObject(
      value
    )
  ) {
    return normalizeString(
      firstNonEmpty(
        value.url,
        value.src,
        value.href,
        value.image_url,
        value.imageUrl
      )
    );
  }

  return "";
}

function extractImageUrls(
  source = {}
) {
  const candidates = [
    source.image,
    source.image_url,
    source.imageUrl,
    source.logo,
    source.logo_url,
    source.logoUrl,
    source.thumbnail,
    source.thumbnail_url,
    source.thumbnailUrl,
    source.hero_image,
    source.heroImage,
  ];

  if (
    Array.isArray(
      source.images
    )
  ) {
    candidates.push(
      ...source.images
    );
  }

  return uniqueStrings(
    candidates
      .map(
        normalizeImageUrl
      )
      .filter(Boolean)
  );
}

/* ==========================================================================
   LOCATION NORMALIZATION
============================================================================ */

function normalizeAccessLocation(
  location = {}
) {
  if (
    !isObject(
      location
    )
  ) {
    return null;
  }

  const latitude =
    normalizeNumber(
      firstNonEmpty(
        location.latitude,
        location.lat
      ),
      NaN
    );

  const longitude =
    normalizeNumber(
      firstNonEmpty(
        location.longitude,
        location.lng,
        location.lon
      ),
      NaN
    );

  const address1 =
    normalizeString(
      firstNonEmpty(
        location.address1,
        location.address_1,
        location.addressLine1,
        location.street,
        location.street_address
      )
    );

  const address2 =
    normalizeString(
      firstNonEmpty(
        location.address2,
        location.address_2,
        location.addressLine2
      )
    );

  const city =
    normalizeString(
      location.city
    );

  const state =
    normalizeString(
      firstNonEmpty(
        location.state,
        location.region,
        location.province
      )
    );

  const postalCode =
    normalizeString(
      firstNonEmpty(
        location.postal_code,
        location.postalCode,
        location.zip,
        location.zip_code
      )
    );

  const country =
    normalizeString(
      firstNonEmpty(
        location.country,
        location.country_code,
        location.countryCode
      )
    );

  return {
    id:
      normalizeString(
        firstNonEmpty(
          location.id,
          location.location_id,
          location.locationId,
          location.token
        )
      ) ||
      null,

    name:
      normalizeString(
        firstNonEmpty(
          location.name,
          location.location_name,
          location.locationName
        )
      ) ||
      null,

    address1:
      address1 ||
      null,

    address2:
      address2 ||
      null,

    city:
      city ||
      null,

    state:
      state ||
      null,

    postalCode:
      postalCode ||
      null,

    country:
      country ||
      null,

    latitude:
      Number.isFinite(
        latitude
      )
        ? latitude
        : null,

    longitude:
      Number.isFinite(
        longitude
      )
        ? longitude
        : null,

    phone:
      normalizeString(
        firstNonEmpty(
          location.phone,
          location.phone_number,
          location.phoneNumber
        )
      ) ||
      null,

    website:
      normalizeString(
        firstNonEmpty(
          location.website,
          location.url,
          location.website_url,
          location.websiteUrl
        )
      ) ||
      null,

    distance:
      normalizeNumber(
        firstNonEmpty(
          location.distance,
          location.distance_miles,
          location.distanceMiles
        ),
        0
      ) ||
      null,
  };
}

/* ==========================================================================
   MERCHANT NORMALIZATION
============================================================================ */

function normalizeAccessMerchant(
  merchant = {}
) {
  if (
    typeof merchant ===
    "string"
  ) {
    return {
      id:
        null,

      name:
        normalizeString(
          merchant
        ),

      description:
        null,

      website:
        null,

      logo:
        null,

      images:
        [],

      locations:
        [],
    };
  }

  if (
    !isObject(
      merchant
    )
  ) {
    return {
      id:
        null,

      name:
        "",

      description:
        null,

      website:
        null,

      logo:
        null,

      images:
        [],

      locations:
        [],
    };
  }

  const locations =
    firstArray(
      merchant.locations,
      merchant.location_list,
      merchant.locationList
    )
      .map(
        normalizeAccessLocation
      )
      .filter(Boolean);

  const images =
    extractImageUrls(
      merchant
    );

  return {
    id:
      normalizeString(
        firstNonEmpty(
          merchant.id,
          merchant.merchant_id,
          merchant.merchantId,
          merchant.token
        )
      ) ||
      null,

    name:
      normalizeString(
        firstNonEmpty(
          merchant.name,
          merchant.merchant_name,
          merchant.merchantName,
          merchant.title
        )
      ),

    description:
      normalizeString(
        firstNonEmpty(
          merchant.description,
          merchant.summary
        )
      ) ||
      null,

    website:
      normalizeString(
        firstNonEmpty(
          merchant.website,
          merchant.url,
          merchant.website_url,
          merchant.websiteUrl
        )
      ) ||
      null,

    logo:
      normalizeImageUrl(
        firstNonEmpty(
          merchant.logo,
          merchant.logo_url,
          merchant.logoUrl,
          images[0]
        )
      ) ||
      null,

    images,

    locations,
  };
}

/* ==========================================================================
   CATEGORY NORMALIZATION
============================================================================ */

function normalizeCategory(
  category
) {
  if (
    typeof category ===
    "string"
  ) {
    return {
      id:
        null,

      name:
        normalizeString(
          category
        ),

      slug:
        normalizeLower(
          category
        )
          .replace(
            /[^a-z0-9]+/g,
            "-"
          )
          .replace(
            /^-+|-+$/g,
            ""
          ),
    };
  }

  if (
    !isObject(
      category
    )
  ) {
    return null;
  }

  const name =
    normalizeString(
      firstNonEmpty(
        category.name,
        category.title,
        category.label,
        category.category_name,
        category.categoryName
      )
    );

  return {
    id:
      normalizeString(
        firstNonEmpty(
          category.id,
          category.category_id,
          category.categoryId,
          category.token
        )
      ) ||
      null,

    name,

    slug:
      normalizeString(
        category.slug
      ) ||
      normalizeLower(
        name
      )
        .replace(
          /[^a-z0-9]+/g,
          "-"
        )
        .replace(
          /^-+|-+$/g,
          ""
        ),
  };
}

/* ==========================================================================
   REDEMPTION NORMALIZATION
============================================================================ */

function normalizeRedemption(
  offer = {}
) {
  const redemption =
    isObject(
      offer.redemption
    )
      ? offer.redemption
      : {};

  const redemptionTypes =
    uniqueStrings(
      firstArray(
        offer.redemption_types,
        offer.redemptionTypes,
        redemption.types,
        redemption.redemption_types
      )
    );

  const onlineUrl =
    normalizeString(
      firstNonEmpty(
        redemption.url,
        redemption.online_url,
        redemption.onlineUrl,
        offer.redemption_url,
        offer.redemptionUrl,
        offer.claim_url,
        offer.claimUrl
      )
    );

  const code =
    normalizeString(
      firstNonEmpty(
        redemption.code,
        redemption.promo_code,
        redemption.promoCode,
        offer.redemption_code,
        offer.redemptionCode,
        offer.promo_code,
        offer.promoCode
      )
    );

  const barcode =
    normalizeString(
      firstNonEmpty(
        redemption.barcode,
        redemption.barcode_value,
        redemption.barcodeValue,
        offer.barcode,
        offer.barcode_value,
        offer.barcodeValue
      )
    );

  const qrCode =
    normalizeString(
      firstNonEmpty(
        redemption.qr_code,
        redemption.qrCode,
        redemption.qr_code_url,
        redemption.qrCodeUrl,
        offer.qr_code,
        offer.qrCode,
        offer.qr_code_url,
        offer.qrCodeUrl
      )
    );

  const instructions =
    normalizeString(
      firstNonEmpty(
        redemption.instructions,
        offer.redemption_instructions,
        offer.redemptionInstructions,
        offer.instructions
      )
    );

  /*
   * IMPORTANT:
   *
   * Presence of catalog redemption metadata does NOT automatically mean
   * we should expose it without a member-specific redemption operation.
   *
   * Step #18 handles actual secure redemption.
   */

  return {
    types:
      redemptionTypes,

    onlineUrl:
      onlineUrl ||
      null,

    code:
      code ||
      null,

    barcode:
      barcode ||
      null,

    qrCode:
      qrCode ||
      null,

    instructions:
      instructions ||
      null,

    requiresClaim:
      normalizeBoolean(
        firstNonEmpty(
          redemption.requires_claim,
          redemption.requiresClaim,
          offer.requires_claim,
          offer.requiresClaim
        ),
        false
      ),

    redeemable:
      Boolean(
        onlineUrl ||
        code ||
        barcode ||
        qrCode ||
        redemptionTypes.length
      ),
  };
}

/* ==========================================================================
   OFFER NORMALIZATION
============================================================================ */

function normalizeAccessOffer(
  offer = {},
  index = 0
) {
  if (
    !isObject(
      offer
    )
  ) {
    return null;
  }

  const merchantSource =
    isObject(
      offer.merchant
    )
      ? offer.merchant
      : {
          id:
            firstNonEmpty(
              offer.merchant_id,
              offer.merchantId
            ),

          name:
            firstNonEmpty(
              offer.merchant_name,
              offer.merchantName,
              offer.business_name,
              offer.businessName
            ),

          logo:
            firstNonEmpty(
              offer.merchant_logo,
              offer.merchantLogo
            ),
        };

  const merchant =
    normalizeAccessMerchant(
      merchantSource
    );

  const locations =
    firstArray(
      offer.locations,
      offer.location_list,
      offer.locationList
    )
      .map(
        normalizeAccessLocation
      )
      .filter(Boolean);

  if (
    !locations.length &&
    merchant.locations.length
  ) {
    locations.push(
      ...merchant.locations
    );
  }

  const rawCategories =
    firstArray(
      offer.categories,
      offer.category_list,
      offer.categoryList
    );

  if (
    !rawCategories.length &&
    offer.category
  ) {
    rawCategories.push(
      offer.category
    );
  }

  const categories =
    rawCategories
      .map(
        normalizeCategory
      )
      .filter(
        (
          category
        ) =>
          category?.name
      );

  const images =
    uniqueStrings([
      ...extractImageUrls(
        offer
      ),
      ...merchant.images,
    ]);

  const redemption =
    normalizeRedemption(
      offer
    );

  const offerId =
    normalizeString(
      firstNonEmpty(
        offer.id,
        offer.offer_id,
        offer.offerId,
        offer.token,
        offer.offer_token,
        offer.offerToken
      )
    );

  const title =
    normalizeString(
      firstNonEmpty(
        offer.title,
        offer.name,
        offer.offer_title,
        offer.offerTitle,
        offer.headline
      )
    );

  const description =
    normalizeString(
      firstNonEmpty(
        offer.description,
        offer.offer_description,
        offer.offerDescription,
        offer.details,
        offer.summary
      )
    );

  const discountText =
    normalizeString(
      firstNonEmpty(
        offer.discount,
        offer.discount_text,
        offer.discountText,
        offer.savings,
        offer.savings_text,
        offer.savingsText,
        offer.offer_value,
        offer.offerValue
      )
    );

  const terms =
    normalizeString(
      firstNonEmpty(
        offer.terms,
        offer.terms_and_conditions,
        offer.termsAndConditions,
        offer.disclaimer,
        offer.restrictions
      )
    );

  const featured =
    normalizeBoolean(
      firstNonEmpty(
        offer.featured,
        offer.is_featured,
        offer.isFeatured
      ),
      false
    );

  const online =
    normalizeBoolean(
      firstNonEmpty(
        offer.online,
        offer.is_online,
        offer.isOnline,
        offer.online_only,
        offer.onlineOnly
      ),
      Boolean(
        redemption.onlineUrl
      )
    );

  const local =
    normalizeBoolean(
      firstNonEmpty(
        offer.local,
        offer.is_local,
        offer.isLocal
      ),
      locations.length >
        0
    );

  const active =
    ![
      "inactive",
      "expired",
      "disabled",
      "closed",
      "deleted",
    ].includes(
      normalizeLower(
        firstNonEmpty(
          offer.status,
          offer.offer_status,
          offer.offerStatus
        )
      )
    );

  return {
    id:
      offerId ||
      `access-offer-${index + 1}`,

    accessOfferId:
      offerId ||
      null,

    title:
      title ||
      merchant.name ||
      "Member Offer",

    description:
      description ||
      null,

    discountText:
      discountText ||
      null,

    savingsText:
      discountText ||
      null,

    merchant,

    merchantName:
      merchant.name ||
      "",

    categories,

    category:
      categories[0] ||
      null,

    categoryName:
      categories[0]?.name ||
      null,

    locations,

    images,

    image:
      images[0] ||
      merchant.logo ||
      null,

    logo:
      merchant.logo ||
      null,

    featured,

    online,

    local,

    active,

    status:
      normalizeString(
        firstNonEmpty(
          offer.status,
          offer.offer_status,
          offer.offerStatus
        )
      ) ||
      (
        active
          ? "active"
          : "inactive"
      ),

    terms:
      terms ||
      null,

    redemption,

    redeemable:
      redemption.redeemable,

    requiresClaim:
      redemption.requiresClaim,

    startsAt:
      safeDate(
        firstNonEmpty(
          offer.starts_at,
          offer.startsAt,
          offer.start_date,
          offer.startDate
        )
      ),

    expiresAt:
      safeDate(
        firstNonEmpty(
          offer.expires_at,
          offer.expiresAt,
          offer.expiration_date,
          offer.expirationDate,
          offer.end_date,
          offer.endDate
        )
      ),

    createdAt:
      safeDate(
        firstNonEmpty(
          offer.created_at,
          offer.createdAt,
          offer.created
        )
      ),

    updatedAt:
      safeDate(
        firstNonEmpty(
          offer.updated_at,
          offer.updatedAt,
          offer.updated
        )
      ),
  };
}

/* ==========================================================================
   NORMALIZE COLLECTION
============================================================================ */

function normalizeAccessOffers(
  rows = []
) {
  return rows
    .map(
      (
        row,
        index
      ) =>
        normalizeAccessOffer(
          row,
          index
        )
    )
    .filter(Boolean);
}

/* ==========================================================================
   DEDUPLICATE OFFERS
============================================================================ */

function deduplicateOffers(
  offers = []
) {
  const seen =
    new Set();

  const results =
    [];

  for (
    const offer
    of offers
  ) {
    const key =
      normalizeString(
        offer.accessOfferId ||
        offer.id
      ) ||
      [
        normalizeLower(
          offer.merchantName
        ),
        normalizeLower(
          offer.title
        ),
      ].join("|");

    if (
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

    results.push(
      offer
    );
  }

  return results;
}

/* ==========================================================================
   BUILD COMMON QUERY
============================================================================ */

function buildAccessOffersQuery(
  options = {}
) {
  const query = {};

  const organizationId =
    normalizeString(
      options.organizationCustomerIdentifier ||
      getOrganizationCustomerIdentifier()
    );

  const programId =
    normalizeString(
      options.programCustomerIdentifier ||
      getProgramCustomerIdentifier()
    );

  /*
   * Parameter names are configurable.
   */

  const organizationParam =
    getEnv(
      "ACCESS_OFFERS_ORGANIZATION_PARAM",
      "organization_customer_identifier"
    );

  const programParam =
    getEnv(
      "ACCESS_OFFERS_PROGRAM_PARAM",
      "program_customer_identifier"
    );

  if (
    normalizeBoolean(
      getEnv(
        "ACCESS_OFFERS_INCLUDE_ORGANIZATION",
        "true"
      ),
      true
    ) &&
    organizationId
  ) {
    query[
      organizationParam
    ] =
      organizationId;
  }

  if (
    normalizeBoolean(
      getEnv(
        "ACCESS_OFFERS_INCLUDE_PROGRAM",
        "true"
      ),
      true
    ) &&
    programId
  ) {
    query[
      programParam
    ] =
      programId;
  }

  if (
    normalizeString(
      options.search
    )
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_SEARCH_PARAM",
        "search"
      )
    ] =
      normalizeString(
        options.search
      );
  }

  if (
    normalizeString(
      options.category
    )
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_CATEGORY_PARAM",
        "category"
      )
    ] =
      normalizeString(
        options.category
      );
  }

  if (
    Number.isFinite(
      Number(
        options.latitude
      )
    )
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_LATITUDE_PARAM",
        "latitude"
      )
    ] =
      Number(
        options.latitude
      );
  }

  if (
    Number.isFinite(
      Number(
        options.longitude
      )
    )
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_LONGITUDE_PARAM",
        "longitude"
      )
    ] =
      Number(
        options.longitude
      );
  }

  if (
    Number.isFinite(
      Number(
        options.radius
      )
    )
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_RADIUS_PARAM",
        "radius"
      )
    ] =
      Number(
        options.radius
      );
  }

  if (
    options.online !==
    undefined
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_ONLINE_PARAM",
        "online"
      )
    ] =
      normalizeBoolean(
        options.online
      );
  }

  if (
    options.featured !==
    undefined
  ) {
    query[
      getEnv(
        "ACCESS_OFFERS_FEATURED_PARAM",
        "featured"
      )
    ] =
      normalizeBoolean(
        options.featured
      );
  }

  return query;
}

/* ==========================================================================
   FETCH ONE PAGE
============================================================================ */

async function fetchAccessOffersPage(
  options = {}
) {
  const endpoint =
    normalizePath(
      options.path ||
      getAccessOffersEndpointPath()
    );

  if (!endpoint) {
    const error =
      new Error(
        "Access Offers endpoint path has not been configured. Add ACCESS_OFFERS_ENDPOINT_PATH in Vercel using the endpoint approved by Access."
      );

    error.code =
      "ACCESS_OFFERS_ENDPOINT_NOT_CONFIGURED";

    throw error;
  }

  const pageSize =
    clamp(
      positiveInteger(
        options.pageSize,
        getAccessOffersDefaultPageSize()
      ),
      1,
      MAX_PAGE_SIZE
    );

  const query =
    buildAccessOffersQuery(
      options
    );

  if (
    options.cursor
  ) {
    query[
      getCursorParameterName()
    ] =
      options.cursor;
  } else {
    query[
      getPageParameterName()
    ] =
      positiveInteger(
        options.page,
        1
      );
  }

  query[
    getPageSizeParameterName()
  ] =
    pageSize;

  const result =
    await accessOffersRequest(
      endpoint,
      {
        method:
          "GET",

        query,

        timeoutMs:
          options.timeoutMs,
      }
    );

  const rows =
    extractOfferRows(
      result
    );

  const offers =
    normalizeAccessOffers(
      rows
    );

  const pagination =
    extractPaginationMeta(
      result
    );

  return {
    success:
      true,

    ok:
      true,

    offers,

    rawCount:
      rows.length,

    count:
      offers.length,

    pagination,

    request: {
      page:
        options.page ||
        1,

      pageSize,

      cursor:
        options.cursor ||
        null,
    },
  };
}

/* ==========================================================================
   FETCH FULL CATALOG

   This solves the "only 32 benefits" issue.

   We keep fetching until:
   - Access says there is no next cursor/page
   - a page is empty
   - fewer than pageSize results arrive
   - maxPages safety limit is reached

============================================================================ */

async function fetchAllAccessOffers(
  options = {}
) {
  const pageSize =
    clamp(
      positiveInteger(
        options.pageSize,
        getAccessOffersDefaultPageSize()
      ),
      1,
      MAX_PAGE_SIZE
    );

  const maxPages =
    clamp(
      positiveInteger(
        options.maxPages,
        getAccessOffersMaxPages()
      ),
      1,
      1000
    );

  let page =
    positiveInteger(
      options.startPage,
      1
    );

  let cursor =
    normalizeString(
      options.cursor
    );

  let pagesFetched =
    0;

  let allOffers =
    [];

  let lastPagination =
    null;

  const seenCursors =
    new Set();

  const seenPages =
    new Set();

  while (
    pagesFetched <
    maxPages
  ) {
    const result =
      await fetchAccessOffersPage({
        ...options,

        page,

        cursor:
          cursor ||
          undefined,

        pageSize,
      });

    pagesFetched +=
      1;

    allOffers.push(
      ...result.offers
    );

    lastPagination =
      result.pagination;

    /*
     * Empty result = stop.
     */

    if (
      result.rawCount ===
      0
    ) {
      break;
    }

    /*
     * Cursor pagination.
     */

    if (
      result
        .pagination
        .nextCursor
    ) {
      const nextCursor =
        result
          .pagination
          .nextCursor;

      if (
        seenCursors.has(
          nextCursor
        )
      ) {
        break;
      }

      seenCursors.add(
        nextCursor
      );

      cursor =
        nextCursor;

      continue;
    }

    /*
     * Explicit next page.
     */

    if (
      result
        .pagination
        .nextPage
    ) {
      const nextPage =
        result
          .pagination
          .nextPage;

      if (
        seenPages.has(
          nextPage
        )
      ) {
        break;
      }

      seenPages.add(
        nextPage
      );

      page =
        nextPage;

      cursor =
        "";

      continue;
    }

    /*
     * Total-pages metadata.
     */

    if (
      result
        .pagination
        .totalPages &&
      result
        .pagination
        .page
    ) {
      if (
        result
          .pagination
          .page >=
        result
          .pagination
          .totalPages
      ) {
        break;
      }

      page =
        result
          .pagination
          .page +
        1;

      cursor =
        "";

      continue;
    }

    /*
     * Explicit hasMore false.
     */

    if (
      result
        .pagination
        .hasMore ===
      false
    ) {
      break;
    }

    /*
     * Common page-number behavior:
     * final page has fewer than pageSize items.
     */

    if (
      result.rawCount <
      pageSize
    ) {
      break;
    }

    page +=
      1;

    cursor =
      "";
  }

  allOffers =
    deduplicateOffers(
      allOffers
    );

  return {
    success:
      true,

    ok:
      true,

    offers:
      allOffers,

    count:
      allOffers.length,

    pagesFetched,

    pageSize,

    hitSafetyLimit:
      pagesFetched >=
      maxPages,

    pagination:
      lastPagination,
  };
}

/* ==========================================================================
   OFFER DETAIL
============================================================================ */

async function fetchAccessOfferById(
  offerId,
  options = {}
) {
  const path =
    normalizePath(
      options.path ||
      buildAccessOfferDetailPath(
        offerId
      )
    );

  if (!path) {
    const error =
      new Error(
        "Access offer-detail endpoint template has not been configured."
      );

    error.code =
      "ACCESS_OFFER_DETAIL_ENDPOINT_NOT_CONFIGURED";

    throw error;
  }

  const query =
    buildAccessOffersQuery(
      options
    );

  const result =
    await accessOffersRequest(
      path,
      {
        method:
          "GET",

        query,

        timeoutMs:
          options.timeoutMs,
      }
    );

  const data =
    unwrapAccessResponse(
      result
    );

  const rawOffer =
    isObject(
      data.offer
    )
      ? data.offer
      : isObject(
          data.data?.offer
        )
        ? data.data.offer
        : isObject(
            data.data
          )
          ? data.data
          : data;

  return {
    success:
      true,

    ok:
      true,

    offer:
      normalizeAccessOffer(
        rawOffer,
        0
      ),
  };
}

/* ==========================================================================
   CLIENT-SIDE CATALOG FILTERING

   Useful after full catalog is loaded server-side.
============================================================================ */

function filterAccessOffers(
  offers = [],
  options = {}
) {
  let results =
    Array.isArray(
      offers
    )
      ? [
          ...offers,
        ]
      : [];

  const search =
    normalizeLower(
      options.search
    );

  if (search) {
    results =
      results.filter(
        (
          offer
        ) => {
          const haystack =
            [
              offer.title,
              offer.description,
              offer.discountText,
              offer.merchantName,
              offer.categoryName,
              ...(offer.categories || [])
                .map(
                  (
                    category
                  ) =>
                    category.name
                ),
              ...(offer.locations || [])
                .flatMap(
                  (
                    location
                  ) => [
                    location.name,
                    location.city,
                    location.state,
                    location.postalCode,
                  ]
                ),
            ]
              .map(
                normalizeLower
              )
              .join(" ");

          return haystack.includes(
            search
          );
        }
      );
  }

  if (
    normalizeString(
      options.category
    )
  ) {
    const category =
      normalizeLower(
        options.category
      );

    results =
      results.filter(
        (
          offer
        ) =>
          (
            offer.categories ||
            []
          ).some(
            (
              item
            ) =>
              normalizeLower(
                item.name
              ) ===
                category ||
              normalizeLower(
                item.slug
              ) ===
                category
          )
      );
  }

  if (
    options.online !==
    undefined
  ) {
    const online =
      normalizeBoolean(
        options.online
      );

    results =
      results.filter(
        (
          offer
        ) =>
          Boolean(
            offer.online
          ) ===
          online
      );
  }

  if (
    options.local !==
    undefined
  ) {
    const local =
      normalizeBoolean(
        options.local
      );

    results =
      results.filter(
        (
          offer
        ) =>
          Boolean(
            offer.local
          ) ===
          local
      );
  }

  if (
    options.featured !==
    undefined
  ) {
    const featured =
      normalizeBoolean(
        options.featured
      );

    results =
      results.filter(
        (
          offer
        ) =>
          Boolean(
            offer.featured
          ) ===
          featured
      );
  }

  if (
    options.active !==
    undefined
  ) {
    const active =
      normalizeBoolean(
        options.active,
        true
      );

    results =
      results.filter(
        (
          offer
        ) =>
          Boolean(
            offer.active
          ) ===
          active
      );
  }

  return results;
}

/* ==========================================================================
   CATEGORY LIST
============================================================================ */

function buildAccessOfferCategories(
  offers = []
) {
  const map =
    new Map();

  for (
    const offer
    of offers
  ) {
    for (
      const category
      of (
        offer.categories ||
        []
      )
    ) {
      const key =
        normalizeString(
          category.id ||
          category.slug ||
          category.name
        );

      if (!key) {
        continue;
      }

      if (
        !map.has(
          key
        )
      ) {
        map.set(
          key,
          {
            ...category,

            count:
              0,
          }
        );
      }

      map.get(
        key
      ).count +=
        1;
    }
  }

  return Array.from(
    map.values()
  ).sort(
    (
      a,
      b
    ) =>
      a.name.localeCompare(
        b.name
      )
  );
}

/* ==========================================================================
   MERCHANT LIST
============================================================================ */

function buildAccessMerchants(
  offers = []
) {
  const map =
    new Map();

  for (
    const offer
    of offers
  ) {
    const merchant =
      offer.merchant;

    if (
      !merchant?.name
    ) {
      continue;
    }

    const key =
      normalizeString(
        merchant.id
      ) ||
      normalizeLower(
        merchant.name
      );

    if (
      !map.has(
        key
      )
    ) {
      map.set(
        key,
        {
          ...merchant,

          offerCount:
            0,
        }
      );
    }

    map.get(
      key
    ).offerCount +=
      1;
  }

  return Array.from(
    map.values()
  );
}

/* ==========================================================================
   SAFE OFFER FOR MEMBER PORTAL

   We expose catalog metadata, but Step #18 remains responsible for
   member-specific redemption behavior.
============================================================================ */

function sanitizeAccessOfferForPortal(
  offer
) {
  if (!offer) {
    return null;
  }

  return {
    id:
      offer.id,

    accessOfferId:
      offer.accessOfferId,

    title:
      offer.title,

    description:
      offer.description,

    discountText:
      offer.discountText,

    savingsText:
      offer.savingsText,

    merchantName:
      offer.merchantName,

    merchant:
      offer.merchant,

    category:
      offer.category,

    categories:
      offer.categories,

    locations:
      offer.locations,

    image:
      offer.image,

    images:
      offer.images,

    logo:
      offer.logo,

    featured:
      offer.featured,

    online:
      offer.online,

    local:
      offer.local,

    active:
      offer.active,

    status:
      offer.status,

    terms:
      offer.terms,

    /*
     * Keep safe descriptive redemption information.
     *
     * Do NOT generate a fake QR or coupon here.
     */

    redemption: {
      types:
        offer.redemption
          ?.types ||
        [],

      instructions:
        offer.redemption
          ?.instructions ||
        null,

      requiresClaim:
        Boolean(
          offer.requiresClaim
        ),

      hasOnlineUrl:
        Boolean(
          offer.redemption
            ?.onlineUrl
        ),

      hasCode:
        Boolean(
          offer.redemption
            ?.code
        ),

      hasBarcode:
        Boolean(
          offer.redemption
            ?.barcode
        ),

      hasQrCode:
        Boolean(
          offer.redemption
            ?.qrCode
        ),
    },

    redeemable:
      offer.redeemable,

    requiresClaim:
      offer.requiresClaim,

    startsAt:
      offer.startsAt,

    expiresAt:
      offer.expiresAt,

    createdAt:
      offer.createdAt,

    updatedAt:
      offer.updatedAt,
  };
}

/* ==========================================================================
   PORTAL CATALOG
============================================================================ */

function buildPortalAccessCatalog(
  offers = []
) {
  const clean =
    deduplicateOffers(
      offers
    )
      .filter(
        (
          offer
        ) =>
          offer.active !==
          false
      )
      .map(
        sanitizeAccessOfferForPortal
      )
      .filter(Boolean);

  return {
    offers:
      clean,

    count:
      clean.length,

    categories:
      buildAccessOfferCategories(
        clean
      ),

    merchants:
      buildAccessMerchants(
        clean
      ),
  };
}

/* ==========================================================================
   SAFE CONFIG
============================================================================ */

function getAccessOffersConfigForDebug() {
  const endpointPath =
    getAccessOffersEndpointPath();

  return {
    environment:
      getAccessOffersEnvironment(),

    production:
      isAccessOffersProduction(),

    stage:
      isAccessOffersStage(),

    baseUrl:
      getAccessOffersBaseUrl(),

    endpointPath:
      endpointPath ||
      null,

    url:
      endpointPath
        ? getAccessOffersUrl()
        : getAccessOffersBaseUrl(),

    detailPathTemplate:
      getAccessOfferDetailPathTemplate() ||
      null,

    organizationCustomerIdentifier:
      getOrganizationCustomerIdentifier(),

    programCustomerIdentifier:
      getProgramCustomerIdentifier(),

    hasToken:
      hasAccessOffersToken(),

    tokenLength:
      getAccessOffersToken()
        ? getAccessOffersToken()
            .length
        : 0,

    authMode:
      getAccessOffersAuthMode(),

    pageSize:
      getAccessOffersDefaultPageSize(),

    maxPages:
      getAccessOffersMaxPages(),

    pagination: {
      pageParam:
        getPageParameterName(),

      pageSizeParam:
        getPageSizeParameterName(),

      cursorParam:
        getCursorParameterName(),
    },
  };
}

/* ==========================================================================
   CONFIG VALIDATION
============================================================================ */

function validateAccessOffersConfiguration() {
  const errors = {};

  if (
    !getAccessOffersBaseUrl()
  ) {
    errors.baseUrl =
      "Access Offers API base URL is missing.";
  }

  if (
    !getAccessOffersToken()
  ) {
    errors.token =
      "Access Offers API token is missing.";
  }

  if (
    !getAccessOffersEndpointPath()
  ) {
    errors.endpointPath =
      "ACCESS_OFFERS_ENDPOINT_PATH has not been configured with the approved Access Offers endpoint.";
  }

  if (
    !getOrganizationCustomerIdentifier()
  ) {
    errors.organization =
      "Access organization customer identifier is missing.";
  }

  if (
    !getProgramCustomerIdentifier()
  ) {
    errors.program =
      "Access program customer identifier is missing.";
  }

  return {
    valid:
      Object.keys(
        errors
      ).length ===
      0,

    errors,

    config:
      getAccessOffersConfigForDebug(),
  };
}

/* ==========================================================================
   INTEGRATION STATUS
============================================================================ */

function getAccessOffersIntegrationStatus() {
  const validation =
    validateAccessOffersConfiguration();

  return {
    configured:
      validation.valid,

    environment:
      getAccessOffersEnvironment(),

    hasToken:
      hasAccessOffersToken(),

    hasEndpoint:
      Boolean(
        getAccessOffersEndpointPath()
      ),

    baseUrl:
      getAccessOffersBaseUrl(),

    errors:
      validation.errors,
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* ------------------------------------------------------------
     CONSTANTS
  ------------------------------------------------------------ */

  DEFAULT_ACCESS_ENVIRONMENT,

  DEFAULT_STAGE_BASE_URL,

  DEFAULT_PRODUCTION_BASE_URL,

  DEFAULT_OFFERS_ENDPOINT_PATH,

  DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER,

  DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER,

  DEFAULT_PAGE_SIZE,

  MAX_PAGE_SIZE,

  DEFAULT_MAX_PAGES,

  /* ------------------------------------------------------------
     GENERAL
  ------------------------------------------------------------ */

  normalizeString,

  normalizeEmail,

  normalizeBoolean,

  normalizeNumber,

  centsToDollars,

  safeJsonStringify,

  /* ------------------------------------------------------------
     ENVIRONMENT
  ------------------------------------------------------------ */

  getAccessOffersEnvironment,

  isAccessOffersProduction,

  isAccessOffersStage,

  /* ------------------------------------------------------------
     CONFIG
  ------------------------------------------------------------ */

  getAccessOffersBaseUrl,

  getAccessOffersEndpointPath,

  getAccessOffersUrl,

  getAccessOffersToken,

  hasAccessOffersToken,

  getOrganizationCustomerIdentifier,

  getProgramCustomerIdentifier,

  getAccessOfferDetailPathTemplate,

  buildAccessOfferDetailPath,

  getAccessOffersDefaultPageSize,

  getAccessOffersMaxPages,

  getAccessOffersConfigForDebug,

  validateAccessOffersConfiguration,

  getAccessOffersIntegrationStatus,

  /* ------------------------------------------------------------
     AUTH / REQUESTS
  ------------------------------------------------------------ */

  getAccessOffersHeaders,

  parseAccessOffersResponse,

  buildAccessOffersRequestUrl,

  accessOffersRequest,

  /* ------------------------------------------------------------
     NORMALIZATION
  ------------------------------------------------------------ */

  normalizeAccessLocation,

  normalizeAccessMerchant,

  normalizeCategory,

  normalizeRedemption,

  normalizeAccessOffer,

  normalizeAccessOffers,

  sanitizeAccessOfferForPortal,

  /* ------------------------------------------------------------
     CATALOG
  ------------------------------------------------------------ */

  extractOfferRows,

  extractPaginationMeta,

  deduplicateOffers,

  buildAccessOffersQuery,

  fetchAccessOffersPage,

  fetchAllAccessOffers,

  fetchAccessOfferById,

  filterAccessOffers,

  buildAccessOfferCategories,

  buildAccessMerchants,

  buildPortalAccessCatalog,
};