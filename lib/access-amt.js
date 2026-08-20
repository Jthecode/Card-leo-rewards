// lib/access-amt.js

/* ==========================================================================
   CARD LEO REWARDS
   ACCESS DEVELOPMENT — AMT MEMBER SYNC

   PURPOSE
   -------
   Handles Card Leo member enrollment/update/suspension in Access AMT.

   Access confirmed the same AMT endpoint is used to:
   - create a member
   - update a member
   - suspend a member

   STAGE:
   https://amt-stage.accessdevelopment.com/api/v1/imports

   PRODUCTION:
   https://amt.accessdevelopment.com/api/v1/imports

   IMPORTANT
   ---------
   This file is ONLY for Access Development / Access Perks membership sync.

   Do NOT place:
   - referral payouts
   - allowance logic
   - Growth Pool logic
   - Lithic card funding
   - reward transaction creation

   inside this helper.

============================================================================ */

/* ==========================================================================
   DEFAULT CONFIG
============================================================================ */

const DEFAULT_STAGE_BASE_URL =
  "https://amt-stage.accessdevelopment.com/api/v1";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://amt.accessdevelopment.com/api/v1";

const DEFAULT_AMT_ENDPOINT_PATH =
  "/imports";

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER =
  "2002479";

const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER =
  "200783";

const OPEN_STATUS =
  "OPEN";

const SUSPEND_STATUS =
  "SUSPEND";

/* ==========================================================================
   GENERAL HELPERS
============================================================================ */

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeString(value).toUpperCase();
}

function onlyAlphaNumeric(value) {
  return normalizeString(value).replace(
    /[^a-zA-Z0-9]/g,
    ""
  );
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(value)
  );
}

function getEnv(name, fallback = "") {
  return normalizeString(
    process.env[name] ?? fallback
  );
}

function cleanBaseUrl(value) {
  return normalizeString(value).replace(
    /\/+$/,
    ""
  );
}

