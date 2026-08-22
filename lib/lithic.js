// lib/lithic.js

import { randomUUID } from "node:crypto";

/**
 * ============================================================================
 * CARD LEO REWARDS — LITHIC SERVER HELPER
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Central server-only integration layer between Card Leo Rewards and Lithic.
 *
 * Powers:
 *
 * 1. Lithic account/cardholder creation
 * 2. Virtual Card Leo card creation
 * 3. Physical card support
 * 4. Member card status
 * 5. Card activation/status changes
 * 6. Allowance card funding infrastructure
 * 7. Card transaction retrieval
 * 8. Card spend-limit controls
 * 9. Lithic Sandbox testing
 * 10. Production Lithic migration
 *
 * SECURITY
 * --------
 * NEVER import this file into browser JavaScript.
 *
 * LITHIC_API_KEY must remain SERVER-SIDE ONLY.
 *
 * PAN/CVV data should never be persisted or returned through ordinary
 * Card Leo APIs.
 *
 * ============================================================================
 */

/* ==========================================================================
   CONSTANTS
============================================================================ */

const LITHIC_SANDBOX_BASE_URL =
  "https://sandbox.lithic.com/v1";

const LITHIC_PRODUCTION_BASE_URL =
  "https://api.lithic.com/v1";

const DEFAULT_TIMEOUT_MS =
  20000;

const CARD_LEO_DEFAULT_CARD_TYPE =
  "VIRTUAL";

const CARD_LEO_DEFAULT_CARD_STATE =
  "OPEN";

/* ==========================================================================
   BASIC HELPERS
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

  const clean =
    normalizeString(
      value
    ).toLowerCase();

  if (!clean) {
    return fallback;
  }

  if (
    [
      "true",
      "1",
      "yes",
      "y",
      "on",
      "enabled",
    ].includes(clean)
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
      "disabled",
    ].includes(clean)
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

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return fallback;
  }

  return parsed;
}

function normalizePositiveInteger(
  value,
  fallback = 0
) {
  const parsed =
    normalizeInteger(
      value,
      fallback
    );

  return parsed >= 0
    ? parsed
    : fallback;
}

function normalizeMoneyToCents(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    Number.isNaN(
      Number(value)
    )
  ) {
    return 0;
  }

  return Math.round(
    Number(value) *
      100
  );
}

function centsToDollars(
  value
) {
  const cents =
    Number(value);

  if (
    !Number.isFinite(
      cents
    )
  ) {
    return 0;
  }

  return cents / 100;
}

function cleanUrl(value) {
  return normalizeString(
    value
  ).replace(
    /\/+$/,
    ""
  );
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

function isValidEmail(
  value
) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(
      value
    )
  );
}

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

function getLithicEnvironment() {
  const environment =
    getEnv(
      "LITHIC_ENVIRONMENT",
      "sandbox"
    ).toLowerCase();

  if (
    environment ===
      "production" ||
    environment ===
      "prod" ||
    environment ===
      "live"
  ) {
    return "production";
  }

  return "sandbox";
}

function isLithicProduction() {
  return (
    getLithicEnvironment() ===
    "production"
  );
}

function isLithicSandbox() {
  return !isLithicProduction();
}

function getLithicBaseUrl() {
  const configured =
    getEnv(
      "LITHIC_BASE_URL"
    );

  if (configured) {
    return cleanUrl(
      configured
    );
  }

  if (
    isLithicProduction()
  ) {
    return LITHIC_PRODUCTION_BASE_URL;
  }

  return LITHIC_SANDBOX_BASE_URL;
}

function getLithicApiKey() {
  return (
    getEnv(
      "LITHIC_API_KEY"
    ) ||
    getEnv(
      "LITHIC_SECRET_KEY"
    ) ||
    getEnv(
      "LITHIC_SANDBOX_API_KEY"
    )
  );
}

function getLithicCardProgramToken() {
  return (
    getEnv(
      "LITHIC_CARD_PROGRAM_TOKEN"
    ) ||
    getEnv(
      "LITHIC_PROGRAM_TOKEN"
    )
  );
}

function getLithicProductId() {
  return getEnv(
    "LITHIC_PRODUCT_ID"
  );
}

function isLithicEnabled() {
  return normalizeBoolean(
    getEnv(
      "LITHIC_ENABLED",
      "false"
    ),
    false
  );
}

function hasLithicApiKey() {
  return Boolean(
    getLithicApiKey()
  );
}

function isLithicConfigured() {
  return (
    isLithicEnabled() &&
    hasLithicApiKey()
  );
}

/* ==========================================================================
   SAFE CONFIG DEBUGGING

   NEVER expose the full Lithic API key.
============================================================================ */

