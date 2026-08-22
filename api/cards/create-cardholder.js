// api/cards/create-cardholder.js

import crypto from "node:crypto";

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  createLithicAccountHolder,
  isLithicEnabled,
  isLithicConfigured,
  getLithicEnvironment,
  getLithicIntegrationStatus,
  getLithicConfigForDebug,
  getMemberNameParts,
  getMemberEmail,
  getMemberPhone,
  getMemberId,
  buildMemberExternalId,
  validateMemberForLithic,
  normalizeString,
  normalizeEmail,
} from "../../lib/lithic.js";

import {
  getSessionCookieName,
  clearAuthCookies,
} from "../../lib/cookies.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

import {
  setNoStore,
} from "../../lib/responses.js";

/* ==========================================================================
   CARD LEO REWARDS
   CREATE LITHIC ACCOUNT HOLDER / CARDHOLDER

   ROUTE
   -----
   POST /api/cards/create-cardholder

   PURPOSE
   -------
   1. Authenticate the Card Leo member.
   2. Resolve the real member from Supabase.
   3. Confirm membership/payment eligibility.
   4. Confirm Lithic is enabled/configured.
   5. Prevent duplicate account-holder creation.
   6. Validate the exact Lithic onboarding information.
   7. Create the Lithic account holder.
   8. Capture the Lithic account-holder/account relationship.
   9. Store SAFE identifiers/status in member_cards.
   10. Return only safe readiness information to the browser.

   IMPORTANT
   ---------
   This route DOES NOT create the virtual card.

   Virtual-card issuance happens in:

     /api/cards/create-virtual-card

   SECURITY
   --------
   - Government ID / SSN is NEVER stored here.
   - Government ID / SSN is NEVER logged here.
   - Full Lithic account/card tokens are NEVER returned to the browser.
   - Do not invent KYC information.
   - Lithic workflow must be explicitly configured for Card Leo.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

const DEFAULT_COUNTRY =
  "USA";

const DEFAULT_WORKFLOW =
  "";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const SESSION_TOKEN_COOKIE_NAMES = [
  "cardleo_session_token",
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",
];

/* ==========================================================================
   MEMBER STATUS RULES
============================================================================ */

const ACTIVE_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

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
  ]);

const ACTIVE_APPROVAL_STATUSES =
  new Set([
    "approved",
    "active",
    "complete",
    "completed",
    "auto_approved",
  ]);

const BLOCKED_STATUSES =
  new Set([
    "disabled",
    "suspended",
    "paused",
    "denied",
    "closed",
    "cancelled",
    "canceled",
  ]);

/* ==========================================================================
   RESPONSE HELPERS
============================================================================ */

function sendJson(
  res,
  status,
  payload
) {
  return res
    .status(status)
    .json(payload);
}

function successResponse(
  res,
  data = {},
  message =
    "Card Leo card account created successfully."
) {
  return sendJson(
    res,
    200,
    {
      success:
        true,

      ok:
        true,

      message,

      ...data,
    }
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
      success:
        false,

      ok:
        false,

      message,

      ...extra,
    }
  );
}

function unauthorized(
  res,
  message =
    "Please sign in to continue."
) {
  return sendJson(
    res,
    401,
    {
      success:
        false,

      ok:
        false,

      authenticated:
        false,

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
      success:
        false,

      ok:
        false,

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
      success:
        false,

      ok:
        false,

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
      success:
        false,

      ok:
        false,

      message,

      ...extra,
    }
  );
}

function serverError(
  res,
  message =
    "Unexpected server error.",
  extra = {}
) {
  return sendJson(
    res,
    500,
    {
      success:
        false,

      ok:
        false,

      message,

      ...extra,
    }
  );
}

/* ==========================================================================
   GENERIC HELPERS
============================================================================ */

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

function normalizeStatus(
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
    ].includes(
      normalized
    )
  ) {
    return false;
  }

  return fallback;
}

