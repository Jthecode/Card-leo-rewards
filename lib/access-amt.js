// lib/access-amt.js

/* ==========================================================================
   CARD LEO REWARDS
   ACCESS DEVELOPMENT — AMT MEMBER SYNC

   PURPOSE
   -------
   Central server-only helper for Card Leo Rewards member synchronization
   with Access Development / Access Perks AMT.

   THIS FILE HANDLES
   -----------------
   - member enrollment
   - member updates
   - member suspension
   - member customer identifier generation
   - stage / production environment switching
   - Access AMT authentication
   - timeout handling
   - response parsing
   - safe configuration diagnostics
   - Card Leo -> Access OPEN/SUSPEND status mapping

   ACCESS AMT ENDPOINTS
   --------------------
   Stage:
     https://amt-stage.accessdevelopment.com/api/v1/imports

   Production:
     https://amt.accessdevelopment.com/api/v1/imports

   IMPORTANT
   ---------
   This helper is ONLY for Access membership synchronization.

   Do NOT place:
   - referral payout logic
   - rewards logic
   - allowance funding
   - Growth Pool logic
   - Stripe billing
   - Lithic card creation
   - card funding

   inside this file.

   SECURITY
   --------
   ACCESS_AMT_API_TOKEN must remain SERVER-SIDE ONLY.

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

const DEFAULT_TIMEOUT_MS =
  20000;

const OPEN_STATUS =
  "OPEN";

const SUSPEND_STATUS =
  "SUSPEND";

/* ==========================================================================
   CARD LEO STATUS RULES
============================================================================ */

const ACTIVE_STATUSES =
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

const BLOCKED_STATUSES =
  new Set([
    "inactive",
    "disabled",
    "suspended",
    "paused",
    "denied",
    "closed",
    "cancelled",
    "canceled",
  ]);

const UNPAID_STATUSES =
  new Set([
    "unpaid",
    "payment_pending",
    "pending_payment",
    "requires_payment",
    "incomplete",
    "past_due",
    "failed",
    "payment_failed",
  ]);

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

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

function normalizeStatus(
  value
) {
  return normalizeString(
    value
  ).toUpperCase();
}

function normalizeLowerStatus(
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
    normalizeString(
      value
    ).toLowerCase();

  if (!normalized) {
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
      "disabled",
    ].includes(
      normalized
    )
  ) {
    return false;
  }

  return fallback;
}

function normalizePositiveInteger(
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
    ) ||
    parsed <= 0
  ) {
    return fallback;
  }

  return parsed;
}

function onlyAlphaNumeric(
  value
) {
  return normalizeString(
    value
  ).replace(
    /[^a-zA-Z0-9]/g,
    ""
  );
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

function normalizeEndpointPath(
  value
) {
  const clean =
    normalizeString(
      value
    );

  if (!clean) {
    return "";
  }

  if (
    clean === "/" ||
    clean.toLowerCase() ===
      "root" ||
    clean.toLowerCase() ===
      "base"
  ) {
    return "";
  }

  return clean.startsWith(
    "/"
  )
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

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
  );
}

/* ==========================================================================
   ACCESS ENVIRONMENT
============================================================================ */

