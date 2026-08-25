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
   - new member enrollment
   - existing member updates
   - member suspension
   - permanent member customer identifier generation
   - Stage / Production environment switching
   - Access AMT authentication
   - timeout handling
   - response parsing
   - safe configuration diagnostics
   - Card Leo -> Access OPEN/SUSPEND status mapping

   ACCESS CONFIRMED MEMBER FIELDS
   ------------------------------
   Required:
   - organization_customer_identifier
   - program_customer_identifier
   - member_customer_identifier
   - member_status
   - email_address

   Nice to have:
   - first_name
   - last_name

   ACCESS CONFIRMED STATUS VALUES
   ------------------------------
   OPEN
     Active / eligible Card Leo member.

   SUSPEND
     Member is no longer eligible.

   MEMBER IDENTIFIER RULE
   ----------------------
   Access confirmed that Card Leo assigns the permanent unique value used as:

     member_customer_identifier

   Subsequent updates and suspensions MUST reuse the exact same identifier.

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
   - Tokenized SSO
   - OAuth / OIDC SSO
   - referral payout logic
   - rewards logic
   - allowance funding
   - Growth Pool logic
   - Stripe billing
   - Lithic card creation
   - card funding

   inside this file.

   Tokenized SSO belongs in the separate Card Leo SSO endpoint.

   SECURITY
   --------
   ACCESS_AMT_API_TOKEN must remain SERVER-SIDE ONLY.

   Never:
   - expose it to browser JavaScript
   - return it through an API response
   - put it in HTML
   - commit it to GitHub
   - log the complete token

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

/*
 * These are Card Leo's currently configured identifiers.
 *
 * Environment variables override these defaults.
 *
 * Production should ultimately use environment variables so configuration
 * can be changed without editing application code.
 */

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER =
  "2002479";

const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER =
  "200783";

const DEFAULT_TIMEOUT_MS =
  20000;

const MAX_MEMBER_IDENTIFIER_LENGTH =
  64;

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
    "incomplete_expired",
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
   * If absent, Access is considered enabled when an AMT token exists.
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

   Austin confirmed Card Leo has Production token access.

   The actual token must only exist in server-side environment variables.
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
     * Normalize those back to /imports.
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

   ACCESS CONFIRMED RULE
   ---------------------
   member_customer_identifier is the unique ID Card Leo assigns to the
   individual member.

   That SAME identifier must be used for:
   - initial creation
   - profile updates
   - OPEN updates
   - SUSPEND updates
   - future SSO member_key

   PRIORITY
   --------
   1. Existing saved Access identifier
   2. Immutable Card Leo / Supabase signup ID
   3. Email fallback for legacy records

   IMPORTANT
   ---------
   We intentionally DO NOT use Date.now().

   A random/timestamp fallback could create duplicate Access members when
   the same Card Leo member is retried.
============================================================================ */

function buildMemberCustomerIdentifier(
  member = {}
) {
  /* ------------------------------------------------------------------------
     1. EXISTING PERMANENT ACCESS IDENTIFIER
  ------------------------------------------------------------------------ */

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
        MAX_MEMBER_IDENTIFIER_LENGTH
      );
    }
  }

  /* ------------------------------------------------------------------------
     2. IMMUTABLE CARD LEO DATABASE ID

     This is preferred over email because email addresses may change.
  ------------------------------------------------------------------------ */

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
      MAX_MEMBER_IDENTIFIER_LENGTH
    );
  }

  /* ------------------------------------------------------------------------
     3. LEGACY EMAIL FALLBACK

     This exists only for older records where no database ID was supplied
     to this helper.

     Once this value is successfully submitted to Access, callers should
     save it in signups.access_member_identifier and reuse it forever.
  ------------------------------------------------------------------------ */

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
      MAX_MEMBER_IDENTIFIER_LENGTH
    );
  }

  /*
   * Do NOT invent a member identifier here.
   *
   * Creating a timestamp/random ID could cause a retry to provision a
   * second Access member.
   */

  return "";
}