function getLithicConfigForDebug() {
  const apiKey =
    getLithicApiKey();

  return {
    enabled:
      isLithicEnabled(),

    configured:
      isLithicConfigured(),

    environment:
      getLithicEnvironment(),

    sandbox:
      isLithicSandbox(),

    production:
      isLithicProduction(),

    baseUrl:
      getLithicBaseUrl(),

    hasApiKey:
      Boolean(apiKey),

    apiKeyPreview:
      apiKey
        ? `${apiKey.slice(
            0,
            4
          )}••••••••${apiKey.slice(
            -4
          )}`
        : null,

    hasCardProgramToken:
      Boolean(
        getLithicCardProgramToken()
      ),

    hasProductId:
      Boolean(
        getLithicProductId()
      ),
  };
}

/* ==========================================================================
   CONFIG VALIDATION
============================================================================ */

function assertLithicConfigured() {
  if (
    !isLithicEnabled()
  ) {
    const error =
      new Error(
        "Lithic integration is currently disabled. Set LITHIC_ENABLED=true when ready."
      );

    error.code =
      "LITHIC_DISABLED";

    error.status =
      503;

    throw error;
  }

  if (
    !getLithicApiKey()
  ) {
    const error =
      new Error(
        "Lithic API key is missing. Add LITHIC_API_KEY to the server environment."
      );

    error.code =
      "LITHIC_API_KEY_MISSING";

    error.status =
      503;

    throw error;
  }

  return true;
}

/* ==========================================================================
   AUTHENTICATION HEADERS
============================================================================ */

function getLithicHeaders(
  options = {}
) {
  const apiKey =
    normalizeString(
      options.apiKey
    ) ||
    getLithicApiKey();

  if (!apiKey) {
    const error =
      new Error(
        "Lithic API key is missing."
      );

    error.code =
      "LITHIC_API_KEY_MISSING";

    error.status =
      503;

    throw error;
  }

  return {
    Accept:
      "application/json",

    "Content-Type":
      "application/json",

    Authorization:
      apiKey,
  };
}

/* ==========================================================================
   REQUEST IDs / IDEMPOTENCY
============================================================================ */

function createRequestId(
  prefix = "clr"
) {
  const safePrefix =
    normalizeString(
      prefix
    ) || "clr";

  return `${safePrefix}-${randomUUID()}`;
}

function createIdempotencyKey() {
  /*
   * Keep this as a bare UUID so it can be passed directly to providers that
   * require UUID-form idempotency keys.
   */

  return randomUUID();
}

function getLithicIdempotencyHeaders(
  options = {}
) {
  const supplied =
    normalizeString(
      options.idempotencyKey
    ) ||
    normalizeString(
      options.idempotency_key
    );

  return {
    "Idempotency-Key":
      supplied ||
      createIdempotencyKey(),
  };
}

/* ==========================================================================
   RESPONSE PARSER
============================================================================ */

