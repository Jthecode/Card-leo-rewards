// api/access/redeem-offer.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  accessOffersRequest,
  getAccessOffersBaseUrl,
  getAccessOffersConfigForDebug,
  getAccessOffersIntegrationStatus,
  getAccessOffersToken,
  normalizeBoolean,
  normalizeString,
} from "../../lib/access-offers.js";

import {
  clearAuthCookies,
  getSessionCookieName,
  safeJsonParse,
} from "../../lib/cookies.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #17
   ACCESS OFFER REDEMPTION ENDPOINT

   ROUTE
   -----
   POST /api/access/redeem-offer

   PURPOSE
   -------
   Securely claim/redeem an Access Development offer for a logged-in
   Card Leo Rewards member.

   MEMBER FLOW
   -----------
   Member chooses benefit
          ↓
   POST /api/access/redeem-offer
          ↓
   Verify Card Leo login
          ↓
   Verify paid/active membership
          ↓
   Verify Access AMT member is OPEN
          ↓
   Send member + offer to Access redemption service
          ↓
   Access returns redemption material
          ↓
   Card Leo returns safe:
      - QR code
      - barcode
      - coupon/code
      - online redemption link
      - instructions
      - expiration

   IMPORTANT
   ---------
   This route does NOT invent coupons.

   It only returns redemption data actually returned by Access.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_TIMEOUT_MS =
  25000;

const MAX_TIMEOUT_MS =
  60000;

const DEFAULT_REDEMPTION_METHOD =
  "POST";

const DEFAULT_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

const ACTIVE_MEMBER_STATUSES =
  new Set([
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

const ACTIVE_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

const ACTIVE_MEMBERSHIP_STATUSES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
  ]);

const ACTIVE_APPROVAL_STATUSES =
  new Set([
    "active",
    "approved",
    "complete",
    "completed",
    "auto_approved",
  ]);

const INACTIVE_STATUSES =
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

/* ==========================================================================
   RESPONSE HELPERS
============================================================================ */

function sendJson(
  res,
  statusCode,
  payload
) {
  res.statusCode =
    statusCode;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

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
      message,
      ...extra,
    }
  );
}

function notFound(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    404,
    {
      success: false,
      ok: false,
      message,
      ...extra,
    }
  );
}

