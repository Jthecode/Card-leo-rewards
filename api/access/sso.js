// api/access/sso.js

import crypto from "node:crypto";

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  getOrganizationCustomerIdentifier,
  getProgramCustomerIdentifier,
  buildMemberCustomerIdentifier,
  isAccessActiveMember,
  OPEN_STATUS,
  normalizeString,
} from "../../lib/access-amt.js";

import {
  getSessionCookieName,
  clearAuthCookies,
  safeJsonParse,
} from "../../lib/cookies.js";

import {
  setNoStore,
} from "../../lib/responses.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

/* ==========================================================================
   CARD LEO REWARDS
   ACCESS PERKS TOKENIZED SSO

   ROUTE
   -----
   GET /api/access/sso

   PURPOSE
   -------
   Send an authenticated Card Leo member directly into their Access Perks
   benefits experience using Access Development Tokenized SSO / Remote Login.

   ACCESS TOKENIZED SSO
   --------------------
   Access requires:

     organization_key
     program_key
     member_key

   These map directly to the Member AMT identifiers:

     organization_key
       =
     organization_customer_identifier

     program_key
       =
     program_customer_identifier

     member_key
       =
     member_customer_identifier

   The CVT token is:

     SHA256(
       ORGANIZATION_KEY-PROGRAM_KEY-MEMBER_KEY
     )

   IMPORTANT
   ---------
   Alphabetic characters must be UPPERCASE before the SHA256 hash is
   calculated.

   MEMBER FLOW
   -----------
   Card Leo Portal
       ↓
   GET /api/access/sso
       ↓
   Verify Card Leo login session
       ↓
   Load member from Supabase
       ↓
   Confirm Card Leo membership is active
       ↓
   Confirm Access status = OPEN
       ↓
   Confirm permanent access_member_identifier
       ↓
   Generate CVT
       ↓
   Redirect to Access Deals
       ↓
   Member enters Card Leo Access Perks benefits

   SECURITY
   --------
   - Access API token is NOT used here.
   - Access AMT API token is NEVER exposed.
   - Browser never chooses member_key.
   - Browser never chooses organization_key.
   - Browser never chooses program_key.
   - Browser never supplies the CVT token.
   - Card Leo generates everything server-side.
   - Only the authenticated Card Leo member may generate their own SSO URL.

   IMPORTANT CONFIG
   ----------------
   Access's PDF uses example launch URLs only.

   Therefore the actual production launch URL MUST be supplied through:

     ACCESS_DEALS_SSO_URL

   Example form:

     https://<access-host>/director

   Do not copy the test URL from the PDF into Production unless Access
   explicitly confirms it for Card Leo.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_PORTAL_URL =
  "/portal/benefits.html";

const DEFAULT_LOGIN_URL =
  "/login.html";

const DEFAULT_ACCESS_STATUS =
  OPEN_STATUS;

const MAX_REDIRECT_URL_LENGTH =
  2048;

/* ==========================================================================
   SESSION COOKIE NAMES

   Keep compatibility with current Card Leo member auth.
============================================================================ */

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   GENERAL HELPERS
============================================================================ */

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

function isObject(
  value
) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function nowIso() {
  return new Date()
    .toISOString();
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

      login:
        DEFAULT_LOGIN_URL,
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

      authenticated:
        true,

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
  message,
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

  const raw =
    normalizeString(
      req?.headers?.cookie
    );

  if (!raw) {
    return {};
  }

  return raw
    .split(";")
    .map(
      (part) =>
        part.trim()
    )
    .filter(Boolean)
    .reduce(
      (
        cookies,
        part
      ) => {
        const separator =
          part.indexOf("=");

        if (
          separator === -1
        ) {
          return cookies;
        }

        const name =
          part
            .slice(
              0,
              separator
            )
            .trim();

        const value =
          part
            .slice(
              separator + 1
            )
            .trim();

        if (!name) {
          return cookies;
        }

        try {
          cookies[name] =
            decodeURIComponent(
              value
            );
        } catch {
          cookies[name] =
            value;
        }

        return cookies;
      },
      {}
    );
}

