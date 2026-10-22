
/**
 * ============================================================
 * CARD LEO REWARDS
 * lib/access-config.js
 * ============================================================
 *
 * Central configuration for Access Development integrations.
 *
 * Services:
 *   1. Offers API — Eat, Play, Shop
 *   2. Member AMT — Member synchronization
 *   3. Travel SDK — Travel session authentication
 *
 * IMPORTANT:
 * - Server-side use only.
 * - Never expose API keys to browser JavaScript.
 * - Never commit actual tokens to GitHub.
 * - Existing environment variable names are preserved.
 * - Production access must be approved by Access.
 *
 * This file only configures connections.
 * It does not make API requests.
 * ============================================================
 */

const STAGE_OFFERS_URL =
  "https://offer-stage.adcrws.com";

const PRODUCTION_OFFERS_URL =
  "https://offer.adcrws.com";

const DEFAULT_TRAVEL_AUTH_URL =
  "https://auth.adcrws.com/api/v1/tokens";

const DEFAULT_TRAVEL_SDK_URL =
  "https://booking.accessdevelopment.com/scripts/travel.client.v2.js";

/**
 * Read and normalize an environment variable.
 */
function env(name, fallback = "") {
  const value = process.env[name];

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

/**
 * Normalize deployment environment.
 *
 * Supported values:
 *   stage
 *   staging
 *   sandbox
 *   test
 *   development
 *
 * Production values:
 *   production
 *   prod
 *   live
 *
 * Missing environment defaults to staging.
 */
function normalizeEnvironment(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (
    ["production", "prod", "live"].includes(normalized)
  ) {
    return "production";
  }

  return "stage";
}

export const ACCESS_ENVIRONMENT =
  normalizeEnvironment(
    env("ACCESS_ENVIRONMENT", "stage")
  );

export const ACCESS_IS_PRODUCTION =
  ACCESS_ENVIRONMENT === "production";

export const ACCESS_IS_STAGE =
  !ACCESS_IS_PRODUCTION;

/**
 * Normalize API base URLs.
 */
function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * Only allow secure HTTPS endpoints.
 */
function requireHttpsUrl(value, label) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${label} must be a valid URL`
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `${label} must use HTTPS`
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${label} must not contain credentials, query, or hash`
    );
  }

  return normalizeBaseUrl(parsed.toString());
}

/**
 * Verify that the Offers API URL matches the selected
 * Access environment.
 *
 * This prevents accidental use of production credentials
 * against the staging API, or vice versa.
 */
function resolveOffersBaseUrl() {
  const expectedUrl = ACCESS_IS_PRODUCTION
    ? PRODUCTION_OFFERS_URL
    : STAGE_OFFERS_URL;

  const configuredUrl = env(
    "ACCESS_OFFERS_API_BASE_URL",
    expectedUrl
  );

  const normalized = requireHttpsUrl(
    configuredUrl,
    "ACCESS_OFFERS_API_BASE_URL"
  );

  const configuredHost = new URL(normalized).hostname;
  const expectedHost = new URL(expectedUrl).hostname;

  if (configuredHost !== expectedHost) {
    throw new Error(
      "ACCESS_OFFERS_API_BASE_URL does not match " +
      `ACCESS_ENVIRONMENT=${ACCESS_ENVIRONMENT}. ` +
      `Expected host: ${expectedHost}`
    );
  }

  return normalized;
}

/**
 * API paths confirmed by Access Offers documentation.
 */
export const ACCESS_OFFERS_PATHS = Object.freeze({
  search: "/v1/offers",

  details(offerKey) {
    const key = String(offerKey || "").trim();

    if (!/^\d+$/.test(key)) {
      throw new Error(
        "Invalid Access offer_key"
      );
    }

    return `/v1/offers/${encodeURIComponent(key)}`;
  },
});

/**
 * Official Access Offers API configuration.
 *
 * The documented API uses:
 *   access_token
 *   member_key
 *
 * as required request parameters.
 *
 * Do not send access_token to the browser.
 */
export const ACCESS_OFFERS = Object.freeze({
  environment: ACCESS_ENVIRONMENT,

  baseUrl: resolveOffersBaseUrl(),

  apiToken: env("ACCESS_OFFERS_API_TOKEN"),

  paths: ACCESS_OFFERS_PATHS,

  defaultPostalCode: env(
    "ACCESS_DEFAULT_POSTAL_CODE"
  ),

  defaultDistance: env(
    "ACCESS_DEFAULT_DISTANCE",
    "10"
  ),

  maxPerPage: 100,

  defaultPerPage: 20,

  requestTimeoutMs: 15000,
});

/**
 * Member AMT configuration.
 *
 * Existing Card Leo AMT environment variable names
 * are retained.
 *
 * IMPORTANT:
 * The actual AMT base URL and endpoint path must
 * come from your existing working integration.
 */
export const ACCESS_AMT = Object.freeze({
  baseUrl: normalizeBaseUrl(
    env("ACCESS_AMT_BASE_URL")
  ),

  endpointPath: env(
    "ACCESS_AMT_ENDPOINT_PATH"
  ),

  apiToken: env(
    "ACCESS_AMT_API_TOKEN"
  ),

  organizationCustomerIdentifier: env(
    "ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER"
  ),

  programCustomerIdentifier: env(
    "ACCESS_PROGRAM_CUSTOMER_IDENTIFIER"
  ),

  requestTimeoutMs: 15000,
});

/**
 * Travel SDK configuration.
 *
 * The Access Travel documentation confirms:
 *
 * POST https://auth.adcrws.com/api/v1/tokens
 *
 * Headers:
 *   Authorization: Bearer <api_key>
 *   Content-Type: application/json
 *
 * JSON:
 *   member_key
 *   scope: "travel"
 *
 * Optional:
 *   email
 *   first_name
 *   last_name
 *
 * The API returns:
 *   session_token
 *
 * IMPORTANT:
 * ACCESS_TRAVEL_API_KEY must be authorized for Travel.
 * Do not assume the Offers token has Travel permission.
 */