function normalizeDate(
  value
) {
  const clean =
    normalizeString(
      value
    );

  if (!clean) {
    return "";
  }

  const date =
    new Date(
      clean
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date
    .toISOString()
    .slice(
      0,
      10
    );
}

function normalizeTimestamp(
  value
) {
  const clean =
    normalizeString(
      value
    );

  if (!clean) {
    return "";
  }

  const date =
    new Date(
      clean
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date
    .toISOString();
}

function normalizePhone(
  value
) {
  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return "";
  }

  const hasPlus =
    raw.startsWith(
      "+"
    );

  const digits =
    raw.replace(
      /\D/g,
      ""
    );

  if (!digits) {
    return "";
  }

  if (hasPlus) {
    return `+${digits}`;
  }

  if (
    digits.length ===
    10
  ) {
    return `+1${digits}`;
  }

  if (
    digits.length ===
      11 &&
    digits.startsWith(
      "1"
    )
  ) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function normalizePostalCode(
  value
) {
  return normalizeString(
    value
  )
    .toUpperCase()
    .slice(
      0,
      20
    );
}

function normalizeCountry(
  value
) {
  const clean =
    normalizeString(
      value ||
        DEFAULT_COUNTRY
    ).toUpperCase();

  if (
    clean === "US" ||
    clean ===
      "UNITED STATES" ||
    clean ===
      "UNITED STATES OF AMERICA"
  ) {
    return "USA";
  }

  return clean;
}

function nowIso() {
  return new Date()
    .toISOString();
}

function getRequestBody(
  req
) {
  if (!req?.body) {
    return {};
  }

  if (
    typeof req.body ===
    "string"
  ) {
    try {
      const parsed =
        JSON.parse(
          req.body
        );

      return isObject(
        parsed
      )
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  if (
    isObject(
      req.body
    )
  ) {
    return req.body;
  }

  return {};
}

/* ==========================================================================
   DATABASE COMPATIBILITY
============================================================================ */

function isMissingTableOrColumn(
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

  const details =
    String(
      error?.details ||
      ""
    ).toLowerCase();

  return (
    code ===
      "42P01" ||
    code ===
      "42703" ||
    code ===
      "PGRST204" ||
    code ===
      "PGRST205" ||

    message.includes(
      "does not exist"
    ) ||

    message.includes(
      "could not find"
    ) ||

    message.includes(
      "schema cache"
    ) ||

    details.includes(
      "does not exist"
    ) ||

    details.includes(
      "could not find"
    ) ||

    details.includes(
      "schema cache"
    )
  );
}

/* ==========================================================================
   COOKIE PARSING
============================================================================ */

function parseCookies(
  req
) {
  if (
    req?.cookies &&
    typeof req.cookies ===
      "object"
  ) {
    return req.cookies;
  }

  const cookieHeader =
    req?.headers?.cookie ||
    "";

  return String(
    cookieHeader
  )
    .split(";")
    .map(
      (part) =>
        part.trim()
    )
    .filter(Boolean)
    .reduce(
      (
        output,
        part
      ) => {
        const separator =
          part.indexOf(
            "="
          );

        if (
          separator ===
          -1
        ) {
          return output;
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
              separator +
                1
            )
            .trim();

        if (!name) {
          return output;
        }

        try {
          output[name] =
            decodeURIComponent(
              rawValue
            );
        } catch {
          output[name] =
            rawValue;
        }

        return output;
      },
      {}
    );
}

/* ==========================================================================
   SESSION DECODING

   Supports the base64url session format created by api/auth/login.js.
============================================================================ */

function safeJsonParse(
  value
) {
  try {
    const parsed =
      JSON.parse(
        value
      );

    return isObject(
      parsed
    )
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseBase64Session(
  value
) {
  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return null;
  }

  try {
    const decoded =
      Buffer
        .from(
          raw,
          "base64url"
        )
        .toString(
          "utf8"
        );

    return safeJsonParse(
      decoded
    );
  } catch {
    return null;
  }
}

function parseSessionValue(
  value
) {
  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return null;
  }

  /*
   * First support plain JSON compatibility sessions.
   */

  const direct =
    safeJsonParse(
      raw
    );

  if (direct) {
    return direct;
  }

  /*
   * Current Card Leo login session format.
   */

  const base64 =
    parseBase64Session(
      raw
    );

  if (base64) {
    return base64;
  }

  return null;
}

function readSessionCookie(
  req
) {
  const cookies =
    parseCookies(
      req
    );

  const configuredName =
    normalizeString(
      typeof getSessionCookieName ===
        "function"
        ? getSessionCookieName()
        : ""
    );

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...SESSION_COOKIE_NAMES,
        ].filter(
          Boolean
        )
      )
    );

  for (
    const name
    of names
  ) {
    const raw =
      cookies[name];

    if (!raw) {
      continue;
    }

    const data =
      parseSessionValue(
        raw
      );

    if (
      isObject(
        data
      )
    ) {
      return {
        name,
        raw,
        data,
      };
    }
  }

  return null;
}

function readSessionToken(
  req
) {
  const cookies =
    parseCookies(
      req
    );

  for (
    const name
    of SESSION_TOKEN_COOKIE_NAMES
  ) {
    const token =
      normalizeString(
        cookies[name]
      );

    if (token) {
      return {
        name,
        token,
      };
    }
  }

  return null;
}

/* ==========================================================================
   SESSION IDENTITY
============================================================================ */

function getSessionMemberId(
  sessionMeta
) {
  const data =
    sessionMeta?.data ||
    {};

  return normalizeString(
    data.member?.id ||
      data.profile?.id ||
      data.signupId ||
      data.signup_id ||
      data.memberId ||
      data.member_id ||
      data.id
  );
}

function getSessionPortalUserId(
  sessionMeta
) {
  const data =
    sessionMeta?.data ||
    {};

  return normalizeString(
    data.portalUserId ||
      data.portal_user_id ||
      data.member
        ?.portalUserId ||
      data.member
        ?.portal_user_id ||
      data.profile
        ?.portalUserId ||
      data.profile
        ?.portal_user_id
  );
}

function getSessionEmail(
  sessionMeta
) {
  const data =
    sessionMeta?.data ||
    {};

  return normalizeEmail(
    data.member?.email ||
      data.profile?.email ||
      data.user?.email ||
      data.email ||
      data.userEmail
  );
}

function getSessionToken(
  sessionMeta
) {
  const data =
    sessionMeta?.data ||
    {};

  return normalizeString(
    data.token ||
      data.sessionToken ||
      data.session_token ||
      data.authToken ||
      data.auth_token ||
      data.loginToken ||
      data.login_token ||
      data.portalToken ||
      data.portal_token
  );
}

function getSessionExpiresAt(
  sessionMeta
) {
  const data =
    sessionMeta?.data ||
    {};

  const candidate =
    Number(
      data.expires_at ||
        data.expiresAt ||
        data.session
          ?.expires_at ||
        data.session
          ?.expiresAt ||
        0
    );

  return Number.isFinite(
    candidate
  )
    ? candidate
    : 0;
}

function isSessionExpired(
  sessionMeta
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionMeta
    );

  /*
   * Match /api/auth/me:
   * Missing expiration does not automatically invalidate a compatible
   * legacy Card Leo session.
   */

  if (!expiresAt) {
    return false;
  }

  return (
    expiresAt <=
    Math.floor(
      Date.now() /
        1000
    )
  );
}

