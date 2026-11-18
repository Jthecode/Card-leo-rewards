// api/access/redeem-offer.js

import { timingSafeEqual } from "node:crypto";

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  accessOffersRequest,
  getAccessOffersBaseUrl,
  getAccessOffersEndpointPath,
  extractOfferRows,
  normalizeAccessOffer,
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
   Verify saved login token and reject suspended Access membership
          ↓
   Verify the offer in the member-scoped Access catalog
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
   This route does NOT invent coupons or redemption endpoints.

   Enable only after Access confirms the redemption endpoint and payload:
     ACCESS_REDEMPTION_ENABLED=true
     ACCESS_REDEMPTION_ENDPOINT_PATH=<Access-approved path or path template>
     ACCESS_REDEMPTION_OFFER_ID_FIELD=<Access-approved JSON field>
     ACCESS_REDEMPTION_MEMBER_ID_FIELD=<Access-approved JSON field>
     ACCESS_REDEMPTION_SUPPORTED_TYPES=<confirmed formats>

   Supported format names: code, barcode, qr_code, online_url.
   The offer/member payload field names deliberately have no guessed defaults.
   Optional endpoint placeholders: {offer_key}, {offer_id}, {member_key}.
   The endpoint must be on the configured Access Offers HTTPS origin.

   A saved session_expires_at and at least one existing signups token column
   must verify the login token:
     session_token, auth_token, login_token, or portal_token.
   Decoding a JSON/base64 cookie alone does not authenticate a member.

   A claim issues redemption material; it does not confirm a merchant purchase.

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
    "expired",
    "incomplete",
    "incomplete_expired",
    "failed",
    "suspend",
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

function getRequestBody(req) {
  let body = req?.body;

  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  }

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > 16384) {
      return null;
    }

    body = safeJsonParse(body, null);
  }

  return isObject(body) ? body : null;
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
  const configured = getEnv("ACCESS_REDEMPTION_ENDPOINT_PATH");

  if (
    !configured || configured === "/" ||
    !configured.startsWith("/") || configured.startsWith("//") ||
    /[\\?#\s]/.test(configured) ||
    configured.split("/").some((part) => part === "." || part === "..")
  ) {
    return "";
  }

  return configured;
}

function getAccessRedemptionMethod() {
  const method = normalizeUpper(getEnv("ACCESS_REDEMPTION_METHOD", DEFAULT_REDEMPTION_METHOD));
  return ["POST", "PUT", "PATCH"].includes(method) ? method : "";
}

function getAccessRedemptionOfferIdField() {
  return getEnv("ACCESS_REDEMPTION_OFFER_ID_FIELD");
}

function getAccessRedemptionMemberIdField() {
  return getEnv("ACCESS_REDEMPTION_MEMBER_ID_FIELD");
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

function getSessionExpiresAt(session) {
  const data = session?.data || {};
  const candidates = [data.expires_at, data.expiresAt, data.exp, data.session?.expires_at, data.session?.expiresAt];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const number = Number(candidate);
    const timestamp = Number.isFinite(number) && number > 0
      ? (number > 1e12 ? number / 1000 : number)
      : Date.parse(candidate) / 1000;
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }

  return 0;
}