/* ==========================================================================
   ACCESS MEMBER STATUS

   Austin confirmed:
     OPEN    = eligible member
     SUSPEND = no longer eligible
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

   Exact fields confirmed by Access:

   REQUIRED
   --------
   organization_customer_identifier
   program_customer_identifier
   member_customer_identifier
   member_status
   email_address

   NICE TO HAVE
   ------------
   first_name
   last_name
============================================================================ */

function buildAccessAmtMemberPayload(
  member = {},
  memberStatus =
    OPEN_STATUS
) {
  const organizationCustomerIdentifier =
    getOrganizationCustomerIdentifier();

  const programCustomerIdentifier =
    getProgramCustomerIdentifier();

  const email =
    normalizeEmail(
      member.email ||
      member.email_address ||
      member.emailAddress
    );

  if (
    !organizationCustomerIdentifier
  ) {
    const error =
      new Error(
        "Access organization_customer_identifier is required."
      );

    error.name =
      "AccessMemberValidationError";

    error.code =
      "ACCESS_ORGANIZATION_IDENTIFIER_REQUIRED";

    error.status =
      503;

    throw error;
  }

  if (
    !programCustomerIdentifier
  ) {
    const error =
      new Error(
        "Access program_customer_identifier is required."
      );

    error.name =
      "AccessMemberValidationError";

    error.code =
      "ACCESS_PROGRAM_IDENTIFIER_REQUIRED";

    error.status =
      503;

    throw error;
  }

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
        "A permanent Card Leo member identifier is required for Access AMT sync."
      );

    error.name =
      "AccessMemberValidationError";

    error.code =
      "ACCESS_MEMBER_IDENTIFIER_REQUIRED";

    error.status =
      400;

    throw error;
  }

  /*
   * Keep these field names EXACT.
   *
   * Access confirmed this request format.
   */

  return {
    organization_customer_identifier:
      organizationCustomerIdentifier,

    program_customer_identifier:
      programCustomerIdentifier,

    member_customer_identifier:
      memberCustomerIdentifier,

    member_status:
      normalizeAccessMemberStatus(
        memberStatus
      ),

    first_name:
      firstName,

    last_name:
      lastName,

    email_address:
      email,
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

   IMPORTANT
   ---------
   Austin confirmed Card Leo has Production token access.

   Keep authentication server-side only.

   The existing Card Leo integration sends both:
   - Authorization: Bearer <token>
   - X-Access-Token: <token>

   Until Access confirms a single required header, preserving both maintains
   compatibility with the existing implementation.
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
   SANITIZE REQUEST PAYLOAD FOR LOGGING

   SECURITY
   --------
   Never expose the Access token through:
   - errors
   - logs
   - API responses
   - browser code

   Member information included here is limited to fields useful for
   diagnosing an AMT member-sync failure.
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

   Access confirmed Member AMT is a POST request.

   This function is shared by:
   - initial member creation
   - existing member updates
   - OPEN reactivation
   - SUSPEND

   Access determines which member is being modified from the permanent:

     member_customer_identifier
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
       * Store only the safe/sanitized request.
       *
       * The token is never attached to the error.
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

   PURPOSE
   -------
   Creates or updates the member in Access with:

     member_status = OPEN

   Because the same permanent member_customer_identifier is reused, this
   function is used for both:

   - first enrollment
   - later member updates
   - membership restoration/reactivation
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

   IMPORTANT
   ---------
   We do NOT create another identifier.

   The exact same member_customer_identifier used when the member was OPEN
   is submitted again with:

     member_status = SUSPEND

   That tells Access to modify the existing Access member rather than
   creating a duplicate member.
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

   RULES
   -----
   Access should be OPEN only when the Card Leo member is actually eligible.

   A blocked/inactive account overrides an old paid/approved state.

   A positive payment state is also required.

   This prevents a record such as:

     approval_status = approved
     payment_status = past_due

   from accidentally remaining OPEN in Access.
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
     PAYMENT MUST NOT BE UNPAID / FAILED
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

     Approval alone is not sufficient.
  ------------------------------------------------------------------------ */

  const paymentActive =
    ACTIVE_STATUSES.has(
      paymentStatus
    );

  if (!paymentActive) {
    return false;
  }

  /* ------------------------------------------------------------------------
     REQUIRE ACTIVE MEMBER / MEMBERSHIP / APPROVAL STATE
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

   Automatically determines whether the member should be OPEN or SUSPEND.
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

   Useful for webhook/API callers.

   IMPORTANT
   ---------
   If there is no saved permanent Access identifier yet, always sync.

   Otherwise compare the desired OPEN/SUSPEND state against the current
   Access state.
============================================================================ */

function shouldSyncMemberAccessState(
  member = {}
) {
  const desiredStatus =
    getDesiredAccessMemberStatus(
      member
    );

  const rawCurrentStatus =
    normalizeStatus(
      member.access_member_status ||
      member.accessMemberStatus
    );

  const identifier =
    normalizeString(
      member.access_member_identifier ||
      member.accessMemberIdentifier
    );

  /*
   * Access has never been given a permanent identifier.
   */

  if (!identifier) {
    return true;
  }

  /*
   * Unknown/empty saved Access status should always be synchronized.
   *
   * Do not normalize an empty value to OPEN here because that could make
   * an unsynchronized active member appear current.
   */

  if (
    rawCurrentStatus !==
      OPEN_STATUS &&
    rawCurrentStatus !==
      SUSPEND_STATUS
  ) {
    return true;
  }

  return (
    desiredStatus !==
    rawCurrentStatus
  );
}
/* ==========================================================================
   ACCESS RESULT HELPERS
============================================================================ */

function isAccessSyncSuccessful(
  result
) {
  return Boolean(
    result &&
    result.success === true &&
    result.ok === true
  );
}

function getAccessSyncStatus(
  result
) {
  if (
    !result ||
    typeof result !==
      "object"
  ) {
    return "";
  }

  return normalizeAccessMemberStatus(
    result.access_member_status ||
    result.member_status ||
    result.status ||
    ""
  );
}

function getAccessMemberIdentifierFromResult(
  result
) {
  if (
    !result ||
    typeof result !==
      "object"
  ) {
    return "";
  }

  return normalizeString(
    result.access_member_identifier ||
    result.member_customer_identifier ||
    result.memberCustomerIdentifier ||
    result
      ?.payload
      ?.import
      ?.members
      ?.[0]
      ?.member_customer_identifier ||
    result
      ?.access_payload
      ?.import
      ?.members
      ?.[0]
      ?.member_customer_identifier ||
    ""
  );
}

/* ==========================================================================
   SAFE ACCESS CONFIGURATION

   PURPOSE
   -------
   Returns configuration information that is safe for:
   - server logs
   - admin diagnostics
   - health checks

   NEVER returns the actual Access token.
============================================================================ */

function getAccessAmtConfiguration() {
  const environment =
    getAccessEnvironment();

  const enabled =
    isAccessAmtEnabled();

  const token =
    getAccessAmtToken();

  const organizationCustomerIdentifier =
    getOrganizationCustomerIdentifier();

  const programCustomerIdentifier =
    getProgramCustomerIdentifier();

  const baseUrl =
    getAccessAmtBaseUrl();

  const endpointPath =
    getAccessAmtEndpointPath();

  const url =
    getAccessAmtUrl();

  return {
    enabled,

    environment,

    production:
      environment ===
      "production",

    stage:
      environment ===
      "stage",

    baseUrl,

    endpointPath,

    url,

    organizationCustomerIdentifier,

    programCustomerIdentifier,

    tokenConfigured:
      Boolean(token),

    tokenPreview:
      token
        ? `...${token.slice(-8)}`
        : "",

    timeoutMs:
      DEFAULT_TIMEOUT_MS,
  };
}

/* ==========================================================================
   CONFIGURATION VALIDATION

   IMPORTANT
   ---------
   Access confirmed that the Member AMT request requires:

   - organization_customer_identifier
   - program_customer_identifier
   - member_customer_identifier
   - member_status
   - email_address

   member_customer_identifier and email_address are member-specific, so this
   configuration validator checks only the server/environment requirements.
============================================================================ */

function validateAccessAmtConfiguration() {
  const missing =
    [];

  const token =
    getAccessAmtToken();

  const organizationCustomerIdentifier =
    getOrganizationCustomerIdentifier();

  const programCustomerIdentifier =
    getProgramCustomerIdentifier();

  const url =
    getAccessAmtUrl();

  if (
    !token
  ) {
    missing.push(
      "ACCESS_AMT_API_TOKEN"
    );
  }

  if (
    !organizationCustomerIdentifier
  ) {
    missing.push(
      "ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER"
    );
  }

  if (
    !programCustomerIdentifier
  ) {
    missing.push(
      "ACCESS_PROGRAM_CUSTOMER_IDENTIFIER"
    );
  }

  if (
    !url
  ) {
    missing.push(
      "ACCESS_AMT_BASE_URL"
    );
  }

  return {
    valid:
      missing.length ===
      0,

    enabled:
      isAccessAmtEnabled(),

    environment:
      getAccessEnvironment(),

    missing,

    configuration:
      getAccessAmtConfiguration(),
  };
}

/* ==========================================================================
   MEMBER PAYLOAD VALIDATION

   PURPOSE
   -------
   Allows routes/tests to verify a member can be sent to Access without
   actually performing the POST.
============================================================================ */

function validateAccessMember(
  member = {},
  memberStatus =
    OPEN_STATUS
) {
  try {
    const payload =
      buildAccessAmtMemberPayload(
        member,
        memberStatus
      );

    return {
      valid:
        true,

      errors:
        [],

      memberCustomerIdentifier:
        payload
          .member_customer_identifier,

      memberStatus:
        payload
          .member_status,

      payload,
    };
  } catch (
    error
  ) {
    return {
      valid:
        false,

      errors: [
        error?.message ||
        "Access member validation failed.",
      ],

      code:
        error?.code ||
        "ACCESS_MEMBER_VALIDATION_FAILED",

      memberCustomerIdentifier:
        buildMemberCustomerIdentifier(
          member
        ),

      memberStatus:
        normalizeAccessMemberStatus(
          memberStatus
        ),

      payload:
        null,
    };
  }
}

/* ==========================================================================
   ACCESS MEMBER SNAPSHOT

   Useful for Card Leo database persistence after a successful sync.
============================================================================ */

function buildAccessMemberSnapshot(
  member = {},
  result = null
) {
  const identifier =
    getAccessMemberIdentifierFromResult(
      result
    ) ||
    buildMemberCustomerIdentifier(
      member
    );

  const status =
    result
      ? getAccessSyncStatus(
          result
        )
      : getDesiredAccessMemberStatus(
          member
        );

  return {
    access_member_identifier:
      identifier,

    access_member_status:
      status,

    access_perks_ready:
      status ===
      OPEN_STATUS,

    access_synced_at:
      new Date()
        .toISOString(),

    access_sync_error:
      null,

    access_last_payload:
      result
        ?.access_payload ||
      result
        ?.payload ||
      null,

    access_last_response:
      result
        ?.access_response ||
      result
        ?.response ||
      null,
  };
}

/* ==========================================================================
   ACCESS FAILURE SNAPSHOT

   Useful for persisting failed sync diagnostics to Supabase.

   SECURITY
   --------
   Does not contain the Access token.
============================================================================ */

function buildAccessFailureSnapshot(
  member = {},
  error = null
) {
  return {
    access_member_identifier:
      buildMemberCustomerIdentifier(
        member
      ),

    access_member_status:
      "sync_failed",

    access_perks_ready:
      false,

    access_sync_error:
      normalizeString(
        error?.message
      ) ||
      "Access AMT synchronization failed.",

    access_last_payload:
      error?.payload ||
      null,

    access_last_response:
      error?.response ||
      null,
  };
}

/* ==========================================================================
   SAFE MEMBER SYNC

   PURPOSE
   -------
   Wrapper for routes that want a result object instead of an exception.

   The Stripe webhook can continue using syncMemberToAccessAmt() directly
   when it wants failures to be handled through its own try/catch logic.
============================================================================ */

async function safeSyncMemberAccessState(
  member = {},
  options = {}
) {
  try {
    const result =
      await syncMemberAccessState(
        member,
        options
      );

    return {
      success:
        true,

      result,

      snapshot:
        buildAccessMemberSnapshot(
          member,
          result
        ),

      error:
        null,
    };
  } catch (
    error
  ) {
    return {
      success:
        false,

      result:
        null,

      snapshot:
        buildAccessFailureSnapshot(
          member,
          error
        ),

      error: {
        name:
          error?.name ||
          "Error",

        code:
          error?.code ||
          "ACCESS_SYNC_FAILED",

        status:
          error?.status ||
          500,

        message:
          error?.message ||
          "Access synchronization failed.",
      },
    };
  }
}

/* ==========================================================================
   CREATE / UPDATE MEMBER ALIASES

   Access confirmed that creating a new member and updating an existing
   member use the Member AMT POST workflow.

   The permanent member_customer_identifier tells Access whether the
   submitted record corresponds to the same member.

   These aliases make route intent clearer while preserving one central
   implementation.
============================================================================ */

async function createAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(
    member,
    options
  );
}