/* ==========================================================================
   MEMBER ELIGIBILITY
============================================================================ */

function getMemberStatuses(
  member
) {
  return {
    status:
      normalizeStatus(
        member?.status
      ),

    paymentStatus:
      normalizeStatus(
        member
          ?.payment_status
      ),

    membershipStatus:
      normalizeStatus(
        member
          ?.membership_status
      ),

    approvalStatus:
      normalizeStatus(
        member
          ?.approval_status
      ),
  };
}

function isMemberBlocked(
  member
) {
  const {
    status,
    membershipStatus,
    approvalStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    BLOCKED_STATUSES.has(
      status
    ) ||
    BLOCKED_STATUSES.has(
      membershipStatus
    ) ||
    BLOCKED_STATUSES.has(
      approvalStatus
    )
  );
}

function isMemberPaid(
  member
) {
  const {
    paymentStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    ACTIVE_PAYMENT_STATUSES.has(
      paymentStatus
    )
  );
}

function isMemberActive(
  member
) {
  if (
    !member ||
    isMemberBlocked(
      member
    )
  ) {
    return false;
  }

  if (
    !isMemberPaid(
      member
    )
  ) {
    return false;
  }

  const {
    status,
    membershipStatus,
    approvalStatus,
  } =
    getMemberStatuses(
      member
    );

  return (
    ACTIVE_MEMBER_STATUSES.has(
      status
    ) ||
    ACTIVE_MEMBER_STATUSES.has(
      membershipStatus
    ) ||
    ACTIVE_APPROVAL_STATUSES.has(
      approvalStatus
    )
  );
}

/* ==========================================================================
   GET MEMBER
============================================================================ */

async function getMemberRecord({
  memberId,
  portalUserId,
  email,
  sessionToken,
}) {
  const extendedFields = [
    "id",

    "email",

    "first_name",
    "last_name",
    "full_name",

    "phone",

    "city",
    "state",

    "status",
    "payment_status",
    "membership_status",
    "approval_status",

    "portal_user_id",

    "session_token",
    "auth_token",
    "login_token",
    "portal_token",

    "stripe_customer_id",
    "stripe_subscription_id",

    "created_at",
    "updated_at",
  ].join(
    ", "
  );

  const fallbackFields = [
    "id",

    "email",

    "first_name",
    "last_name",
    "full_name",

    "phone",

    "city",
    "state",

    "status",

    "created_at",
    "updated_at",
  ].join(
    ", "
  );

  async function runQuery(
    fields
  ) {
    let query =
      supabaseAdmin
        .from(
          "signups"
        )
        .select(
          fields
        )
        .limit(
          1
        );

    if (memberId) {
      query =
        query.eq(
          "id",
          memberId
        );
    } else if (
      portalUserId
    ) {
      query =
        query.eq(
          "portal_user_id",
          portalUserId
        );
    } else if (
      email
    ) {
      query =
        query.ilike(
          "email",
          email
        );
    } else if (
      sessionToken
    ) {
      /*
       * Token lookup is used only as a last compatibility path.
       */

      query =
        query.or(
          [
            `session_token.eq.${sessionToken}`,
            `auth_token.eq.${sessionToken}`,
            `login_token.eq.${sessionToken}`,
            `portal_token.eq.${sessionToken}`,
          ].join(",")
        );
    } else {
      return {
        data:
          null,

        error:
          null,
      };
    }

    return query
      .maybeSingle();
  }

  let result =
    await runQuery(
      extendedFields
    );

  if (
    result.error &&
    isMissingTableOrColumn(
      result.error
    )
  ) {
    /*
     * The fallback schema can only resolve IDs/emails.
     */

    if (
      !memberId &&
      !email
    ) {
      return result;
    }

    result =
      await runQuery(
        fallbackFields
      );
  }

  return result;
}

/* ==========================================================================
   AUTHENTICATE MEMBER
============================================================================ */