function isSessionExpired(session) {
  const expiresAt = getSessionExpiresAt(session);
  return !expiresAt || expiresAt <= Math.floor(Date.now() / 1000);
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findMember({ memberId, email }) {
  if (!memberId && !email) return null;

  let query = supabaseAdmin.from("signups").select("*");
  query = memberId ? query.eq("id", memberId) : query.eq("email", email);

  // Do not select an arbitrary member when identities are duplicated.
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
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

function isAccessReady(member) {
  // Eligibility only. OPEN and cached readiness are not proof of redemption support.
  const status = normalizeUpper(member?.access_member_status);
  return !["SUSPEND", "SUSPENDED", "CLOSED", "INACTIVE", "DISABLED"].includes(status);
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

  if (session.data.authenticated !== true) {
    return {
      member: null,
      response: unauthorized(res, "Please sign in again before redeeming benefits."),
    };
  }

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

  const sessionProof = verifyMemberSessionToken(req, session, member);

  if (!sessionProof.ok) {
    return {
      member: null,
      response: sendJson(res, sessionProof.status, {
        success: false,
        ok: false,
        code: sessionProof.code,
        message: sessionProof.message,
      }),
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
              "/login.html?status=payment_required&next=%2Fportal%2Fbenefits.html",
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
          "Your Access Perks membership is suspended or inactive.",
          {
            code:
              "ACCESS_MEMBER_SUSPENDED",

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
      normalizeBoolean(member?.access_perks_ready, false),

    accessEligible:
      isAccessReady(member),
  };
}

/* ==========================================================================
   OFFER ID
============================================================================ */

function getOfferId(body = {}) {
  return safeIdentifier(firstNonEmpty(
    body.offer_key, body.offerKey, body.offer_id, body.offerId,
    body.access_offer_id, body.accessOfferId, body.id
  ));
}

/* ==========================================================================
   REDEMPTION REQUEST PAYLOAD
============================================================================ */

function buildRedemptionPayload({
  member,
  offerId,
  body,
}) {
  const payload = Object.create(null);

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
    safeIdentifier(
      body.location_key ?? body.locationKey ?? body.location_id ?? body.locationId
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
    safeIdentifier(
      body.redemption_type || body.redemptionType
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

function normalizeRedemptionResult(result, offerId) {
  const data = unwrapRedemptionResponse(result);
  const supported = getSupportedRedemptionTypes();
  const code = supported.has("code") ? firstScalar(
    data.code, data.coupon_code, data.couponCode, data.promo_code,
    data.promoCode, data.redemption_code, data.redemptionCode
  ) : "";
  const barcode = supported.has("barcode") ? firstScalar(
    data.barcode, data.barcode_value, data.barcodeValue, data.bar_code, data.barCode
  ) : "";
  const barcodeFormat = firstScalar(
    data.barcode_format, data.barcodeFormat, data.barcode_type, data.barcodeType
  );
  const qrCode = supported.has("qr_code") ? firstSafeUrl(true,
    data.qr_code, data.qrCode, data.qr_code_url, data.qrCodeUrl, data.qrcode, data.qrcode_url
  ) : "";
  const redemptionUrl = supported.has("online_url") ? firstSafeUrl(false,
    data.redemption_url, data.redemptionUrl, data.claim_url, data.claimUrl,
    data.online_url, data.onlineUrl, data.url
  ) : "";
  const instructions = combineInstructions(
    data.instructions, data.redemption_instructions, data.redemptionInstructions
  );
  const redemptionId = firstScalar(
    data.id, data.redemption_id, data.redemptionId
  );
  const rawExpiry = firstScalar(
    data.expires_at, data.expiresAt, data.expiration_date,
    data.expirationDate, data.valid_until, data.validUntil
  );
  const expiresAt = safeDate(rawExpiry);
  const expired = Boolean(rawExpiry) && (!expiresAt || Date.parse(expiresAt) <= Date.now());
  const providerStatus = normalizeLower(firstScalar(
    data.status, data.redemption_status, data.redemptionStatus
  ));
  const blockedStatus = [
    "pending", "processing", "queued", "failed", "failure", "error", "denied",
    "rejected", "expired", "cancelled", "canceled", "inactive", "suspended", "used", "redeemed",
  ].includes(providerStatus);
  const ready = Boolean(code || barcode || qrCode || redemptionUrl) && !expired && !blockedStatus;

  return {
    offerId,
    redemptionId: redemptionId || null,
    status: expired ? "expired" : providerStatus || (ready ? "ready" : "pending"),
    code: ready ? code || null : null,
    barcode: ready ? barcode || null : null,
    barcodeFormat: ready ? barcodeFormat || null : null,
    qrCode: ready ? qrCode || null : null,
    redemptionUrl: ready ? redemptionUrl || null : null,
    instructions: instructions || null,
    expiresAt,
    hasCode: ready && Boolean(code),
    hasBarcode: ready && Boolean(barcode),
    hasQrCode: ready && Boolean(qrCode),
    hasOnlineUrl: ready && Boolean(redemptionUrl),
    ready,
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

    provider_response: {
      status: Number(accessResponse?.status) || null,
      offer_id: offerId,
      redemption_id: redemption.redemptionId || null,
      material_issued: redemption.ready === true,
    },

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
      .select("id")
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
    "Card Leo redemption logging failed",
    { code: firstScalar(error?.code) || "UNKNOWN" }
  );

  return {
    saved:
      false,

    tableReady:
      true,

    error:
      "REDEMPTION_HISTORY_SAVE_FAILED",
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
   REQUEST, SESSION, AND PROVIDER VALIDATION
============================================================================ */

function firstScalar(...values) {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function safeIdentifier(value) {
  const text = firstScalar(value);
  return text.length <= 256 && ![".", ".."].includes(text) &&
    !/[\s\x00-\x1f\x7f]/.test(text) ? text : "";
}

function safeHttpsUrl(value, allowImageData = false) {
  const text = firstScalar(value);
  if (!text) return "";
  if (allowImageData && text.length <= 2000000 &&
      /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function firstSafeUrl(allowImageData, ...values) {
  for (const value of values) {
    const url = safeHttpsUrl(value, allowImageData);
    if (url) return url;
  }
  return "";
}

function combineInstructions(...values) {
  function read(value) {
    if (Array.isArray(value)) return value.map(read).filter(Boolean).join("\n\n");
    if (isObject(value)) return read(value.text || value.description || value.content || value.value);
    return firstScalar(value);
  }
  return [...new Set(values.map(read).filter(Boolean))].join("\n\n");
}

function getSupportedRedemptionTypes() {
  const aliases = {
    code: "code", barcode: "barcode", qr: "qr_code", qrcode: "qr_code",
    qr_code: "qr_code", online: "online_url", onlineurl: "online_url", online_url: "online_url",
  };
  return new Set(getEnv("ACCESS_REDEMPTION_SUPPORTED_TYPES").toLowerCase()
    .split(",").map((type) => Object.hasOwn(aliases, type.trim()) ? aliases[type.trim()] : "").filter(Boolean));
}

function validateRedemptionConfiguration() {
  if (!normalizeBoolean(getEnv("ACCESS_REDEMPTION_ENABLED"), false)) {
    return "ACCESS_REDEMPTION_DISABLED";
  }
  if (!getAccessRedemptionEndpointPath() || !getAccessRedemptionMethod()) {
    return "ACCESS_REDEMPTION_ENDPOINT_REQUIRED";
  }
  const fields = [
    getAccessRedemptionOfferIdField(), getAccessRedemptionMemberIdField(),
    getAccessRedemptionProgramField(), getAccessRedemptionOrganizationField(),
    getEnv("ACCESS_REDEMPTION_LOCATION_ID_FIELD", "location_id"),
    getEnv("ACCESS_REDEMPTION_TYPE_FIELD", "redemption_type"),
  ];
  if (fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)) ||
      new Set(fields).size !== fields.length) return "ACCESS_REDEMPTION_FIELDS_INVALID";
  if (!getSupportedRedemptionTypes().size) return "ACCESS_REDEMPTION_TYPES_REQUIRED";
  return "";
}

function isAllowedBrowserRequest(req) {
  const origin = firstScalar(req.headers?.origin);
  const allowed = new Set(["https://cardleorewards.com", "https://www.cardleorewards.com"]);
  for (const value of [process.env.CARDLEO_SITE_URL, process.env.APP_BASE_URL]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:") allowed.add(url.origin);
    } catch {
      /* Ignore invalid optional origins. */
    }
  }
  if (origin && !allowed.has(origin)) return false;
  const fetchSite = firstScalar(req.headers?.["sec-fetch-site"]);
  return Boolean(origin) || !fetchSite || ["same-origin", "none"].includes(fetchSite);
}

function verifyMemberSessionToken(req, session, member) {
  const cookies = parseCookies(req);
  const data = session.data;
  const token = firstScalar(
    cookies.cardleo_session_token, data.token, data.sessionToken, data.session_token,
    data.authToken, data.auth_token, data.loginToken, data.login_token,
    data.portalToken, data.portal_token, data.session?.token
  );
  const stored = [member.session_token, member.auth_token, member.login_token, member.portal_token]
    .map((value) => firstScalar(value)).filter(Boolean);
  if (!stored.length || !member.session_expires_at) {
    return {
      ok: false,
      status: 503,
      code: "SESSION_VERIFICATION_NOT_CONFIGURED",
      message: "Secure redemption session verification is unavailable. Please contact Card Leo support."
    };
  }
  const valid = token && stored.some((value) => {
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(value, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  const expiresAt = member.session_expires_at;
  const expired = expiresAt && (!safeDate(expiresAt) || Date.parse(expiresAt) <= Date.now());
  if (!valid || expired) {
    return {
      ok: false,
      status: 401,
      code: "SESSION_VERIFICATION_FAILED",
      message: "Your login session could not be verified. Please sign in again."
    };
  }
  return { ok: true };
}

function buildAccessRedemptionPath(offerId, memberKey) {
  const path = getAccessRedemptionEndpointPath()
    .replaceAll("{offer_key}", encodeURIComponent(offerId))
    .replaceAll("{offer_id}", encodeURIComponent(offerId))
    .replaceAll("{member_key}", encodeURIComponent(memberKey));
  if (/[{}]/.test(path)) throw new Error("Invalid redemption endpoint template.");
  const base = new URL(getAccessOffersBaseUrl());
  const url = new URL(base.origin + path);
  if (base.protocol !== "https:" || url.origin !== base.origin || url.username || url.password ||
      url.search || url.hash) throw new Error("Invalid redemption endpoint origin.");
  return url.pathname;
}

function providerFailed(result) {
  const response = result?.response;
  const data = unwrapRedemptionResponse(result);
  return result?.success === false || result?.ok === false ||
    response?.success === false || response?.ok === false ||
    response?.data?.success === false || response?.data?.ok === false ||
    data?.success === false || data?.ok === false ||
    Boolean(response?.error) || Boolean(response?.data?.error) || Boolean(data?.error) ||
    [response, response?.data, data].some((value) => Array.isArray(value?.errors) && value.errors.length > 0);
}

async function findMemberOffer(memberKey, offerId, timeoutMs) {
  const result = await accessOffersRequest(getAccessOffersEndpointPath(), {
    method: "GET",
    query: {
      member_key: memberKey,
      offer_key: offerId,
      all_offers: true,
      sanitize_html: true,
      page: 1,
      per_page: 1
    },
    timeoutMs,
  });
  if (providerFailed(result)) throw new Error("Offer verification failed.");
  const offers = extractOfferRows(result).map((row) => normalizeAccessOffer(row)).filter(Boolean);
  return offers.find((offer) => firstScalar(offer.offer_key, offer.accessOfferId, offer.id) === offerId) || null;
}

function providerFailureResponse(res, error, offerId) {
  const status = Number(error?.status);
  const responseStatus = status === 429 ? 429 : status === 503 ? 503 : status === 504 ? 504 : 502;

  // Provider authentication failures are not failures of the member's Card Leo login.
  return sendJson(res, responseStatus, {
    success: false,
    ok: false,
    code: "ACCESS_REDEMPTION_FAILED",
    offerId,
    message: status === 504
      ? "Access timed out. Check your benefit before trying again."
      : "Access could not complete the redemption request. Please try again later.",
  });
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

  if (!isAllowedBrowserRequest(req)) {
    return forbidden(res, "This redemption request is not allowed.", {
      code: "ORIGIN_NOT_ALLOWED"
    });
  }

  const contentType = firstScalar(req.headers?.["content-type"]).toLowerCase();

  if (contentType && contentType.split(";")[0].trim() !== "application/json") {
    return sendJson(res, 415, {
      success: false,
      ok: false,
      code: "JSON_REQUIRED",
      message: "Send the redemption request as JSON."
    });
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

    if (!body) {
      return badRequest(res, "A valid JSON object is required.", {
        code: "INVALID_REQUEST_BODY"
      });
    }

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

    // Never return provider bodies, credential-bearing URLs, or debug data to members.
    const debug = false;

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

    const configurationError = validateRedemptionConfiguration();

    if (configurationError) {
      return serviceUnavailable(res, "Direct offer redemption is not configured yet.", {
        code: configurationError,
      });
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

    const timeoutMs = Math.min(Math.max(
      normalizeInteger(getEnv("ACCESS_REDEMPTION_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS), 5000
    ), MAX_TIMEOUT_MS);

    let offer;

    try {
      offer = await findMemberOffer(accessMemberIdentifier, offerId, timeoutMs);
    } catch (error) {
      return providerFailureResponse(res, error, offerId);
    }

    if (!offer) {
      return notFound(res, "This offer is not available in your Access catalog.", {
        code: "ACCESS_OFFER_NOT_AVAILABLE",
        offerId,
      });
    }

    if (
      (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.now()) ||
      (offer.startsAt && Date.parse(offer.startsAt) > Date.now())
    ) {
      return conflict(res, "This offer is not currently available.", {
        code: "ACCESS_OFFER_OUTSIDE_VALID_DATES",
        offerId,
      });
    }

    const requestedLocation =
      body.location_key ??
      body.locationKey ??
      body.location_id ??
      body.locationId;

    const locationId = safeIdentifier(requestedLocation);

    if (
      requestedLocation !== undefined &&
      (
        !locationId ||
        !offer.locations.some((location) =>
          firstScalar(location.id, location.location_key, location.locationId) === locationId
        )
      )
    ) {
      return badRequest(res, "Choose a participating location for this offer.", {
        code: "ACCESS_LOCATION_NOT_AVAILABLE",
        offerId,
      });
    }

    const requestedType = body.redemption_type ?? body.redemptionType;

    if (requestedType !== undefined && !safeIdentifier(requestedType)) {
      return badRequest(res, "The redemption type is invalid.", {
        code: "INVALID_REDEMPTION_TYPE"
      });
    }

    const redemptionPath = buildAccessRedemptionPath(offerId, accessMemberIdentifier);

    const payload = buildRedemptionPayload({
      member,
      offerId,
      body
    });

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
      return providerFailureResponse(res, accessError, offerId);
    }

    if (providerFailed(accessResult)) {
      return providerFailureResponse(res, {}, offerId);
    }

    const returned = unwrapRedemptionResponse(accessResult);

    const returnedOfferId = firstScalar(
      returned.offer_key,
      returned.offerKey,
      returned.offer_id,
      returned.offerId
    );

    const returnedMemberKey = firstScalar(
      returned.member_key,
      returned.member_customer_identifier
    );

    if (
      (returnedOfferId && returnedOfferId !== offerId) ||
      (returnedMemberKey && returnedMemberKey !== accessMemberIdentifier)
    ) {
      return providerFailureResponse(res, {}, offerId);
    }

    /* ======================================================================
       NORMALIZE RESULT
    ====================================================================== */

    const redemption =
      normalizeRedemptionResult(
        accessResult,
        offerId
      );

    redemption.instructions = combineInstructions(
      redemption.instructions,
      offer.redemption?.instructions
    ) || null;

    /*
     * Never invent a QR/code, convert an opaque QR value into an image URL,
     * or report unsupported/expired material as ready.
     */

    if (
      !redemption.ready
    ) {
      return conflict(
        res,
        "Access has not returned usable, current redemption material for this offer.",
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

    let history;

    try {
      history = await saveRedemptionRecord({
        member,

        offerId,

        redemption,

        accessResponse: {
          status: accessResult.status
        },
      });
    } catch {
      // Issuing succeeded. A local history outage must not discard the member's material.
      history = {
        saved: false,
        error: "REDEMPTION_HISTORY_SAVE_FAILED"
      };

      console.error("Card Leo redemption history is unavailable.");
    }

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
          offerId,
          offer_key: offerId,
          ready: redemption.ready,
          redemptionId: redemption.redemptionId,

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
      "Card Leo Access redemption failed",
      {
        code: firstScalar(error?.code) || "UNKNOWN"
      }
    );

    return serverError(
      res,
      "Unable to redeem this Card Leo benefit right now.",
      {
        code: "ACCESS_REDEMPTION_ERROR"
      }
    );
  }
}