async function parseLithicResponse(
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
   ERROR HANDLING
============================================================================ */

function extractLithicErrorMessage(
  data,
  status
) {
  if (!data) {
    return `Lithic request failed with HTTP ${status}.`;
  }

  if (
    typeof data ===
      "string" &&
    data.trim()
  ) {
    return data.trim();
  }

  if (
    typeof data.message ===
      "string" &&
    data.message.trim()
  ) {
    return data.message.trim();
  }

  if (
    typeof data.error ===
      "string" &&
    data.error.trim()
  ) {
    return data.error.trim();
  }

  if (
    data.error &&
    typeof data.error ===
      "object" &&
    typeof data.error
      .message ===
      "string"
  ) {
    return data.error
      .message;
  }

  if (
    Array.isArray(
      data.errors
    ) &&
    data.errors.length
  ) {
    const firstError =
      data.errors[0];

    if (
      typeof firstError ===
      "string"
    ) {
      return firstError;
    }

    if (
      typeof firstError
        ?.message ===
      "string"
    ) {
      return firstError
        .message;
    }
  }

  return `Lithic request failed with HTTP ${status}.`;
}

function buildLithicError({
  response,
  data,
  url,
  method,
}) {
  const message =
    extractLithicErrorMessage(
      data,
      response?.status ||
        500
    );

  const error =
    new Error(
      message
    );

  error.name =
    "LithicApiError";

  error.code =
    "LITHIC_API_ERROR";

  error.status =
    response?.status ||
    500;

  error.statusText =
    response?.statusText ||
    "";

  error.url =
    url;

  error.method =
    method;

  error.response =
    data;

  return error;
}

/* ==========================================================================
   CORE LITHIC REQUEST
============================================================================ */

async function lithicRequest(
  path,
  options = {}
) {
  assertLithicConfigured();

  const method =
    normalizeString(
      options.method ||
        "GET"
    ).toUpperCase();

  const cleanPath =
    normalizeString(
      path
    );

  if (!cleanPath) {
    const error =
      new Error(
        "Lithic request path is required."
      );

    error.code =
      "LITHIC_PATH_REQUIRED";

    error.status =
      400;

    throw error;
  }

  const baseUrl =
    getLithicBaseUrl();

  const normalizedPath =
    cleanPath.startsWith(
      "/"
    )
      ? cleanPath
      : `/${cleanPath}`;

  const url =
    `${baseUrl}${normalizedPath}`;

  const controller =
    new AbortController();

  const timeoutMs =
    normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS
    );

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      timeoutMs
    );

  try {
    const headers = {
      ...getLithicHeaders(
        options
      ),

      ...(options.headers ||
        {}),
    };

    const fetchOptions = {
      method,
      headers,
      signal:
        controller.signal,
    };

    if (
      options.body !==
        undefined &&
      options.body !==
        null &&
      method !==
        "GET" &&
      method !==
        "HEAD"
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
      await parseLithicResponse(
        response
      );

    if (
      !response.ok
    ) {
      throw buildLithicError({
        response,
        data,
        url,
        method,
      });
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

      method,

      url,

      data,
    };
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          `Lithic request timed out after ${timeoutMs}ms.`
        );

      timeoutError.name =
        "LithicTimeoutError";

      timeoutError.code =
        "LITHIC_TIMEOUT";

      timeoutError.status =
        504;

      timeoutError.url =
        url;

      timeoutError.method =
        method;

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
   MEMBER NORMALIZATION
============================================================================ */

function getMemberNameParts(
  member = {}
) {
  const firstName =
    normalizeString(
      member.first_name
    ) ||
    normalizeString(
      member.firstName
    ) ||
    normalizeString(
      member.given_name
    ) ||
    normalizeString(
      member.givenName
    );

  const lastName =
    normalizeString(
      member.last_name
    ) ||
    normalizeString(
      member.lastName
    ) ||
    normalizeString(
      member.family_name
    ) ||
    normalizeString(
      member.familyName
    );

  if (
    firstName ||
    lastName
  ) {
    return {
      firstName:
        firstName ||
        "Card",

      lastName:
        lastName ||
        "Leo",
    };
  }

  const fullName =
    normalizeString(
      member.full_name
    ) ||
    normalizeString(
      member.fullName
    ) ||
    normalizeString(
      member.name
    );

  const parts =
    fullName
      .split(
        /\s+/
      )
      .filter(
        Boolean
      );

  if (
    parts.length >=
    2
  ) {
    return {
      firstName:
        parts[0],

      lastName:
        parts
          .slice(1)
          .join(" "),
    };
  }

  if (
    parts.length ===
    1
  ) {
    return {
      firstName:
        parts[0],

      lastName:
        "Member",
    };
  }

  return {
    firstName:
      "Card",

    lastName:
      "Leo",
  };
}

function getMemberEmail(
  member = {}
) {
  return normalizeEmail(
    member.email ||
      member.email_address ||
      member.emailAddress
  );
}

function getMemberPhone(
  member = {}
) {
  return normalizeString(
    member.phone ||
      member.phone_number ||
      member.phoneNumber
  );
}

function getMemberId(
  member = {}
) {
  return normalizeString(
    member.id ||
      member.member_id ||
      member.memberId ||
      member.signup_id ||
      member.signupId
  );
}

function buildMemberExternalId(
  member = {}
) {
  const id =
    getMemberId(
      member
    );

  if (id) {
    return `cardleo-${id}`.slice(
      0,
      128
    );
  }

  const email =
    getMemberEmail(
      member
    );

  if (email) {
    return `cardleo-${email}`
      .replace(
        /[^a-zA-Z0-9@._-]/g,
        ""
      )
      .slice(
        0,
        128
      );
  }

  return createRequestId(
    "cardleo-member"
  ).slice(
    0,
    128
  );
}

/* ==========================================================================
   MEMBER VALIDATION
============================================================================ */

function validateMemberForLithic(
  member = {}
) {
  const errors = {};

  const memberId =
    getMemberId(
      member
    );

  const email =
    getMemberEmail(
      member
    );

  const phone =
    getMemberPhone(
      member
    );

  const {
    firstName,
    lastName,
  } =
    getMemberNameParts(
      member
    );

  if (!memberId) {
    errors.memberId =
      "Member ID is required.";
  }

  if (!firstName) {
    errors.firstName =
      "First name is required.";
  }

  if (!lastName) {
    errors.lastName =
      "Last name is required.";
  }

  if (
    !email ||
    !isValidEmail(
      email
    )
  ) {
    errors.email =
      "A valid member email address is required.";
  }

  return {
    valid:
      Object.keys(
        errors
      ).length ===
      0,

    errors,

    values: {
      memberId,
      firstName,
      lastName,
      email,
      phone,

      externalId:
        buildMemberExternalId(
          member
        ),
    },
  };
}

/* ==========================================================================
   ACCOUNT HOLDER METADATA

   Do not fabricate KYC/KYB identity data here.
============================================================================ */

function buildAccountHolderMetadata(
  member = {}
) {
  const validation =
    validateMemberForLithic(
      member
    );

  if (
    !validation.valid
  ) {
    const error =
      new Error(
        "Member does not contain the required information for Lithic."
      );

    error.code =
      "INVALID_LITHIC_MEMBER";

    error.status =
      400;

    error.validation =
      validation.errors;

    throw error;
  }

  return {
    card_leo_member_id:
      validation.values
        .memberId,

    card_leo_external_id:
      validation.values
        .externalId,
  };
}

/* ==========================================================================
   TOKEN HELPERS
============================================================================ */

function getLithicCardToken(
  record = {}
) {
  return normalizeString(
    record.lithic_card_token ||
      record.lithicCardToken ||
      record.card_token ||
      record.cardToken
  );
}

function getLithicAccountToken(
  record = {}
) {
  return normalizeString(
    record.lithic_account_token ||
      record.lithicAccountToken ||
      record.account_token ||
      record.accountToken
  );
}

function getLithicAccountHolderToken(
  record = {}
) {
  return normalizeString(
    record
      .lithic_account_holder_token ||
      record
        .lithicAccountHolderToken ||
      record
        .account_holder_token ||
      record
        .accountHolderToken
  );
}

/* ==========================================================================
   LIST CARDS
============================================================================ */

async function listLithicCards(
  options = {}
) {
  const params =
    new URLSearchParams();

  const pageSize =
    normalizePositiveInteger(
      options.pageSize ||
        options.page_size,
      50
    );

  params.set(
    "page_size",
    String(
      Math.min(
        Math.max(
          pageSize,
          1
        ),
        100
      )
    )
  );

  const accountToken =
    normalizeString(
      options.accountToken ||
        options.account_token
    );

  if (accountToken) {
    params.set(
      "account_token",
      accountToken
    );
  }

  const state =
    normalizeString(
      options.state
    ).toUpperCase();

  if (state) {
    params.set(
      "state",
      state
    );
  }

  const memo =
    normalizeString(
      options.memo
    );

  if (memo) {
    params.set(
      "memo",
      memo
    );
  }

  const begin =
    normalizeString(
      options.begin
    );

  if (begin) {
    params.set(
      "begin",
      begin
    );
  }

  const end =
    normalizeString(
      options.end
    );

  if (end) {
    params.set(
      "end",
      end
    );
  }

  const startingAfter =
    normalizeString(
      options.startingAfter ||
        options.starting_after
    );

  if (startingAfter) {
    params.set(
      "starting_after",
      startingAfter
    );
  }

  const endingBefore =
    normalizeString(
      options.endingBefore ||
        options.ending_before
    );

  if (endingBefore) {
    params.set(
      "ending_before",
      endingBefore
    );
  }

  return lithicRequest(
    `/cards?${params.toString()}`
  );
}

/* ==========================================================================
   GET CARD
============================================================================ */

async function getLithicCard(
  cardToken
) {
  const token =
    normalizeString(
      cardToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic card token is required."
      );

    error.code =
      "LITHIC_CARD_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/cards/${encodeURIComponent(
      token
    )}`
  );
}

/* ==========================================================================
   CREATE CARD
============================================================================ */

async function createLithicCard(
  cardPayload = {},
  options = {}
) {
  if (
    !cardPayload ||
    typeof cardPayload !==
      "object" ||
    Array.isArray(
      cardPayload
    )
  ) {
    const error =
      new Error(
        "Lithic card payload must be an object."
      );

    error.code =
      "INVALID_LITHIC_CARD_PAYLOAD";

    error.status =
      400;

    throw error;
  }

  const payload = {
    ...cardPayload,
  };

  if (
    !payload.type
  ) {
    payload.type =
      CARD_LEO_DEFAULT_CARD_TYPE;
  }

  payload.type =
    normalizeString(
      payload.type
    ).toUpperCase();

  if (
    !payload.state
  ) {
    payload.state =
      CARD_LEO_DEFAULT_CARD_STATE;
  }

  payload.state =
    normalizeString(
      payload.state
    ).toUpperCase();

  /*
   * Only attach the configured Card Leo program token when the caller has
   * not supplied one explicitly.
   */

  if (
    !payload
      .card_program_token &&
    getLithicCardProgramToken()
  ) {
    payload.card_program_token =
      getLithicCardProgramToken();
  }

  return lithicRequest(
    "/cards",
    {
      method:
        "POST",

      headers: {
        ...getLithicIdempotencyHeaders(
          options
        ),

        ...(options.headers ||
          {}),
      },

      body:
        payload,

      timeoutMs:
        options.timeoutMs,
    }
  );
}

/* ==========================================================================
   UPDATE CARD
============================================================================ */

async function updateLithicCard(
  cardToken,
  updates = {},
  options = {}
) {
  const token =
    normalizeString(
      cardToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic card token is required."
      );

    error.code =
      "LITHIC_CARD_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  if (
    !updates ||
    typeof updates !==
      "object" ||
    Array.isArray(
      updates
    )
  ) {
    const error =
      new Error(
        "Lithic card updates must be an object."
      );

    error.code =
      "INVALID_LITHIC_CARD_UPDATE";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/cards/${encodeURIComponent(
      token
    )}`,
    {
      method:
        "PATCH",

      body:
        updates,

      timeoutMs:
        options.timeoutMs,
    }
  );
}