function getAccessEnvironment() {
  const environment =
    getEnv(
      "ACCESS_ENVIRONMENT",
      "stage"
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
   ACCESS ENABLED STATE
============================================================================ */

function isAccessAmtEnabled() {
  /*
   * ACCESS_AMT_ENABLED is optional for backward compatibility.
   *
   * If it is completely absent, Access is treated as enabled when a token
   * exists. This prevents older Card Leo deployments from unexpectedly
   * disabling their working AMT integration.
   */

  const raw =
    getEnv(
      "ACCESS_AMT_ENABLED"
    );

  if (!raw) {
    return Boolean(
      getAccessAmtToken()
    );
  }

  return normalizeBoolean(
    raw,
    false
  );
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
     * Access AMT member imports use /imports.
     *
     * Older Card Leo configuration sometimes used "root" or "/".
     * Those values are normalized back to the correct /imports endpoint.
     */

    if (!normalized) {
      return DEFAULT_AMT_ENDPOINT_PATH;
    }

    return normalized;
  }

  return DEFAULT_AMT_ENDPOINT_PATH;
}

function getAccessAmtUrl() {
  return (
    `${getAccessAmtBaseUrl()}` +
    `${getAccessAmtEndpointPath()}`
  );
}

/* ==========================================================================
   MEMBER NAME
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
      member.email ||
      member.email_address ||
      member.emailAddress
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

   IMPORTANT
   ---------
   The Access member identifier must remain stable.

   Priority:
   1. Existing saved Access identifier
   2. Card Leo member/Supabase ID
   3. Email fallback

   We do NOT generate a new timestamp identifier when an email exists because
   repeated sync attempts should represent the same Access member.
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

  const memberId =
    onlyAlphaNumeric(
      member.id ||
      member.member_id ||
      member.memberId ||
      member.signup_id ||
      member.signupId
    );

  if (memberId) {
    return `CLR${memberId}`.slice(
      0,
      64
    );
  }

  const email =
    normalizeEmail(
      member.email ||
      member.email_address ||
      member.emailAddress
    );

  const emailIdentifier =
    onlyAlphaNumeric(
      email
    );

  if (emailIdentifier) {
    return `CLR${emailIdentifier}`.slice(
      0,
      64
    );
  }

  const fallback =
    Date.now()
      .toString();

  return `CLRMEMBER${fallback}`.slice(
    0,
    64
  );
}

/* ==========================================================================
   ACCESS MEMBER STATUS
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
   BUILD AMT MEMBER PAYLOAD
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
    !isValidEmail(
      email
    )
  ) {
    const error =
      new Error(
        "A valid member email is required for Access AMT sync."
      );

    error.name =
      "AccessMemberValidationError";

    error.code =
      "ACCESS_MEMBER_EMAIL_REQUIRED";

    error.status =
      400;

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

  if (
    !memberCustomerIdentifier
  ) {
    const error =
      new Error(
        "Unable to generate Access member customer identifier."
      );

    error.name =
      "AccessMemberValidationError";

    error.code =
      "ACCESS_MEMBER_IDENTIFIER_REQUIRED";

    error.status =
      400;

    throw error;
  }

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

    error.name =
      "AccessAmtConfigurationError";

    error.code =
      "ACCESS_AMT_TOKEN_MISSING";

    error.status =
      503;

    throw error;
  }

  return {
    "Content-Type":
      "application/json",

    Accept:
      "application/json",

    /*
     * Keep both headers for compatibility with the current Access account
     * configuration.
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
    isObject(
      data?.error
    ) &&
    typeof data.error
      .message ===
      "string"
  ) {
    return data.error
      .message
      .trim();
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
      typeof first
        ?.message ===
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
   SANITIZE ERROR PAYLOAD FOR LOGGING

   Do not expose Access token in errors.
============================================================================ */

function sanitizeAccessRequestPayload(
  payload
) {
  if (!isObject(payload)) {
    return payload;
  }

  const members =
    Array.isArray(
      payload
        ?.import
        ?.members
    )
      ? payload
          .import
          .members
      : [];

  return {
    import: {
      members:
        members.map(
          (member) => ({
            organization_customer_identifier:
              member
                .organization_customer_identifier ||
              null,

            program_customer_identifier:
              member
                .program_customer_identifier ||
              null,

            member_customer_identifier:
              member
                .member_customer_identifier ||
              null,

            email_address:
              member
                .email_address ||
              null,

            member_status:
              member
                .member_status ||
              null,
          })
        ),
    },
  };
}

/* ==========================================================================
   POST TO ACCESS AMT
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

    error.name =
      "AccessAmtConfigurationError";

    error.code =
      "ACCESS_AMT_URL_MISSING";

    error.status =
      503;

    throw error;
  }

  if (
    !payload ||
    typeof payload !==
      "object"
  ) {
    const error =
      new Error(
        "Access AMT request payload is required."
      );

    error.name =
      "AccessAmtValidationError";

    error.code =
      "ACCESS_AMT_PAYLOAD_REQUIRED";

    error.status =
      400;

    throw error;
  }

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
    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          headers: {
            ...getAuthHeaders(
              token
            ),

            ...(isObject(
              options.headers
            )
              ? options.headers
              : {}),
          },

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

      /*
       * Safe version only.
       */

      error.payload =
        sanitizeAccessRequestPayload(
          payload
        );

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
  } catch (
    error
  ) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          `Access AMT request timed out after ${timeoutMs}ms.`
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
   MEMBER STATUS HELPERS
============================================================================ */

