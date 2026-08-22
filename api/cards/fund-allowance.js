// api/cards/fund-allowance.js

import crypto from "node:crypto";

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  lithicRequest,
  isLithicEnabled,
  isLithicConfigured,
  getLithicEnvironment,
  getLithicIntegrationStatus,
  getLithicConfigForDebug,
  getMemberId,
  normalizeString,
  centsToDollars,
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
   FUND MEMBER ALLOWANCE

   ROUTE
   -----
   POST /api/cards/fund-allowance

   PURPOSE
   -------
   Move an APPROVED Card Leo allowance/reward into the member's Lithic
   issuing financial account.

   SECURITY MODEL
   --------------
   The browser NEVER chooses:

   - amount
   - member_id
   - Lithic account
   - financial account
   - source funding account
   - destination funding account
   - provider transaction reference

   Browser sends ONLY:

     {
       "allowanceTransactionId": "..."
     }

   Card Leo then verifies everything server-side.

   FLOW
   ----
   1. Authenticate Card Leo member.
   2. Resolve member from Supabase.
   3. Verify member is paid + active.
   4. Reject blocked/suspended members.
   5. Load member_cards.
   6. Require Lithic account holder.
   7. Require accepted account holder.
   8. Require Lithic account.
   9. Require Card Leo virtual card.
   10. Load allowance transaction by BOTH transaction ID and member ID.
   11. Load amount only from database.
   12. Confirm transaction is an approved credit.
   13. Prevent duplicate funding.
   14. Resolve destination ISSUING financial account from Lithic.
   15. Resolve Card Leo source funding account from server env.
   16. Lock allowance as processing.
   17. Perform Lithic book transfer.
   18. Save provider reference.
   19. Mark allowance funded/processing.
   20. Return safe balance/result.

============================================================================ */

/* ==========================================================================
   TABLES
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

const ALLOWANCE_TRANSACTIONS_TABLE =
  "allowance_transactions";

/* ==========================================================================
   SESSION COOKIES
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

const SESSION_TOKEN_COOKIE_NAMES = [
  "cardleo_session_token",
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",
];

/* ==========================================================================
   MEMBER STATUS
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
   ALLOWANCE STATUS
============================================================================ */

const READY_ALLOWANCE_STATUSES =
  new Set([
    "approved",
    "ready",
    "ready_to_fund",
    "queued",
  ]);

const PROCESSING_ALLOWANCE_STATUSES =
  new Set([
    "processing",
    "funding",
    "submitted",
    "pending_transfer",
  ]);

const COMPLETED_ALLOWANCE_STATUSES =
  new Set([
    "funded",
    "completed",
    "complete",
    "settled",
    "succeeded",
  ]);

const FAILED_ALLOWANCE_STATUSES =
  new Set([
    "failed",
    "declined",
    "cancelled",
    "canceled",
    "reversed",
  ]);

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_CURRENCY =
  "USD";

const DEFAULT_MEMO_PREFIX =
  "Card Leo Allowance";

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