function conflict(
  res,
  message,
  extra = {}
) {
  return sendJson(
    res,
    409,
    {
      success: false,
      ok: false,
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

function normalizeUpper(
  value
) {
  return normalizeString(
    value
  ).toUpperCase();
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

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
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
      normalizeString(value)
    ) {
      return value;
    }
  }

  return "";
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

function nowIso() {
  return new Date()
    .toISOString();
}

/* ==========================================================================
   REQUEST BODY
============================================================================ */

function getRequestBody(
  req
) {
  if (!req?.body) {
    return {};
  }

  if (
    typeof req.body === "string"
  ) {
    try {
      return JSON.parse(
        req.body
      );
    } catch {
      return {};
    }
  }

  if (
    typeof req.body === "object"
  ) {
    return req.body;
  }

  return {};
}

/* ==========================================================================
   ENVIRONMENT HELPERS
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
   REDEMPTION CONFIG

   DO NOT GUESS THESE.

   Add the exact values Access gives Card Leo.
============================================================================ */

function getAccessRedemptionEndpointPath() {
  const configured =
    getEnv(
      "ACCESS_REDEMPTION_ENDPOINT_PATH"
    );

  if (!configured) {
    return "";
  }

  if (
    configured === "/" ||
    normalizeLower(configured) === "root"
  ) {
    return "";
  }

  return configured.startsWith("/")
    ? configured
    : `/${configured}`;
}

function getAccessRedemptionMethod() {
  const method =
    normalizeUpper(
      getEnv(
        "ACCESS_REDEMPTION_METHOD",
        DEFAULT_REDEMPTION_METHOD
      )
    );

  if (
    [
      "POST",
      "PUT",
      "PATCH",
    ].includes(method)
  ) {
    return method;
  }

  return DEFAULT_REDEMPTION_METHOD;
}

function getAccessRedemptionOfferIdField() {
  return (
    getEnv(
      "ACCESS_REDEMPTION_OFFER_ID_FIELD"
    ) ||
    "offer_id"
  );
}

function getAccessRedemptionMemberIdField() {
  return (
    getEnv(
      "ACCESS_REDEMPTION_MEMBER_ID_FIELD"
    ) ||
    "member_customer_identifier"
  );
}

function getAccessRedemptionProgramField() {
  return (
    getEnv(
      "ACCESS_REDEMPTION_PROGRAM_FIELD"
    ) ||
    "program_customer_identifier"
  );
}

function getAccessRedemptionOrganizationField() {
  return (
    getEnv(
      "ACCESS_REDEMPTION_ORGANIZATION_FIELD"
    ) ||
    "organization_customer_identifier"
  );
}

/* ==========================================================================
   SESSION COOKIE PARSING
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
        result,
        part
      ) => {
        const separator =
          part.indexOf("=");

        if (
          separator === -1
        ) {
          return result;
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
          return result;
        }

        try {
          result[name] =
            decodeURIComponent(
              rawValue
            );
        } catch {
          result[name] =
            rawValue;
        }

        return result;
      },
      {}
    );
}

/* ==========================================================================
   SESSION DECODING
============================================================================ */

function parseSessionValue(
  rawValue
) {
  if (
    isObject(rawValue)
  ) {
    return rawValue;
  }

  const raw =
    normalizeString(
      rawValue
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
          normalized.length /
          4
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
    typeof getSessionCookieName ===
    "function"
      ? normalizeString(
          getSessionCookieName()
        )
      : "";

  const names =
    Array.from(
      new Set([
        configuredName,
        ...DEFAULT_SESSION_COOKIE_NAMES,
      ].filter(Boolean))
    );

  for (
    const name
    of names
  ) {
    const value =
      cookies[name];

    if (!value) {
      continue;
    }

    const data =
      parseSessionValue(
        value
      );

    if (
      isObject(data)
    ) {
      return {
        name,
        data,
      };
    }
  }

  return null;
}

/* ==========================================================================
   SESSION MEMBER
============================================================================ */

function getSessionMemberId(
  session
) {
  const data =
    session?.data ||
    {};

  return normalizeString(
    data.member?.id ||
      data.profile?.id ||
      data.user?.id ||
      data.member_id ||
      data.memberId ||
      data.signup_id ||
      data.signupId ||
      data.id
  );
}

function getSessionEmail(
  session
) {
  const data =
    session?.data ||
    {};

  return normalizeEmail(
    data.member?.email ||
      data.profile?.email ||
      data.user?.email ||
      data.email ||
      data.userEmail
  );
}

function getSessionExpiresAt(
  session
) {
  const data =
    session?.data ||
    {};

  const candidates = [
    data.expires_at,
    data.expiresAt,
    data.exp,
    data.session?.expires_at,
    data.session?.expiresAt,
  ];

  for (
    const candidate
    of candidates
  ) {
    const value =
      Number(candidate);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return 0;
}

function isSessionExpired(
  session
) {
  const expiresAt =
    getSessionExpiresAt(
      session
    );

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
  } else {
    query =
      query.ilike(
        "email",
        email
      );
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

  return data ||
    null;
}

/* ==========================================================================
   ACTIVE MEMBER
============================================================================ */

function isMemberActive(
  member
) {
  const status =
    normalizeLower(
      member?.status
    );

  const paymentStatus =
    normalizeLower(
      member?.payment_status
    );

  const membershipStatus =
    normalizeLower(
      member?.membership_status
    );

  const approvalStatus =
    normalizeLower(
      member?.approval_status
    );

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

  return paid &&
    active;
}

/* ==========================================================================
   ACCESS READY
============================================================================ */

function isAccessReady(
  member
) {
  if (
    typeof member
      ?.access_perks_ready ===
      "boolean"
  ) {
    return member
      .access_perks_ready;
  }

  return (
    normalizeUpper(
      member
        ?.access_member_status
    ) ===
    "OPEN"
  );
}

/* ==========================================================================
   AUTHENTICATE
============================================================================ */

async function authenticateMember(
  req,
  res
) {
  const session =
    readSessionCookie(
      req
    );

  if (!session?.data) {
    return {
      member: null,
      response:
        unauthorized(
          res,
          "Please sign in to redeem Card Leo benefits."
        ),
    };
  }

  if (
    isSessionExpired(
      session
    )
  ) {
    clearAuthCookies(
      res
    );

    return {
      member: null,
      response:
        unauthorized(
          res,
          "Your session has expired. Please sign in again."
        ),
    };
  }

  /*
   * IMPORTANT:
   *
   * Do NOT require:
   *
   *   session.data.authenticated === true
   *
   * Card Leo resolves the member from the server-side session identity.
   */

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
    return {
      member: null,
      response:
        unauthorized(
          res,
          "Member identity is missing from your login session."
        ),
    };
  }

  const member =
    await findMember({
      memberId,
      email,
    });

  if (!member?.id) {
    return {
      member: null,
      response:
        unauthorized(
          res,
          "Card Leo member record could not be found."
        ),
    };
  }

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
          "Your Card Leo membership must be active and paid before redeeming benefits.",
          {
            requiresPayment:
              true,

            redirectTo:
              "/signup.html?status=payment_required",
          }
        ),
    };
  }

  if (
    !isAccessReady(
      member
    )
  ) {
    return {
      member: null,
      response:
        forbidden(
          res,
          "Your Access Perks membership is not ready for redemption yet.",
          {
            code:
              "ACCESS_MEMBER_NOT_READY",

            accessStatus:
              normalizeString(
                member
                  .access_member_status
              ) ||
              "pending",

            syncEndpoint:
              "/api/access/sync-member",
          }
        ),
    };
  }

  return {
    member,
    response:
      null,
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
      isAccessReady(
        member
      ),
  };
}