/* ==========================================================================
   CARD STATE HELPERS
============================================================================ */

async function openLithicCard(
  cardToken
) {
  return updateLithicCard(
    cardToken,
    {
      state:
        "OPEN",
    }
  );
}

async function pauseLithicCard(
  cardToken
) {
  return updateLithicCard(
    cardToken,
    {
      state:
        "PAUSED",
    }
  );
}

async function closeLithicCard(
  cardToken
) {
  return updateLithicCard(
    cardToken,
    {
      state:
        "CLOSED",
    }
  );
}

/* ==========================================================================
   ACCOUNTS
============================================================================ */

async function listLithicAccounts(
  options = {}
) {
  const params =
    new URLSearchParams();

  const pageSize =
    normalizePositiveInteger(
      options.pageSize ||
        options.page_size,
      50
    );

  params.set(
    "page_size",
    String(
      Math.min(
        Math.max(
          pageSize,
          1
        ),
        100
      )
    )
  );

  const startingAfter =
    normalizeString(
      options.startingAfter ||
        options.starting_after
    );

  if (startingAfter) {
    params.set(
      "starting_after",
      startingAfter
    );
  }

  const endingBefore =
    normalizeString(
      options.endingBefore ||
        options.ending_before
    );

  if (endingBefore) {
    params.set(
      "ending_before",
      endingBefore
    );
  }

  return lithicRequest(
    `/accounts?${params.toString()}`
  );
}