async function updateAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(
    member,
    options
  );
}

async function openAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(
    member,
    options
  );
}

async function suspendAccessMember(
  member = {},
  options = {}
) {
  return suspendMemberInAccessAmt(
    member,
    options
  );
}

/* ==========================================================================
   ACCESS TEST MEMBER

   PURPOSE
   -------
   Build a deterministic member object for controlled Stage/Production
   integration testing.

   IMPORTANT
   ---------
   Austin confirmed Stage members do NOT receive access to the live Deals
   site.

   Therefore:

   Stage:
     Use for validating AMT request/response behavior.

   Production:
     Use ONE controlled real test member when Card Leo is ready to validate
     actual Access Perks access.

   Do not use fake or disposable email addresses for a live production
   member if Access email delivery / benefits access must be tested.
============================================================================ */

function buildAccessTestMember({
  id,
  firstName,
  lastName,
  email,
} = {}) {
  const cleanId =
    normalizeString(
      id
    ) ||
    "ACCESS_TEST_MEMBER";

  return {
    id:
      cleanId,

    first_name:
      normalizeString(
        firstName
      ) ||
      "Card",

    last_name:
      normalizeString(
        lastName
      ) ||
      "Leo",

    email:
      normalizeEmail(
        email
      ),

    status:
      "active",

    payment_status:
      "paid",

    membership_status:
      "active",

    approval_status:
      "approved",
  };
}

