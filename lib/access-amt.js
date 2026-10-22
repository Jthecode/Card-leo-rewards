// lib/access-amt.js
//
// Card Leo Rewards — Access Development AMT member synchronization.
// Server-side only.
//
// Handles:
// - Member enrollment and updates.
// - OPEN / SUSPEND synchronization.
// - Permanent member identifiers.
// - Stage / production configuration.
// - Request timeouts and safe diagnostics.
//
// Callers must persist returned snapshots to Supabase.
// This helper does not write to the database.

const DEFAULT_STAGE_BASE_URL =
  "https://amt-stage.accessdevelopment.com/api/v1";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://amt.accessdevelopment.com/api/v1";

const DEFAULT_AMT_ENDPOINT_PATH = "/imports";

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER = "2002479";
const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER = "200783";

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_MEMBER_IDENTIFIER_LENGTH = 64;

const OPEN_STATUS = "OPEN";
const SUSPEND_STATUS = "SUSPEND";

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
]);

const BLOCKED_STATUSES = new Set([
  "inactive",
  "disabled",
  "suspended",
  "paused",
  "denied",
  "closed",
  "cancelled",
  "canceled",
]);

const UNPAID_STATUSES = new Set([
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
  return normalizeString(value).toUpperCase();
}

function normalizeLowerStatus(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeLowerStatus(value);

  if (
    ["true", "1", "yes", "y", "on", "enabled"].includes(normalized)
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "n", "off", "disabled"].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function onlyAlphaNumeric(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9]/g, "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(value)
  );
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function getEnv(name, fallback = "") {
  return normalizeString(process.env[name] ?? fallback);
}

function cleanBaseUrl(value) {
  return normalizeString(value).replace(/\/+$/, "");
}

function normalizeEndpointPath(value) {
  const path = normalizeString(value);

  if (
    !path ||
    path === "/" ||
    ["root", "base"].includes(path.toLowerCase())
  ) {
    return DEFAULT_AMT_ENDPOINT_PATH;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function accessError(
  message,
  code,
  status = 500,
  name = "AccessAmtError"
) {
  const error = new Error(message);

  error.name = name;
  error.code = code;
  error.status = status;

  return error;
}

function getMemberEmail(member = {}) {
  return normalizeEmail(
    member?.email ||
      member?.email_address ||
      member?.emailAddress
  );
}

// -----------------------------------------------------------------------------
// Environment and configuration
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

function isAccessProduction() {
  return getAccessEnvironment() === "production";
}

function isAccessStage() {
  return !isAccessProduction();
}

function getAccessAmtToken() {
  // AMT credentials must remain separate from Offers API credentials.
  return getEnv("ACCESS_AMT_API_TOKEN");
}

function hasAccessAmtToken() {
  return Boolean(getAccessAmtToken());
}

function isAccessAmtEnabled() {
  const configured = getEnv("ACCESS_AMT_ENABLED");

  return configured
    ? normalizeBoolean(configured, false)
    : hasAccessAmtToken();
}

function getAccessAmtBaseUrl() {
  const configured = getEnv("ACCESS_AMT_BASE_URL");

  return cleanBaseUrl(
    configured ||
      (isAccessProduction()
        ? DEFAULT_PRODUCTION_BASE_URL
        : DEFAULT_STAGE_BASE_URL)
  );
}

function getAccessAmtEndpointPath() {
  return normalizeEndpointPath(
    getEnv("ACCESS_AMT_ENDPOINT_PATH")
  );
}

function getAccessAmtUrl() {
  const baseUrl = getAccessAmtBaseUrl();
  const endpointPath = getAccessAmtEndpointPath();

  // Support an existing configuration containing the complete imports URL.
  if (baseUrl.endsWith("/imports")) {
    return baseUrl;
  }

  return `${baseUrl}${endpointPath}`;
}

function validateAccessAmtUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw accessError(
      "Access AMT URL is invalid.",
      "ACCESS_AMT_URL_INVALID",
      503,
      "AccessAmtConfigurationError"
    );
  }

  const expectedHost = isAccessProduction()
    ? "amt.accessdevelopment.com"
    : "amt-stage.accessdevelopment.com";

  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v1/imports"
  ) {
    throw accessError(
      `Access AMT must use the approved ${getAccessEnvironment()} imports endpoint.`,
      "ACCESS_AMT_URL_NOT_ALLOWED",
      503,
      "AccessAmtConfigurationError"
    );
  }

  return url.toString();
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

function getAccessAmtConfiguration() {
  const environment = getAccessEnvironment();

  return {
    enabled: isAccessAmtEnabled(),
    environment,
    production: environment === "production",
    stage: environment === "stage",
    baseUrl: getAccessAmtBaseUrl(),
    endpointPath: getAccessAmtEndpointPath(),
    url: getAccessAmtUrl(),
    organizationCustomerIdentifier:
      getOrganizationCustomerIdentifier(),
    programCustomerIdentifier:
      getProgramCustomerIdentifier(),
    tokenConfigured: hasAccessAmtToken(),

    // Retained for compatibility without revealing any token characters.
    tokenPreview: "",

    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function validateAccessAmtConfiguration() {
  const configuration = getAccessAmtConfiguration();
  const missing = [];
  const errors = [];

  if (!configuration.tokenConfigured) {
    missing.push("ACCESS_AMT_API_TOKEN");
  }

  if (!configuration.organizationCustomerIdentifier) {
    missing.push("ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER");
  }

  if (!configuration.programCustomerIdentifier) {
    missing.push("ACCESS_PROGRAM_CUSTOMER_IDENTIFIER");
  }

  try {
    validateAccessAmtUrl(configuration.url);
  } catch (error) {
    errors.push(error.message);
  }

  return {
    valid: missing.length === 0 && errors.length === 0,
    enabled: configuration.enabled,
    environment: configuration.environment,
    missing,
    errors,
    configuration,
  };
}

function logAccessAmtConfiguration() {
  const configuration = getAccessAmtConfiguration();

  console.log(
    "Card Leo Access AMT configuration:",
    configuration
  );

  return configuration;
}

// -----------------------------------------------------------------------------
// Member identity
// -----------------------------------------------------------------------------

function getMemberNameParts(member = {}) {
  let firstName = normalizeString(
    member.first_name ||
      member.firstName ||
      member.given_name ||
      member.givenName
  );

  let lastName = normalizeString(
    member.last_name ||
      member.lastName ||
      member.family_name ||
      member.familyName
  );

  const fullName = normalizeString(
    member.full_name || member.fullName || member.name
  );

  if ((!firstName || !lastName) && fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);

    firstName ||= parts[0] || "";
    lastName ||= parts.slice(1).join(" ");
  }

  return {
    firstName:
      firstName ||
      getMemberEmail(member).split("@")[0] ||
      "Card",
    lastName: lastName || "Member",
  };
}

function buildMemberCustomerIdentifier(member = {}) {
  const existing = normalizeString(
    member?.access_member_identifier ||
      member?.accessMemberIdentifier ||
      member?.member_customer_identifier ||
      member?.memberCustomerIdentifier
  );

  // Never sanitize, truncate, or regenerate an existing Access identifier.
  // Altering it could target a different Access member.
  if (existing) {
    return existing;
  }

  const memberId = onlyAlphaNumeric(
    member?.id ||
      member?.member_id ||
      member?.memberId ||
      member?.signup_id ||
      member?.signupId
  );

  if (memberId) {
    const identifier = `CLR${memberId}`;

    if (identifier.length > MAX_MEMBER_IDENTIFIER_LENGTH) {
      throw accessError(
        "Card Leo member ID exceeds the Access identifier length limit.",
        "ACCESS_MEMBER_IDENTIFIER_TOO_LONG",
        400,
        "AccessMemberValidationError"
      );
    }

    return identifier;
  }

  // Compatibility fallback for older records without a supplied database ID.
  // Persist this value before allowing the member's email address to change.
  const email = getMemberEmail(member);

  if (!isValidEmail(email)) {
    return "";
  }

  const legacyIdentifier = `CLR${onlyAlphaNumeric(email)}`;

  if (legacyIdentifier.length > MAX_MEMBER_IDENTIFIER_LENGTH) {
    throw accessError(
      "Legacy member identifier is too long. Supply the immutable Card Leo member ID.",
      "ACCESS_MEMBER_IDENTIFIER_TOO_LONG",
      400,
      "AccessMemberValidationError"
    );
  }

  return legacyIdentifier;
}

// -----------------------------------------------------------------------------
// Member payloads
// -----------------------------------------------------------------------------

function normalizeAccessMemberStatus(value) {
  const status = normalizeStatus(value);

  if (!status) {
    return OPEN_STATUS;
  }

  if (status === OPEN_STATUS || status === SUSPEND_STATUS) {
    return status;
  }

  throw accessError(
    "Access member status must be OPEN or SUSPEND.",
    "ACCESS_MEMBER_STATUS_INVALID",
    400,
    "AccessMemberValidationError"
  );
}

function buildAccessAmtMemberPayload(
  member = {},
  memberStatus = OPEN_STATUS
) {
  if (!isObject(member)) {
    throw accessError(
      "A Card Leo member object is required.",
      "ACCESS_MEMBER_REQUIRED",
      400,
      "AccessMemberValidationError"
    );
  }

  const organizationCustomerIdentifier =
    getOrganizationCustomerIdentifier();

  const programCustomerIdentifier =
    getProgramCustomerIdentifier();

  if (!organizationCustomerIdentifier) {
    throw accessError(
      "Access organization identifier is not configured.",
      "ACCESS_ORGANIZATION_IDENTIFIER_REQUIRED",
      503,
      "AccessMemberValidationError"
    );
  }

  if (!programCustomerIdentifier) {
    throw accessError(
      "Access program identifier is not configured.",
      "ACCESS_PROGRAM_IDENTIFIER_REQUIRED",
      503,
      "AccessMemberValidationError"
    );
  }

  const email = getMemberEmail(member);

  if (!isValidEmail(email)) {
    throw accessError(
      "A valid member email is required for Access AMT sync.",
      "ACCESS_MEMBER_EMAIL_REQUIRED",
      400,
      "AccessMemberValidationError"
    );
  }

  const memberCustomerIdentifier =
    buildMemberCustomerIdentifier(member);

  if (
    !memberCustomerIdentifier ||
    memberCustomerIdentifier.length >
      MAX_MEMBER_IDENTIFIER_LENGTH
  ) {
    throw accessError(
      "A permanent Access member identifier of at most 64 characters is required.",
      "ACCESS_MEMBER_IDENTIFIER_INVALID",
      400,
      "AccessMemberValidationError"
    );
  }

  const { firstName, lastName } = getMemberNameParts(member);

  return {
    organization_customer_identifier:
      organizationCustomerIdentifier,
    program_customer_identifier:
      programCustomerIdentifier,
    member_customer_identifier:
      memberCustomerIdentifier,
    member_status:
      normalizeAccessMemberStatus(memberStatus),
    first_name: firstName,
    last_name: lastName,
    email_address: email,
  };
}

function buildAccessAmtImportPayload(
  member = {},
  memberStatus = OPEN_STATUS
) {
  return {
    import: {
      members: [
        buildAccessAmtMemberPayload(member, memberStatus),
      ],
    },
  };
}

function validateAccessMember(
  member = {},
  memberStatus = OPEN_STATUS
) {
  try {
    const payload = buildAccessAmtMemberPayload(
      member,
      memberStatus
    );

    return {
      valid: true,
      errors: [],
      memberCustomerIdentifier:
        payload.member_customer_identifier,
      memberStatus: payload.member_status,
      payload,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        error?.message || "Access member validation failed.",
      ],
      code:
        error?.code || "ACCESS_MEMBER_VALIDATION_FAILED",
      memberCustomerIdentifier: "",
      memberStatus: normalizeStatus(memberStatus),
      payload: null,
    };
  }
}

// -----------------------------------------------------------------------------
// Safe request and response handling
// -----------------------------------------------------------------------------

function getAuthHeaders(token) {
  const cleanToken = normalizeString(token);

  if (!cleanToken) {
    throw accessError(
      "Missing Access AMT token. Configure ACCESS_AMT_API_TOKEN.",
      "ACCESS_AMT_TOKEN_MISSING",
      503,
      "AccessAmtConfigurationError"
    );
  }

  // Preserve the existing integration's authentication headers.
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cleanToken}`,
    "X-Access-Token": cleanToken,
  };
}

function redactCredentials(value, token) {
  const secrets = [
    normalizeString(token),
    getAccessAmtToken(),
  ].filter(Boolean);

  function redactString(text) {
    let result = text;

    for (const secret of secrets) {
      result = result.split(secret).join("[REDACTED]");
    }

    return result;
  }

  function walk(item) {
    if (typeof item === "string") {
      return redactString(item);
    }

    if (Array.isArray(item)) {
      return item.map(walk);
    }

    if (isObject(item)) {
      const result = {};

      for (const [key, child] of Object.entries(item)) {
        const sensitive =
          /token|authorization|secret|password|api[-_]?key/i.test(
            key
          );

        Object.defineProperty(result, key, {
          value: sensitive ? "[REDACTED]" : walk(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }

      return result;
    }

    return item;
  }

  return walk(value);
}

async function parseAccessResponse(response, token) {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return redactCredentials(JSON.parse(text), token);
  } catch {
    return {
      raw: redactCredentials(text.slice(0, 2000), token),
    };
  }
}

function getAccessErrorMessage(data, status) {
  if (typeof data?.message === "string") {
    return data.message;
  }

  if (typeof data?.error === "string") {
    return data.error;
  }

  if (typeof data?.error?.message === "string") {
    return data.error.message;
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

  return `Access AMT request failed with status ${status}.`;
}

function sanitizeAccessRequestPayload(payload) {
  const members = Array.isArray(payload?.import?.members)
    ? payload.import.members
    : [];

  return {
    import: {
      members: members.map((member) => ({
        organization_customer_identifier:
          member.organization_customer_identifier || null,
        program_customer_identifier:
          member.program_customer_identifier || null,
        member_customer_identifier:
          member.member_customer_identifier || null,
        member_status: member.member_status || null,
      })),
    },
  };
}

function validateImportPayload(payload) {
  const members = payload?.import?.members;

  if (
    !isObject(payload) ||
    !Array.isArray(members) ||
    members.length === 0
  ) {
    throw accessError(
      "Access AMT payload must contain import.members.",
      "ACCESS_AMT_PAYLOAD_REQUIRED",
      400,
      "AccessAmtValidationError"
    );
  }

  for (const member of members) {
    if (
      !isObject(member) ||
      !normalizeString(
        member.organization_customer_identifier
      ) ||
      !normalizeString(
        member.program_customer_identifier
      ) ||
      !normalizeString(
        member.member_customer_identifier
      ) ||
      normalizeString(
        member.member_customer_identifier
      ).length > MAX_MEMBER_IDENTIFIER_LENGTH ||
      !isValidEmail(member.email_address) ||
      ![OPEN_STATUS, SUSPEND_STATUS].includes(
        member.member_status
      )
    ) {
      throw accessError(
        "Access AMT payload contains an invalid member.",
        "ACCESS_AMT_MEMBER_PAYLOAD_INVALID",
        400,
        "AccessAmtValidationError"
      );
    }
  }
}

async function postToAccessAmt(payload, options = {}) {
  options = isObject(options) ? options : {};

  if (!isAccessAmtEnabled()) {
    throw accessError(
      "Access AMT is disabled or its token is not configured.",
      "ACCESS_AMT_DISABLED",
      503,
      "AccessAmtConfigurationError"
    );
  }

  validateImportPayload(payload);

  const token =
    normalizeString(options.token) || getAccessAmtToken();

  const url = validateAccessAmtUrl(
    normalizeString(options.url) || getAccessAmtUrl()
  );

  const headers = getAuthHeaders(token);

  const timeoutMs = Math.min(
    normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS
    ),
    60000
  );

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });

    const data = await parseAccessResponse(response, token);

    const explicitlyFailed =
      data?.success === false || data?.ok === false;

    if (!response.ok || explicitlyFailed) {
      const error = accessError(
        getAccessErrorMessage(data, response.status),
        "ACCESS_AMT_REQUEST_FAILED",
        response.ok ? 502 : response.status
      );

      error.statusText = response.statusText;
      error.url = url;
      error.payload = sanitizeAccessRequestPayload(payload);
      error.response = data;

      throw error;
    }

    return {
      success: true,
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url,
      payload,
      response: data,

      // A 202 response confirms acceptance, not completed provisioning.
      pending: response.status === 202,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw accessError(
        `Access AMT request timed out after ${timeoutMs}ms.`,
        "ACCESS_AMT_TIMEOUT",
        504,
        "AccessAmtTimeoutError"
      );
    }

    if (
      typeof error?.code === "string" &&
      error.code.startsWith("ACCESS_")
    ) {
      throw error;
    }

    throw accessError(
      "Access AMT could not be reached or its response could not be read.",
      "ACCESS_AMT_NETWORK_ERROR",
      502
    );
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Direct member actions
// -----------------------------------------------------------------------------

async function submitAccessMember(
  member,
  memberStatus,
  options
) {
  const payload = buildAccessAmtImportPayload(
    member,
    memberStatus
  );

  const result = await postToAccessAmt(payload, options);
  const submittedMember = payload.import.members[0];

  return {
    ...result,
    access_member_identifier:
      submittedMember.member_customer_identifier,
    access_member_status: memberStatus,
    access_perks_ready:
      memberStatus === OPEN_STATUS && !result.pending,
    access_payload: payload,
    access_response: result.response,
  };
}

async function syncMemberToAccessAmt(
  member = {},
  options = {}
) {
  // Explicit OPEN action. For automatic billing eligibility decisions,
  // use syncMemberAccessState().
  return submitAccessMember(member, OPEN_STATUS, options);
}

async function suspendMemberInAccessAmt(
  member = {},
  options = {}
) {
  return submitAccessMember(member, SUSPEND_STATUS, options);
}

async function createAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(member, options);
}

async function updateAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(member, options);
}

async function openAccessMember(
  member = {},
  options = {}
) {
  return syncMemberToAccessAmt(member, options);
}

async function suspendAccessMember(
  member = {},
  options = {}
) {
  return suspendMemberInAccessAmt(member, options);
}

// -----------------------------------------------------------------------------
// Card Leo eligibility
// -----------------------------------------------------------------------------

function getCardLeoMemberStatuses(member = {}) {
  return {
    status: normalizeLowerStatus(member.status),
    paymentStatus: normalizeLowerStatus(
      member.payment_status || member.paymentStatus
    ),
    membershipStatus: normalizeLowerStatus(
      member.membership_status || member.membershipStatus
    ),
    approvalStatus: normalizeLowerStatus(
      member.approval_status || member.approvalStatus
    ),
  };
}

function isAccessActiveMember(member = {}) {
  if (!isObject(member)) {
    return false;
  }

  const {
    status,
    paymentStatus,
    membershipStatus,
    approvalStatus,
  } = getCardLeoMemberStatuses(member);

  const accountStatuses = [
    status,
    membershipStatus,
    approvalStatus,
  ];

  // Negative states override stale paid/approved values.
  if (
    [...accountStatuses, paymentStatus].some(
      (value) =>
        BLOCKED_STATUSES.has(value) ||
        UNPAID_STATUSES.has(value)
    )
  ) {
    return false;
  }

  if (!ACTIVE_STATUSES.has(paymentStatus)) {
    return false;
  }

  return accountStatuses.some((value) =>
    ACTIVE_STATUSES.has(value)
  );
}

function getDesiredAccessMemberStatus(member = {}) {
  return isAccessActiveMember(member)
    ? OPEN_STATUS
    : SUSPEND_STATUS;
}

function shouldSyncMemberAccessState(member = {}) {
  if (!isObject(member)) {
    return true;
  }

  const identifier = normalizeString(
    member.access_member_identifier ||
      member.accessMemberIdentifier ||
      member.member_customer_identifier ||
      member.memberCustomerIdentifier
  );

  const currentStatus = normalizeStatus(
    member.access_member_status || member.accessMemberStatus
  );

  if (
    !identifier ||
    normalizeString(member.access_sync_error) ||
    ![OPEN_STATUS, SUSPEND_STATUS].includes(currentStatus)
  ) {
    return true;
  }

  return (
    getDesiredAccessMemberStatus(member) !== currentStatus
  );
}

async function syncMemberAccessState(
  member = {},
  options = {}
) {
  return getDesiredAccessMemberStatus(member) === OPEN_STATUS
    ? syncMemberToAccessAmt(member, options)
    : suspendMemberInAccessAmt(member, options);
}

// -----------------------------------------------------------------------------
// Result helpers
// -----------------------------------------------------------------------------

function isAccessSyncSuccessful(result) {
  return Boolean(
    result &&
      result.success === true &&
      result.ok === true &&
      result.pending !== true
  );
}

function getAccessSyncStatus(result) {
  if (!isObject(result)) {
    return "";
  }

  const candidates = [
    result.access_member_status,
    result.member_status,
    result.payload?.import?.members?.[0]?.member_status,
    result.access_payload?.import?.members?.[0]?.member_status,
    result.status,
  ];

  for (const value of candidates) {
    const status = normalizeStatus(value);

    if (status === OPEN_STATUS || status === SUSPEND_STATUS) {
      return status;
    }
  }

  return "";
}

function getAccessMemberIdentifierFromResult(result) {
  if (!isObject(result)) {
    return "";
  }

  return normalizeString(
    result.access_member_identifier ||
      result.member_customer_identifier ||
      result.memberCustomerIdentifier ||
      result.payload?.import?.members?.[0]
        ?.member_customer_identifier ||
      result.access_payload?.import?.members?.[0]
        ?.member_customer_identifier
  );
}

// -----------------------------------------------------------------------------
// Database snapshots
// -----------------------------------------------------------------------------

function buildAccessMemberSnapshot(
  member = {},
  result = null
) {
  // Never mark a member ready from a local status calculation alone.
  if (!isAccessSyncSuccessful(result)) {
    throw accessError(
      result?.pending
        ? "Access accepted the import; provisioning confirmation is still pending."
        : "A completed Access AMT result is required for a success snapshot.",
      result?.pending
        ? "ACCESS_AMT_IMPORT_PENDING"
        : "ACCESS_AMT_RESULT_REQUIRED",
      result?.pending ? 202 : 400
    );
  }

  const identifier =
    getAccessMemberIdentifierFromResult(result) ||
    buildMemberCustomerIdentifier(member);

  const status = getAccessSyncStatus(result);

  if (!identifier || !status) {
    throw accessError(
      "Access sync result is missing its member identifier or status.",
      "ACCESS_AMT_RESULT_INVALID",
      502
    );
  }

  const syncedAt = new Date().toISOString();

  return {
    access_member_identifier: identifier,
    access_member_status: status,
    access_perks_ready: status === OPEN_STATUS,
    access_synced_at: syncedAt,
    access_suspended_at:
      status === SUSPEND_STATUS ? syncedAt : null,
    access_sync_error: null,
    access_last_payload:
      result.access_payload || result.payload || null,
    access_last_response: redactCredentials(
      result.access_response || result.response || null
    ),
  };
}

function buildAccessFailureSnapshot(
  member = {},
  error = null
) {
  let identifier = normalizeString(
    member?.access_member_identifier ||
      member?.accessMemberIdentifier ||
      member?.member_customer_identifier ||
      member?.memberCustomerIdentifier
  );

  if (!identifier) {
    try {
      identifier = buildMemberCustomerIdentifier(member);
    } catch {
      identifier = "";
    }
  }

  return {
    access_member_identifier: identifier,
    access_member_status:
      error?.code === "ACCESS_AMT_IMPORT_PENDING"
        ? "sync_pending"
        : "sync_failed",
    access_perks_ready: false,
    access_sync_error: redactCredentials(
      normalizeString(error?.message) ||
        "Access AMT synchronization failed."
    ),
    access_last_payload:
      error?.payload || null,
    access_last_response: redactCredentials(
      error?.response || null
    ),
  };
}

async function safeSyncMemberAccessState(
  member = {},
  options = {}
) {
  try {
    const result = await syncMemberAccessState(
      member,
      options
    );

    if (result.pending) {
      const error = accessError(
        "Access accepted the import; provisioning confirmation is still pending.",
        "ACCESS_AMT_IMPORT_PENDING",
        202
      );

      error.payload = sanitizeAccessRequestPayload(
        result.payload
      );
      error.response = result.response;

      return {
        success: false,
        pending: true,
        result,
        snapshot: buildAccessFailureSnapshot(member, error),
        error: {
          name: error.name,
          code: error.code,
          status: error.status,
          message: error.message,
        },
      };
    }

    return {
      success: true,
      pending: false,
      result,
      snapshot: buildAccessMemberSnapshot(member, result),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      pending: false,
      result: null,
      snapshot: buildAccessFailureSnapshot(member, error),
      error: {
        name: error?.name || "Error",
        code: error?.code || "ACCESS_SYNC_FAILED",
        status: error?.status || 500,
        message: redactCredentials(
          error?.message ||
            "Access synchronization failed."
        ),
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Controlled integration-test member
// -----------------------------------------------------------------------------

function buildAccessTestMember({
  id,
  firstName,
  lastName,
  email,
} = {}) {
  // Use the real immutable ID of the controlled test account.
  // Do not share a default test identifier between different accounts.
  const memberId = normalizeString(id);

  if (!memberId) {
    throw accessError(
      "Supply the controlled test member's immutable Card Leo ID.",
      "ACCESS_TEST_MEMBER_ID_REQUIRED",
      400
    );
  }

  if (!isValidEmail(email)) {
    throw accessError(
      "Supply a valid controlled test member email.",
      "ACCESS_TEST_MEMBER_EMAIL_REQUIRED",
      400
    );
  }

  return {
    id: memberId,
    first_name: normalizeString(firstName) || "Card",
    last_name: normalizeString(lastName) || "Leo",
    email: normalizeEmail(email),
    status: "active",
    payment_status: "paid",
    membership_status: "active",
    approval_status: "approved",
  };
}

// -----------------------------------------------------------------------------
// Named exports
// -----------------------------------------------------------------------------

export {
  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,
  DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER,
  DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER,
  DEFAULT_TIMEOUT_MS,
  MAX_MEMBER_IDENTIFIER_LENGTH,
  OPEN_STATUS,
  SUSPEND_STATUS,
  normalizeString,
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

// -----------------------------------------------------------------------------
// Default export
// -----------------------------------------------------------------------------

const accessAmt = {
  DEFAULT_STAGE_BASE_URL,
  DEFAULT_PRODUCTION_BASE_URL,
  DEFAULT_AMT_ENDPOINT_PATH,
  DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER,
  DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER,
  DEFAULT_TIMEOUT_MS,
  MAX_MEMBER_IDENTIFIER_LENGTH,
  OPEN_STATUS,
  SUSPEND_STATUS,
  normalizeString,
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