function getCardLeoMemberStatuses(
  member = {}
) {
  return {
    status:
      normalizeLowerStatus(
        member.status
      ),

    paymentStatus:
      normalizeLowerStatus(
        member.payment_status ||
        member.paymentStatus
      ),

    membershipStatus:
      normalizeLowerStatus(
        member.membership_status ||
        member.membershipStatus
      ),

    approvalStatus:
      normalizeLowerStatus(
        member.approval_status ||
        member.approvalStatus
      ),
  };
}

/* ==========================================================================
   ACCESS ELIGIBILITY

   IMPORTANT
   ---------
   Blocked/inactive status wins over any old paid status.

   We also require a CURRENT/PAID payment state. A member being "approved"
   alone must not make Access active if payment is unpaid/past due.
============================================================================ */

function isAccessActiveMember(
  member = {}
) {
  if (
    !member ||
    typeof member !==
      "object"
  ) {
    return false;
  }

  const {
    status,
    paymentStatus,
    membershipStatus,
    approvalStatus,
  } =
    getCardLeoMemberStatuses(
      member
    );

  /* ------------------------------------------------------------------------
     BLOCKED ACCOUNT OVERRIDES EVERYTHING
  ------------------------------------------------------------------------ */

  if (
    BLOCKED_STATUSES.has(
      status
    ) ||
    BLOCKED_STATUSES.has(
      membershipStatus
    ) ||
    BLOCKED_STATUSES.has(
      approvalStatus
    )
  ) {
    return false;
  }

  /* ------------------------------------------------------------------------
     PAYMENT MUST NOT BE UNPAID/FAILED
  ------------------------------------------------------------------------ */

  if (
    UNPAID_STATUSES.has(
      paymentStatus
    )
  ) {
    return false;
  }

  /* ------------------------------------------------------------------------
     REQUIRE POSITIVE PAYMENT STATE

     This prevents:
       approval_status = approved
       payment_status = ""

     from activating Access accidentally.
  ------------------------------------------------------------------------ */

  const paymentActive =
    ACTIVE_STATUSES.has(
      paymentStatus
    );

  if (!paymentActive) {
    return false;
  }

  /* ------------------------------------------------------------------------
     REQUIRE ACTIVE MEMBER/MEMBERSHIP/APPROVAL STATE
  ------------------------------------------------------------------------ */

  const memberActive =
    ACTIVE_STATUSES.has(
      status
    ) ||
    ACTIVE_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_STATUSES.has(
      approvalStatus
    );

  return memberActive;
}

/* ==========================================================================
   DESIRED ACCESS STATUS
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
   SHOULD MEMBER SYNC?

   Useful for webhook / API callers.

   This lets callers avoid unnecessary AMT calls when the saved state already
   matches the desired state.
============================================================================ */

function shouldSyncMemberAccessState(
  member = {}
) {
  const desiredStatus =
    getDesiredAccessMemberStatus(
      member
    );

  const currentStatus =
    normalizeAccessMemberStatus(
      member.access_member_status ||
      member.accessMemberStatus
    );

  const identifier =
    normalizeString(
      member.access_member_identifier ||
      member.accessMemberIdentifier
    );

  /*
   * If Access has never been given a stable identifier, sync is required.
   */

  if (!identifier) {
    return true;
  }

  return (
    desiredStatus !==
    currentStatus
  );
}

/* ==========================================================================
   ACCESS RESULT HELPERS
============================================================================ */

function isAccessSyncSuccessful(
  result
) {
  return Boolean(
    result?.success === true &&
    result?.ok === true
  );
}

function buildAccessDatabaseUpdate(
  result,
  error = null
) {
  const timestamp =
    new Date()
      .toISOString();

  if (error) {
    return {
      access_synced_at:
        timestamp,

      access_sync_error:
        normalizeString(
          error.message ||
          "Access synchronization failed."
        ),

      access_perks_ready:
        false,

      access_last_response:
        isObject(
          error.response
        )
          ? error.response
          : null,

      updated_at:
        timestamp,
    };
  }

  return {
    access_member_identifier:
      normalizeString(
        result
          ?.access_member_identifier
      ) ||
      null,

    access_member_status:
      normalizeString(
        result
          ?.access_member_status
      ) ||
      null,

    access_synced_at:
      timestamp,

    access_sync_error:
      null,

    access_perks_ready:
      result
        ?.access_member_status ===
        OPEN_STATUS,

    access_last_payload:
      result
        ?.access_payload ||
      null,

    access_last_response:
      result
        ?.access_response ||
      null,

    updated_at:
      timestamp,
  };
}