/* ==========================================================================
   SAFE CONFIG LOGGING

   Useful during deployment without exposing credentials.
============================================================================ */

function logAccessAmtConfiguration() {
  const configuration =
    getAccessAmtConfiguration();

  console.log(
    "Card Leo Access AMT configuration:",
    {
      enabled:
        configuration.enabled,

      environment:
        configuration.environment,

      production:
        configuration.production,

      baseUrl:
        configuration.baseUrl,

      endpointPath:
        configuration.endpointPath,

      organizationCustomerIdentifier:
        configuration
          .organizationCustomerIdentifier,

      programCustomerIdentifier:
        configuration
          .programCustomerIdentifier,

      tokenConfigured:
        configuration
          .tokenConfigured,

      tokenPreview:
        configuration
          .tokenPreview,

      timeoutMs:
        configuration.timeoutMs,
    }
  );

  return configuration;
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* ------------------------------------------------------------------------
     CONSTANTS
  ------------------------------------------------------------------------ */

  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,
  DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER,
  DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER,
  DEFAULT_TIMEOUT_MS,
  MAX_MEMBER_IDENTIFIER_LENGTH,
  OPEN_STATUS,
  SUSPEND_STATUS,

  /* ------------------------------------------------------------------------
     ENVIRONMENT / CONFIG
  ------------------------------------------------------------------------ */

  getAccessEnvironment,
  isAccessProduction,
  isAccessStage,
  isAccessAmtEnabled,

  getAccessAmtBaseUrl,
  getAccessAmtToken,
  hasAccessAmtToken,
  getOrganizationCustomerIdentifier,
  getProgramCustomerIdentifier,
  getAccessAmtEndpointPath,
  getAccessAmtUrl,

  getAccessAmtConfiguration,
  validateAccessAmtConfiguration,
  logAccessAmtConfiguration,

  /* ------------------------------------------------------------------------
     MEMBER IDENTIFIER / PAYLOAD
  ------------------------------------------------------------------------ */

  buildMemberCustomerIdentifier,
  normalizeAccessMemberStatus,
  buildAccessAmtMemberPayload,
  buildAccessAmtImportPayload,
  validateAccessMember,

  /* ------------------------------------------------------------------------
     ACCESS REQUEST
  ------------------------------------------------------------------------ */

  postToAccessAmt,

  /* ------------------------------------------------------------------------
     DIRECT MEMBER ACTIONS
  ------------------------------------------------------------------------ */

  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,

  createAccessMember,
  updateAccessMember,
  openAccessMember,
  suspendAccessMember,

  /* ------------------------------------------------------------------------
     CARD LEO ELIGIBILITY
  ------------------------------------------------------------------------ */

  isAccessActiveMember,
  getDesiredAccessMemberStatus,
  shouldSyncMemberAccessState,
  syncMemberAccessState,
  safeSyncMemberAccessState,

  /* ------------------------------------------------------------------------
     RESULT / DATABASE HELPERS
  ------------------------------------------------------------------------ */

  isAccessSyncSuccessful,
  getAccessSyncStatus,
  getAccessMemberIdentifierFromResult,
  buildAccessMemberSnapshot,
  buildAccessFailureSnapshot,

  /* ------------------------------------------------------------------------
     TESTING
  ------------------------------------------------------------------------ */

  buildAccessTestMember,
};