async function getAuthenticatedMember(
  req,
  res
) {
  const session =
    readSessionCookie(
      req
    );

  if (!session?.data) {
    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Please sign in before creating your Card Leo card account."
        ),
    };
  }

  if (
    isSessionExpired(
      session
    )
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Your session has expired. Please sign in again."
        ),
    };
  }

  /*
   * Do NOT require:
   *
   * session.data.authenticated === true
   *
   * /api/auth/me and the fixed Card Leo login support compatible session
   * formats that resolve identity server-side.
   */

  const memberId =
    getSessionMemberId(
      session
    );

  const portalUserId =
    getSessionPortalUserId(
      session
    );

  const email =
    getSessionEmail(
      session
    );

  const embeddedToken =
    getSessionToken(
      session
    );

  const tokenCookie =
    readSessionToken(
      req
    );

  const sessionToken =
    embeddedToken ||
    tokenCookie?.token ||
    "";

  if (
    !memberId &&
    !portalUserId &&
    !email &&
    !sessionToken
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Member information is missing from your login session."
        ),
    };
  }

  const {
    data:
      member,

    error,
  } =
    await getMemberRecord({
      memberId,
      portalUserId,
      email,
      sessionToken,
    });

  if (error) {
    /*
     * Database failure is NOT proof that the browser session is invalid.
     * Do not clear cookies here.
     */

    throw error;
  }

  if (!member?.id) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort.
    }

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Card Leo member account could not be found."
        ),
    };
  }

  if (
    isMemberBlocked(
      member
    )
  ) {
    return {
      member:
        null,

      response:
        forbidden(
          res,
          "Your Card Leo account is not eligible for card provisioning at this time.",
          {
            code:
              "MEMBER_BLOCKED",
          }
        ),
    };
  }

  if (
    !isMemberPaid(
      member
    )
  ) {
    return {
      member:
        null,

      response:
        forbidden(
          res,
          "Your Card Leo membership payment must be current before a Card Leo card account can be created.",
          {
            code:
              "PAYMENT_NOT_CURRENT",
          }
        ),
    };
  }

  if (
    !isMemberActive(
      member
    )
  ) {
    return {
      member:
        null,

      response:
        forbidden(
          res,
          "Your Card Leo membership must be active and approved before a card account can be created.",
          {
            code:
              "MEMBERSHIP_NOT_ACTIVE",
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
   EXISTING MEMBER CARD RECORD
============================================================================ */

async function getExistingMemberCard(
  memberId
) {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        MEMBER_CARDS_TABLE
      )
      .select(
        "*"
      )
      .eq(
        "member_id",
        memberId
      )
      .limit(
        1
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        record:
          null,

        tableMissing:
          true,

        error:
          null,
      };
    }

    throw error;
  }

  return {
    record:
      data ||
      null,

    tableMissing:
      false,

    error:
      null,
  };
}

/* ==========================================================================
   STABLE IDEMPOTENCY KEY

   Same Card Leo member -> same UUID.
   This provides an additional layer of duplicate protection.
============================================================================ */

function buildMemberIdempotencyKey(
  memberId
) {
  const digest =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        `cardleo:lithic:account-holder:${memberId}`
      )
      .digest();

  const bytes =
    Buffer.from(
      digest.subarray(
        0,
        16
      )
    );

  /*
   * RFC-4122-compatible deterministic UUID bits.
   */

  bytes[6] =
    (
      bytes[6] &
      0x0f
    ) |
    0x50;

  bytes[8] =
    (
      bytes[8] &
      0x3f
    ) |
    0x80;

  const hex =
    bytes.toString(
      "hex"
    );

  return [
    hex.slice(
      0,
      8
    ),

    hex.slice(
      8,
      12
    ),

    hex.slice(
      12,
      16
    ),

    hex.slice(
      16,
      20
    ),

    hex.slice(
      20,
      32
    ),
  ].join(
    "-"
  );
}

/* ==========================================================================
   SAVE MEMBER CARD RECORD
============================================================================ */

async function saveMemberCardRecord({
  member,
  existingRecord,
  accountHolderToken,
  accountToken,
  lithicStatus,
  lithicResponse,
  workflow,
  externalId,
}) {
  const timestamp =
    nowIso();

  const payload = {
    member_id:
      member.id,

    provider:
      "lithic",

    lithic_account_holder_token:
      accountHolderToken ||
      null,

    lithic_account_token:
      accountToken ||
      null,

    lithic_account_holder_status:
      lithicStatus ||
      null,

    lithic_workflow:
      workflow ||
      null,

    lithic_external_id:
      externalId ||
      null,

    card_status:
      existingRecord
        ?.card_status ||
      "NOT_CREATED",

    card_type:
      existingRecord
        ?.card_type ||
      null,

    last_four:
      existingRecord
        ?.last_four ||
      null,

    updated_at:
      timestamp,

    /*
     * SAFE diagnostic data only.
     *
     * Never save raw onboarding input here.
     */

    lithic_last_response:
      lithicResponse ||
      null,
  };

  if (
    !existingRecord?.id
  ) {
    payload.created_at =
      timestamp;
  }

  if (
    existingRecord?.id
  ) {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          MEMBER_CARDS_TABLE
        )
        .update(
          payload
        )
        .eq(
          "id",
          existingRecord.id
        )
        .select()
        .single();

    if (error) {
      throw error;
    }

    return data;
  }

  /*
   * Upsert by member_id adds another duplicate-protection layer when the
   * table has a unique member_id constraint.
   */

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        MEMBER_CARDS_TABLE
      )
      .upsert(
        payload,
        {
          onConflict:
            "member_id",
        }
      )
      .select()
      .single();

  if (error) {
    throw error;
  }

  return data;
}

/* ==========================================================================
   ADDRESS
============================================================================ */

function buildAddress(
  member,
  body
) {
  const address1 =
    normalizeString(
      body.address1 ||
        body.address_line_1 ||
        body.addressLine1
    );

  const address2 =
    normalizeString(
      body.address2 ||
        body.address_line_2 ||
        body.addressLine2
    );

  const city =
    normalizeString(
      body.city ||
        member.city
    );

  const state =
    normalizeString(
      body.state ||
        member.state
    ).toUpperCase();

  const postalCode =
    normalizePostalCode(
      body.postal_code ||
        body.postalCode ||
        body.zip ||
        body.zip_code
    );

  const country =
    normalizeCountry(
      body.country ||
        DEFAULT_COUNTRY
    );

  return {
    address1,
    address2,
    city,
    state,
    postalCode,
    country,
  };
}