async function getLithicAccount(
  accountToken
) {
  const token =
    normalizeString(
      accountToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic account token is required."
      );

    error.code =
      "LITHIC_ACCOUNT_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/accounts/${encodeURIComponent(
      token
    )}`
  );
}

/* ==========================================================================
   ACCOUNT HOLDERS
============================================================================ */

async function createLithicAccountHolder(
  payload = {},
  options = {}
) {
  if (
    !payload ||
    typeof payload !==
      "object" ||
    Array.isArray(
      payload
    )
  ) {
    const error =
      new Error(
        "Lithic account-holder payload must be an object."
      );

    error.code =
      "INVALID_LITHIC_ACCOUNT_HOLDER_PAYLOAD";

    error.status =
      400;

    throw error;
  }

  /*
   * KYC/KYB identity fields MUST be supplied by the approved onboarding
   * workflow. Never manufacture SSNs, DOBs, addresses, tax IDs, or other
   * identity data.
   */

  return lithicRequest(
    "/account_holders",
    {
      method:
        "POST",

      headers: {
        ...getLithicIdempotencyHeaders(
          options
        ),

        ...(options.headers ||
          {}),
      },

      body: {
        ...payload,
      },

      timeoutMs:
        options.timeoutMs,
    }
  );
}

async function listLithicAccountHolders(
  options = {}
) {
  const params =
    new URLSearchParams();

  const pageSize =
    normalizePositiveInteger(
      options.pageSize ||
        options.page_size,
      50
    );

  params.set(
    "page_size",
    String(
      Math.min(
        Math.max(
          pageSize,
          1
        ),
        100
      )
    )
  );

  const startingAfter =
    normalizeString(
      options.startingAfter ||
        options.starting_after
    );

  if (startingAfter) {
    params.set(
      "starting_after",
      startingAfter
    );
  }

  const endingBefore =
    normalizeString(
      options.endingBefore ||
        options.ending_before
    );

  if (endingBefore) {
    params.set(
      "ending_before",
      endingBefore
    );
  }

  return lithicRequest(
    `/account_holders?${params.toString()}`
  );
}

async function getLithicAccountHolder(
  accountHolderToken
) {
  const token =
    normalizeString(
      accountHolderToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic account-holder token is required."
      );

    error.code =
      "LITHIC_ACCOUNT_HOLDER_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/account_holders/${encodeURIComponent(
      token
    )}`
  );
}

