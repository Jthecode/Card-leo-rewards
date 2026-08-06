// lib/access-amt.js

const DEFAULT_STAGE_BASE_URL = "https://amt-stage.accessdevelopment.com/api/v1";
const DEFAULT_PRODUCTION_BASE_URL = "https://amt.accessdevelopment.com/api/v1";

const DEFAULT_ORGANIZATION_CUSTOMER_IDENTIFIER = "2002479";
const DEFAULT_PROGRAM_CUSTOMER_IDENTIFIER = "200783";

const OPEN_STATUS = "OPEN";
const SUSPEND_STATUS = "SUSPEND";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function onlyAlphaNumeric(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9]/g, "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function getEnv(name, fallback = "") {
  return normalizeString(process.env[name] || fallback);
}

function cleanBaseUrl(value) {
  return normalizeString(value).replace(/\/+$/, "");
}

function getAccessAmtBaseUrl() {
  const configured = getEnv("ACCESS_AMT_BASE_URL");

  if (configured) {
    return cleanBaseUrl(configured);
  }

  const env = getEnv("ACCESS_ENVIRONMENT", "stage").toLowerCase();

  if (env === "production" || env === "prod" || env === "live") {
    return DEFAULT_PRODUCTION_BASE_URL;
  }

  return DEFAULT_STAGE_BASE_URL;
}

function getAccessAmtToken() {
  return (
    getEnv("ACCESS_AMT_API_TOKEN") ||
    getEnv("ACCESS_API_TOKEN") ||
    getEnv("ACCESS_OFFERS_API_TOKEN") ||
    getEnv("ACCESS_CURRENT_ACCESS_TOKEN")
  );
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

function getAccessAmtEndpointPath() {
  const configured = getEnv("ACCESS_AMT_ENDPOINT_PATH");

  if (
    !configured ||
    configured === "/" ||
    configured.toLowerCase() === "root" ||
    configured.toLowerCase() === "base"
  ) {
    return "";
  }

  return configured.startsWith("/") ? configured : `/${configured}`;
}

function getAccessAmtUrl() {
  return `${getAccessAmtBaseUrl()}${getAccessAmtEndpointPath()}`;
}

function getMemberNameParts(member = {}) {
  const firstName =
    normalizeString(member.first_name) ||
    normalizeString(member.firstName) ||
    normalizeString(member.given_name) ||
    normalizeString(member.givenName);

  const lastName =
    normalizeString(member.last_name) ||
    normalizeString(member.lastName) ||
    normalizeString(member.family_name) ||
    normalizeString(member.familyName);

  const fullName =
    normalizeString(member.full_name) ||
    normalizeString(member.fullName) ||
    normalizeString(member.name);

  if (firstName || lastName) {
    return {
      firstName: firstName || "Card",
      lastName: lastName || "Leo",
    };
  }

  const parts = fullName.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
    };
  }

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "Member",
    };
  }

  const emailPrefix = normalizeEmail(member.email).split("@")[0];

  return {
    firstName: emailPrefix || "Card",
    lastName: "Leo",
  };
}

function buildMemberCustomerIdentifier(member = {}) {
  const existing =
    normalizeString(member.access_member_identifier) ||
    normalizeString(member.accessMemberIdentifier) ||
    normalizeString(member.member_customer_identifier) ||
    normalizeString(member.memberCustomerIdentifier);

  if (existing) {
    const cleaned = onlyAlphaNumeric(existing);

    if (cleaned) {
      return cleaned.slice(0, 64);
    }
  }

  const id = onlyAlphaNumeric(member.id);

  if (id) {
    return `CLR${id}`.slice(0, 64);
  }

  const email = normalizeEmail(member.email);
  const emailPrefix = onlyAlphaNumeric(email.split("@")[0]);
  const timestamp = Date.now().toString();

  return `CLR${emailPrefix || "MEMBER"}${timestamp}`.slice(0, 64);
}