/* ==========================================================================
   OFFER ID
============================================================================ */

function getOfferId(
  body = {}
) {
  return normalizeString(
    body.offer_id ||
      body.offerId ||
      body.access_offer_id ||
      body.accessOfferId ||
      body.id
  );
}

/* ==========================================================================
   REDEMPTION REQUEST PAYLOAD
============================================================================ */

function buildRedemptionPayload({
  member,
  offerId,
  body,
}) {
  const payload = {};

  const offerField =
    getAccessRedemptionOfferIdField();

  const memberField =
    getAccessRedemptionMemberIdField();

  const organizationField =
    getAccessRedemptionOrganizationField();

  const programField =
    getAccessRedemptionProgramField();

  payload[offerField] =
    offerId;

  payload[memberField] =
    normalizeString(
      member
        .access_member_identifier
    );

  const organization =
    getEnv(
      "ACCESS_ORGANIZATION_CUSTOMER_IDENTIFIER",
      "2002479"
    );

  const program =
    getEnv(
      "ACCESS_PROGRAM_CUSTOMER_IDENTIFIER",
      "200783"
    );

  if (organization) {
    payload[
      organizationField
    ] =
      organization;
  }

  if (program) {
    payload[
      programField
    ] =
      program;
  }

  /*
   * Optional location selected by member.
   */

  const locationId =
    normalizeString(
      body.location_id ||
      body.locationId
    );

  if (locationId) {
    payload[
      getEnv(
        "ACCESS_REDEMPTION_LOCATION_ID_FIELD",
        "location_id"
      )
    ] =
      locationId;
  }

  /*
   * Optional redemption type selected by frontend.
   */

  const redemptionType =
    normalizeString(
      body.redemption_type ||
      body.redemptionType
    );

  if (redemptionType) {
    payload[
      getEnv(
        "ACCESS_REDEMPTION_TYPE_FIELD",
        "redemption_type"
      )
    ] =
      redemptionType;
  }

  return payload;
}

/* ==========================================================================
   RESPONSE UNWRAP
============================================================================ */

function unwrapRedemptionResponse(
  result
) {
  const response =
    result?.response;

  if (
    isObject(
      response?.redemption
    )
  ) {
    return response.redemption;
  }

  if (
    isObject(
      response?.data?.redemption
    )
  ) {
    return response
      .data
      .redemption;
  }

  if (
    isObject(
      response?.data
    )
  ) {
    return response.data;
  }

  if (
    isObject(response)
  ) {
    return response;
  }

  return {};
}