/* ==========================================================================
   SESSION VALUE PARSER
============================================================================ */

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

  /* ------------------------------------------------------------------------
     DIRECT JSON
  ------------------------------------------------------------------------ */

  try {
    const direct =
      typeof safeJsonParse ===
        "function"
        ? safeJsonParse(
            raw,
            null
          )
        : JSON.parse(
            raw
          );

    if (
      isObject(
        direct
      )
    ) {
      return direct;
    }
  } catch {
    // Continue.
  }

  /* ------------------------------------------------------------------------
     BASE64URL
  ------------------------------------------------------------------------ */

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

    const parsed =
      typeof safeJsonParse ===
        "function"
        ? safeJsonParse(
            decoded,
            null
          )
        : JSON.parse(
            decoded
          );

    if (
      isObject(
        parsed
      )
    ) {
      return parsed;
    }
  } catch {
    // Continue.
  }

  /* ------------------------------------------------------------------------
     BASE64
  ------------------------------------------------------------------------ */

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
      typeof safeJsonParse ===
        "function"
        ? safeJsonParse(
            decoded,
            null
          )
        : JSON.parse(
            decoded
          );

    if (
      isObject(
        parsed
      )
    ) {
      return parsed;
    }
  } catch {
    // Ignore invalid cookie.
  }

  return null;
}

/* ==========================================================================
   READ MEMBER SESSION
============================================================================ */

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

  const possibleNames =
    Array.from(
      new Set(
        [
          configuredName,
          ...SESSION_COOKIE_NAMES,
        ].filter(Boolean)
      )
    );

  for (
    const name
    of possibleNames
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

/* ==========================================================================
   SESSION EXPIRATION
============================================================================ */

function getSessionExpiresAt(
  sessionMeta
) {
  const session =
    sessionMeta?.data ||
    {};

  const possible =
    [
      session.expires_at,
      session.expiresAt,
      session.exp,
      session.session
        ?.expires_at,
      session.session
        ?.expiresAt,
    ];

  for (
    const value
    of possible
  ) {
    const parsed =
      Number(
        value
      );

    if (
      Number.isFinite(
        parsed
      ) &&
      parsed > 0
    ) {
      return parsed;
    }
  }

  return 0;
}

function isSessionExpired(
  sessionMeta
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionMeta
    );

  /*
   * Some older Card Leo session formats do not include an explicit
   * expiration value.
   *
   * Do not treat a missing expiration field as automatically expired.
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
   SESSION MEMBER ID
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
    data.user?.id ||
    data.signupId ||
    data.signup_id ||
    data.memberId ||
    data.member_id ||
    data.id
  );
}

/* ==========================================================================
   SESSION EMAIL
============================================================================ */

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
    data.userEmail ||
    ""
  );
}

/* ==========================================================================
   OPTIONAL DATABASE COLUMN ERROR
============================================================================ */