/* ==========================================================================
   NORMALIZE CARDHOLDER INPUT
============================================================================ */

function normalizeCardholderInput(
  member,
  rawBody
) {
  const body =
    isObject(
      rawBody
    )
      ? rawBody
      : {};

  const {
    firstName,
    lastName,
  } =
    getMemberNameParts(
      member
    );

  const email =
    getMemberEmail(
      member
    );

  const phone =
    normalizePhone(
      body.phone ||
        getMemberPhone(
          member
        )
    );

  const dob =
    normalizeDate(
      body.dob ||
        body.date_of_birth ||
        body.dateOfBirth
    );

  /*
   * SENSITIVE:
   * Used only in-memory for workflows requiring customer-provided KYC.
   */

  const governmentId =
    normalizeString(
      body.government_id ||
        body.governmentId ||
        body.ssn
    );

  const address =
    buildAddress(
      member,
      body
    );

  const tosAccepted =
    normalizeBoolean(
      body.tos_accepted ??
        body.tosAccepted,
      false
    );

  const tosTimestamp =
    normalizeTimestamp(
      body.tos_timestamp ||
        body.tosTimestamp
    ) ||
    (
      tosAccepted
        ? nowIso()
        : ""
    );

  const workflow =
    normalizeString(
      process.env
        .LITHIC_ACCOUNT_HOLDER_WORKFLOW ||
        body.workflow ||
        DEFAULT_WORKFLOW
    ).toUpperCase();

  const kycExemptionType =
    normalizeString(
      process.env
        .LITHIC_KYC_EXEMPTION_TYPE ||
        body.kyc_exemption_type ||
        body.kycExemptionType
    ).toUpperCase();

  const businessAccountToken =
    normalizeString(
      process.env
        .LITHIC_BUSINESS_ACCOUNT_TOKEN ||
        body.business_account_token ||
        body.businessAccountToken
    );

  return {
    firstName,
    lastName,

    email,

    phone,

    dob,

    governmentId,

    address,

    tosAccepted,

    tosTimestamp,

    workflow,

    kycExemptionType,

    businessAccountToken,

    externalId:
      buildMemberExternalId(
        member
      ),
  };
}

/* ==========================================================================
   WORKFLOW VALIDATION
============================================================================ */

function validateWorkflow(
  workflow
) {
  const clean =
    normalizeString(
      workflow
    ).toUpperCase();

  /*
   * Never select a Lithic compliance workflow automatically.
   *
   * It must match the workflow specifically approved for Card Leo.
   */

  const supported =
    new Set([
      "KYC_EXEMPT",
      "KYC_BYO",
      "KYC_BASIC",
    ]);

  if (!clean) {
    return {
      valid:
        false,

      message:
        "Lithic account-holder workflow has not been configured. Add LITHIC_ACCOUNT_HOLDER_WORKFLOW only after Lithic confirms the workflow approved for Card Leo Rewards.",
    };
  }

  if (
    !supported.has(
      clean
    )
  ) {
    return {
      valid:
        false,

      message:
        `Unsupported Lithic individual workflow: ${clean}.`,
    };
  }

  return {
    valid:
      true,

    workflow:
      clean,
  };
}

/* ==========================================================================
   INPUT VALIDATION
============================================================================ */

function validateCardholderInput(
  member,
  input
) {
  const errors = {};

  const memberValidation =
    validateMemberForLithic(
      member
    );

  if (
    !memberValidation.valid
  ) {
    Object.assign(
      errors,
      memberValidation.errors
    );
  }

  if (
    !input.email
  ) {
    errors.email =
      "Member email is required.";
  }

  if (
    !input.phone
  ) {
    errors.phone =
      "Phone number is required for Card Leo cardholder onboarding.";
  }

  if (
    !input.tosAccepted
  ) {
    errors.tosAccepted =
      "The member must accept the applicable cardholder terms before onboarding.";
  }

  if (
    !input.tosTimestamp
  ) {
    errors.tosTimestamp =
      "Terms acceptance timestamp is required.";
  }

  const workflowValidation =
    validateWorkflow(
      input.workflow
    );

  if (
    !workflowValidation.valid
  ) {
    errors.workflow =
      workflowValidation.message;
  }

  /*
   * KYC_BYO means Card Leo is performing the KYC process itself under an
   * arrangement Lithic has explicitly approved.
   */

  if (
    input.workflow ===
    "KYC_BYO"
  ) {
    if (
      !input.dob
    ) {
      errors.dob =
        "Date of birth is required for KYC_BYO.";
    }

    if (
      !input.governmentId
    ) {
      errors.governmentId =
        "Government ID is required for KYC_BYO.";
    }

    if (
      !input.address
        .address1
    ) {
      errors.address1 =
        "Street address is required for KYC_BYO.";
    }

    if (
      !input.address
        .city
    ) {
      errors.city =
        "City is required for KYC_BYO.";
    }

    if (
      !input.address
        .state
    ) {
      errors.state =
        "State is required for KYC_BYO.";
    }

    if (
      !input.address
        .postalCode
    ) {
      errors.postalCode =
        "Postal code is required for KYC_BYO.";
    }

    if (
      !input.address
        .country
    ) {
      errors.country =
        "Country is required for KYC_BYO.";
    }
  }

  /*
   * KYC_BASIC requirements vary with the approved program.
   * We require the normal identity/address foundation and allow Lithic to
   * enforce any program-specific fields.
   */

  if (
    input.workflow ===
    "KYC_BASIC"
  ) {
    if (
      !input.dob
    ) {
      errors.dob =
        "Date of birth is required for KYC_BASIC.";
    }

    if (
      !input.address
        .address1
    ) {
      errors.address1 =
        "Street address is required for KYC_BASIC.";
    }

    if (
      !input.address
        .city
    ) {
      errors.city =
        "City is required for KYC_BASIC.";
    }

    if (
      !input.address
        .state
    ) {
      errors.state =
        "State is required for KYC_BASIC.";
    }

    if (
      !input.address
        .postalCode
    ) {
      errors.postalCode =
        "Postal code is required for KYC_BASIC.";
    }
  }

  /*
   * KYC_EXEMPT can require program-specific exemption information.
   */

  if (
    input.workflow ===
      "KYC_EXEMPT" &&
    process.env
      .LITHIC_REQUIRE_KYC_EXEMPTION_TYPE ===
      "true" &&
    !input.kycExemptionType
  ) {
    errors.kycExemptionType =
      "A KYC exemption type is required for the configured Card Leo program.";
  }

  return {
    valid:
      Object.keys(
        errors
      ).length ===
      0,

    errors,
  };
}