/* ==========================================================================
   NORMALIZE REDEMPTION RESPONSE
============================================================================ */

function normalizeRedemptionResult(
  result,
  offerId
) {
  const data =
    unwrapRedemptionResponse(
      result
    );

  const code =
    normalizeString(
      firstNonEmpty(
        data.code,
        data.coupon_code,
        data.couponCode,
        data.promo_code,
        data.promoCode,
        data.redemption_code,
        data.redemptionCode
      )
    );

  const barcode =
    normalizeString(
      firstNonEmpty(
        data.barcode,
        data.barcode_value,
        data.barcodeValue,
        data.bar_code,
        data.barCode
      )
    );

  const barcodeFormat =
    normalizeString(
      firstNonEmpty(
        data.barcode_format,
        data.barcodeFormat,
        data.barcode_type,
        data.barcodeType
      )
    );

  const qrCode =
    normalizeString(
      firstNonEmpty(
        data.qr_code,
        data.qrCode,
        data.qr_code_url,
        data.qrCodeUrl,
        data.qrcode,
        data.qrcode_url
      )
    );

  const redemptionUrl =
    normalizeString(
      firstNonEmpty(
        data.url,
        data.redemption_url,
        data.redemptionUrl,
        data.claim_url,
        data.claimUrl,
        data.online_url,
        data.onlineUrl
      )
    );

  const instructions =
    normalizeString(
      firstNonEmpty(
        data.instructions,
        data.redemption_instructions,
        data.redemptionInstructions,
        data.description
      )
    );

  const redemptionId =
    normalizeString(
      firstNonEmpty(
        data.id,
        data.redemption_id,
        data.redemptionId,
        data.token,
        data.redemption_token,
        data.redemptionToken
      )
    );

  const expiresAt =
    safeDate(
      firstNonEmpty(
        data.expires_at,
        data.expiresAt,
        data.expiration_date,
        data.expirationDate,
        data.valid_until,
        data.validUntil
      )
    );

  const hasRedemptionMaterial =
    Boolean(
      code ||
      barcode ||
      qrCode ||
      redemptionUrl
    );

  return {
    offerId,

    redemptionId:
      redemptionId ||
      null,

    status:
      normalizeString(
        firstNonEmpty(
          data.status,
          data.redemption_status,
          data.redemptionStatus
        )
      ) ||
      (
        hasRedemptionMaterial
          ? "ready"
          : "pending"
      ),

    code:
      code ||
      null,

    barcode:
      barcode ||
      null,

    barcodeFormat:
      barcodeFormat ||
      null,

    qrCode:
      qrCode ||
      null,

    redemptionUrl:
      redemptionUrl ||
      null,

    instructions:
      instructions ||
      null,

    expiresAt,

    hasCode:
      Boolean(code),

    hasBarcode:
      Boolean(barcode),

    hasQrCode:
      Boolean(qrCode),

    hasOnlineUrl:
      Boolean(
        redemptionUrl
      ),

    ready:
      hasRedemptionMaterial,
  };
}

/* ==========================================================================
   OPTIONAL REDEMPTION LOGGING

   Step #21 will create access_redemptions.

   Until then this safely skips if the table does not exist.
============================================================================ */

function isMissingTable(
  error
) {
  const code =
    String(
      error?.code ||
      ""
    );

  const message =
    String(
      error?.message ||
      ""
    ).toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes(
      "does not exist"
    ) ||
    message.includes(
      "could not find"
    )
  );
}