function success(
  res,
  data = {},
  message =
    "Allowance processed successfully."
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

      authenticated:
        true,

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
   GENERAL HELPERS
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

function normalizeEmail(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeInteger(
  value,
  fallback = 0
) {
  const parsed =
    Number.parseInt(
      String(
        value ??
        ""
      ),
      10
    );

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
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

  return parsed > 0
    ? parsed
    : fallback;
}

function nowIso() {
  return new Date()
    .toISOString();
}

function safeDate(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date
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
   SUPABASE COMPATIBILITY
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

  const header =
    req?.headers?.cookie ||
    "";

  return String(
    header
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

  const direct =
    safeJsonParse(
      raw
    );

  if (direct) {
    return direct;
  }

  return parseBase64Session(
    raw
  );
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

function readSessionTokenCookie(
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

  const value =
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
    value
  )
    ? value
    : 0;
}

function isSessionExpired(
  sessionMeta
) {
  const expiresAt =
    getSessionExpiresAt(
      sessionMeta
    );

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
   MEMBER STATUS
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
   MEMBER LOOKUP
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
   AUTHENTICATION
============================================================================ */

async function getAuthenticatedMember(
  req,
  res
) {
  const session =
    readSessionCookie(
      req
    );

  if (
    !session?.data
  ) {
    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Please sign in before funding your Card Leo allowance."
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
   * Same session resolution as #8, #9, #10.
   *
   * DO NOT require:
   *
   * session.data.authenticated === true
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
    readSessionTokenCookie(
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

  /*
   * Database problem != logout.
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
          "Your Card Leo account is currently restricted and cannot receive card allowance.",
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
          "Your Card Leo membership payment must be current before allowance can be funded.",
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
          "Your Card Leo membership must be active and approved before allowance can be funded.",
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
   MEMBER CARD
============================================================================ */

async function getMemberCardRecord(
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
  };
}

/* ==========================================================================
   ALLOWANCE LOOKUP

   Ownership is enforced in SQL:
   id = allowanceTransactionId
   member_id = authenticated member
============================================================================ */

async function getAllowanceTransaction({
  allowanceTransactionId,
  memberId,
}) {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .select(
        "*"
      )
      .eq(
        "id",
        allowanceTransactionId
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
        transaction:
          null,

        tableMissing:
          true,
      };
    }

    throw error;
  }

  return {
    transaction:
      data ||
      null,

    tableMissing:
      false,
  };
}

/* ==========================================================================
   ALLOWANCE AMOUNT

   The browser amount is NEVER used.
============================================================================ */

function getAllowanceAmountCents(
  transaction
) {
  const amountCents =
    normalizePositiveInteger(
      transaction
        ?.amount_cents,
      0
    );

  if (
    amountCents >
    0
  ) {
    return amountCents;
  }

  /*
   * Compatibility fallback only.
   *
   * Older rows may contain dollar amount.
   */

  const amount =
    Number(
      transaction
        ?.amount ||
      0
    );

  if (
    Number.isFinite(
      amount
    ) &&
    amount >
    0
  ) {
    return Math.round(
      amount *
      100
    );
  }

  return 0;
}

/* ==========================================================================
   ALLOWANCE DIRECTION
============================================================================ */

function isAllowanceCredit(
  transaction
) {
  const direction =
    normalizeStatus(
      transaction
        ?.direction ||
      transaction
        ?.type ||
      transaction
        ?.transaction_type ||
      "credit"
    );

  return [
    "credit",
    "allowance",
    "reward",
    "deposit",
    "fund",
  ].includes(
    direction
  );
}

/* ==========================================================================
   EXISTING PROVIDER REFERENCE
============================================================================ */

function getExistingProviderTransactionToken(
  transaction
) {
  return normalizeString(
    transaction
      ?.provider_transaction_token ||
    transaction
      ?.lithic_transaction_token ||
    transaction
      ?.external_reference ||
    transaction
      ?.external_id
  );
}

/* ==========================================================================
   VALIDATE ALLOWANCE
============================================================================ */

function validateAllowanceTransaction(
  transaction
) {
  const errors = {};

  if (
    !transaction?.id
  ) {
    errors.transaction =
      "Allowance transaction does not exist.";
  }

  const amountCents =
    getAllowanceAmountCents(
      transaction
    );

  if (
    amountCents <=
    0
  ) {
    errors.amount =
      "Allowance transaction does not contain a valid amount.";
  }

  if (
    !isAllowanceCredit(
      transaction
    )
  ) {
    errors.direction =
      "Only Card Leo allowance credits can be funded.";
  }

  const status =
    normalizeStatus(
      transaction
        ?.status
    );

  if (
    COMPLETED_ALLOWANCE_STATUSES.has(
      status
    )
  ) {
    errors.completed =
      "This allowance has already been funded.";
  }

  if (
    FAILED_ALLOWANCE_STATUSES.has(
      status
    )
  ) {
    errors.failed =
      "This allowance transaction is not eligible for funding.";
  }

  if (
    PROCESSING_ALLOWANCE_STATUSES.has(
      status
    )
  ) {
    errors.processing =
      "This allowance is already processing.";
  }

  if (
    status &&
    !READY_ALLOWANCE_STATUSES.has(
      status
    ) &&
    !COMPLETED_ALLOWANCE_STATUSES.has(
      status
    ) &&
    !PROCESSING_ALLOWANCE_STATUSES.has(
      status
    )
  ) {
    errors.status =
      `Allowance status "${status}" is not ready for funding.`;
  }

  return {
    valid:
      Object.keys(
        errors
      ).length ===
      0,

    errors,

    amountCents,
  };
}

/* ==========================================================================
   DETERMINISTIC IDEMPOTENCY KEY

   The same Card Leo allowance transaction always maps to the same UUID.
============================================================================ */

function buildAllowanceIdempotencyKey(
  transaction
) {
  const existing =
    normalizeString(
      transaction
        ?.idempotency_key ||
      transaction
        ?.idempotency_token
    );

  if (existing) {
    return existing;
  }

  const transactionId =
    normalizeString(
      transaction
        ?.id
    );

  const memberId =
    normalizeString(
      transaction
        ?.member_id
    );

  const digest =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        [
          "cardleo",
          "lithic",
          "allowance",
          memberId,
          transactionId,
        ].join(":")
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
   * RFC 4122-compatible deterministic UUID.
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
   ATOMIC-STYLE PROCESSING CLAIM

   This protects against two browser requests racing each other.

   We only claim a row when it is still in a ready state.
============================================================================ */

async function claimAllowanceForProcessing({
  transaction,
  idempotencyKey,
}) {
  const readyStatuses =
    Array.from(
      READY_ALLOWANCE_STATUSES
    );

  const timestamp =
    nowIso();

  let query =
    supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .update({
        status:
          "processing",

        provider:
          "lithic",

        provider_status:
          "processing",

        idempotency_key:
          idempotencyKey,

        funding_started_at:
          timestamp,

        updated_at:
          timestamp,
      })
      .eq(
        "id",
        transaction.id
      )
      .eq(
        "member_id",
        transaction.member_id
      );

  /*
   * Restrict update to an allowable starting status.
   */

  if (
    readyStatuses.length
  ) {
    query =
      query.in(
        "status",
        readyStatuses
      );
  }

  const {
    data,
    error,
  } =
    await query
      .select()
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data ||
    null;
}

/* ==========================================================================
   UPDATE ALLOWANCE
============================================================================ */

async function updateAllowanceTransaction(
  transactionId,
  updates
) {
  const payload = {
    ...updates,

    updated_at:
      nowIso(),
  };

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        ALLOWANCE_TRANSACTIONS_TABLE
      )
      .update(
        payload
      )
      .eq(
        "id",
        transactionId
      )
      .select()
      .single();

  if (error) {
    throw error;
  }

  return data;
}

/* ==========================================================================
   LITHIC LIST
============================================================================ */

function unwrapLithicList(
  result
) {
  if (
    Array.isArray(
      result?.data
    )
  ) {
    return result.data;
  }

  if (
    Array.isArray(
      result?.data?.data
    )
  ) {
    return result
      .data
      .data;
  }

  if (
    Array.isArray(
      result?.data?.items
    )
  ) {
    return result
      .data
      .items;
  }

  return [];
}

function unwrapLithicObject(
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

/* ==========================================================================
   MEMBER ISSUING FINANCIAL ACCOUNT

   We deliberately require ISSUING.
   We do NOT silently fall back to OPERATING.
============================================================================ */

async function getMemberIssuingFinancialAccount(
  accountToken
) {
  const cleanAccountToken =
    normalizeString(
      accountToken
    );

  if (!cleanAccountToken) {
    return null;
  }

  const params =
    new URLSearchParams();

  params.set(
    "account_token",
    cleanAccountToken
  );

  const result =
    await lithicRequest(
      `/financial_accounts?${params.toString()}`,
      {
        method:
          "GET",
      }
    );

  const accounts =
    unwrapLithicList(
      result
    );

  return (
    accounts.find(
      (account) =>
        normalizeStatus(
          account?.type
        ) ===
        "issuing"
    ) ||
    null
  );
}

/* ==========================================================================
   CARD LEO SOURCE FUNDING ACCOUNT
============================================================================ */

function getProgramIssuingFinancialAccountToken() {
  return (
    getEnv(
      "LITHIC_PROGRAM_ISSUING_FINANCIAL_ACCOUNT_TOKEN"
    ) ||
    getEnv(
      "LITHIC_ISSUING_FINANCIAL_ACCOUNT_TOKEN"
    )
  );
}

/* ==========================================================================
   BOOK TRANSFER CONFIG
============================================================================ */

function getBookTransferCategory() {
  return getEnv(
    "LITHIC_BOOK_TRANSFER_CATEGORY"
  ).toUpperCase();
}

function getBookTransferSubtype() {
  return getEnv(
    "LITHIC_BOOK_TRANSFER_SUBTYPE"
  );
}

function validateBookTransferConfiguration() {
  const errors = {};

  const sourceToken =
    getProgramIssuingFinancialAccountToken();

  const category =
    getBookTransferCategory();

  const subtype =
    getBookTransferSubtype();

  if (!sourceToken) {
    errors.sourceFinancialAccount =
      "LITHIC_PROGRAM_ISSUING_FINANCIAL_ACCOUNT_TOKEN is missing.";
  }

  /*
   * Card Leo must use the category/subtype approved for its Lithic program.
   * Never guess these values.
   */

  if (!category) {
    errors.category =
      "LITHIC_BOOK_TRANSFER_CATEGORY is missing.";
  }

  if (!subtype) {
    errors.subtype =
      "LITHIC_BOOK_TRANSFER_SUBTYPE is missing.";
  }

  return {
    valid:
      Object.keys(
        errors
      ).length ===
      0,

    errors,

    sourceToken,

    category,

    subtype,
  };
}

/* ==========================================================================
   TRANSFER MEMO
============================================================================ */

function buildTransferMemo({
  member,
  transaction,
}) {
  const memberName =
    normalizeString(
      member
        ?.full_name
    ) ||
    [
      member
        ?.first_name,

      member
        ?.last_name,
    ]
      .map(
        normalizeString
      )
      .filter(Boolean)
      .join(" ");

  const source =
    normalizeString(
      transaction
        ?.source ||
      transaction
        ?.description
    );

  let memo =
    DEFAULT_MEMO_PREFIX;

  if (memberName) {
    memo +=
      ` - ${memberName}`;
  }

  if (source) {
    memo +=
      ` - ${source}`;
  }

  return memo.slice(
    0,
    300
  );
}

/* ==========================================================================
   CREATE LITHIC BOOK TRANSFER
============================================================================ */

async function createLithicBookTransfer({
  fromFinancialAccountToken,
  toFinancialAccountToken,
  amountCents,
  category,
  subtype,
  memo,
  idempotencyKey,
}) {
  const payload = {
    amount:
      amountCents,

    from_financial_account_token:
      fromFinancialAccountToken,

    to_financial_account_token:
      toFinancialAccountToken,

    category,

    subtype,

    memo,
  };

  return lithicRequest(
    "/book_transfers",
    {
      method:
        "POST",

      headers: {
        "Idempotency-Key":
          idempotencyKey,
      },

      body:
        payload,
    }
  );
}

/* ==========================================================================
   PARSE TRANSFER
============================================================================ */

function parseBookTransfer(
  result
) {
  const data =
    unwrapLithicObject(
      result
    );

  return {
    token:
      normalizeString(
        data.token
      ) ||
      null,

    status:
      normalizeString(
        data.status
      ).toUpperCase() ||
      null,

    result:
      normalizeString(
        data.result
      ).toUpperCase() ||
      null,

    category:
      normalizeString(
        data.category
      ) ||
      null,

    subtype:
      normalizeString(
        data.subtype
      ) ||
      null,

    createdAt:
      safeDate(
        data.created
      ),

    updatedAt:
      safeDate(
        data.updated
      ),
  };
}

/* ==========================================================================
   FINANCIAL ACCOUNT BALANCE
============================================================================ */

async function getFinancialAccountBalance(
  financialAccountToken
) {
  const token =
    normalizeString(
      financialAccountToken
    );

  if (!token) {
    return null;
  }

  const result =
    await lithicRequest(
      `/financial_accounts/${encodeURIComponent(
        token
      )}/balances`,
      {
        method:
          "GET",
      }
    );

  const data =
    unwrapLithicObject(
      result
    );

  const availableCents =
    Number(
      data.available_amount ??
      data.available_balance ??
      0
    );

  const pendingCents =
    Number(
      data.pending_amount ??
      data.pending_balance ??
      0
    );

  const totalCents =
    Number(
      data.total_amount ??
      data.total_balance ??
      (
        Number.isFinite(
          availableCents
        )
          ? availableCents
          : 0
      ) +
      (
        Number.isFinite(
          pendingCents
        )
          ? pendingCents
          : 0
      )
    );

  const safeAvailable =
    Number.isFinite(
      availableCents
    )
      ? availableCents
      : 0;

  const safePending =
    Number.isFinite(
      pendingCents
    )
      ? pendingCents
      : 0;

  const safeTotal =
    Number.isFinite(
      totalCents
    )
      ? totalCents
      : 0;

  return {
    availableCents:
      safeAvailable,

    available:
      centsToDollars(
        safeAvailable
      ),

    pendingCents:
      safePending,

    pending:
      centsToDollars(
        safePending
      ),

    totalCents:
      safeTotal,

    total:
      centsToDollars(
        safeTotal
      ),

    currency:
      normalizeString(
        data.currency
      ) ||
      DEFAULT_CURRENCY,

    updatedAt:
      safeDate(
        data.updated ||
        data.updated_at ||
        data.created
      ),
  };
}

/* ==========================================================================
   SAFE ALLOWANCE RESPONSE
============================================================================ */

function sanitizeAllowanceTransaction(
  transaction
) {
  if (!transaction) {
    return null;
  }

  const amountCents =
    getAllowanceAmountCents(
      transaction
    );

  return {
    id:
      transaction.id ||
      null,

    memberId:
      transaction
        .member_id ||
      null,

    amountCents,

    amount:
      centsToDollars(
        amountCents
      ),

    currency:
      normalizeString(
        transaction.currency
      ) ||
      DEFAULT_CURRENCY,

    direction:
      normalizeStatus(
        transaction.direction ||
        transaction.type ||
        transaction
          .transaction_type ||
        "credit"
      ),

    status:
      normalizeStatus(
        transaction.status
      ),

    source:
      normalizeString(
        transaction.source
      ) ||
      null,

    sourceRewardId:
      transaction
        .source_reward_id ||
      transaction
        .reward_id ||
      null,

    description:
      normalizeString(
        transaction.description
      ) ||
      null,

    provider:
      normalizeString(
        transaction.provider
      ) ||
      null,

    providerStatus:
      normalizeString(
        transaction
          .provider_status
      ) ||
      null,

    fundedAt:
      safeDate(
        transaction
          .funded_at
      ),

    createdAt:
      safeDate(
        transaction
          .created_at
      ),

    updatedAt:
      safeDate(
        transaction
          .updated_at
      ),
  };
}

/* ==========================================================================
   IDEMPOTENT FUNDED CHECK
============================================================================ */

function isAlreadyFunded(
  transaction
) {
  const status =
    normalizeStatus(
      transaction
        ?.status
    );

  const providerToken =
    getExistingProviderTransactionToken(
      transaction
    );

  return (
    COMPLETED_ALLOWANCE_STATUSES.has(
      status
    ) ||
    Boolean(
      providerToken
    )
  );
}

/* ==========================================================================
   PROCESSING CHECK
============================================================================ */

function isAlreadyProcessing(
  transaction
) {
  return PROCESSING_ALLOWANCE_STATUSES.has(
    normalizeStatus(
      transaction
        ?.status
    )
  );
}

/* ==========================================================================
   ACCOUNT HOLDER READY
============================================================================ */

function getAccountHolderStatus(
  memberCard
) {
  return normalizeString(
    memberCard
      ?.lithic_account_holder_status
  ).toUpperCase();
}

function isAccountHolderAccepted(
  memberCard
) {
  return (
    getAccountHolderStatus(
      memberCard
    ) ===
    "ACCEPTED"
  );
}

/* ==========================================================================
   SAFE MEMBER
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
        "fund_allowance",
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
       AUTHENTICATE
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
       REQUEST BODY
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const allowanceTransactionId =
      normalizeString(
        body
          .allowanceTransactionId ||
        body
          .allowance_transaction_id ||
        body
          .transactionId ||
        body
          .transaction_id
      );

    if (
      !allowanceTransactionId
    ) {
      return badRequest(
        res,
        "An allowance transaction ID is required.",
        {
          code:
            "ALLOWANCE_TRANSACTION_ID_REQUIRED",

          expectedBody: {
            allowanceTransactionId:
              "approved-allowance-transaction-id",
          },
        }
      );
    }

    /*
     * SECURITY:
     *
     * Ignore all of the following even if the browser supplies them:
     *
     * body.amount
     * body.amount_cents
     * body.member_id
     * body.account_token
     * body.card_token
     * body.financial_account_token
     */

    /* ======================================================================
       MEMBER CARD
    ====================================================================== */

    const {
      record:
        memberCard,

      tableMissing:
        memberCardsMissing,
    } =
      await getMemberCardRecord(
        memberId
      );

    if (
      memberCardsMissing
    ) {
      return serviceUnavailable(
        res,
        "The Card Leo member_cards table has not been created yet.",
        {
          code:
            "MEMBER_CARDS_TABLE_MISSING",
        }
      );
    }

    if (
      !memberCard?.id
    ) {
      return conflict(
        res,
        "Your Card Leo card account has not been created yet.",
        {
          code:
            "MEMBER_CARD_ACCOUNT_REQUIRED",

          nextEndpoint:
            "/api/cards/create-cardholder",
        }
      );
    }

    /* ======================================================================
       ACCOUNT HOLDER
    ====================================================================== */

    const accountHolderToken =
      normalizeString(
        memberCard
          .lithic_account_holder_token
      );

    const accountToken =
      normalizeString(
        memberCard
          .lithic_account_token
      );

    const cardToken =
      normalizeString(
        memberCard
          .lithic_card_token
      );

    if (
      !accountHolderToken
    ) {
      return conflict(
        res,
        "A Lithic account holder must be created before allowance can be funded.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_REQUIRED",

          nextEndpoint:
            "/api/cards/create-cardholder",
        }
      );
    }

    if (
      !isAccountHolderAccepted(
        memberCard
      )
    ) {
      return conflict(
        res,
        "Your Lithic account holder must be accepted before allowance can be funded.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_NOT_ACCEPTED",

          accountHolderStatus:
            getAccountHolderStatus(
              memberCard
            ) ||
            "UNKNOWN",
        }
      );
    }

    if (
      !accountToken
    ) {
      return conflict(
        res,
        "The Lithic account token is missing.",
        {
          code:
            "LITHIC_ACCOUNT_TOKEN_REQUIRED",

          requiresReconciliation:
            true,
        }
      );
    }

    if (
      !cardToken
    ) {
      return conflict(
        res,
        "Your Card Leo virtual card must be created before allowance can be loaded.",
        {
          code:
            "LITHIC_CARD_REQUIRED",

          nextEndpoint:
            "/api/cards/create-virtual-card",
        }
      );
    }

    /* ======================================================================
       LOAD ALLOWANCE

       The .eq(member_id, authenticated member) check prevents a member
       from submitting another member's transaction ID.
    ====================================================================== */

    const {
      transaction:
        allowanceTransaction,

      tableMissing:
        allowanceTableMissing,
    } =
      await getAllowanceTransaction({
        allowanceTransactionId,

        memberId,
      });

    if (
      allowanceTableMissing
    ) {
      return serviceUnavailable(
        res,
        "The Card Leo allowance_transactions table has not been created yet.",
        {
          code:
            "ALLOWANCE_TRANSACTIONS_TABLE_MISSING",
        }
      );
    }

    if (
      !allowanceTransaction?.id
    ) {
      return notFound(
        res,
        "This approved allowance could not be found for your member account.",
        {
          code:
            "ALLOWANCE_NOT_FOUND",
        }
      );
    }

    /* ======================================================================
       ALREADY FUNDED
    ====================================================================== */

    if (
      isAlreadyFunded(
        allowanceTransaction
      )
    ) {
      return success(
        res,
        {
          authenticated:
            true,

          funded:
            true,

          processing:
            false,

          alreadyFunded:
            true,

          member:
            buildSafeMember(
              member
            ),

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),

          lithic:
            getLithicIntegrationStatus(),

          links: {
            card:
              "/portal/card.html",

            memberCard:
              "/api/cards/member-card",
          },
        },
        "This Card Leo allowance has already been funded."
      );
    }

    /* ======================================================================
       ALREADY PROCESSING

       Do not initiate another provider request.
    ====================================================================== */

    if (
      isAlreadyProcessing(
        allowanceTransaction
      )
    ) {
      return success(
        res,
        {
          authenticated:
            true,

          funded:
            false,

          processing:
            true,

          alreadyFunded:
            false,

          alreadyProcessing:
            true,

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),

          lithic:
            getLithicIntegrationStatus(),
        },
        "This Card Leo allowance is already processing."
      );
    }

    /* ======================================================================
       VALIDATE ALLOWANCE
    ====================================================================== */

    const allowanceValidation =
      validateAllowanceTransaction(
        allowanceTransaction
      );

    if (
      !allowanceValidation.valid
    ) {
      return conflict(
        res,
        "This allowance is not ready to be funded.",
        {
          code:
            "ALLOWANCE_NOT_READY",

          errors:
            allowanceValidation
              .errors,

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),
        }
      );
    }

    const amountCents =
      allowanceValidation
        .amountCents;

    /* ======================================================================
       LITHIC ENABLED
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return success(
        res,
        {
          authenticated:
            true,

          funded:
            false,

          processing:
            false,

          alreadyFunded:
            false,

          configurationRequired:
            true,

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),

          amount: {
            cents:
              amountCents,

            dollars:
              centsToDollars(
                amountCents
              ),

            currency:
              DEFAULT_CURRENCY,
          },

          lithic:
            getLithicIntegrationStatus(),
        },
        "The allowance is approved and ready, but Lithic funding is currently disabled."
      );
    }

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

    /* ======================================================================
       TRANSFER CONFIGURATION
    ====================================================================== */

    const transferConfig =
      validateBookTransferConfiguration();

    if (
      !transferConfig.valid
    ) {
      return serviceUnavailable(
        res,
        "Card Leo's Lithic allowance-transfer configuration is incomplete.",
        {
          code:
            "LITHIC_BOOK_TRANSFER_CONFIGURATION_REQUIRED",

          errors:
            transferConfig
              .errors,

          requirements: [
            "LITHIC_PROGRAM_ISSUING_FINANCIAL_ACCOUNT_TOKEN",
            "LITHIC_BOOK_TRANSFER_CATEGORY",
            "LITHIC_BOOK_TRANSFER_SUBTYPE",
          ],
        }
      );
    }

    /* ======================================================================
       DESTINATION FINANCIAL ACCOUNT

       Server resolves this from the authenticated member's Lithic account.
    ====================================================================== */

    let memberFinancialAccount;

    try {
      memberFinancialAccount =
        await getMemberIssuingFinancialAccount(
          accountToken
        );
    } catch (
      error
    ) {
      logRequestError(
        req,
        error,
        {
          scope:
            "fund_allowance_member_financial_account",

          memberId,

          allowanceTransactionId,
        }
      );

      return serviceUnavailable(
        res,
        "Card Leo could not locate your Lithic issuing financial account.",
        {
          code:
            "MEMBER_ISSUING_FINANCIAL_ACCOUNT_LOOKUP_FAILED",
        }
      );
    }

    if (
      !memberFinancialAccount?.token
    ) {
      return conflict(
        res,
        "Your Lithic account exists, but an issuing financial account is not available yet.",
        {
          code:
            "MEMBER_ISSUING_FINANCIAL_ACCOUNT_REQUIRED",

          requiresReconciliation:
            true,
        }
      );
    }

    const memberFinancialAccountToken =
      normalizeString(
        memberFinancialAccount
          .token
      );

    /* ======================================================================
       IDEMPOTENCY
    ====================================================================== */

    const idempotencyKey =
      buildAllowanceIdempotencyKey(
        allowanceTransaction
      );

    /* ======================================================================
       CLAIM ALLOWANCE

       We save/claim the idempotency key before calling Lithic.
    ====================================================================== */

    let processingTransaction;

    try {
      processingTransaction =
        await claimAllowanceForProcessing({
          transaction:
            allowanceTransaction,

          idempotencyKey,
        });
    } catch (
      error
    ) {
      logRequestError(
        req,
        error,
        {
          scope:
            "fund_allowance_claim_processing",

          memberId,

          allowanceTransactionId,
        }
      );

      return serverError(
        res,
        "Card Leo could not safely lock this allowance for processing.",
        {
          code:
            "ALLOWANCE_PROCESSING_LOCK_FAILED",
        }
      );
    }

    /*
     * Another request may have claimed it between our SELECT and UPDATE.
     */

    if (
      !processingTransaction
    ) {
      const {
        transaction:
          currentTransaction,
      } =
        await getAllowanceTransaction({
          allowanceTransactionId,

          memberId,
        });

      if (
        isAlreadyFunded(
          currentTransaction
        )
      ) {
        return success(
          res,
          {
            funded:
              true,

            processing:
              false,

            alreadyFunded:
              true,

            allowance:
              sanitizeAllowanceTransaction(
                currentTransaction
              ),
          },
          "This Card Leo allowance has already been funded."
        );
      }

      return success(
        res,
        {
          funded:
            false,

          processing:
            true,

          alreadyFunded:
            false,

          alreadyProcessing:
            true,

          allowance:
            sanitizeAllowanceTransaction(
              currentTransaction ||
              allowanceTransaction
            ),
        },
        "This Card Leo allowance is already being processed."
      );
    }

    /* ======================================================================
       TRANSFER
    ====================================================================== */

    const memo =
      buildTransferMemo({
        member,

        transaction:
          processingTransaction,
      });

    let transferResult;

    try {
      transferResult =
        await createLithicBookTransfer({
          fromFinancialAccountToken:
            transferConfig
              .sourceToken,

          toFinancialAccountToken:
            memberFinancialAccountToken,

          amountCents,

          category:
            transferConfig
              .category,

          subtype:
            transferConfig
              .subtype,

          memo,

          idempotencyKey,
        });
    } catch (
      lithicError
    ) {
      logRequestError(
        req,
        lithicError,
        {
          scope:
            "fund_allowance_lithic_transfer",

          memberId,

          allowanceTransactionId,

          amountCents,

          environment:
            getLithicEnvironment(),
        }
      );

      /*
       * IMPORTANT:
       *
       * We retain the same idempotency key.
       *
       * Do not create a different one on retry.
       */

      try {
        await updateAllowanceTransaction(
          allowanceTransaction.id,
          {
            status:
              "failed",

            provider:
              "lithic",

            provider_status:
              "failed",

            provider_error:
              lithicError
                ?.message ||
              "Lithic book transfer failed.",

            funding_failed_at:
              nowIso(),
          }
        );
      } catch (
        updateError
      ) {
        logRequestError(
          req,
          updateError,
          {
            scope:
              "fund_allowance_save_provider_failure",

            memberId,

            allowanceTransactionId,
          }
        );
      }

      const providerStatus =
        Number(
          lithicError
            ?.status
        ) ||
        502;

      return sendJson(
        res,
        providerStatus >= 400 &&
        providerStatus <= 599
          ? providerStatus
          : 502,
        {
          success:
            false,

          ok:
            false,

          authenticated:
            true,

          funded:
            false,

          processing:
            false,

          message:
            lithicError
              ?.message ||
            "Lithic could not fund the Card Leo allowance.",

          code:
            lithicError
              ?.code ||
            "LITHIC_BOOK_TRANSFER_FAILED",

          allowance: {
            id:
              allowanceTransaction.id,

            amountCents,

            amount:
              centsToDollars(
                amountCents
              ),

            currency:
              DEFAULT_CURRENCY,
          },

          requiresReview:
            true,
        }
      );
    }

    /* ======================================================================
       PARSE TRANSFER
    ====================================================================== */

    const transfer =
      parseBookTransfer(
        transferResult
      );

    if (
      !transfer.token
    ) {
      /*
       * Provider may have executed transfer.
       *
       * Do not automatically try again.
       */

      try {
        await updateAllowanceTransaction(
          allowanceTransaction.id,
          {
            status:
              "processing",

            provider:
              "lithic",

            provider_status:
              transfer.status ||
              transfer.result ||
              "unknown",

            provider_error:
              "Lithic response did not include a transfer token.",
          }
        );
      } catch (
        updateError
      ) {
        logRequestError(
          req,
          updateError,
          {
            scope:
              "fund_allowance_missing_transfer_token_save",

            memberId,

            allowanceTransactionId,
          }
        );
      }

      return serverError(
        res,
        "Lithic returned an unexpected transfer response. Do not retry automatically.",
        {
          code:
            "LITHIC_TRANSFER_TOKEN_MISSING",

          requiresReconciliation:
            true,

          allowanceTransactionId,
        }
      );
    }

    /* ======================================================================
       PROVIDER STATUS
    ====================================================================== */

    const providerState =
      transfer.result ||
      transfer.status ||
      "";

    const transferApproved =
      [
        "APPROVED",
        "COMPLETED",
        "COMPLETE",
        "SETTLED",
        "SUCCESS",
        "SUCCEEDED",
      ].includes(
        providerState
      );

    const transferRejected =
      [
        "DECLINED",
        "FAILED",
        "REJECTED",
        "CANCELLED",
        "CANCELED",
        "REVERSED",
      ].includes(
        providerState
      );

    const finalStatus =
      transferApproved
        ? "funded"
        : transferRejected
          ? "failed"
          : "processing";

    /* ======================================================================
       SAVE RESULT
    ====================================================================== */

    let finalTransaction;

    try {
      finalTransaction =
        await updateAllowanceTransaction(
          allowanceTransaction.id,
          {
            status:
              finalStatus,

            provider:
              "lithic",

            provider_status:
              providerState ||
              "processing",

            provider_transaction_token:
              transfer.token,

            lithic_transaction_token:
              transfer.token,

            external_reference:
              transfer.token,

            funded_at:
              transferApproved
                ? nowIso()
                : null,

            funding_failed_at:
              transferRejected
                ? nowIso()
                : null,

            provider_error:
              transferRejected
                ? "Lithic rejected the allowance transfer."
                : null,

            provider_response: {
              /*
               * Safe transfer metadata only.
               */

              token:
                transfer.token,

              result:
                transfer.result,

              status:
                transfer.status,

              category:
                transfer.category,

              subtype:
                transfer.subtype,

              created_at:
                transfer.createdAt,

              updated_at:
                transfer.updatedAt,
            },
          }
        );
    } catch (
      databaseError
    ) {
      logRequestError(
        req,
        databaseError,
        {
          scope:
            "fund_allowance_save_transfer",

          memberId,

          allowanceTransactionId,

          lithicTransferCreated:
            true,
        }
      );

      /*
       * A Lithic transfer now exists.
       *
       * Never automatically create another transfer.
       */

      return serverError(
        res,
        "Lithic processed the allowance transfer, but Card Leo could not save the final transaction state. Do not retry automatically.",
        {
          code:
            "LITHIC_TRANSFER_DATABASE_SAVE_FAILED",

          requiresReconciliation:
            true,

          allowanceTransactionId,

          providerTransactionRecorded:
            true,
        }
      );
    }

    /* ======================================================================
       BALANCE

       Failure here does not undo successful funding.
    ====================================================================== */

    let balance =
      null;

    try {
      balance =
        await getFinancialAccountBalance(
          memberFinancialAccountToken
        );
    } catch (
      balanceError
    ) {
      logRequestError(
        req,
        balanceError,
        {
          scope:
            "fund_allowance_balance_lookup",

          memberId,

          allowanceTransactionId,
        }
      );
    }

    /* ======================================================================
       LOG SUCCESS
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "fund_allowance",

        memberId,

        allowanceTransactionId,

        amountCents,

        amount:
          centsToDollars(
            amountCents
          ),

        provider:
          "lithic",

        providerStatus:
          providerState,

        funded:
          transferApproved,

        processing:
          !transferApproved &&
          !transferRejected,

        failed:
          transferRejected,

        environment:
          getLithicEnvironment(),
      }
    );

    /* ======================================================================
       SAFE RESPONSE

       DO NOT expose:
       - Lithic account token
       - Lithic card token
       - account holder token
       - financial account token
       - program source account
       - raw provider response
    ====================================================================== */

    return success(
      res,
      {
        authenticated:
          true,

        funded:
          transferApproved,

        processing:
          !transferApproved &&
          !transferRejected,

        failed:
          transferRejected,

        alreadyFunded:
          false,

        alreadyProcessing:
          false,

        member:
          buildSafeMember(
            member
          ),

        allowance:
          sanitizeAllowanceTransaction(
            finalTransaction
          ),

        amount: {
          cents:
            amountCents,

          dollars:
            centsToDollars(
              amountCents
            ),

          currency:
            DEFAULT_CURRENCY,
        },

        balance:
          balance
            ? {
                available:
                  balance.available,

                availableCents:
                  balance
                    .availableCents,

                pending:
                  balance.pending,

                pendingCents:
                  balance
                    .pendingCents,

                total:
                  balance.total,

                totalCents:
                  balance
                    .totalCents,

                currency:
                  balance.currency,

                updatedAt:
                  balance.updatedAt,
              }
            : null,

        lithic: {
          enabled:
            true,

          configured:
            true,

          environment:
            getLithicEnvironment(),

          transferCreated:
            true,

          transferStatus:
            providerState ||
            "PROCESSING",
        },

        links: {
          card:
            "/portal/card.html",

          memberCard:
            "/api/cards/member-card",
        },

        generatedAt:
          nowIso(),
      },
      transferApproved
        ? "Your Card Leo allowance was successfully added to your card account."
        : transferRejected
          ? "The Card Leo allowance transfer was not approved."
          : "Your Card Leo allowance transfer has been submitted and is processing."
    );
  } catch (
    error
  ) {
    /*
     * IMPORTANT:
     *
     * A provider/database error does NOT prove member authentication failed.
     *
     * Never clear auth cookies from this catch.
     */

    logRequestError(
      req,
      error,
      {
        scope:
          "fund_allowance_unexpected",
      }
    );

    console.error(
      "Card Leo fund-allowance error:",
      error
    );

    return serverError(
      res,
      "Unable to fund your Card Leo allowance right now.",
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