function isMissingOptionalColumn(
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
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||

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
   MEMBER LOOKUP
============================================================================ */

async function getMemberRecord({
  memberId,
  email,
}) {
  const extendedFields = [
    "id",
    "email",

    "first_name",
    "last_name",
    "full_name",

    "status",
    "payment_status",
    "membership_status",
    "approval_status",

    "access_member_identifier",
    "access_member_status",
    "access_synced_at",
    "access_suspended_at",
    "access_sync_error",
    "access_perks_ready",

    "created_at",
    "updated_at",
  ].join(", ");

  const fallbackFields = [
    "id",
    "email",

    "first_name",
    "last_name",
    "full_name",

    "status",

    "created_at",
    "updated_at",
  ].join(", ");

  async function execute(
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
    } else if (email) {
      query =
        query.ilike(
          "email",
          email
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
    await execute(
      extendedFields
    );

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    result =
      await execute(
        fallbackFields
      );
  }

  return result;
}

/* ==========================================================================
   AUTHENTICATE CARD LEO MEMBER
============================================================================ */

async function getAuthenticatedMember(
  req,
  res
) {
  const sessionMeta =
    readSessionCookie(
      req
    );

  if (
    !sessionMeta?.data
  ) {
    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Please sign in before opening Card Leo benefits."
        ),
    };
  }

  if (
    isSessionExpired(
      sessionMeta
    )
  ) {
    try {
      clearAuthCookies(
        res
      );
    } catch {
      // Best effort only.
    }

    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Your Card Leo session expired. Please sign in again."
        ),
    };
  }

  /*
   * Do NOT require:
   *
   *   session.data.authenticated === true
   *
   * Older valid Card Leo sessions may not carry that flag.
   *
   * Identity must still resolve to an actual database member.
   */

  const memberId =
    getSessionMemberId(
      sessionMeta
    );

  const email =
    getSessionEmail(
      sessionMeta
    );

  if (
    !memberId &&
    !email
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
          "Your login session does not contain a Card Leo member identity."
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
      email,
    });

  /*
   * Database errors are NOT authentication failures.
   */

  if (error) {
    throw error;
  }

  if (
    !member?.id
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
          "Card Leo member account could not be found."
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
   ACCESS MEMBER IDENTIFIER

   IMPORTANT
   ---------
   Use the identifier saved after successful Access AMT enrollment whenever
   possible.

   That permanent value is also Access's SSO member_key.
============================================================================ */

function getPermanentAccessMemberIdentifier(
  member
) {
  const savedIdentifier =
    normalizeString(
      member
        ?.access_member_identifier
    );

  if (
    savedIdentifier
  ) {
    return savedIdentifier;
  }

  /*
   * Compatibility fallback.
   *
   * buildMemberCustomerIdentifier() is deterministic and uses the immutable
   * Card Leo member ID when available.
   *
   * However, the normal production flow should have already saved the
   * identifier after AMT enrollment.
   */

  return buildMemberCustomerIdentifier(
    member
  );
}

/* ==========================================================================
   ACCESS SSO CONFIG
============================================================================ */

function getAccessDealsSsoUrl() {
  return (
    getEnv(
      "ACCESS_DEALS_SSO_URL"
    ) ||
    getEnv(
      "ACCESS_SSO_URL"
    ) ||
    getEnv(
      "ACCESS_REMOTE_LOGIN_URL"
    )
  );
}

/* ==========================================================================
   SSO CONFIG VALIDATION
============================================================================ */

function validateSsoConfiguration() {
  const errors =
    {};

  const organizationKey =
    getOrganizationCustomerIdentifier();

  const programKey =
    getProgramCustomerIdentifier();

  const ssoUrl =
    getAccessDealsSsoUrl();

  if (
    !organizationKey
  ) {
    errors.organizationKey =
      "Access organization identifier is missing.";
  }

  if (
    !programKey
  ) {
    errors.programKey =
      "Access program identifier is missing.";
  }

  if (
    !ssoUrl
  ) {
    errors.ssoUrl =
      "ACCESS_DEALS_SSO_URL is missing.";
  } else {
    try {
      const parsed =
        new URL(
          ssoUrl
        );

      if (
        ![
          "https:",
          "http:",
        ].includes(
          parsed.protocol
        )
      ) {
        errors.ssoUrl =
          "ACCESS_DEALS_SSO_URL must use HTTP or HTTPS.";
      }
    } catch {
      errors.ssoUrl =
        "ACCESS_DEALS_SSO_URL is invalid.";
    }
  }

  return {
    valid:
      Object.keys(
        errors
      ).length === 0,

    errors,

    organizationKey,

    programKey,

    ssoUrl,
  };
}

/* ==========================================================================
   ACCESS KEY NORMALIZATION

   Access requires alphabetic characters to be uppercase before hashing.

   Uppercasing the entire value is safe because digits and punctuation are
   unchanged.
============================================================================ */

function normalizeAccessSsoKey(
  value
) {
  return normalizeString(
    value
  ).toUpperCase();
}

/* ==========================================================================
   CVT SOURCE STRING
============================================================================ */

function buildCvtSource({
  organizationKey,
  programKey,
  memberKey,
}) {
  const normalizedOrganizationKey =
    normalizeAccessSsoKey(
      organizationKey
    );

  const normalizedProgramKey =
    normalizeAccessSsoKey(
      programKey
    );

  const normalizedMemberKey =
    normalizeAccessSsoKey(
      memberKey
    );

  if (
    !normalizedOrganizationKey
  ) {
    throw new Error(
      "Access organization key is required for SSO."
    );
  }

  if (
    !normalizedProgramKey
  ) {
    throw new Error(
      "Access program key is required for SSO."
    );
  }

  if (
    !normalizedMemberKey
  ) {
    throw new Error(
      "Access member key is required for SSO."
    );
  }

  return [
    normalizedOrganizationKey,
    normalizedProgramKey,
    normalizedMemberKey,
  ].join("-");
}

/* ==========================================================================
   GENERATE CVT TOKEN

   SHA256(
     organization_key-program_key-member_key
   )
============================================================================ */

function generateAccessCvt({
  organizationKey,
  programKey,
  memberKey,
}) {
  const source =
    buildCvtSource({
      organizationKey,
      programKey,
      memberKey,
    });

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      source,
      "utf8"
    )
    .digest(
      "hex"
    );
}

/* ==========================================================================
   BUILD ACCESS LAUNCH URL
============================================================================ */