/* ==========================================================================
   BUILD LITHIC INDIVIDUAL
============================================================================ */

function buildLithicIndividual(
  input
) {
  const individual = {
    first_name:
      input.firstName,

    last_name:
      input.lastName,

    email:
      input.email,

    phone_number:
      input.phone,
  };

  if (
    input.dob
  ) {
    individual.dob =
      input.dob;
  }

  /*
   * This stays in memory and goes directly to Lithic when the selected
   * workflow requires it.
   */

  if (
    input.governmentId
  ) {
    individual.government_id =
      input.governmentId;
  }

  const hasAddress =
    Boolean(
      input.address
        .address1 ||
      input.address
        .city ||
      input.address
        .state ||
      input.address
        .postalCode
    );

  if (hasAddress) {
    individual.address = {
      address1:
        input.address
          .address1,

      city:
        input.address
          .city,

      state:
        input.address
          .state,

      postal_code:
        input.address
          .postalCode,

      country:
        input.address
          .country,
    };

    if (
      input.address
        .address2
    ) {
      individual.address
        .address2 =
        input.address
          .address2;
    }
  }

  return individual;
}

/* ==========================================================================
   BUILD LITHIC ACCOUNT HOLDER PAYLOAD
============================================================================ */

function buildLithicAccountHolderPayload(
  input
) {
  const payload = {
    workflow:
      input.workflow,

    tos_timestamp:
      input.tosTimestamp,

    individual:
      buildLithicIndividual(
        input
      ),
  };

  /*
   * external_id is included only if configured/accepted by the current
   * Card Leo Lithic program.
   */

  if (
    normalizeBoolean(
      process.env
        .LITHIC_SEND_EXTERNAL_ID,
      false
    )
  ) {
    payload.external_id =
      input.externalId;
  }

  if (
    input.workflow ===
      "KYC_EXEMPT" &&
    input.kycExemptionType
  ) {
    payload.kyc_exemption_type =
      input.kycExemptionType;
  }

  if (
    input.businessAccountToken
  ) {
    payload.business_account_token =
      input.businessAccountToken;
  }

  return payload;
}

/* ==========================================================================
   PARSE LITHIC RESULT
============================================================================ */

function unwrapLithicData(
  result
) {
  if (
    isObject(
      result?.data?.data
    )
  ) {
    return result
      .data
      .data;
  }

  if (
    isObject(
      result?.data
    )
  ) {
    return result.data;
  }

  return {};
}

function parseCreatedAccountHolder(
  result
) {
  const data =
    unwrapLithicData(
      result
    );

  const accountHolderToken =
    normalizeString(
      data.token ||
        data.account_holder_token ||
        data.accountHolderToken
    );

  const accountToken =
    normalizeString(
      data.account_token ||
        data.accountToken
    );

  const status =
    normalizeString(
      data.status ||
        "UNKNOWN"
    ).toUpperCase();

  const statusReasons =
    Array.isArray(
      data.status_reasons
    )
      ? data.status_reasons
      : [];

  return {
    accountHolderToken,

    accountToken,

    status,

    statusReasons,
  };
}

/* ==========================================================================
   SAFE MEMBER CARD RESPONSE
============================================================================ */

function sanitizeMemberCardRecord(
  record
) {
  if (!record) {
    return null;
  }

  return {
    id:
      record.id ||
      null,

    memberId:
      record.member_id ||
      null,

    provider:
      record.provider ||
      "lithic",

    accountHolderCreated:
      Boolean(
        record
          .lithic_account_holder_token
      ),

    accountCreated:
      Boolean(
        record
          .lithic_account_token
      ),

    accountHolderStatus:
      record
        .lithic_account_holder_status ||
      null,

    workflow:
      record
        .lithic_workflow ||
      null,

    cardCreated:
      Boolean(
        record
          .lithic_card_token
      ),

    cardStatus:
      record.card_status ||
      "NOT_CREATED",

    cardType:
      record.card_type ||
      null,

    lastFour:
      record.last_four ||
      null,

    createdAt:
      record.created_at ||
      null,

    updatedAt:
      record.updated_at ||
      null,
  };
}

function hasExistingAccountHolder(
  record
) {
  return Boolean(
    normalizeString(
      record
        ?.lithic_account_holder_token
    )
  );
}