async function saveRedemptionRecord({
  member,
  offerId,
  redemption,
  accessResponse,
}) {
  const payload = {
    member_id:
      member.id,

    access_member_identifier:
      normalizeString(
        member
          .access_member_identifier
      ) ||
      null,

    access_offer_id:
      offerId,

    access_redemption_id:
      redemption
        .redemptionId ||
      null,

    status:
      redemption.status ||
      "ready",

    redemption_code:
      redemption.code ||
      null,

    barcode_value:
      redemption.barcode ||
      null,

    barcode_format:
      redemption
        .barcodeFormat ||
      null,

    qr_code_data:
      redemption.qrCode ||
      null,

    redemption_url:
      redemption
        .redemptionUrl ||
      null,

    instructions:
      redemption
        .instructions ||
      null,

    expires_at:
      redemption
        .expiresAt ||
      null,

    provider:
      "access",

    provider_response:
      accessResponse ||
      {},

    redeemed_at:
      nowIso(),

    created_at:
      nowIso(),

    updated_at:
      nowIso(),
  };

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "access_redemptions"
      )
      .insert(
        payload
      )
      .select()
      .single();

  if (!error) {
    return {
      saved:
        true,

      recordId:
        data?.id ||
        null,
    };
  }

  if (
    isMissingTable(error)
  ) {
    return {
      saved:
        false,

      tableReady:
        false,
    };
  }

  /*
   * Redemption has already succeeded at Access.
   * Do NOT fail the member's coupon merely because local logging failed.
   */

  console.error(
    "Card Leo redemption logging error:",
    error
  );

  return {
    saved:
      false,

    tableReady:
      true,

    error:
      error.message,
  };
}

/* ==========================================================================
   REDACTION FOR DEBUG
============================================================================ */