function buildAccessLaunchUrl({
  ssoUrl,
  cvt,
}) {
  const url =
    new URL(
      ssoUrl
    );

  /*
   * Preserve any Access-provided URL parameters while adding/replacing cvt.
   */

  url.searchParams.set(
    "cvt",
    cvt
  );

  const finalUrl =
    url.toString();

  if (
    finalUrl.length >
    MAX_REDIRECT_URL_LENGTH
  ) {
    throw new Error(
      "Access SSO launch URL exceeds the allowed length."
    );
  }

  return finalUrl;
}

/* ==========================================================================
   SAFE MEMBER RESPONSE
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

    firstName:
      normalizeString(
        member?.first_name
      ),

    lastName:
      normalizeString(
        member?.last_name
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

    status:
      normalizeString(
        member?.status
      ),

    paymentStatus:
      normalizeString(
        member
          ?.payment_status
      ),

    membershipStatus:
      normalizeString(
        member
          ?.membership_status
      ),

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
      member
        ?.access_perks_ready ===
      true,
  };
}

/* ==========================================================================
   DETERMINE JSON MODE

   Normal portal use:
     GET /api/access/sso
       → HTTP redirect

   Debug/API use:
     GET /api/access/sso?format=json
       → JSON response containing launchUrl

   JSON mode should remain authenticated just like redirect mode.
============================================================================ */

function wantsJsonResponse(
  req
) {
  const format =
    normalizeString(
      req?.query?.format
    ).toLowerCase();

  if (
    format === "json"
  ) {
    return true;
  }

  const accept =
    normalizeString(
      req?.headers?.accept
    ).toLowerCase();

  return (
    accept.includes(
      "application/json"
    ) &&
    !accept.includes(
      "text/html"
    )
  );
}

/* ==========================================================================
   AUDIT INFO
============================================================================ */