function normalizeEndpointPath(value) {
  const clean =
    normalizeString(value);

  if (!clean) {
    return "";
  }

  if (
    clean === "/" ||
    clean.toLowerCase() === "root" ||
    clean.toLowerCase() === "base"
  ) {
    return "";
  }

  return clean.startsWith("/")
    ? clean
    : `/${clean}`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/* ==========================================================================
   ENVIRONMENT
============================================================================ */

function getAccessEnvironment() {
  const env =
    getEnv(
      "ACCESS_ENVIRONMENT",
      "stage"
    ).toLowerCase();

  if (
    env === "production" ||
    env === "prod" ||
    env === "live"
  ) {
    return "production";
  }

  return "stage";
}

function isAccessProduction() {
  return (
    getAccessEnvironment() ===
    "production"
  );
}

function isAccessStage() {
  return !isAccessProduction();
}

/* ==========================================================================
   BASE URL
============================================================================ */

function getAccessAmtBaseUrl() {
  const configured =
    getEnv(
      "ACCESS_AMT_BASE_URL"
    );

  if (configured) {
    return cleanBaseUrl(
      configured
    );
  }

  return isAccessProduction()
    ? DEFAULT_PRODUCTION_BASE_URL
    : DEFAULT_STAGE_BASE_URL;
}

/* ==========================================================================
   TOKEN
============================================================================ */

function getAccessAmtToken() {
  return (
    getEnv(
      "ACCESS_AMT_API_TOKEN"
    ) ||
    getEnv(
      "ACCESS_API_TOKEN"
    ) ||
    getEnv(
      "ACCESS_OFFERS_API_TOKEN"
    ) ||
    getEnv(
      "ACCESS_CURRENT_ACCESS_TOKEN"
    )
  );
}

function hasAccessAmtToken() {
  return Boolean(
    getAccessAmtToken()
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
   AMT ENDPOINT

   Access confirmed:
   /imports
============================================================================ */

function getAccessAmtEndpointPath() {
  const configured =
    getEnv(
      "ACCESS_AMT_ENDPOINT_PATH"
    );

  if (configured) {
    const normalized =
      normalizeEndpointPath(
        configured
      );

    /*
     * If Vercel is still set to "root" or "/",
     * do NOT silently use the root anymore.
     *
     * We now know the correct endpoint is /imports.
     */

    if (!normalized) {
      return DEFAULT_AMT_ENDPOINT_PATH;
    }

    return normalized;
  }

  return DEFAULT_AMT_ENDPOINT_PATH;
}

function getAccessAmtUrl() {
  return `${getAccessAmtBaseUrl()}${getAccessAmtEndpointPath()}`;
}

/* ==========================================================================
   MEMBER NAME
============================================================================ */

function getMemberNameParts(member = {}) {
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

  const parts =
    fullName
      .split(/\s+/)
      .filter(Boolean);

  if (
    parts.length >= 2
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
    parts.length === 1
  ) {
    return {
      firstName:
        parts[0],

      lastName:
        "Member",
    };
  }

  const emailPrefix =
    normalizeEmail(
      member.email
    ).split("@")[0];

  return {
    firstName:
      emailPrefix ||
      "Card",

    lastName:
      "Leo",
  };
}

/* ==========================================================================
   MEMBER CUSTOMER IDENTIFIER
============================================================================ */

function buildMemberCustomerIdentifier(
  member = {}
) {
  const existing =
    normalizeString(
      member
        .access_member_identifier
    ) ||
    normalizeString(
      member
        .accessMemberIdentifier
    ) ||
    normalizeString(
      member
        .member_customer_identifier
    ) ||
    normalizeString(
      member
        .memberCustomerIdentifier
    );

  if (existing) {
    const cleaned =
      onlyAlphaNumeric(
        existing
      );

    if (cleaned) {
      return cleaned.slice(
        0,
        64
      );
    }
  }

  const id =
    onlyAlphaNumeric(
      member.id
    );

  if (id) {
    return `CLR${id}`.slice(
      0,
      64
    );
  }

  const email =
    normalizeEmail(
      member.email
    );

  const emailPrefix =
    onlyAlphaNumeric(
      email.split("@")[0]
    );

  /*
   * Fallback only.
   *
   * Real members normally have a Supabase id,
   * so this should rarely be used.
   */

  const timestamp =
    Date.now()
      .toString();

  return `CLR${
    emailPrefix ||
    "MEMBER"
  }${timestamp}`.slice(
    0,
    64
  );
}

/* ==========================================================================
   MEMBER STATUS VALIDATION
============================================================================ */

function normalizeAccessMemberStatus(
  value
) {
  const status =
    normalizeStatus(
      value
    );

  if (
    status ===
    SUSPEND_STATUS
  ) {
    return SUSPEND_STATUS;
  }

  return OPEN_STATUS;
}

/* ==========================================================================
   BUILD AMT MEMBER
============================================================================ */

function buildAccessAmtMemberPayload(
  member = {},
  memberStatus =
    OPEN_STATUS
) {
  const email =
    normalizeEmail(
      member.email ||
      member.email_address ||
      member.emailAddress
    );

  if (
    !email ||
    !isValidEmail(email)
  ) {
    const error =
      new Error(
        "A valid member email is required for Access AMT sync."
      );

    error.code =
      "ACCESS_MEMBER_EMAIL_REQUIRED";

    throw error;
  }

  const {
    firstName,
    lastName,
  } =
    getMemberNameParts(
      member
    );

  const memberCustomerIdentifier =
    buildMemberCustomerIdentifier(
      member
    );

  return {
    organization_customer_identifier:
      getOrganizationCustomerIdentifier(),

    program_customer_identifier:
      getProgramCustomerIdentifier(),

    first_name:
      firstName,

    last_name:
      lastName,

    email_address:
      email,

    member_customer_identifier:
      memberCustomerIdentifier,

    member_status:
      normalizeAccessMemberStatus(
        memberStatus
      ),
  };
}

/* ==========================================================================
   BUILD IMPORT PAYLOAD
============================================================================ */

function buildAccessAmtImportPayload(
  member = {},
  memberStatus =
    OPEN_STATUS
) {
  return {
    import: {
      members: [
        buildAccessAmtMemberPayload(
          member,
          memberStatus
        ),
      ],
    },
  };
}

/* ==========================================================================
   AUTH HEADERS
============================================================================ */

function getAuthHeaders(
  token
) {
  const cleanToken =
    normalizeString(
      token
    );

  if (!cleanToken) {
    const error =
      new Error(
        "Missing Access AMT token. Add ACCESS_AMT_API_TOKEN in Vercel."
      );

    error.code =
      "ACCESS_AMT_TOKEN_MISSING";

    throw error;
  }

  return {
    "Content-Type":
      "application/json",

    Accept:
      "application/json",

    /*
     * Keep both because your current Access setup
     * has been using the Current Access Token.
     */

    Authorization:
      `Bearer ${cleanToken}`,

    "X-Access-Token":
      cleanToken,
  };
}

/* ==========================================================================
   RESPONSE PARSER
============================================================================ */

async function parseAccessResponse(
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
   ACCESS ERROR MESSAGE
============================================================================ */

function getAccessErrorMessage(
  data,
  status
) {
  if (
    typeof data?.message ===
      "string" &&
    data.message.trim()
  ) {
    return data.message.trim();
  }

  if (
    typeof data?.error ===
      "string" &&
    data.error.trim()
  ) {
    return data.error.trim();
  }

  if (
    typeof data?.error?.message ===
      "string" &&
    data.error.message.trim()
  ) {
    return data.error.message.trim();
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
    `Access AMT request failed with status ${status}.`
  );
}

/* ==========================================================================
   ACCESS POST
============================================================================ */

async function postToAccessAmt(
  payload,
  options = {}
) {
  const token =
    normalizeString(
      options.token
    ) ||
    getAccessAmtToken();

  const url =
    normalizeString(
      options.url
    ) ||
    getAccessAmtUrl();

  if (!url) {
    const error =
      new Error(
        "Access AMT URL is missing."
      );

    error.code =
      "ACCESS_AMT_URL_MISSING";

    throw error;
  }

  const controller =
    new AbortController();

  const timeoutMs =
    Number(
      options.timeoutMs ||
      20000
    );

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      Number.isFinite(
        timeoutMs
      )
        ? timeoutMs
        : 20000
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          headers:
            getAuthHeaders(
              token
            ),

          body:
            JSON.stringify(
              payload
            ),

          signal:
            controller.signal,
        }
      );

    const data =
      await parseAccessResponse(
        response
      );

    if (!response.ok) {
      const message =
        getAccessErrorMessage(
          data,
          response.status
        );

      const error =
        new Error(
          message
        );

      error.name =
        "AccessAmtError";

      error.code =
        "ACCESS_AMT_REQUEST_FAILED";

      error.status =
        response.status;

      error.statusText =
        response.statusText;

      error.url =
        url;

      error.payload =
        payload;

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

      payload,

      response:
        data,
    };
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          "Access AMT request timed out."
        );

      timeoutError.name =
        "AccessAmtTimeoutError";

      timeoutError.code =
        "ACCESS_AMT_TIMEOUT";

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
   SYNC OPEN MEMBER
============================================================================ */

async function syncMemberToAccessAmt(
  member = {},
  options = {}
) {
  const payload =
    buildAccessAmtImportPayload(
      member,
      OPEN_STATUS
    );

  const result =
    await postToAccessAmt(
      payload,
      options
    );

  const syncedMember =
    payload
      .import
      .members[0];

  return {
    ...result,

    access_member_identifier:
      syncedMember
        .member_customer_identifier,

    access_member_status:
      OPEN_STATUS,

    access_perks_ready:
      true,

    access_payload:
      payload,

    access_response:
      result.response,
  };
}

/* ==========================================================================
   SUSPEND MEMBER
============================================================================ */

async function suspendMemberInAccessAmt(
  member = {},
  options = {}
) {
  const payload =
    buildAccessAmtImportPayload(
      member,
      SUSPEND_STATUS
    );

  const result =
    await postToAccessAmt(
      payload,
      options
    );

  const syncedMember =
    payload
      .import
      .members[0];

  return {
    ...result,

    access_member_identifier:
      syncedMember
        .member_customer_identifier,

    access_member_status:
      SUSPEND_STATUS,

    access_perks_ready:
      false,

    access_payload:
      payload,

    access_response:
      result.response,
  };
}

/* ==========================================================================
   ACTIVE CARD LEO MEMBER
============================================================================ */

function isAccessActiveMember(
  member = {}
) {
  const status =
    normalizeString(
      member.status
    ).toLowerCase();

  const paymentStatus =
    normalizeString(
      member.payment_status
    ).toLowerCase();

  const membershipStatus =
    normalizeString(
      member.membership_status
    ).toLowerCase();

  const approvalStatus =
    normalizeString(
      member.approval_status
    ).toLowerCase();

  const inactiveStatuses =
    new Set([
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

  if (
    inactiveStatuses.has(
      status
    ) ||
    inactiveStatuses.has(
      paymentStatus
    ) ||
    inactiveStatuses.has(
      membershipStatus
    ) ||
    inactiveStatuses.has(
      approvalStatus
    )
  ) {
    return false;
  }

  const activeStatuses =
    new Set([
      "active",
      "approved",
      "paid",
      "current",
      "complete",
      "completed",
      "succeeded",
      "auto_approved",
    ]);

  return (
    activeStatuses.has(
      status
    ) ||
    activeStatuses.has(
      paymentStatus
    ) ||
    activeStatuses.has(
      membershipStatus
    ) ||
    activeStatuses.has(
      approvalStatus
    )
  );
}

/* ==========================================================================
   DETERMINE ACCESS STATUS FROM CARD LEO MEMBER
============================================================================ */

function getDesiredAccessMemberStatus(
  member = {}
) {
  return isAccessActiveMember(
    member
  )
    ? OPEN_STATUS
    : SUSPEND_STATUS;
}

/* ==========================================================================
   SMART MEMBER SYNC
============================================================================ */

async function syncMemberAccessState(
  member = {},
  options = {}
) {
  const desiredStatus =
    getDesiredAccessMemberStatus(
      member
    );

  if (
    desiredStatus ===
    SUSPEND_STATUS
  ) {
    return suspendMemberInAccessAmt(
      member,
      options
    );
  }

  return syncMemberToAccessAmt(
    member,
    options
  );
}

/* ==========================================================================
   SAFE DEBUG CONFIG
============================================================================ */

function getAccessAmtConfigForDebug() {
  return {
    environment:
      getAccessEnvironment(),

    production:
      isAccessProduction(),

    stage:
      isAccessStage(),

    baseUrl:
      getAccessAmtBaseUrl(),

    endpointPath:
      getAccessAmtEndpointPath(),

    url:
      getAccessAmtUrl(),

    organizationCustomerIdentifier:
      getOrganizationCustomerIdentifier(),

    programCustomerIdentifier:
      getProgramCustomerIdentifier(),

    hasToken:
      hasAccessAmtToken(),

    /*
     * Never return the actual token.
     */

    tokenLength:
      getAccessAmtToken()
        ? getAccessAmtToken().length
        : 0,
  };
}

/* ==========================================================================
   CONFIG VALIDATION
============================================================================ */

function validateAccessAmtConfiguration() {
  const errors =
    {};

  if (
    !getAccessAmtBaseUrl()
  ) {
    errors.baseUrl =
      "Access AMT base URL is missing.";
  }

  if (
    !getAccessAmtEndpointPath()
  ) {
    errors.endpointPath =
      "Access AMT endpoint path is missing.";
  }

  if (
    !getAccessAmtToken()
  ) {
    errors.token =
      "Access AMT API token is missing.";
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
      ).length === 0,

    errors,

    config:
      getAccessAmtConfigForDebug(),
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,

  OPEN_STATUS,
  SUSPEND_STATUS,

  normalizeString,
  normalizeEmail,

  buildAccessAmtMemberPayload,
  buildAccessAmtImportPayload,
  buildMemberCustomerIdentifier,

  getAccessEnvironment,
  isAccessProduction,
  isAccessStage,

  getAccessAmtBaseUrl,
  getAccessAmtEndpointPath,
  getAccessAmtToken,
  getAccessAmtUrl,

  getOrganizationCustomerIdentifier,
  getProgramCustomerIdentifier,

  getAccessAmtConfigForDebug,
  validateAccessAmtConfiguration,

  isAccessActiveMember,
  getDesiredAccessMemberStatus,

  parseAccessResponse,
  postToAccessAmt,

  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
  syncMemberAccessState,

  safeJsonStringify,
};