/* ==========================================================================
   CARD PROGRAMS
============================================================================ */

async function listLithicCardPrograms(
  options = {}
) {
  const params =
    new URLSearchParams();

  const pageSize =
    normalizePositiveInteger(
      options.pageSize ||
        options.page_size,
      50
    );

  params.set(
    "page_size",
    String(
      Math.min(
        Math.max(
          pageSize,
          1
        ),
        100
      )
    )
  );

  const startingAfter =
    normalizeString(
      options.startingAfter ||
        options.starting_after
    );

  if (startingAfter) {
    params.set(
      "starting_after",
      startingAfter
    );
  }

  const endingBefore =
    normalizeString(
      options.endingBefore ||
        options.ending_before
    );

  if (endingBefore) {
    params.set(
      "ending_before",
      endingBefore
    );
  }

  return lithicRequest(
    `/card_programs?${params.toString()}`
  );
}

async function getLithicCardProgram(
  cardProgramToken
) {
  const token =
    normalizeString(
      cardProgramToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic card program token is required."
      );

    error.code =
      "LITHIC_CARD_PROGRAM_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/card_programs/${encodeURIComponent(
      token
    )}`
  );
}

/* ==========================================================================
   TRANSACTIONS
============================================================================ */

async function listLithicTransactions(
  options = {}
) {
  const params =
    new URLSearchParams();

  const pageSize =
    normalizePositiveInteger(
      options.pageSize ||
        options.page_size,
      50
    );

  params.set(
    "page_size",
    String(
      Math.min(
        Math.max(
          pageSize,
          1
        ),
        100
      )
    )
  );

  const cardToken =
    normalizeString(
      options.cardToken ||
        options.card_token
    );

  if (cardToken) {
    params.set(
      "card_token",
      cardToken
    );
  }

  const accountToken =
    normalizeString(
      options.accountToken ||
        options.account_token
    );

  if (accountToken) {
    params.set(
      "account_token",
      accountToken
    );
  }

  const startingAfter =
    normalizeString(
      options.startingAfter ||
        options.starting_after
    );

  if (startingAfter) {
    params.set(
      "starting_after",
      startingAfter
    );
  }

  const endingBefore =
    normalizeString(
      options.endingBefore ||
        options.ending_before
    );

  if (endingBefore) {
    params.set(
      "ending_before",
      endingBefore
    );
  }

  return lithicRequest(
    `/transactions?${params.toString()}`
  );
}

async function getLithicTransaction(
  transactionToken
) {
  const token =
    normalizeString(
      transactionToken
    );

  if (!token) {
    const error =
      new Error(
        "Lithic transaction token is required."
      );

    error.code =
      "LITHIC_TRANSACTION_TOKEN_REQUIRED";

    error.status =
      400;

    throw error;
  }

  return lithicRequest(
    `/transactions/${encodeURIComponent(
      token
    )}`
  );
}

/* ==========================================================================
   SAFE CARD DISPLAY
============================================================================ */

function maskCardNumber(
  value
) {
  const digits =
    normalizeString(
      value
    ).replace(
      /\D/g,
      ""
    );

  if (!digits) {
    return "";
  }

  const lastFour =
    digits.slice(
      -4
    );

  return `•••• •••• •••• ${lastFour}`;
}

function getLastFour(
  card = {}
) {
  const explicit =
    normalizeString(
      card.last_four
    ) ||
    normalizeString(
      card.lastFour
    );

  if (explicit) {
    return explicit.slice(
      -4
    );
  }

  const pan =
    normalizeString(
      card.pan
    ) ||
    normalizeString(
      card.card_number
    );

  return pan
    .replace(
      /\D/g,
      ""
    )
    .slice(
      -4
    );
}

function sanitizeLithicCard(
  card = {}
) {
  if (
    !card ||
    typeof card !==
      "object"
  ) {
    return null;
  }

  const lastFour =
    getLastFour(
      card
    );

  return {
    token:
      normalizeString(
        card.token
      ) ||
      normalizeString(
        card.card_token
      ) ||
      null,

    accountToken:
      normalizeString(
        card.account_token
      ) ||
      null,

    cardholderToken:
      normalizeString(
        card.cardholder_token
      ) ||
      normalizeString(
        card.account_holder_token
      ) ||
      null,

    type:
      normalizeString(
        card.type
      ) ||
      null,

    state:
      normalizeString(
        card.state
      ) ||
      null,

    memo:
      normalizeString(
        card.memo
      ) ||
      null,

    lastFour:
      lastFour ||
      null,

    maskedNumber:
      lastFour
        ? `•••• •••• •••• ${lastFour}`
        : null,

    spendLimit:
      card.spend_limit ??
      null,

    spendLimitDuration:
      card
        .spend_limit_duration ??
      null,

    created:
      card.created ??
      null,
  };
}

/* ==========================================================================
   SAFE TRANSACTION DISPLAY
============================================================================ */

function sanitizeLithicTransaction(
  transaction = {}
) {
  if (
    !transaction ||
    typeof transaction !==
      "object"
  ) {
    return null;
  }

  const amount =
    typeof transaction
      .amount ===
    "number"
      ? transaction.amount
      : null;

  return {
    token:
      normalizeString(
        transaction.token
      ) ||
      null,

    cardToken:
      normalizeString(
        transaction
          .card_token
      ) ||
      null,

    accountToken:
      normalizeString(
        transaction
          .account_token
      ) ||
      null,

    status:
      normalizeString(
        transaction.status
      ) ||
      null,

    result:
      normalizeString(
        transaction.result
      ) ||
      null,

    merchant:
      transaction.merchant ||
      null,

    amountCents:
      amount,

    amount:
      amount !== null
        ? centsToDollars(
            amount
          )
        : null,

    created:
      transaction.created ??
      null,

    settledAmount:
      transaction
        .settled_amount ??
      null,
  };
}

/* ==========================================================================
   ALLOWANCE HELPERS
============================================================================ */

function normalizeAllowanceAmount(
  amount
) {
  const cents =
    normalizeMoneyToCents(
      amount
    );

  if (
    cents <= 0
  ) {
    const error =
      new Error(
        "Allowance amount must be greater than $0."
      );

    error.code =
      "INVALID_ALLOWANCE_AMOUNT";

    error.status =
      400;

    throw error;
  }

  return {
    cents,

    dollars:
      centsToDollars(
        cents
      ),
  };
}

function buildAllowanceMetadata({
  memberId,
  rewardId,
  source =
    "card-leo-rewards",
  description =
    "Card Leo member allowance",
} = {}) {
  return {
    member_id:
      normalizeString(
        memberId
      ) ||
      null,

    reward_id:
      normalizeString(
        rewardId
      ) ||
      null,

    source:
      normalizeString(
        source
      ) ||
      "card-leo-rewards",

    description:
      normalizeString(
        description
      ) ||
      "Card Leo member allowance",
  };
}

/* ==========================================================================
   DATABASE MAPPING
============================================================================ */

function mapLithicCardToDatabase(
  card = {},
  memberId = ""
) {
  const safeCard =
    sanitizeLithicCard(
      card
    );

  if (!safeCard) {
    return null;
  }

  return {
    member_id:
      normalizeString(
        memberId
      ) ||
      null,

    provider:
      "lithic",

    lithic_card_token:
      safeCard.token,

    lithic_account_token:
      safeCard.accountToken,

    lithic_account_holder_token:
      safeCard.cardholderToken,

    card_type:
      safeCard.type,

    card_status:
      safeCard.state,

    last_four:
      safeCard.lastFour,

    card_memo:
      safeCard.memo,

    updated_at:
      new Date()
        .toISOString(),
  };
}

/* ==========================================================================
   INTEGRATION STATUS
============================================================================ */

function getLithicIntegrationStatus() {
  const configured =
    isLithicConfigured();

  const hasCardProgramToken =
    Boolean(
      getLithicCardProgramToken()
    );

  const hasProductId =
    Boolean(
      getLithicProductId()
    );

  return {
    provider:
      "lithic",

    enabled:
      isLithicEnabled(),

    configured,

    readyForApiRequests:
      configured,

    readyForCardCreation:
      configured,

    hasCardProgramToken,

    hasProductId,

    environment:
      getLithicEnvironment(),

    sandbox:
      isLithicSandbox(),

    production:
      isLithicProduction(),

    message:
      configured
        ? `Lithic ${getLithicEnvironment()} integration is configured.`
        : isLithicEnabled()
          ? "Lithic is enabled, but the API key is missing."
          : "Lithic integration is prepared but currently disabled.",
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* ------------------------------------------------------------------------
     CONSTANTS
  ------------------------------------------------------------------------ */

  LITHIC_SANDBOX_BASE_URL,
  LITHIC_PRODUCTION_BASE_URL,

  CARD_LEO_DEFAULT_CARD_TYPE,
  CARD_LEO_DEFAULT_CARD_STATE,

  /* ------------------------------------------------------------------------
     CONFIGURATION
  ------------------------------------------------------------------------ */

  getLithicEnvironment,
  getLithicBaseUrl,
  getLithicApiKey,
  getLithicCardProgramToken,
  getLithicProductId,

  getLithicConfigForDebug,
  getLithicIntegrationStatus,

  /* ------------------------------------------------------------------------
     STATE
  ------------------------------------------------------------------------ */

  isLithicEnabled,
  isLithicConfigured,
  isLithicSandbox,
  isLithicProduction,

  hasLithicApiKey,
  assertLithicConfigured,

  /* ------------------------------------------------------------------------
     REQUESTS
  ------------------------------------------------------------------------ */

  getLithicHeaders,
  getLithicIdempotencyHeaders,

  lithicRequest,
  parseLithicResponse,

  /* ------------------------------------------------------------------------
     IDS
  ------------------------------------------------------------------------ */

  createRequestId,
  createIdempotencyKey,

  /* ------------------------------------------------------------------------
     MEMBER
  ------------------------------------------------------------------------ */

  getMemberNameParts,
  getMemberEmail,
  getMemberPhone,
  getMemberId,

  buildMemberExternalId,
  validateMemberForLithic,
  buildAccountHolderMetadata,

  /* ------------------------------------------------------------------------
     TOKEN HELPERS
  ------------------------------------------------------------------------ */

  getLithicCardToken,
  getLithicAccountToken,
  getLithicAccountHolderToken,

  /* ------------------------------------------------------------------------
     CARDS
  ------------------------------------------------------------------------ */

  listLithicCards,
  getLithicCard,

  createLithicCard,
  updateLithicCard,

  openLithicCard,
  pauseLithicCard,
  closeLithicCard,

  /* ------------------------------------------------------------------------
     ACCOUNTS
  ------------------------------------------------------------------------ */

  listLithicAccounts,
  getLithicAccount,

  /* ------------------------------------------------------------------------
     ACCOUNT HOLDERS
  ------------------------------------------------------------------------ */

  createLithicAccountHolder,
  listLithicAccountHolders,
  getLithicAccountHolder,

  /* ------------------------------------------------------------------------
     CARD PROGRAMS
  ------------------------------------------------------------------------ */

  listLithicCardPrograms,
  getLithicCardProgram,

  /* ------------------------------------------------------------------------
     TRANSACTIONS
  ------------------------------------------------------------------------ */

  listLithicTransactions,
  getLithicTransaction,

  /* ------------------------------------------------------------------------
     SAFE DISPLAY
  ------------------------------------------------------------------------ */

  maskCardNumber,
  getLastFour,

  sanitizeLithicCard,
  sanitizeLithicTransaction,

  /* ------------------------------------------------------------------------
     ALLOWANCES
  ------------------------------------------------------------------------ */

  normalizeAllowanceAmount,
  buildAllowanceMetadata,

  /* ------------------------------------------------------------------------
     DATABASE
  ------------------------------------------------------------------------ */

  mapLithicCardToDatabase,

  /* ------------------------------------------------------------------------
     GENERAL
  ------------------------------------------------------------------------ */

  normalizeString,
  normalizeEmail,
  normalizeBoolean,

  normalizeMoneyToCents,
  centsToDollars,

  safeJsonStringify,
};