/* ==========================================================================
   SAFE MEMBER RESPONSE
============================================================================ */

function buildSafeMember(
  member
) {
  return {
    id:
      member.id,

    email:
      normalizeEmail(
        member.email
      ),

    firstName:
      normalizeString(
        member.first_name
      ),

    lastName:
      normalizeString(
        member.last_name
      ),

    fullName:
      normalizeString(
        member.full_name
      ) ||
      [
        member.first_name,
        member.last_name,
      ]
        .map(
          normalizeString
        )
        .filter(Boolean)
        .join(" "),
  };
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  if (
    typeof setNoStore ===
    "function"
  ) {
    setNoStore(
      res
    );
  }

  logRequestStart(
    req,
    {
      scope:
        "create_lithic_cardholder",
    }
  );

  /* ------------------------------------------------------------------------
     METHOD
  ------------------------------------------------------------------------ */

  if (
    req.method !==
    "POST"
  ) {
    res.setHeader(
      "Allow",
      "POST"
    );

    return sendJson(
      res,
      405,
      {
        success:
          false,

        ok:
          false,

        message:
          "Method not allowed. Use POST.",
      }
    );
  }

  try {
    /* ======================================================================
       AUTHENTICATION
    ====================================================================== */

    const {
      member,
      response,
    } =
      await getAuthenticatedMember(
        req,
        res
      );

    if (!member) {
      return response;
    }

    const memberId =
      getMemberId(
        member
      );

    /* ======================================================================
       EXISTING MEMBER CARD RECORD
    ====================================================================== */

    const existingResult =
      await getExistingMemberCard(
        memberId
      );

    if (
      existingResult
        .tableMissing &&
      isLithicEnabled()
    ) {
      return serviceUnavailable(
        res,
        "The Card Leo member_cards table has not been created yet.",
        {
          code:
            "MEMBER_CARDS_TABLE_MISSING",

          nextStep:
            "Create the member_cards table before enabling Lithic provisioning.",
        }
      );
    }

    const existingRecord =
      existingResult.record;

    /* ======================================================================
       IDEMPOTENT EXISTING HOLDER
    ====================================================================== */

    if (
      hasExistingAccountHolder(
        existingRecord
      )
    ) {
      return successResponse(
        res,
        {
          created:
            false,

          alreadyExists:
            true,

          member:
            buildSafeMember(
              member
            ),

          cardAccount:
            sanitizeMemberCardRecord(
              existingRecord
            ),

          lithic:
            getLithicIntegrationStatus(),

          next: {
            canCreateVirtualCard:
              Boolean(
                existingRecord
                  ?.lithic_account_token
              ) &&
              normalizeStatus(
                existingRecord
                  ?.lithic_account_holder_status
              ) ===
                "accepted",

            endpoint:
              "/api/cards/create-virtual-card",
          },
        },
        "Your Card Leo Lithic card account already exists."
      );
    }

    /* ======================================================================
       LITHIC DISABLED

       This is normal while Card Leo is still preparing Sandbox.
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return successResponse(
        res,
        {
          created:
            false,

          alreadyExists:
            false,

          configurationRequired:
            true,

          member:
            buildSafeMember(
              member
            ),

          lithic:
            getLithicIntegrationStatus(),

          nextSteps: [
            "Obtain Card Leo Lithic program approval.",
            "Obtain the Lithic Sandbox API key.",
            "Confirm Card Leo's approved individual account-holder workflow.",
            "Create/verify the member_cards table.",
            "Add the Lithic environment variables in Vercel.",
            "Set LITHIC_ENABLED=true when Sandbox provisioning is ready.",
          ],
        },
        "Card Leo card infrastructure is prepared, but Lithic is currently disabled."
      );
    }

    /* ======================================================================
       LITHIC CONFIG
    ====================================================================== */

    if (
      !isLithicConfigured()
    ) {
      return serviceUnavailable(
        res,
        "Lithic is enabled but is not fully configured.",
        {
          code:
            "LITHIC_NOT_CONFIGURED",

          lithic:
            getLithicIntegrationStatus(),
        }
      );
    }

    if (
      existingResult
        .tableMissing
    ) {
      return serviceUnavailable(
        res,
        "Card Leo cannot create a Lithic account holder until the member_cards table exists.",
        {
          code:
            "MEMBER_CARDS_TABLE_REQUIRED",
        }
      );
    }

    /* ======================================================================
       NORMALIZE REQUEST
    ====================================================================== */

    const rawBody =
      getRequestBody(
        req
      );

    const input =
      normalizeCardholderInput(
        member,
        rawBody
      );

    /* ======================================================================
       VALIDATE
    ====================================================================== */

    const validation =
      validateCardholderInput(
        member,
        input
      );

    if (
      !validation.valid
    ) {
      return badRequest(
        res,
        "Additional information is required before your Card Leo card account can be created.",
        {
          code:
            "CARDHOLDER_VALIDATION_FAILED",

          errors:
            validation.errors,

          workflow:
            input.workflow ||
            null,
        }
      );
    }

    /* ======================================================================
       BUILD LITHIC REQUEST

       Do not log this object because it may contain KYC PII.
    ====================================================================== */

    const lithicPayload =
      buildLithicAccountHolderPayload(
        input
      );

    const idempotencyKey =
      buildMemberIdempotencyKey(
        memberId
      );

    /* ======================================================================
       CREATE ACCOUNT HOLDER
    ====================================================================== */

    let lithicResult;

    try {
      lithicResult =
        await createLithicAccountHolder(
          lithicPayload,
          {
            idempotencyKey,
          }
        );
    } catch (
      lithicError
    ) {
      /*
       * Do not include payload/PII in logs.
       */

      logRequestError(
        req,
        lithicError,
        {
          scope:
            "lithic_create_account_holder",

          memberId,

          workflow:
            input.workflow,

          environment:
            getLithicEnvironment(),
        }
      );

      const status =
        Number(
          lithicError
            ?.status
        ) ||
        502;

      return sendJson(
        res,
        status >= 400 &&
        status <= 599
          ? status
          : 502,
        {
          success:
            false,

          ok:
            false,

          message:
            lithicError
              ?.message ||
            "Lithic could not create the Card Leo account holder.",

          code:
            lithicError
              ?.code ||
            "LITHIC_CREATE_ACCOUNT_HOLDER_FAILED",

          lithic: {
            environment:
              getLithicEnvironment(),

            configured:
              isLithicConfigured(),
          },
        }
      );
    }

    /* ======================================================================
       PARSE RESPONSE
    ====================================================================== */

    const created =
      parseCreatedAccountHolder(
        lithicResult
      );

    if (
      !created
        .accountHolderToken
    ) {
      const unexpected =
        new Error(
          "Lithic response did not include an account-holder token."
        );

      logRequestError(
        req,
        unexpected,
        {
          scope:
            "lithic_account_holder_missing_token",

          memberId,

          workflow:
            input.workflow,

          status:
            created.status,
        }
      );

      return serverError(
        res,
        "Lithic returned an unexpected account-holder response.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_TOKEN_MISSING",

          status:
            created.status,
        }
      );
    }

    /* ======================================================================
       SAVE SAFE LITHIC RELATIONSHIP

       NEVER persist:
       - government ID
       - DOB request payload
       - address request payload
       - raw request body
    ====================================================================== */

    let savedRecord;

    try {
      savedRecord =
        await saveMemberCardRecord({
          member,

          existingRecord,

          accountHolderToken:
            created
              .accountHolderToken,

          accountToken:
            created
              .accountToken,

          lithicStatus:
            created.status,

          lithicResponse: {
            status:
              created.status,

            status_reasons:
              created
                .statusReasons,
          },

          workflow:
            input.workflow,

          externalId:
            input.externalId,
        });
    } catch (
      databaseError
    ) {
      logRequestError(
        req,
        databaseError,
        {
          scope:
            "save_lithic_account_holder",

          memberId,

          lithicAccountHolderCreated:
            true,
        }
      );

      /*
       * Lithic may now contain this member.
       *
       * We MUST NOT blindly retry account-holder creation if the relationship
       * could not be persisted.
       */

      return serverError(
        res,
        "The Lithic account holder was created, but Card Leo could not save the account relationship. Do not retry automatically. An administrator must reconcile this member before another provisioning attempt.",
        {
          code:
            "LITHIC_CREATED_DATABASE_SAVE_FAILED",

          requiresReconciliation:
            true,
        }
      );
    }

    /* ======================================================================
       SUCCESS
    ====================================================================== */

    const accepted =
      created.status ===
      "ACCEPTED";

    const hasAccount =
      Boolean(
        created
          .accountToken
      );

    logRequestSuccess(
      req,
      {
        scope:
          "create_lithic_cardholder",

        memberId,

        lithicEnvironment:
          getLithicEnvironment(),

        workflow:
          input.workflow,

        lithicStatus:
          created.status,

        accountHolderCreated:
          true,

        accountCreated:
          hasAccount,
      }
    );

    return successResponse(
      res,
      {
        created:
          true,

        alreadyExists:
          false,

        member:
          buildSafeMember(
            member
          ),

        cardAccount:
          sanitizeMemberCardRecord(
            savedRecord
          ),

        lithic: {
          enabled:
            true,

          configured:
            true,

          environment:
            getLithicEnvironment(),

          status:
            created.status,

          accepted,

          pendingReview:
            created.status ===
            "PENDING_REVIEW",

          statusReasons:
            created
              .statusReasons,

          /*
           * Intentionally booleans only.
           * Tokens remain server-side.
           */

          accountHolderCreated:
            true,

          accountCreated:
            hasAccount,
        },

        next: {
          canCreateVirtualCard:
            accepted &&
            hasAccount,

          endpoint:
            "/api/cards/create-virtual-card",

          message:
            accepted &&
            hasAccount
              ? "Your Card Leo Lithic account is ready for virtual-card creation."
              : accepted
                ? "Your Lithic account holder was accepted, but an account token is not yet available."
                : "Your Lithic account holder exists, but onboarding must finish before a Card Leo virtual card can be issued.",
        },
      },
      accepted &&
      hasAccount
        ? "Card Leo card account created successfully."
        : "Card Leo card account was submitted to Lithic."
    );
  } catch (
    error
  ) {
    /*
     * IMPORTANT:
     * Unexpected server/database failures do not prove the member's browser
     * authentication is invalid. Do not clear their auth session here.
     */

    logRequestError(
      req,
      error,
      {
        scope:
          "create_lithic_cardholder_unexpected",
      }
    );

    console.error(
      "Card Leo create-cardholder error:",
      error
    );

    return serverError(
      res,
      "Unable to create the Card Leo card account right now.",
      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null,

            lithic:
              getLithicConfigForDebug(),
          }
        : {}
    );
  }
}