/* ==========================================================================
   SAFE DEBUG CONFIG
============================================================================ */

function getAccessAmtConfigForDebug() {
  const token =
    getAccessAmtToken();

  return {
    enabled:
      isAccessAmtEnabled(),

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
      Boolean(token),

    /*
     * Never expose the actual token.
     */

    tokenLength:
      token
        ? token.length
        : 0,
  };
}

/* ==========================================================================
   CONFIG VALIDATION
============================================================================ */

function validateAccessAmtConfiguration() {
  const errors = {};

  if (
    !isAccessAmtEnabled()
  ) {
    errors.enabled =
      "Access AMT is not enabled.";
  }

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
   ASSERT ACCESS CONFIGURATION
============================================================================ */

function assertAccessAmtConfigured() {
  const validation =
    validateAccessAmtConfiguration();

  if (
    validation.valid
  ) {
    return true;
  }

  const error =
    new Error(
      "Access AMT is not fully configured."
    );

  error.name =
    "AccessAmtConfigurationError";

  error.code =
    "ACCESS_AMT_NOT_CONFIGURED";

  error.status =
    503;

  error.validation =
    validation.errors;

  throw error;
}

/* ==========================================================================
   SAFE INTEGRATION STATUS
============================================================================ */

function getAccessAmtIntegrationStatus() {
  const validation =
    validateAccessAmtConfiguration();

  return {
    provider:
      "access-development",

    product:
      "access-perks",

    enabled:
      isAccessAmtEnabled(),

    configured:
      validation.valid,

    readyForMemberSync:
      validation.valid,

    environment:
      getAccessEnvironment(),

    stage:
      isAccessStage(),

    production:
      isAccessProduction(),

    endpoint:
      getAccessAmtUrl(),

    organizationCustomerIdentifier:
      getOrganizationCustomerIdentifier(),

    programCustomerIdentifier:
      getProgramCustomerIdentifier(),

    message:
      validation.valid
        ? `Access AMT ${getAccessEnvironment()} member sync is configured.`
        : "Access AMT requires additional configuration.",

    errors:
      validation.errors,
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* ------------------------------------------------------------------------
     DEFAULTS
  ------------------------------------------------------------------------ */

  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,

  OPEN_STATUS,
  SUSPEND_STATUS,

  /* ------------------------------------------------------------------------
     GENERAL
  ------------------------------------------------------------------------ */

  normalizeString,
  normalizeEmail,

  safeJsonStringify,

  /* ------------------------------------------------------------------------
     ENVIRONMENT
  ------------------------------------------------------------------------ */

  getAccessEnvironment,

  isAccessProduction,
  isAccessStage,

  isAccessAmtEnabled,

  /* ------------------------------------------------------------------------
     CONFIG
  ------------------------------------------------------------------------ */

  getAccessAmtBaseUrl,
  getAccessAmtEndpointPath,
  getAccessAmtToken,
  getAccessAmtUrl,

  hasAccessAmtToken,

  getOrganizationCustomerIdentifier,
  getProgramCustomerIdentifier,

  getAccessAmtConfigForDebug,
  getAccessAmtIntegrationStatus,

  validateAccessAmtConfiguration,
  assertAccessAmtConfigured,

  /* ------------------------------------------------------------------------
     MEMBER PAYLOAD
  ------------------------------------------------------------------------ */

  buildAccessAmtMemberPayload,
  buildAccessAmtImportPayload,

  buildMemberCustomerIdentifier,

  /* ------------------------------------------------------------------------
     CARD LEO MEMBER STATE
  ------------------------------------------------------------------------ */

  isAccessActiveMember,
  getDesiredAccessMemberStatus,
  shouldSyncMemberAccessState,

  /* ------------------------------------------------------------------------
     REQUEST
  ------------------------------------------------------------------------ */

  parseAccessResponse,
  postToAccessAmt,

  /* ------------------------------------------------------------------------
     MEMBER SYNC
  ------------------------------------------------------------------------ */

  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
  syncMemberAccessState,

  /* ------------------------------------------------------------------------
     RESULT HELPERS
  ------------------------------------------------------------------------ */

  isAccessSyncSuccessful,
  buildAccessDatabaseUpdate,
};