/* ==========================================================================
   DEFAULT EXPORT

   Included for compatibility with code that prefers:

     import accessAmt from "../lib/access-amt.js";

   Existing named imports continue to work.
============================================================================ */

const accessAmt = {
  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,

  OPEN_STATUS,
  SUSPEND_STATUS,

  getAccessEnvironment,
  isAccessProduction,
  isAccessStage,
  isAccessAmtEnabled,

  getAccessAmtBaseUrl,
  getAccessAmtToken,
  hasAccessAmtToken,
  getOrganizationCustomerIdentifier,
  getProgramCustomerIdentifier,
  getAccessAmtEndpointPath,
  getAccessAmtUrl,

  getAccessAmtConfiguration,
  validateAccessAmtConfiguration,
  logAccessAmtConfiguration,

  buildMemberCustomerIdentifier,
  normalizeAccessMemberStatus,
  buildAccessAmtMemberPayload,
  buildAccessAmtImportPayload,
  validateAccessMember,

  postToAccessAmt,

  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,

  createAccessMember,
  updateAccessMember,
  openAccessMember,
  suspendAccessMember,

  isAccessActiveMember,
  getDesiredAccessMemberStatus,
  shouldSyncMemberAccessState,
  syncMemberAccessState,
  safeSyncMemberAccessState,

  isAccessSyncSuccessful,
  getAccessSyncStatus,
  getAccessMemberIdentifierFromResult,
  buildAccessMemberSnapshot,
  buildAccessFailureSnapshot,

  buildAccessTestMember,
};

export default accessAmt;