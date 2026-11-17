// lib/access-offers.js
//
// Card Leo Rewards — Access Offers helper.
//
// Stage:
// https://offer.adcrws-stage.com/v1/offers
//
// Catalog metadata is returned to the portal.
// Actual redemption credentials remain server-side.
//
// Existing requests, configuration options, and exports are preserved.

const DEFAULT_ACCESS_ENVIRONMENT = "stage";
const DEFAULT_STAGE_BASE_URL = "https://offer.adcrws-stage.com";
const DEFAULT_PRODUCTION_BASE_URL = "https://offer.adcrws.com";
const DEFAULT_OFFERS_ENDPOINT_PATH = "/v1/offers";

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER = "2002479";
const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER = "200783";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 25000;

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeUpper(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeLower(value);

  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = normalizeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      normalizeString(value)
    ) {
      return value;
    }
  }

  return "";
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(values.map(normalizeString).filter(Boolean))
  );
}

function cleanBaseUrl(value) {
  return normalizeString(value).replace(/\/+$/, "");
}

function normalizePath(value) {
  const clean = normalizeString(value);

  if (
    !clean ||
    clean === "/" ||
    normalizeLower(clean) === "root" ||
    normalizeLower(clean) === "base"
  ) {
    return "";
  }

  return clean.startsWith("/") ? clean : `/${clean}`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function centsToDollars(value) {
  const cents = normalizeNumber(value, 0);
  return Number((cents / 100).toFixed(2));
}

function getEnv(name, fallback = "") {
  return normalizeString(process.env[name] ?? fallback);
}

// -----------------------------------------------------------------------------
// Environment and configuration
// -----------------------------------------------------------------------------

function getAccessOffersEnvironment() {
  const environment = normalizeLower(
    getEnv("ACCESS_ENVIRONMENT", DEFAULT_ACCESS_ENVIRONMENT)
  );

  if (["production", "prod", "live"].includes(environment)) {
    return "production";
  }

  return "stage";
}

function isAccessOffersProduction() {
  return getAccessOffersEnvironment() === "production";
}

function isAccessOffersStage() {
  return !isAccessOffersProduction();
}

function getAccessOffersBaseUrl() {
  const configured =
    getEnv("ACCESS_OFFERS_API_BASE_URL") ||
    getEnv("ACCESS_OFFERS_BASE_URL");

  if (configured) {
    return cleanBaseUrl(configured);
  }

  return isAccessOffersProduction()
    ? DEFAULT_PRODUCTION_BASE_URL
    : DEFAULT_STAGE_BASE_URL;
}

function getAccessOffersToken() {
  return getEnv("ACCESS_OFFERS_API_TOKEN");
}

function hasAccessOffersToken() {
  return Boolean(getAccessOffersToken());
}

function getOrganizationCustomerIdentifier() {
  return (
    getEnv("ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER") ||
    getEnv("ACCESS_ORGANIZATION_ID") ||
    DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER
  );
}

function getProgramCustomerIdentifier() {
  return (
    getEnv("ACCESS_PROGRAM_CUSTOMER_IDENTIFIER") ||
    getEnv("ACCESS_PROGRAM_ID") ||
    DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER
  );
}

function getAccessOffersEndpointPath() {
  const configured = getEnv("ACCESS_OFFERS_ENDPOINT_PATH");

  if (configured) {
    return normalizePath(configured);
  }

  return DEFAULT_OFFERS_ENDPOINT_PATH;
}

function getAccessOffersUrl() {
  return `${getAccessOffersBaseUrl()}${getAccessOffersEndpointPath()}`;
}

function getAccessOfferDetailPathTemplate() {
  return normalizeString(
    getEnv("ACCESS_OFFERS_DETAIL_PATH_TEMPLATE")
  );
}

function buildAccessOfferDetailPath(offerId) {
  const id = normalizeString(offerId);

  if (!id) {
    throw new Error("An Access offer ID is required.");
  }

  const template = getAccessOfferDetailPathTemplate();

  if (!template) {
    return "";
  }

  return normalizePath(
    template.replace(/\{offerId\}/g, encodeURIComponent(id))
  );
}

function getAccessOffersDefaultPageSize() {
  return clamp(
    positiveInteger(
      getEnv("ACCESS_OFFERS_PAGE_SIZE"),
      DEFAULT_PAGE_SIZE
    ),
    1,
    MAX_PAGE_SIZE
  );
}

function getAccessOffersMaxPages() {
  return clamp(
    positiveInteger(
      getEnv("ACCESS_OFFERS_MAX_PAGES"),
      DEFAULT_MAX_PAGES
    ),
    1,
    1000
  );
}

function getPageParameterName() {
  return getEnv("ACCESS_OFFERS_PAGE_PARAM") || "page";
}

function getPageSizeParameterName() {
  return getEnv("ACCESS_OFFERS_PAGE_SIZE_PARAM") || "per_page";
}

function getCursorParameterName() {
  return getEnv("ACCESS_OFFERS_CURSOR_PARAM") || "cursor";
}

// -----------------------------------------------------------------------------
// Authentication and requests
// -----------------------------------------------------------------------------

function getAccessOffersAuthMode() {
  return normalizeLower(
    getEnv("ACCESS_OFFERS_AUTH_MODE", "query")
  );
}

function getAccessOffersHeaders(token, extraHeaders = {}) {
  const cleanToken = normalizeString(token);

  if (!cleanToken) {
    const error = new Error(
      "Missing Access Offers API token. Add ACCESS_OFFERS_API_TOKEN in Vercel."
    );

    error.code = "ACCESS_OFFERS_TOKEN_MISSING";
    throw error;
  }

  const mode = getAccessOffersAuthMode();

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (mode === "bearer" || mode === "both") {
    headers.Authorization = `Bearer ${cleanToken}`;
  }

  if (
    mode === "access-token" ||
    mode === "x-access-token" ||
    mode === "both"
  ) {
    headers["X-Access-Token"] = cleanToken;
  }

  const mergedHeaders = {
    ...headers,
    ...extraHeaders,
  };

  for (const name of Object.keys(mergedHeaders)) {
    if (
      /^(authorization|x-access-token)$/i.test(name) &&
      !Object.prototype.hasOwnProperty.call(headers, name)
    ) {
      delete mergedHeaders[name];
    }
  }

  if (headers.Authorization) {
    mergedHeaders.Authorization = headers.Authorization;
  }

  if (headers["X-Access-Token"]) {
    mergedHeaders["X-Access-Token"] = headers["X-Access-Token"];
  }

  return mergedHeaders;
}

async function parseAccessOffersResponse(response) {
  const text = await response.text().catch(() => "");

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getAccessOffersErrorMessage(data, status) {
  const direct = firstNonEmpty(
    data?.message,
    data?.error,
    data?.error_description,
    data?.detail,
    data?.details
  );

  if (typeof direct === "string" && normalizeString(direct)) {
    return normalizeString(direct);
  }

  if (typeof data?.error?.message === "string") {
    return normalizeString(data.error.message);
  }

  if (Array.isArray(data?.errors) && data.errors.length) {
    const first = data.errors[0];

    if (typeof first === "string") {
      return first;
    }

    if (typeof first?.message === "string") {
      return first.message;
    }
  }

  return `Access Offers API request failed with status ${status}.`;
}

function buildAccessOffersRequestUrl(path = "", query = {}) {
  const base = getAccessOffersBaseUrl();
  const endpoint = normalizePath(path);
  const url = new URL(`${base}${endpoint}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item !== undefined &&
          item !== null &&
          normalizeString(item)
        ) {
          url.searchParams.append(key, String(item));
        }
      }

      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function accessOffersRequest(path, options = {}) {
  const token =
    normalizeString(options.token) ||
    getAccessOffersToken();

  const method = normalizeUpper(options.method || "GET");

  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS
  );

  const url = options.url
    ? normalizeString(options.url)
    : buildAccessOffersRequestUrl(path, options.query || {});

  const expectedOrigin =
    new URL(getAccessOffersBaseUrl()).origin;

  let parsedRequestUrl;

  try {
    parsedRequestUrl = new URL(url);
  } catch {
    const invalidUrlError = new Error(
      "Invalid Access Offers request URL."
    );

    invalidUrlError.code = "ACCESS_OFFERS_URL_INVALID";
    throw invalidUrlError;
  }

  if (
    parsedRequestUrl.protocol !== "https:" ||
    parsedRequestUrl.origin !== expectedOrigin ||
    parsedRequestUrl.username ||
    parsedRequestUrl.password ||
    parsedRequestUrl.hash
  ) {
    const unsafeUrlError = new Error(
      "Access Offers request URL must use the configured HTTPS host."
    );

    unsafeUrlError.code = "ACCESS_OFFERS_URL_NOT_ALLOWED";
    throw unsafeUrlError;
  }

  parsedRequestUrl.searchParams.set("access_token", token);

  if (!url) {
    const error = new Error(
      "Access Offers request URL is missing."
    );

    error.code = "ACCESS_OFFERS_URL_MISSING";
    throw error;
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const fetchOptions = {
      method,
      headers: getAccessOffersHeaders(
        token,
        options.headers || {}
      ),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    };

    if (
      options.body !== undefined &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      fetchOptions.body =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    }

    const response = await fetch(
      parsedRequestUrl.toString(),
      fetchOptions
    );

    const data = await parseAccessOffersResponse(response);

    if (!response.ok) {
      const error = new Error(
        `Access Offers API request failed with status ${response.status}.`
      );

      error.name = "AccessOffersError";
      error.code = "ACCESS_OFFERS_REQUEST_FAILED";
      error.status = response.status;
      error.statusText = response.statusText;

      error.url =
        parsedRequestUrl.origin +
        parsedRequestUrl.pathname;

      error.response = {
        status: response.status,
        message: "Access Offers request was rejected.",
      };

      throw error;
    }

    return {
      success: true,
      ok: true,
      status: response.status,
      statusText: response.statusText,

      url:
        parsedRequestUrl.origin +
        parsedRequestUrl.pathname,

      response: data,

      headers: {
        contentType: response.headers.get("content-type"),
        link: response.headers.get("link"),
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "Access Offers API request timed out."
      );

      timeoutError.name = "AccessOffersTimeoutError";
      timeoutError.code = "ACCESS_OFFERS_TIMEOUT";
      timeoutError.status = 504;

      timeoutError.url =
        parsedRequestUrl.origin +
        parsedRequestUrl.pathname;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Response extraction and pagination
// -----------------------------------------------------------------------------

function unwrapAccessResponse(result) {
  if (isObject(result?.response)) {
    return result.response;
  }

  if (isObject(result)) {
    return result;
  }

  return {};
}

function extractOfferRows(result) {
  const data = unwrapAccessResponse(result);

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

function extractPaginationMeta(result) {
  const data = unwrapAccessResponse(result);

  const pagination = isObject(data.pagination)
    ? data.pagination
    : isObject(data.meta?.pagination)
      ? data.meta.pagination
      : {};

  const meta = isObject(data.meta) ? data.meta : {};

  const nextCursor = normalizeString(
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

  const nextPageRaw = firstNonEmpty(
    pagination.next_page,
    pagination.nextPage,
    meta.next_page,
    meta.nextPage,
    data.next_page,
    data.nextPage
  );

  const pageRaw = firstNonEmpty(
    pagination.page,
    pagination.current_page,
    pagination.currentPage,
    data.info?.current_page,
    meta.page,
    data.page
  );

  const totalPagesRaw = firstNonEmpty(
    pagination.total_pages,
    pagination.totalPages,
    data.info?.total_pages,
    meta.total_pages,
    meta.totalPages,
    data.total_pages,
    data.totalPages
  );

  const totalRaw = firstNonEmpty(
    pagination.total,
    pagination.total_count,
    pagination.totalCount,
    data.info?.total_results,
    meta.total,
    meta.total_count,
    meta.totalCount,
    data.total,
    data.total_count,
    data.totalCount
  );

  const hasMoreRaw = firstNonEmpty(
    pagination.has_more,
    pagination.hasMore,
    meta.has_more,
    meta.hasMore,
    data.has_more,
    data.hasMore
  );

  const nextPage = normalizeInteger(nextPageRaw, 0);
  const page = normalizeInteger(pageRaw, 0);
  const totalPages = normalizeInteger(totalPagesRaw, 0);
  const total = normalizeInteger(totalRaw, 0);

  const hasMore = normalizeString(hasMoreRaw) !== ""
    ? normalizeBoolean(hasMoreRaw, false)
    : nextCursor || nextPage
      ? true
      : totalPages > 0 && page > 0
        ? page < totalPages
        : null;

  return {
    nextCursor: nextCursor || null,
    nextPage: nextPage || null,
    page: page || null,
    totalPages: totalPages || null,
    total: total || null,
    hasMore,
  };
}

// -----------------------------------------------------------------------------
// Display-field helpers
// -----------------------------------------------------------------------------

function displayText(value) {
  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return normalizeString(value);
  }

  if (Array.isArray(value)) {
    return uniqueStrings(
      value.map(displayText).filter(Boolean)
    ).join("\n\n");
  }

  if (isObject(value)) {
    return displayText(
      value.text ??
      value.description ??
      value.content ??
      value.value ??
      ""
    );
  }

  return "";
}

function firstDisplayText(...values) {
  for (const value of values) {
    const text = displayText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function combineDisplayText(...values) {
  return uniqueStrings(
    values.map(displayText).filter(Boolean)
  ).join("\n\n");
}

function locationRows(source = {}) {
  for (const rows of [
    source.locations,
    source.location_list,
    source.locationList,
  ]) {
    if (Array.isArray(rows) && rows.length) {
      return rows;
    }
  }

  return isObject(source.location)
    ? [source.location]
    : [];
}

function nullableCoordinate(value, minimum, maximum) {
  if (
    value === undefined ||
    value === null ||
    normalizeString(value) === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const number = Number(value);

  return (
    Number.isFinite(number) &&
    number >= minimum &&
    number <= maximum
  )
    ? number
    : null;
}

// -----------------------------------------------------------------------------
// Images
// -----------------------------------------------------------------------------

function normalizeImageUrl(value) {
  if (typeof value === "string") {
    return normalizeString(value);
  }

  if (isObject(value)) {
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

function extractImageUrls(source = {}) {
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

  if (Array.isArray(source.images)) {
    candidates.push(...source.images);
  }

  return uniqueStrings(
    candidates.map(normalizeImageUrl).filter(Boolean)
  );
}

// -----------------------------------------------------------------------------
// Locations
// -----------------------------------------------------------------------------

function normalizeAccessLocation(location = {}) {
  if (!isObject(location)) {
    return null;
  }

  const latitude = nullableCoordinate(
    firstNonEmpty(location.latitude, location.lat),
    -90,
    90
  );

  const longitude = nullableCoordinate(
    firstNonEmpty(
      location.longitude,
      location.lng,
      location.lon
    ),
    -180,
    180
  );

  const address1 = normalizeString(
    firstNonEmpty(
      location.address1,
      location.address_1,
      location.addressLine1,
      typeof location.address === "string"
        ? location.address
        : "",
      location.street,
      location.street_address
    )
  );

  const address2 = normalizeString(
    firstNonEmpty(
      location.address2,
      location.address_2,
      location.addressLine2
    )
  );

  const city = normalizeString(
    firstNonEmpty(
      location.city_locality,
      location.city
    )
  );

  const state = normalizeString(
    firstNonEmpty(
      location.state_region,
      location.state,
      location.region,
      location.province
    )
  );

  const postalCode = normalizeString(
    firstNonEmpty(
      location.postal_code,
      location.postalCode,
      location.zip,
      location.zip_code
    )
  );

  const country = normalizeString(
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
          location.location_key,
          location.id,
          location.location_id,
          location.locationId,
          location.token
        )
      ) || null,

    name:
      normalizeString(
        firstNonEmpty(
          location.name,
          location.location_name,
          location.locationName
        )
      ) || null,

    address1: address1 || null,
    address2: address2 || null,
    city: city || null,
    state: state || null,
    postalCode: postalCode || null,
    country: country || null,

    latitude: Number.isFinite(latitude)
      ? latitude
      : null,

    longitude: Number.isFinite(longitude)
      ? longitude
      : null,

    phone:
      normalizeString(
        firstNonEmpty(
          location.phone,
          location.phone_number,
          location.phoneNumber
        )
      ) || null,

    website:
      normalizeString(
        firstNonEmpty(
          location.website,
          location.url,
          location.website_url,
          location.websiteUrl
        )
      ) || null,

    distance:
      normalizeNumber(
        firstNonEmpty(
          location.distance,
          location.distance_miles,
          location.distanceMiles
        ),
        0
      ) || null,
  };
}

// -----------------------------------------------------------------------------
// Merchants
// -----------------------------------------------------------------------------

function normalizeAccessMerchant(merchant = {}) {
  if (typeof merchant === "string") {
    return {
      id: null,
      name: normalizeString(merchant),
      description: null,
      website: null,
      logo: null,
      images: [],
      locations: [],
    };
  }

  if (!isObject(merchant)) {
    return {
      id: null,
      name: "",
      description: null,
      website: null,
      logo: null,
      images: [],
      locations: [],
    };
  }

  const locations = locationRows(merchant)
    .map(normalizeAccessLocation)
    .filter(Boolean);

  const images = extractImageUrls(merchant);

  return {
    id:
      normalizeString(
        firstNonEmpty(
          merchant.store_key,
          merchant.merchant_key,
          merchant.id,
          merchant.merchant_id,
          merchant.merchantId,
          merchant.token
        )
      ) || null,

    name: normalizeString(
      firstNonEmpty(
        merchant.name,
        merchant.store_name,
        merchant.merchant_name,
        merchant.merchantName,
        merchant.title
      )
    ),

    description:
      firstDisplayText(
        merchant.description,
        merchant.long_description,
        merchant.short_description,
        merchant.summary
      ) || null,

    website:
      normalizeString(
        firstNonEmpty(
          merchant.website,
          merchant.url,
          merchant.website_url,
          merchant.websiteUrl
        )
      ) || null,

    logo:
      normalizeImageUrl(
        firstNonEmpty(
          merchant.logo,
          merchant.logo_url,
          merchant.logoUrl,
          images[0]
        )
      ) || null,

    images,
    locations,
  };
}

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

function normalizeCategory(category) {
  if (typeof category === "string") {
    return {
      id: null,
      name: normalizeString(category),

      slug: normalizeLower(category)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    };
  }

  if (!isObject(category)) {
    return null;
  }

  const name = normalizeString(
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
          category.category_key,
          category.token
        )
      ) || null,

    name,

    slug:
      normalizeString(category.slug) ||
      normalizeLower(name)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
  };
}

// -----------------------------------------------------------------------------
// Redemption metadata
// -----------------------------------------------------------------------------

function normalizeRedemption(offer = {}) {
  const redemption = isObject(offer.redemption)
    ? offer.redemption
    : {};

  const redemptionTypes = uniqueStrings(
    firstArray(
      offer.redemption_types,
      offer.redemptionTypes,
      redemption.types,
      redemption.redemption_types
    )
  );

  const onlineUrl = normalizeString(
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

  const code = normalizeString(
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

  const barcode = normalizeString(
    firstNonEmpty(
      redemption.barcode,
      redemption.barcode_value,
      redemption.barcodeValue,
      offer.barcode,
      offer.barcode_value,
      offer.barcodeValue
    )
  );

  const qrCode = normalizeString(
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

  const instructions = combineDisplayText(
    redemption.instructions,
    offer.redemption_instructions,
    offer.redemptionInstructions,
    offer.instructions
  );

  const method = firstDisplayText(
    redemption.method,
    offer.redemption_method
  );

  return {
    types: redemptionTypes,
    method: method || null,
    onlineUrl: onlineUrl || null,
    code: code || null,
    barcode: barcode || null,
    qrCode: qrCode || null,
    instructions: instructions || null,

    requiresClaim: normalizeBoolean(
      firstNonEmpty(
        redemption.requires_claim,
        redemption.requiresClaim,
        offer.requires_claim,
        offer.requiresClaim
      ),
      false
    ),

    // Metadata presence only, not authorization to claim.
    redeemable: Boolean(
      onlineUrl ||
      code ||
      barcode ||
      qrCode ||
      redemptionTypes.length
    ),
  };
}

// -----------------------------------------------------------------------------
// Offers
// -----------------------------------------------------------------------------

function normalizeAccessOffer(offer = {}, index = 0) {
  if (!isObject(offer)) {
    return null;
  }

  const store = isObject(offer.store)
    ? offer.store
    : {};

  const nestedMerchant = isObject(offer.merchant)
    ? offer.merchant
    : {};

  const merchantSource = {
    ...store,
    ...nestedMerchant,

    id: firstNonEmpty(
      nestedMerchant.id,
      nestedMerchant.merchant_key,
      store.store_key,
      store.id,
      offer.store_key,
      offer.merchant_key,
      offer.merchant_id,
      offer.merchantId
    ),

    name: firstDisplayText(
      nestedMerchant.name,
      nestedMerchant.merchant_name,
      store.name,
      store.store_name,
      offer.store_name,
      offer.merchant_name,
      offer.merchantName,
      offer.business_name,
      offer.businessName,
      typeof offer.merchant === "string"
        ? offer.merchant
        : ""
    ),

    logo:
      normalizeImageUrl(nestedMerchant.logo) ||
      normalizeImageUrl(nestedMerchant.logo_url) ||
      normalizeImageUrl(store.logo) ||
      normalizeImageUrl(store.logo_url) ||
      normalizeImageUrl(offer.store_logo) ||
      normalizeImageUrl(offer.store_logo_url) ||
      normalizeImageUrl(offer.merchant_logo) ||
      normalizeImageUrl(offer.merchantLogo),

    description: firstDisplayText(
      nestedMerchant.description,
      store.description,
      store.long_description,
      offer.store_description,
      offer.merchant_description
    ),

    locations: locationRows(nestedMerchant).length
      ? locationRows(nestedMerchant)
      : locationRows(store),
  };

  const merchant = normalizeAccessMerchant(merchantSource);

  const locations = locationRows(offer)
    .map(normalizeAccessLocation)
    .filter(Boolean);

  if (!locations.length && merchant.locations.length) {
    locations.push(...merchant.locations);
  }

  const rawCategories = [
    ...firstArray(
      offer.categories,
      offer.category_list,
      offer.categoryList
    ),
  ];

  if (!rawCategories.length && offer.category) {
    rawCategories.push(offer.category);
  }

  const categories = rawCategories
    .map(normalizeCategory)
    .filter((category) => category?.name);

  const images = uniqueStrings([
    ...extractImageUrls(offer),
    ...merchant.images,
  ]);

  const redemption = normalizeRedemption(offer);

  const offerId = normalizeString(
    firstNonEmpty(
      offer.offer_key,
      offer.offerKey,
      offer.id,
      offer.offer_id,
      offer.offerId,
      offer.token,
      offer.offer_token,
      offer.offerToken
    )
  );

  const title = normalizeString(
    firstNonEmpty(
      offer.title,
      offer.name,
      offer.offer_title,
      offer.offerTitle,
      offer.headline
    )
  );

  const description = firstDisplayText(
    offer.description,
    offer.long_description,
    offer.offer_description,
    offer.offerDescription,
    offer.details,
    offer.summary,
    offer.short_description
  );

  const discountCandidates = [
    offer.discount_text,
    offer.discountText,
    offer.savings_text,
    offer.savingsText,
    offer.discount,
    offer.savings,
    offer.offer_value,
    offer.offerValue,
  ];

  // Do not invent currency or percentage units for bare numbers.
  const discountText = discountCandidates
    .map(displayText)
    .find(
      (text) =>
        text &&
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)
    ) || title;

  // Preserve distinct terms and restrictions instead of selecting
  // only the first nonempty field.
  const terms = combineDisplayText(
    offer.terms,
    offer.terms_of_use,
    offer.termsOfUse,
    offer.offer_terms,
    offer.terms_and_conditions,
    offer.termsAndConditions,
    offer.disclaimer,
    offer.restrictions
  );

  const featured = normalizeBoolean(
    firstNonEmpty(
      offer.featured,
      offer.is_featured,
      offer.isFeatured
    ),
    false
  );

  const online = normalizeBoolean(
    firstNonEmpty(
      offer.online,
      offer.is_online,
      offer.isOnline,
      offer.online_only,
      offer.onlineOnly
    ),
    Boolean(redemption.onlineUrl)
  );

  const local = normalizeBoolean(
    firstNonEmpty(
      offer.local,
      offer.is_local,
      offer.isLocal
    ),
    locations.length > 0
  );

  const active = ![
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
    id: offerId || `access-offer-${index + 1}`,
    accessOfferId: offerId || null,
    offerKey: offerId || null,
    offer_key: offerId || null,

    title: title || merchant.name || "Member Offer",
    description: description || null,

    shortDescription:
      firstDisplayText(
        offer.short_description,
        offer.shortDescription
      ) || null,

    discountText: discountText || null,
    savingsText: discountText || null,

    merchant,
    merchantName: merchant.name || "",
    merchantDescription: merchant.description || null,

    categories,
    category: categories[0] || null,
    categoryName: categories[0]?.name || null,

    locations,
    images,
    image: images[0] || merchant.logo || null,
    logo: merchant.logo || null,

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
      ) || (active ? "active" : "inactive"),

    terms: terms || null,

    redemption,
    redeemable: redemption.redeemable,
    requiresClaim: redemption.requiresClaim,

    startsAt: safeDate(
      firstNonEmpty(
        offer.starts_at,
        offer.startsAt,
        offer.start_date,
        offer.startDate
      )
    ),

    expiresAt: safeDate(
      firstNonEmpty(
        offer.expires_at,
        offer.expiresAt,
        offer.expiration_date,
        offer.expirationDate,
        offer.end_date,
        offer.endDate
      )
    ),

    createdAt: safeDate(
      firstNonEmpty(
        offer.created_at,
        offer.createdAt,
        offer.created
      )
    ),

    updatedAt: safeDate(
      firstNonEmpty(
        offer.updated_at,
        offer.updatedAt,
        offer.updated
      )
    ),
  };
}

function normalizeAccessOffers(rows = []) {
  return rows
    .map((row, index) => normalizeAccessOffer(row, index))
    .filter(Boolean);
}

function deduplicateOffers(offers = []) {
  const seen = new Set();
  const results = [];

  for (const offer of offers) {
    const key =
      normalizeString(offer.accessOfferId || offer.id) ||
      [
        normalizeLower(offer.merchantName),
        normalizeLower(offer.title),
      ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(offer);
  }

  return results;
}

// -----------------------------------------------------------------------------
// Provider query
// -----------------------------------------------------------------------------

function buildAccessOffersQuery(options = {}) {
  const query = {};

  const memberKey = normalizeString(
    options.memberKey ||
    options.member_key ||
    options.memberCustomerIdentifier
  );

  if (!memberKey) {
    const error = new Error(
      "The saved Access member identifier is required to load offers."
    );

    error.code = "ACCESS_OFFERS_MEMBER_KEY_REQUIRED";
    error.status = 409;

    throw error;
  }

  query.member_key = memberKey;
  query.sanitize_html = true;

  const search = normalizeString(
    options.search || options.query
  );

  const category = normalizeString(
    options.category || options.category_key
  );

  const postalCode = normalizeString(
    options.postalCode || options.postal_code
  );

  if (search) {
    query.query = search;
  }

  if (category) {
    query.category_key = category;
  }

  if (postalCode) {
    query.postal_code = postalCode;
  }

  const latPresent =
    options.latitude !== undefined &&
    options.latitude !== null &&
    options.latitude !== "";

  const lonPresent =
    options.longitude !== undefined &&
    options.longitude !== null &&
    options.longitude !== "";

  if (latPresent && lonPresent) {
    const latitude = Number(options.latitude);
    const longitude = Number(options.longitude);

    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
    ) {
      query.lat = latitude;
      query.lon = longitude;
    }
  }

  if (
    options.radius !== undefined &&
    options.radius !== null &&
    options.radius !== ""
  ) {
    const radius = Number(options.radius);

    if (Number.isFinite(radius) && radius > 0) {
      query.distance = `${radius}mi`;
    }
  }

  if (options.online !== undefined) {
    query.online = normalizeBoolean(options.online)
      ? "only"
      : "none";
  }

  query.all_offers = true;

  return query;
}

// -----------------------------------------------------------------------------
// Fetch one page
// -----------------------------------------------------------------------------

async function fetchAccessOffersPage(options = {}) {
  const endpoint = normalizePath(
    options.path || getAccessOffersEndpointPath()
  );

  if (!endpoint) {
    const error = new Error(
      "Access Offers endpoint path has not been configured. Add ACCESS_OFFERS_ENDPOINT_PATH in Vercel using the endpoint approved by Access."
    );

    error.code = "ACCESS_OFFERS_ENDPOINT_NOT_CONFIGURED";
    throw error;
  }

  const pageSize = clamp(
    positiveInteger(
      options.pageSize,
      getAccessOffersDefaultPageSize()
    ),
    1,
    MAX_PAGE_SIZE
  );

  const query = buildAccessOffersQuery(options);

  if (options.cursor) {
    query[getCursorParameterName()] = options.cursor;
  } else {
    query[getPageParameterName()] = positiveInteger(
      options.page,
      1
    );
  }

  query[getPageSizeParameterName()] = pageSize;

  const result = await accessOffersRequest(endpoint, {
    method: "GET",
    query,
    timeoutMs: options.timeoutMs,
  });

  const rows = extractOfferRows(result);
  const offers = normalizeAccessOffers(rows);
  const pagination = extractPaginationMeta(result);

  return {
    success: true,
    ok: true,
    offers,
    rawCount: rows.length,
    count: offers.length,
    pagination,

    request: {
      page: options.page || 1,
      pageSize,
      cursor: options.cursor || null,
    },
  };
}

// -----------------------------------------------------------------------------
// Fetch full catalog
// -----------------------------------------------------------------------------

async function fetchAllAccessOffers(options = {}) {
  const pageSize = clamp(
    positiveInteger(
      options.pageSize,
      getAccessOffersDefaultPageSize()
    ),
    1,
    MAX_PAGE_SIZE
  );

  const maxPages = clamp(
    positiveInteger(
      options.maxPages,
      getAccessOffersMaxPages()
    ),
    1,
    1000
  );

  let page = positiveInteger(options.startPage, 1);
  let cursor = normalizeString(options.cursor);
  let pagesFetched = 0;
  let allOffers = [];
  let lastPagination = null;

  const seenCursors = new Set();
  const seenPages = new Set();

  while (pagesFetched < maxPages) {
    const result = await fetchAccessOffersPage({
      ...options,
      page,
      cursor: cursor || undefined,
      pageSize,
    });

    pagesFetched += 1;
    allOffers.push(...result.offers);
    lastPagination = result.pagination;

    if (result.rawCount === 0) {
      break;
    }

    if (result.pagination.nextCursor) {
      const nextCursor = result.pagination.nextCursor;

      if (seenCursors.has(nextCursor)) {
        break;
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;

      continue;
    }

    if (result.pagination.nextPage) {
      const nextPage = result.pagination.nextPage;

      if (seenPages.has(nextPage)) {
        break;
      }

      seenPages.add(nextPage);
      page = nextPage;
      cursor = "";

      continue;
    }

    if (
      result.pagination.totalPages &&
      result.pagination.page
    ) {
      if (
        result.pagination.page >=
        result.pagination.totalPages
      ) {
        break;
      }

      page = result.pagination.page + 1;
      cursor = "";

      continue;
    }

    if (result.pagination.hasMore === false) {
      break;
    }

    if (result.rawCount < pageSize) {
      break;
    }

    page += 1;
    cursor = "";
  }

  allOffers = deduplicateOffers(allOffers);

  return {
    success: true,
    ok: true,
    offers: allOffers,
    count: allOffers.length,
    pagesFetched,
    pageSize,
    hitSafetyLimit: pagesFetched >= maxPages,
    pagination: lastPagination,
  };
}

// -----------------------------------------------------------------------------
// Optional configured detail endpoint
// -----------------------------------------------------------------------------

async function fetchAccessOfferById(offerId, options = {}) {
  const path = normalizePath(
    options.path || buildAccessOfferDetailPath(offerId)
  );

  if (!path) {
    const error = new Error(
      "Access offer-detail endpoint template has not been configured."
    );

    error.code = "ACCESS_OFFER_DETAIL_ENDPOINT_NOT_CONFIGURED";
    throw error;
  }

  const query = buildAccessOffersQuery(options);

  const result = await accessOffersRequest(path, {
    method: "GET",
    query,
    timeoutMs: options.timeoutMs,
  });

  const data = unwrapAccessResponse(result);

  const rawOffer = isObject(data.offer)
    ? data.offer
    : isObject(data.data?.offer)
      ? data.data.offer
      : isObject(data.data)
        ? data.data
        : data;

  return {
    success: true,
    ok: true,
    offer: normalizeAccessOffer(rawOffer, 0),
  };
}

// -----------------------------------------------------------------------------
// Portal filters
// -----------------------------------------------------------------------------

function filterAccessOffers(offers = [], options = {}) {
  let results = Array.isArray(offers)
    ? [...offers]
    : [];

  const search = normalizeLower(options.search);

  if (search) {
    results = results.filter((offer) => {
      const haystack = [
        offer.title,
        offer.description,
        offer.discountText,
        offer.merchantName,
        offer.categoryName,

        ...(offer.categories || []).map(
          (category) => category.name
        ),

        ...(offer.locations || []).flatMap((location) => [
          location.name,
          location.city,
          location.state,
          location.postalCode,
        ]),
      ].map(normalizeLower).join(" ");

      return haystack.includes(search);
    });
  }

  if (normalizeString(options.category)) {
    const category = normalizeLower(options.category);

    results = results.filter((offer) =>
      (offer.categories || []).some((item) =>
        normalizeLower(item.name) === category ||
        normalizeLower(item.slug) === category
      )
    );
  }

  if (options.online !== undefined) {
    const online = normalizeBoolean(options.online);

    results = results.filter(
      (offer) => Boolean(offer.online) === online
    );
  }

  if (options.local !== undefined) {
    const local = normalizeBoolean(options.local);

    results = results.filter(
      (offer) => Boolean(offer.local) === local
    );
  }

  if (options.featured !== undefined) {
    const featured = normalizeBoolean(options.featured);

    results = results.filter(
      (offer) => Boolean(offer.featured) === featured
    );
  }

  if (options.active !== undefined) {
    const active = normalizeBoolean(options.active, true);

    results = results.filter(
      (offer) => Boolean(offer.active) === active
    );
  }

  return results;
}

// -----------------------------------------------------------------------------
// Catalog categories and merchants
// -----------------------------------------------------------------------------

function buildAccessOfferCategories(offers = []) {
  const map = new Map();

  for (const offer of offers) {
    for (const category of offer.categories || []) {
      const key = normalizeString(
        category.id ||
        category.slug ||
        category.name
      );

      if (!key) {
        continue;
      }

      if (!map.has(key)) {
        map.set(key, {
          ...category,
          count: 0,
        });
      }

      map.get(key).count += 1;
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
}

function buildAccessMerchants(offers = []) {
  const map = new Map();

  for (const offer of offers) {
    const merchant = offer.merchant;

    if (!merchant?.name) {
      continue;
    }

    const key =
      normalizeString(merchant.id) ||
      normalizeLower(merchant.name);

    if (!map.has(key)) {
      map.set(key, {
        ...merchant,
        offerCount: 0,
      });
    }

    map.get(key).offerCount += 1;
  }

  return Array.from(map.values());
}

// -----------------------------------------------------------------------------
// Portal-safe metadata
// -----------------------------------------------------------------------------

function sanitizeAccessOfferForPortal(offer) {
  if (!offer) {
    return null;
  }

  return {
    id: offer.id,
    accessOfferId: offer.accessOfferId,
    offerKey: offer.offerKey || offer.accessOfferId,
    offer_key: offer.offer_key || offer.accessOfferId,

    title: offer.title,
    description: offer.description,
    shortDescription: offer.shortDescription || null,
    merchantDescription: offer.merchantDescription || null,

    discountText: offer.discountText,
    savingsText: offer.savingsText,

    merchantName: offer.merchantName,
    merchant: offer.merchant,

    category: offer.category,
    categories: offer.categories,

    categoryName:
      offer.categoryName ||
      offer.category?.name ||
      null,

    locations: offer.locations,
    image: offer.image,
    images: offer.images,
    logo: offer.logo,

    featured: offer.featured,
    online: offer.online,
    local: offer.local,
    active: offer.active,
    status: offer.status,
    terms: offer.terms,

    // Return descriptive instructions and presence flags.
    // Do not return the actual URLs, codes, barcodes, or QR credentials.
    redemption: {
      types: offer.redemption?.types || [],
      method: offer.redemption?.method || null,
      instructions: offer.redemption?.instructions || null,
      requiresClaim: Boolean(offer.requiresClaim),

      hasOnlineUrl:
        Boolean(offer.redemption?.onlineUrl) ||
        offer.redemption?.hasOnlineUrl === true,

      hasCode:
        Boolean(offer.redemption?.code) ||
        offer.redemption?.hasCode === true,

      hasBarcode:
        Boolean(offer.redemption?.barcode) ||
        offer.redemption?.hasBarcode === true,

      hasQrCode:
        Boolean(offer.redemption?.qrCode) ||
        offer.redemption?.hasQrCode === true,
    },

    redeemable: offer.redeemable,
    requiresClaim: offer.requiresClaim,

    startsAt: offer.startsAt,
    expiresAt: offer.expiresAt,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

function buildPortalAccessCatalog(offers = []) {
  const clean = deduplicateOffers(offers)
    .filter((offer) => offer.active !== false)
    .map(sanitizeAccessOfferForPortal)
    .filter(Boolean);

  return {
    offers: clean,
    count: clean.length,
    categories: buildAccessOfferCategories(clean),
    merchants: buildAccessMerchants(clean),
  };
}

// -----------------------------------------------------------------------------
// Configuration diagnostics
// -----------------------------------------------------------------------------

function getAccessOffersConfigForDebug() {
  const endpointPath = getAccessOffersEndpointPath();

  return {
    environment: getAccessOffersEnvironment(),
    production: isAccessOffersProduction(),
    stage: isAccessOffersStage(),

    baseUrl: getAccessOffersBaseUrl(),
    endpointPath: endpointPath || null,

    url: endpointPath
      ? getAccessOffersUrl()
      : getAccessOffersBaseUrl(),

    detailPathTemplate:
      getAccessOfferDetailPathTemplate() || null,

    organizationCustomerIdentifier:
      getOrganizationCustomerIdentifier(),

    programCustomerIdentifier:
      getProgramCustomerIdentifier(),

    hasToken: hasAccessOffersToken(),

    tokenLength: getAccessOffersToken()
      ? getAccessOffersToken().length
      : 0,

    authMode: getAccessOffersAuthMode(),
    pageSize: getAccessOffersDefaultPageSize(),
    maxPages: getAccessOffersMaxPages(),

    pagination: {
      pageParam: getPageParameterName(),
      pageSizeParam: getPageSizeParameterName(),
      cursorParam: getCursorParameterName(),
    },
  };
}

function validateAccessOffersConfiguration() {
  const errors = {};

  if (!getAccessOffersBaseUrl()) {
    errors.baseUrl =
      "Access Offers API base URL is missing.";
  }

  if (!getAccessOffersToken()) {
    errors.token =
      "Access Offers API token is missing.";
  }

  if (!getAccessOffersEndpointPath()) {
    errors.endpointPath =
      "ACCESS_OFFERS_ENDPOINT_PATH has not been configured with the approved Access Offers endpoint.";
  }

  if (!getOrganizationCustomerIdentifier()) {
    errors.organization =
      "Access organization customer identifier is missing.";
  }

  if (!getProgramCustomerIdentifier()) {
    errors.program =
      "Access program customer identifier is missing.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    config: getAccessOffersConfigForDebug(),
  };
}

function getAccessOffersIntegrationStatus() {
  const validation = validateAccessOffersConfiguration();

  return {
    configured: validation.valid,
    environment: getAccessOffersEnvironment(),
    hasToken: hasAccessOffersToken(),

    hasEndpoint: Boolean(
      getAccessOffersEndpointPath()
    ),

    baseUrl: getAccessOffersBaseUrl(),
    errors: validation.errors,
  };
}

// -----------------------------------------------------------------------------
// Existing named exports
// -----------------------------------------------------------------------------

export {
  DEFAULT_ACCESS_ENVIRONMENT,
  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_OFFERS_ENDPOINT_PATH,
  DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER,
  DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_MAX_PAGES,

  normalizeString,
  normalizeEmail,
  normalizeBoolean,
  normalizeNumber,
  centsToDollars,
  safeJsonStringify,

  getAccessOffersEnvironment,
  isAccessOffersProduction,
  isAccessOffersStage,

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

  getAccessOffersHeaders,
  parseAccessOffersResponse,
  buildAccessOffersRequestUrl,
  accessOffersRequest,

  normalizeAccessLocation,
  normalizeAccessMerchant,
  normalizeCategory,
  normalizeRedemption,
  normalizeAccessOffer,
  normalizeAccessOffers,
  sanitizeAccessOfferForPortal,

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

// -----------------------------------------------------------------------------
// Existing default export
// -----------------------------------------------------------------------------

export default {
  fetchAccessOffersPage,
  fetchAllAccessOffers,
  fetchAccessOfferById,
  filterAccessOffers,
  buildPortalAccessCatalog,
  sanitizeAccessOfferForPortal,
  getAccessOffersIntegrationStatus,
};