function redactSensitive(
  value
) {
  if (
    Array.isArray(value)
  ) {
    return value.map(
      redactSensitive
    );
  }

  if (
    !isObject(value)
  ) {
    return value;
  }

  const output = {};

  for (
    const [
      key,
      item,
    ] of Object.entries(value)
  ) {
    const normalized =
      normalizeLower(key);

    if (
      normalized.includes(
        "authorization"
      ) ||
      normalized.includes(
        "secret"
      ) ||
      normalized.includes(
        "password"
      ) ||
      normalized ===
        "api_token" ||
      normalized ===
        "access_token"
    ) {
      output[key] =
        "[REDACTED]";

      continue;
    }

    output[key] =
      redactSensitive(
        item
      );
  }

  return output;
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
    req.method !== "POST"
  ) {
    res.setHeader(
      "Allow",
      "POST"
    );

    return sendJson(
      res,
      405,
      {
        success: false,
        ok: false,
        message:
          "Method not allowed. Use POST.",
      }
    );
  }

  try {
    /* ======================================================================
       AUTH
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
       BODY
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const offerId =
      getOfferId(
        body
      );

    if (!offerId) {
      return badRequest(
        res,
        "An Access offer ID is required.",
        {
          code:
            "ACCESS_OFFER_ID_REQUIRED",

          example: {
            offerId:
              "ACCESS-OFFER-ID",
          },
        }
      );
    }

    const debug =
      normalizeBoolean(
        body.debug,
        false
      );

    /* ======================================================================
       ACCESS OFFERS CONFIG
    ====================================================================== */

    const offersStatus =
      getAccessOffersIntegrationStatus();

    if (
      !offersStatus
        .hasToken
    ) {
      return serviceUnavailable(
        res,
        "Access API token is not configured.",
        {
          code:
            "ACCESS_TOKEN_REQUIRED",
        }
      );
    }

    /* ======================================================================
       REDEMPTION CONFIG
    ====================================================================== */

    const redemptionPath =
      getAccessRedemptionEndpointPath();

    if (!redemptionPath) {
      return serviceUnavailable(
        res,
        "Access redemption is not configured yet.",
        {
          code:
            "ACCESS_REDEMPTION_ENDPOINT_REQUIRED",

          message:
            "Add the exact Access-approved redemption endpoint path to ACCESS_REDEMPTION_ENDPOINT_PATH before enabling Claim Offer.",

          configuredOffersBaseUrl:
            getAccessOffersBaseUrl(),

          debug:
            debug
              ? {
                  offers:
                    getAccessOffersConfigForDebug(),

                  redemption: {
                    endpointPath:
                      null,

                    method:
                      getAccessRedemptionMethod(),
                  },
                }
              : undefined,
        }
      );
    }

    const accessMemberIdentifier =
      normalizeString(
        member
          .access_member_identifier
      );

    if (
      !accessMemberIdentifier
    ) {
      return conflict(
        res,
        "Your Access member identifier is missing. Sync your membership before redeeming this offer.",
        {
          code:
            "ACCESS_MEMBER_IDENTIFIER_REQUIRED",

          syncEndpoint:
            "/api/access/sync-member",
        }
      );
    }

    /* ======================================================================
       REQUEST PAYLOAD
    ====================================================================== */

    const payload =
      buildRedemptionPayload({
        member,
        offerId,
        body,
      });

    const timeoutMs =
      Math.min(
        Math.max(
          normalizeInteger(
            body.timeout_ms ??
            body.timeoutMs,
            DEFAULT_TIMEOUT_MS
          ),
          5000
        ),
        MAX_TIMEOUT_MS
      );

    /* ======================================================================
       ACCESS REDEMPTION REQUEST
    ====================================================================== */

    let accessResult;

    try {
      accessResult =
        await accessOffersRequest(
          redemptionPath,
          {
            method:
              getAccessRedemptionMethod(),

            body:
              payload,

            timeoutMs,
          }
        );
    } catch (
      accessError
    ) {
      const providerStatus =
        Number(
          accessError?.status
        );

      return sendJson(
        res,
        (
          Number.isFinite(
            providerStatus
          ) &&
          providerStatus >= 400 &&
          providerStatus <= 599
        )
          ? providerStatus
          : 502,
        {
          success:
            false,

          ok:
            false,

          message:
            accessError?.message ||
            "Access could not generate this offer redemption.",

          code:
            accessError?.code ||
            "ACCESS_REDEMPTION_FAILED",

          offerId,

          access: {
            status:
              accessError?.status ||
              null,

            statusText:
              accessError
                ?.statusText ||
              "",

            url:
              accessError?.url ||
              null,

            response:
              debug
                ? redactSensitive(
                    accessError
                      ?.response
                  )
                : undefined,
          },
        }
      );
    }

    /* ======================================================================
       NORMALIZE RESULT
    ====================================================================== */

    const redemption =
      normalizeRedemptionResult(
        accessResult,
        offerId
      );

    /*
     * Never invent a QR/code.
     */

    if (
      !redemption.ready
    ) {
      return conflict(
        res,
        "Access accepted the redemption request but did not return a usable redemption code, barcode, QR code, or online link.",
        {
          code:
            "ACCESS_REDEMPTION_NOT_READY",

          offerId,

          redemption,

          accessResponse:
            debug
              ? redactSensitive(
                  accessResult
                    ?.response
                )
              : undefined,
        }
      );
    }

    /* ======================================================================
       SAVE REDEMPTION
    ====================================================================== */

    const history =
      await saveRedemptionRecord({
        member,

        offerId,

        redemption,

        accessResponse:
          accessResult
            ?.response ||
          {},
      });

    /* ======================================================================
       SUCCESS
    ====================================================================== */

    return sendJson(
      res,
      200,
      {
        success:
          true,

        ok:
          true,

        message:
          "Your Card Leo benefit is ready to redeem.",

        member:
          sanitizeMember(
            member
          ),

        offer: {
          id:
            offerId,
        },

        redemption: {
          id:
            redemption
              .redemptionId,

          status:
            redemption.status,

          code:
            redemption.code,

          barcode:
            redemption.barcode,

          barcodeFormat:
            redemption
              .barcodeFormat,

          qrCode:
            redemption.qrCode,

          redemptionUrl:
            redemption
              .redemptionUrl,

          instructions:
            redemption
              .instructions,

          expiresAt:
            redemption.expiresAt,

          hasCode:
            redemption.hasCode,

          hasBarcode:
            redemption.hasBarcode,

          hasQrCode:
            redemption.hasQrCode,

          hasOnlineUrl:
            redemption.hasOnlineUrl,
        },

        history,

        links: {
          offers:
            "/api/access/offers",

          benefits:
            "/portal/benefits.html",
        },

        access:
          debug
            ? {
                response:
                  redactSensitive(
                    accessResult
                      ?.response
                  ),

                integration:
                  getAccessOffersConfigForDebug(),
              }
            : undefined,

        redeemedAt:
          nowIso(),
      }
    );
  } catch (
    error
  ) {
    console.error(
      "Card Leo Access redemption error:",
      error
    );

    return serverError(
      res,
      "Unable to redeem this Card Leo benefit right now.",
      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,
          }
        : {}
    );
  }
}