export const ACCESS_TRAVEL = Object.freeze({
  authUrl: requireHttpsUrl(
    env(
      "ACCESS_TRAVEL_AUTH_URL",
      DEFAULT_TRAVEL_AUTH_URL
    ),
    "ACCESS_TRAVEL_AUTH_URL"
  ),

  apiKey: env("ACCESS_TRAVEL_API_KEY"),

  scope: "travel",

  sdkUrl: requireHttpsUrl(
    env(
      "ACCESS_TRAVEL_SDK_URL",
      DEFAULT_TRAVEL_SDK_URL
    ),
    "ACCESS_TRAVEL_SDK_URL"
  ),

  requestTimeoutMs: 15000,
});

/**
 * Existing/legacy Access configuration.
 *
 * These values are kept available during migration.
 * Do not delete existing Vercel variables until
 * we review which files still use them.
 */
export const ACCESS_LEGACY = Object.freeze({
  apiBaseUrl: normalizeBaseUrl(
    env("ACCESS_API_BASE_URL")
  ),

  apiToken: env("ACCESS_API_TOKEN"),

  apiUsername: env("ACCESS_API_USERNAME"),

  apiPassword: env("ACCESS_API_PASSWORD"),

  searchBenefitsEndpoint: env(
    "ACCESS_SEARCH_BENEFITS_ENDPOINT"
  ),

  categoriesEndpoint: env(
    "ACCESS_CATEGORIES_ENDPOINT"
  ),

  benefitDetailsEndpoint: env(
    "ACCESS_BENEFIT_DETAILS_ENDPOINT"
  ),

  anonymousMemberKey: env(
    "ACCESS_ANONYMOUS_MEMBER_KEY"
  ),

  perksUrl: env("ACCESS_PERKS_URL"),

  accountNumber: env("ACCESS_ACCOUNT_NUMBER"),

  programId: env("ACCESS_PROGRAM_ID"),

  customerServicePhone: env(
    "ACCESS_CUSTOMER_SERVICE_PHONE"
  ),
});

/**
 * Validate only the service being used.
 *
 * This prevents missing Travel configuration from
 * breaking Offers API integration.
 */
export function validateAccessConfig(
  service = "offers"
) {
  const errors = [];

  if (service === "offers") {
    if (!ACCESS_OFFERS.apiToken) {
      errors.push(
        "Missing ACCESS_OFFERS_API_TOKEN"
      );
    }
  } else if (service === "amt") {
    if (!ACCESS_AMT.baseUrl) {
      errors.push(
        "Missing ACCESS_AMT_BASE_URL"
      );
    }

    if (!ACCESS_AMT.endpointPath) {
      errors.push(
        "Missing ACCESS_AMT_ENDPOINT_PATH"
      );
    }

    if (!ACCESS_AMT.apiToken) {
      errors.push(
        "Missing ACCESS_AMT_API_TOKEN"
      );
    }

    if (
      !ACCESS_AMT.organizationCustomerIdentifier
    ) {
      errors.push(
        "Missing ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER"
      );
    }

    if (
      !ACCESS_AMT.programCustomerIdentifier
    ) {
      errors.push(
        "Missing ACCESS_PROGRAM_CUSTOMER_IDENTIFIER"
      );
    }
  } else if (service === "travel") {
    if (!ACCESS_TRAVEL.apiKey) {
      errors.push(
        "Missing ACCESS_TRAVEL_API_KEY"
      );
    }
  } else {
    errors.push(
      `Unknown Access service: ${service}`
    );
  }

  return {
    ok: errors.length === 0,
    service,
    environment: ACCESS_ENVIRONMENT,
    errors,
  };
}

/**
 * Throw an error if a service is not configured.
 *
 * Never include actual API keys in error messages.
 */
export function assertAccessConfig(
  service = "offers"
) {
  const result = validateAccessConfig(service);

  if (!result.ok) {
    throw new Error(
      `Access ${service} configuration error: ` +
      result.errors.join("; ")
    );
  }

  return true;
}

/**
 * Safe diagnostics for server logs.
 *
 * Does not return token values.
 */
export function getAccessConfigStatus() {
  return {
    environment: ACCESS_ENVIRONMENT,

    offers: {
      configured:
        validateAccessConfig("offers").ok,

      baseUrl: ACCESS_OFFERS.baseUrl,

      hasToken: Boolean(
        ACCESS_OFFERS.apiToken
      ),
    },

    amt: {
      configured:
        validateAccessConfig("amt").ok,

      hasToken: Boolean(
        ACCESS_AMT.apiToken
      ),

      hasOrganizationIdentifier: Boolean(
        ACCESS_AMT.organizationCustomerIdentifier
      ),

      hasProgramIdentifier: Boolean(
        ACCESS_AMT.programCustomerIdentifier
      ),
    },

    travel: {
      configured:
        validateAccessConfig("travel").ok,

      hasApiKey: Boolean(
        ACCESS_TRAVEL.apiKey
      ),

      authUrl: ACCESS_TRAVEL.authUrl,
    },
  };
}

/**
 * Default export for convenience.
 */
const accessConfig = Object.freeze({
  environment: ACCESS_ENVIRONMENT,

  isProduction: ACCESS_IS_PRODUCTION,

  isStage: ACCESS_IS_STAGE,

  offers: ACCESS_OFFERS,

  amt: ACCESS_AMT,

  travel: ACCESS_TRAVEL,

  legacy: ACCESS_LEGACY,
});

export default accessConfig;