function buildAccessAmtMemberPayload(member = {}, memberStatus = OPEN_STATUS) {
  const email = normalizeEmail(member.email || member.email_address);

  if (!email || !isValidEmail(email)) {
    throw new Error("A valid member email is required for Access AMT sync.");
  }

  const { firstName, lastName } = getMemberNameParts(member);
  const memberCustomerIdentifier = buildMemberCustomerIdentifier(member);

  return {
    organization_customer_identifier: getOrganizationCustomerIdentifier(),
    program_customer_identifier: getProgramCustomerIdentifier(),
    first_name: firstName,
    last_name: lastName,
    email_address: email,
    member_customer_identifier: memberCustomerIdentifier,
    member_status: memberStatus,
  };
}

function buildAccessAmtImportPayload(member = {}, memberStatus = OPEN_STATUS) {
  return {
    import: {
      members: [buildAccessAmtMemberPayload(member, memberStatus)],
    },
  };
}

function getAuthHeaders(token) {
  const cleanToken = normalizeString(token);

  if (!cleanToken) {
    throw new Error(
      "Missing Access AMT token. Add ACCESS_AMT_API_TOKEN in Vercel."
    );
  }

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cleanToken}`,
    "X-Access-Token": cleanToken,
  };
}

async function parseAccessResponse(response) {
  const text = await response.text().catch(() => "");

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
    };
  }
}

async function postToAccessAmt(payload, options = {}) {
  const token = normalizeString(options.token) || getAccessAmtToken();
  const url = normalizeString(options.url) || getAccessAmtUrl();

  const response = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(token),
    body: JSON.stringify(payload),
  });

  const data = await parseAccessResponse(response);

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.errors?.[0]?.message ||
      `Access AMT request failed with status ${response.status}.`;

    const error = new Error(message);

    error.status = response.status;
    error.statusText = response.statusText;
    error.url = url;
    error.payload = payload;
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
  };
}

async function syncMemberToAccessAmt(member = {}, options = {}) {
  const payload = buildAccessAmtImportPayload(member, OPEN_STATUS);
  const result = await postToAccessAmt(payload, options);

  return {
    ...result,
    access_member_identifier:
      payload.import.members[0].member_customer_identifier,
    access_member_status: OPEN_STATUS,
    access_payload: payload,
    access_response: result.response,
  };
}

async function suspendMemberInAccessAmt(member = {}, options = {}) {
  const payload = buildAccessAmtImportPayload(member, SUSPEND_STATUS);
  const result = await postToAccessAmt(payload, options);

  return {
    ...result,
    access_member_identifier:
      payload.import.members[0].member_customer_identifier,
    access_member_status: SUSPEND_STATUS,
    access_payload: payload,
    access_response: result.response,
  };
}

function isAccessActiveMember(member = {}) {
  const status = normalizeString(member.status).toLowerCase();
  const paymentStatus = normalizeString(member.payment_status).toLowerCase();
  const membershipStatus = normalizeString(member.membership_status).toLowerCase();
  const approvalStatus = normalizeString(member.approval_status).toLowerCase();

  const activeStatuses = new Set([
    "active",
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

  return (
    activeStatuses.has(status) ||
    activeStatuses.has(paymentStatus) ||
    activeStatuses.has(membershipStatus) ||
    activeStatuses.has(approvalStatus)
  );
}

function getAccessAmtConfigForDebug() {
  return {
    baseUrl: getAccessAmtBaseUrl(),
    endpointPath: getAccessAmtEndpointPath() || "root",
    url: getAccessAmtUrl(),
    organizationCustomerIdentifier: getOrganizationCustomerIdentifier(),
    programCustomerIdentifier: getProgramCustomerIdentifier(),
    hasToken: Boolean(getAccessAmtToken()),
  };
}

export {
  OPEN_STATUS,
  SUSPEND_STATUS,
  buildAccessAmtMemberPayload,
  buildAccessAmtImportPayload,
  buildMemberCustomerIdentifier,
  getAccessAmtBaseUrl,
  getAccessAmtEndpointPath,
  getAccessAmtToken,
  getAccessAmtUrl,
  getAccessAmtConfigForDebug,
  isAccessActiveMember,
  postToAccessAmt,
  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
};