function getClientIp(
  req
) {
  const forwarded =
    normalizeString(
      req?.headers?.[
        "x-forwarded-for"
      ]
    );

  if (forwarded) {
    return forwarded
      .split(",")[0]
      .trim();
  }

  return (
    req?.socket?.remoteAddress ||
    null
  );
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore(
    res
  );

  logRequestStart(
    req,
    {
      scope:
        "access_sso",
    }
  );

  /* ========================================================================
     GET ONLY

     A member benefit launch is naturally a GET navigation from the portal.
  ======================================================================== */

  if (
    req.method !==
    "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET"
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
          "Method not allowed. Use GET.",
      }
    );
  }

  try {
    /* ======================================================================
       AUTHENTICATE CARD LEO MEMBER
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

    /* ======================================================================
       CARD LEO ELIGIBILITY

       isAccessActiveMember() requires:
       - current/paid payment
       - eligible member state
       - no inactive/blocked status
    ====================================================================== */

    if (
      !isAccessActiveMember(
        member
      )
    ) {
      return forbidden(
        res,
        "Your Card Leo membership must be active and current before Access Perks benefits can be opened.",
        {
          code:
            "CARDLEO_MEMBERSHIP_NOT_ELIGIBLE",

          benefitsPage:
            DEFAULT_PORTAL_URL,
        }
      );
    }

    /* ======================================================================
       ACCESS STATUS
    ====================================================================== */

    const accessStatus =
      normalizeStatus(
        member
          .access_member_status
      );

    if (
      accessStatus !==
      DEFAULT_ACCESS_STATUS
    ) {
      return forbidden(
        res,
        "Your Access Perks membership is not currently open.",
        {
          code:
            "ACCESS_MEMBER_NOT_OPEN",

          accessMemberStatus:
            accessStatus ||
            "NOT_SYNCED",

          benefitsPage:
            DEFAULT_PORTAL_URL,
        }
      );
    }

    /* ======================================================================
       ACCESS READY
    ====================================================================== */

    if (
      member
        .access_perks_ready ===
      false
    ) {
      return forbidden(
        res,
        "Your Access Perks enrollment is still being finalized.",
        {
          code:
            "ACCESS_PERKS_NOT_READY",

          accessMemberStatus:
            accessStatus,

          benefitsPage:
            DEFAULT_PORTAL_URL,
        }
      );
    }

    /* ======================================================================
       PERMANENT MEMBER KEY
    ====================================================================== */

    const memberKey =
      getPermanentAccessMemberIdentifier(
        member
      );

    if (
      !memberKey
    ) {
      return forbidden(
        res,
        "Your Access Perks member identifier has not been created yet.",
        {
          code:
            "ACCESS_MEMBER_IDENTIFIER_MISSING",

          benefitsPage:
            DEFAULT_PORTAL_URL,
        }
      );
    }

    /*
     * Production best practice:
     *
     * If Access status is OPEN but the permanent identifier was never saved
     * to the database, do not silently create a different identity.
     */

    if (
      !normalizeString(
        member
          .access_member_identifier
      )
    ) {
      return forbidden(
        res,
        "Your Access Perks member profile needs to be synchronized before benefits can be launched.",
        {
          code:
            "ACCESS_MEMBER_IDENTIFIER_NOT_PERSISTED",

          benefitsPage:
            DEFAULT_PORTAL_URL,
        }
      );
    }

    /* ======================================================================
       SSO CONFIG
    ====================================================================== */

    const configuration =
      validateSsoConfiguration();

    if (
      !configuration.valid
    ) {
      return serviceUnavailable(
        res,
        "Card Leo Access Perks SSO is not fully configured yet.",
        {
          code:
            "ACCESS_SSO_NOT_CONFIGURED",

          ...(process.env
            .NODE_ENV ===
          "development"
            ? {
                errors:
                  configuration
                    .errors,
              }
            : {}),
        }
      );
    }

    /* ======================================================================
       CVT
    ====================================================================== */

    const cvt =
      generateAccessCvt({
        organizationKey:
          configuration
            .organizationKey,

        programKey:
          configuration
            .programKey,

        memberKey,
      });

    /* ======================================================================
       ACCESS LAUNCH URL
    ====================================================================== */

    const launchUrl =
      buildAccessLaunchUrl({
        ssoUrl:
          configuration.ssoUrl,

        cvt,
      });

    /* ======================================================================
       AUDIT LOG

       Do NOT log the CVT.

       Although CVT is deterministic rather than a password, it provides
       member login capability and should not be unnecessarily stored in logs.
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "access_sso",

        memberId:
          member.id,

        email:
          normalizeEmail(
            member.email
          ),

        accessMemberIdentifier:
          memberKey,

        accessMemberStatus:
          accessStatus,

        environment:
          getEnv(
            "ACCESS_ENVIRONMENT",
            "stage"
          ),

        ip:
          getClientIp(
            req
          ),

        generatedAt:
          nowIso(),
      }
    );

    /* ======================================================================
       OPTIONAL JSON RESPONSE

       Useful when the portal wants JavaScript to request the launch URL.

       The normal implementation should simply link to:

         /api/access/sso
    ====================================================================== */

    if (
      wantsJsonResponse(
        req
      )
    ) {
      return sendJson(
        res,
        200,
        {
          success:
            true,

          ok:
            true,

          authenticated:
            true,

          ready:
            true,

          provider:
            "access-development",

          product:
            "access-perks",

          member:
            sanitizeMember(
              member
            ),

          access: {
            memberIdentifier:
              memberKey,

            status:
              accessStatus,

            perksReady:
              true,
          },

          launchUrl,

          redirect:
            launchUrl,

          generatedAt:
            nowIso(),
        }
      );
    }

    /* ======================================================================
       REDIRECT MEMBER INTO ACCESS

       Use 302 because this is a member navigation/login launch.
    ====================================================================== */

    res.statusCode =
      302;

    res.setHeader(
      "Location",
      launchUrl
    );

    return res.end();
  } catch (
    error
  ) {
    logRequestError(
      req,
      error,
      {
        scope:
          "access_sso_unexpected",
      }
    );

    console.error(
      "Card Leo Access SSO error:",
      {
        message:
          error?.message ||
          error,

        code:
          error?.code ||
          null,
      }
    );

    return serverError(
      res,
      "Card Leo could not open Access Perks right now.",
      {
        code:
          "ACCESS_SSO_FAILED",

        ...(process.env
          .NODE_ENV ===
        "development"
          ? {
              debug: {
                message:
                  error?.message ||
                  "Unknown error",

                code:
                  error?.code ||
                  null,
              },
            }
          : {}),
      }
    );
  }
}

/* ==========================================================================
   OPTIONAL TEST EXPORTS

   These exports are useful if we later add unit tests for CVT generation.
============================================================================ */

export {
  normalizeAccessSsoKey,
  buildCvtSource,
  generateAccessCvt,
  buildAccessLaunchUrl,
  getAccessDealsSsoUrl,
  validateSsoConfiguration,
};