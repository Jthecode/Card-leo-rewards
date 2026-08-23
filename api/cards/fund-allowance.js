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
  setNoStore(
    res
  );

  logRequestStart(
    req,
    {
      scope:
        "fund_allowance",
    }
  );

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
       LITHIC CONFIG
    ====================================================================== */

    const integrationStatus =
      getLithicIntegrationStatus();

    if (
      !isLithicEnabled()
    ) {
      return serviceUnavailable(
        res,
        "Card Leo allowance card funding is not enabled yet.",
        {
          code:
            "LITHIC_DISABLED",

          lithic: {
            enabled:
              false,

            configured:
              isLithicConfigured(),

            environment:
              getLithicEnvironment(),

            integrationStatus,
          },
        }
      );
    }

    if (
      !isLithicConfigured()
    ) {
      return serviceUnavailable(
        res,
        "Card Leo allowance card funding is not fully configured yet.",
        {
          code:
            "LITHIC_NOT_CONFIGURED",

          lithic: {
            enabled:
              true,

            configured:
              false,

            environment:
              getLithicEnvironment(),

            integrationStatus,
          },
        }
      );
    }

    /* ======================================================================
       AUTHENTICATE MEMBER
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

    if (!memberId) {
      return forbidden(
        res,
        "Unable to identify your Card Leo member account.",
        {
          code:
            "MEMBER_ID_MISSING",
        }
      );
    }

    /* ======================================================================
       REQUEST BODY

       IMPORTANT:
       The browser is allowed to choose ONLY the allowance transaction ID.

       Amount, member, account and funding destination are resolved
       server-side.
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
        "allowanceTransactionId is required.",
        {
          code:
            "ALLOWANCE_TRANSACTION_ID_REQUIRED",
        }
      );
    }

    /* ======================================================================
       MEMBER CARD RECORD
    ====================================================================== */

    const {
      record:
        memberCard,

      tableMissing:
        memberCardsTableMissing,
    } =
      await getMemberCardRecord(
        memberId
      );

    if (
      memberCardsTableMissing
    ) {
      return serviceUnavailable(
        res,
        "Card Leo member card storage has not been configured yet.",
        {
          code:
            "MEMBER_CARDS_TABLE_MISSING",
        }
      );
    }

    if (!memberCard) {
      return forbidden(
        res,
        "Create your Card Leo allowance card before loading allowance.",
        {
          code:
            "MEMBER_CARD_NOT_CREATED",

          cardPage:
            "/portal/card.html",
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

    if (
      !accountHolderToken
    ) {
      return forbidden(
        res,
        "Your Card Leo account holder setup must be completed before allowance can be funded.",
        {
          code:
            "ACCOUNT_HOLDER_NOT_CREATED",

          cardPage:
            "/portal/card.html",
        }
      );
    }

    if (
      !isAccountHolderAccepted(
        memberCard
      )
    ) {
      return forbidden(
        res,
        "Your Card Leo account holder must be approved before allowance can be funded.",
        {
          code:
            "ACCOUNT_HOLDER_NOT_ACCEPTED",

          accountHolderStatus:
            getAccountHolderStatus(
              memberCard
            ) ||
            "UNKNOWN",

          cardPage:
            "/portal/card.html",
        }
      );
    }

    /* ======================================================================
       LITHIC ACCOUNT
    ====================================================================== */

    const accountToken =
      normalizeString(
        memberCard
          .lithic_account_token
      );

    if (!accountToken) {
      return forbidden(
        res,
        "Your Card Leo card account has not been created yet.",
        {
          code:
            "LITHIC_ACCOUNT_NOT_CREATED",

          cardPage:
            "/portal/card.html",
        }
      );
    }

    /* ======================================================================
       CARD
    ====================================================================== */

    const cardToken =
      normalizeString(
        memberCard
          .lithic_card_token
      );

    if (!cardToken) {
      return forbidden(
        res,
        "Your Card Leo allowance card has not been created yet.",
        {
          code:
            "CARD_NOT_CREATED",

          cardPage:
            "/portal/card.html",
        }
      );
    }

    const cardStatus =
      normalizeStatus(
        memberCard
          .card_status
      );

    if (
      [
        "closed",
        "terminated",
        "canceled",
        "cancelled",
      ].includes(
        cardStatus
      )
    ) {
      return forbidden(
        res,
        "Your Card Leo allowance card cannot receive allowance in its current status.",
        {
          code:
            "CARD_NOT_FUNDABLE",

          cardStatus:
            cardStatus ||
            "unknown",
        }
      );
    }

    /* ======================================================================
       LOAD ALLOWANCE TRANSACTION

       Ownership is enforced here using BOTH:

       transaction ID
       +
       authenticated member ID
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
        "Card Leo allowance storage has not been configured yet.",
        {
          code:
            "ALLOWANCE_TRANSACTIONS_TABLE_MISSING",
        }
      );
    }

    if (
      !allowanceTransaction
    ) {
      return notFound(
        res,
        "Allowance transaction was not found for this member.",
        {
          code:
            "ALLOWANCE_TRANSACTION_NOT_FOUND",
        }
      );
    }

    /* ======================================================================
       IDEMPOTENT COMPLETED RESPONSE

       If this exact allowance was already funded, do NOT send money again.
    ====================================================================== */

    if (
      isAlreadyFunded(
        allowanceTransaction
      )
    ) {
      const providerToken =
        getExistingProviderTransactionToken(
          allowanceTransaction
        );

      logRequestSuccess(
        req,
        {
          scope:
            "fund_allowance_already_funded",

          memberId,

          allowanceTransactionId,

          providerTransactionToken:
            providerToken ||
            null,
        }
      );

      return success(
        res,
        {
          authenticated:
            true,

          alreadyFunded:
            true,

          processing:
            false,

          member:
            buildSafeMember(
              member
            ),

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),

          provider: {
            name:
              "lithic",

            environment:
              getLithicEnvironment(),

            transactionToken:
              providerToken ||
              null,

            status:
              normalizeString(
                allowanceTransaction
                  .provider_status
              ) ||
              normalizeString(
                allowanceTransaction
                  .status
              ) ||
              "FUNDED",
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
        "This Card Leo allowance has already been funded."
      );
    }

    /* ======================================================================
       ALREADY PROCESSING

       Another request may have already claimed this transaction.
       Never submit another transfer while it is processing.
    ====================================================================== */

    if (
      isAlreadyProcessing(
        allowanceTransaction
      )
    ) {
      return conflict(
        res,
        "This Card Leo allowance is already being processed.",
        {
          code:
            "ALLOWANCE_ALREADY_PROCESSING",

          authenticated:
            true,

          processing:
            true,

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),
        }
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
      if (
        allowanceValidation
          .errors
          .completed
      ) {
        return conflict(
          res,
          allowanceValidation
            .errors
            .completed,
          {
            code:
              "ALLOWANCE_ALREADY_FUNDED",

            errors:
              allowanceValidation
                .errors,
          }
        );
      }

      if (
        allowanceValidation
          .errors
          .processing
      ) {
        return conflict(
          res,
          allowanceValidation
            .errors
            .processing,
          {
            code:
              "ALLOWANCE_ALREADY_PROCESSING",

            errors:
              allowanceValidation
                .errors,
          }
        );
      }

      return badRequest(
        res,
        "This allowance transaction is not eligible for funding.",
        {
          code:
            "ALLOWANCE_NOT_ELIGIBLE",

          errors:
            allowanceValidation
              .errors,
        }
      );
    }

    const amountCents =
      allowanceValidation
        .amountCents;

    /* ======================================================================
       IDEMPOTENCY
    ====================================================================== */

    const idempotencyKey =
      buildAllowanceIdempotencyKey(
        allowanceTransaction
      );

    /* ======================================================================
       BOOK TRANSFER CONFIGURATION
    ====================================================================== */

    const transferConfig =
      validateBookTransferConfiguration();

    if (
      !transferConfig.valid
    ) {
      return serviceUnavailable(
        res,
        "Card Leo allowance transfer configuration is incomplete.",
        {
          code:
            "BOOK_TRANSFER_NOT_CONFIGURED",

          configuration:
            process.env.NODE_ENV ===
              "development"
              ? transferConfig.errors
              : undefined,
        }
      );
    }

    /* ======================================================================
       MEMBER DESTINATION FINANCIAL ACCOUNT
    ====================================================================== */

    let destinationFinancialAccount;

    try {
      destinationFinancialAccount =
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
            "fund_allowance_destination_account",

          memberId,

          allowanceTransactionId,
        }
      );

      return serviceUnavailable(
        res,
        "Unable to verify your Card Leo issuing account right now.",
        {
          code:
            "DESTINATION_ACCOUNT_LOOKUP_FAILED",
        }
      );
    }

    if (
      !destinationFinancialAccount
    ) {
      return forbidden(
        res,
        "Your Card Leo issuing financial account is not available yet.",
        {
          code:
            "ISSUING_FINANCIAL_ACCOUNT_NOT_FOUND",

          cardPage:
            "/portal/card.html",
        }
      );
    }

    const destinationFinancialAccountToken =
      normalizeString(
        destinationFinancialAccount
          .token
      );

    if (
      !destinationFinancialAccountToken
    ) {
      return serviceUnavailable(
        res,
        "Your Card Leo issuing account could not be resolved.",
        {
          code:
            "ISSUING_FINANCIAL_ACCOUNT_TOKEN_MISSING",
        }
      );
    }

    /* ======================================================================
       SOURCE FINANCIAL ACCOUNT

       This value comes ONLY from Card Leo's server environment.
    ====================================================================== */

    const sourceFinancialAccountToken =
      transferConfig
        .sourceToken;

    if (
      sourceFinancialAccountToken ===
      destinationFinancialAccountToken
    ) {
      return serviceUnavailable(
        res,
        "Card Leo allowance transfer accounts are not configured correctly.",
        {
          code:
            "SOURCE_DESTINATION_ACCOUNT_MATCH",
        }
      );
    }

    /* ======================================================================
       CLAIM ALLOWANCE

       The transaction must be successfully changed from a READY state to
       PROCESSING before any provider transfer is submitted.
    ====================================================================== */

    let claimedAllowance;

    try {
      claimedAllowance =
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
            "fund_allowance_claim",

          memberId,

          allowanceTransactionId,
        }
      );

      throw error;
    }

    if (
      !claimedAllowance
    ) {
      /*
       * Another request may have updated the row after we originally read it.
       * Re-read the transaction before deciding what happened.
       */

      const {
        transaction:
          latestAllowance,
      } =
        await getAllowanceTransaction({
          allowanceTransactionId,
          memberId,
        });

      if (
        latestAllowance &&
        isAlreadyFunded(
          latestAllowance
        )
      ) {
        return success(
          res,
          {
            authenticated:
              true,

            alreadyFunded:
              true,

            processing:
              false,

            member:
              buildSafeMember(
                member
              ),

            allowance:
              sanitizeAllowanceTransaction(
                latestAllowance
              ),

            provider: {
              name:
                "lithic",

              environment:
                getLithicEnvironment(),

              transactionToken:
                getExistingProviderTransactionToken(
                  latestAllowance
                ) ||
                null,

              status:
                normalizeString(
                  latestAllowance
                    .provider_status
                ) ||
                "FUNDED",
            },

            generatedAt:
              nowIso(),
          },
          "This Card Leo allowance has already been funded."
        );
      }

      if (
        latestAllowance &&
        isAlreadyProcessing(
          latestAllowance
        )
      ) {
        return conflict(
          res,
          "This Card Leo allowance is already being processed.",
          {
            code:
              "ALLOWANCE_ALREADY_PROCESSING",

            authenticated:
              true,

            processing:
              true,

            allowance:
              sanitizeAllowanceTransaction(
                latestAllowance
              ),
          }
        );
      }

      return conflict(
        res,
        "This Card Leo allowance could not be claimed for funding. Refresh your rewards and try again.",
        {
          code:
            "ALLOWANCE_CLAIM_FAILED",
        }
      );
    }

    /* ======================================================================
       BUILD TRANSFER
    ====================================================================== */

    const memo =
      buildTransferMemo({
        member,
        transaction:
          claimedAllowance,
      });

    let transferResult;

    try {
      transferResult =
        await createLithicBookTransfer({
          fromFinancialAccountToken:
            sourceFinancialAccountToken,

          toFinancialAccountToken:
            destinationFinancialAccountToken,

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
      error
    ) {
      /*
       * The provider call failed.
       *
       * Mark the allowance failed so it does not remain permanently
       * stuck in PROCESSING.
       */

      try {
        await updateAllowanceTransaction(
          allowanceTransactionId,
          {
            status:
              "failed",

            provider:
              "lithic",

            provider_status:
              "request_failed",

            funding_failed_at:
              nowIso(),

            funding_error:
              normalizeString(
                error?.message
              ) ||
              "Lithic transfer request failed.",
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
              "fund_allowance_failure_update",

            memberId,

            allowanceTransactionId,
          }
        );
      }

      logRequestError(
        req,
        error,
        {
          scope:
            "fund_allowance_provider_transfer",

          memberId,

          allowanceTransactionId,
        }
      );

      return serviceUnavailable(
        res,
        "Card Leo could not submit your allowance transfer right now.",
        {
          code:
            "ALLOWANCE_TRANSFER_FAILED",
        }
      );
    }

    /* ======================================================================
       PARSE PROVIDER RESPONSE
    ====================================================================== */

    const transfer =
      parseBookTransfer(
        transferResult
      );

    const providerTransactionToken =
      normalizeString(
        transfer.token
      );

    const providerStatus =
      normalizeString(
        transfer.status
      ).toUpperCase();

    const providerResult =
      normalizeString(
        transfer.result
      ).toUpperCase();

    /*
     * A successful API call must still return a provider transaction token.
     */

    if (
      !providerTransactionToken
    ) {
      try {
        await updateAllowanceTransaction(
          allowanceTransactionId,
          {
            status:
              "failed",

            provider:
              "lithic",

            provider_status:
              providerStatus ||
              "missing_transaction_token",

            funding_failed_at:
              nowIso(),

            funding_error:
              "Lithic transfer response did not include a transaction token.",
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
              "fund_allowance_missing_token_update",

            memberId,

            allowanceTransactionId,
          }
        );
      }

      return serviceUnavailable(
        res,
        "Card Leo could not confirm the allowance transfer.",
        {
          code:
            "TRANSFER_TOKEN_MISSING",
        }
      );
    }

    /* ======================================================================
       CLASSIFY PROVIDER RESULT
    ====================================================================== */

    const approvedProviderStatuses =
      new Set([
        "APPROVED",
        "COMPLETED",
        "COMPLETE",
        "SETTLED",
        "SUCCEEDED",
        "SUCCESS",
      ]);

    const processingProviderStatuses =
      new Set([
        "PENDING",
        "PROCESSING",
        "SUBMITTED",
        "OPEN",
        "CREATED",
      ]);

    const rejectedProviderStatuses =
      new Set([
        "DECLINED",
        "REJECTED",
        "FAILED",
        "CANCELED",
        "CANCELLED",
        "REVERSED",
      ]);

    const providerState =
      providerResult ||
      providerStatus;

    const transferApproved =
      approvedProviderStatuses.has(
        providerResult
      ) ||
      approvedProviderStatuses.has(
        providerStatus
      );

    const transferRejected =
      rejectedProviderStatuses.has(
        providerResult
      ) ||
      rejectedProviderStatuses.has(
        providerStatus
      );

    const transferProcessing =
      !transferApproved &&
      !transferRejected &&
      (
        processingProviderStatuses.has(
          providerResult
        ) ||
        processingProviderStatuses.has(
          providerStatus
        ) ||
        Boolean(
          providerTransactionToken
        )
      );

    /* ======================================================================
       DATABASE STATUS
    ====================================================================== */

    let nextAllowanceStatus =
      "processing";

    let nextProviderStatus =
      providerState ||
      "PROCESSING";

    if (
      transferApproved
    ) {
      nextAllowanceStatus =
        "funded";

      nextProviderStatus =
        providerState ||
        "APPROVED";
    } else if (
      transferRejected
    ) {
      nextAllowanceStatus =
        "failed";

      nextProviderStatus =
        providerState ||
        "FAILED";
    } else if (
      transferProcessing
    ) {
      nextAllowanceStatus =
        "processing";

      nextProviderStatus =
        providerState ||
        "PROCESSING";
    }

    /* ======================================================================
       SAVE PROVIDER RESULT
    ====================================================================== */

    const updatePayload = {
      status:
        nextAllowanceStatus,

      provider:
        "lithic",

      provider_status:
        nextProviderStatus,

      provider_transaction_token:
        providerTransactionToken,

      lithic_transaction_token:
        providerTransactionToken,

      external_reference:
        providerTransactionToken,

      idempotency_key:
        idempotencyKey,

      provider_category:
        transfer.category ||
        transferConfig.category,

      provider_subtype:
        transfer.subtype ||
        transferConfig.subtype,

      provider_created_at:
        transfer.createdAt,

      provider_updated_at:
        transfer.updatedAt,
    };

    if (
      transferApproved
    ) {
      updatePayload.funded_at =
        nowIso();

      updatePayload.funding_completed_at =
        nowIso();

      updatePayload.funding_failed_at =
        null;

      updatePayload.funding_error =
        null;
    }

    if (
      transferRejected
    ) {
      updatePayload.funding_failed_at =
        nowIso();

      updatePayload.funding_error =
        `Lithic transfer returned ${nextProviderStatus}.`;
    }

    let updatedAllowance;

    try {
      updatedAllowance =
        await updateAllowanceTransaction(
          allowanceTransactionId,
          updatePayload
        );
    } catch (
      error
    ) {
      /*
       * IMPORTANT:
       *
       * The provider transfer already exists at this point.
       *
       * DO NOT retry the transfer here.
       *
       * The deterministic idempotency key protects against a future
       * duplicate provider transfer, but this database error must still
       * be surfaced for reconciliation.
       */

      logRequestError(
        req,
        error,
        {
          scope:
            "fund_allowance_provider_saved_db_failed",

          memberId,

          allowanceTransactionId,

          providerTransactionToken,
        }
      );

      return serverError(
        res,
        "Your allowance transfer was submitted, but Card Leo could not finish saving the transfer status. Please contact support before trying again.",
        {
          code:
            "TRANSFER_CREATED_DATABASE_UPDATE_FAILED",

          transferSubmitted:
            true,

          providerTransactionToken,

          providerStatus:
            nextProviderStatus,
        }
      );
    }
        /* ======================================================================
       UPDATED BALANCE
    ====================================================================== */

    let balance =
      null;

    /*
     * Balance lookup is best effort.
     *
     * A balance-read failure must NOT turn a successfully submitted
     * allowance transfer into a failed transfer.
     */

    try {
      balance =
        await getFinancialAccountBalance(
          destinationFinancialAccountToken
        );
    } catch (
      balanceError
    ) {
      logRequestError(
        req,
        balanceError,
        {
          scope:
            "fund_allowance_balance_refresh",

          memberId,

          allowanceTransactionId,

          providerTransactionToken,
        }
      );

      balance =
        null;
    }

    /* ======================================================================
       PROVIDER REJECTED
    ====================================================================== */

    if (
      transferRejected
    ) {
      logRequestError(
        req,
        new Error(
          `Lithic allowance transfer returned ${nextProviderStatus}.`
        ),
        {
          scope:
            "fund_allowance_provider_rejected",

          memberId,

          allowanceTransactionId,

          providerTransactionToken,

          providerStatus:
            nextProviderStatus,
        }
      );

      return conflict(
        res,
        "Card Leo could not fund this allowance because the card provider rejected the transfer.",
        {
          code:
            "ALLOWANCE_TRANSFER_REJECTED",

          authenticated:
            true,

          funded:
            false,

          processing:
            false,

          member:
            buildSafeMember(
              member
            ),

          allowance:
            sanitizeAllowanceTransaction(
              updatedAllowance
            ),

          provider: {
            name:
              "lithic",

            environment:
              getLithicEnvironment(),

            transactionToken:
              providerTransactionToken,

            status:
              nextProviderStatus,

            result:
              providerResult ||
              null,
          },

          balance,

          links: {
            card:
              "/portal/card.html",

            memberCard:
              "/api/cards/member-card",
          },

          generatedAt:
            nowIso(),
        }
      );
    }

    /* ======================================================================
       PROVIDER PROCESSING
    ====================================================================== */

    if (
      transferProcessing
    ) {
      logRequestSuccess(
        req,
        {
          scope:
            "fund_allowance_processing",

          memberId,

          allowanceTransactionId,

          providerTransactionToken,

          providerStatus:
            nextProviderStatus,

          amountCents,
        }
      );

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

          member:
            buildSafeMember(
              member
            ),

          allowance:
            sanitizeAllowanceTransaction(
              updatedAllowance
            ),

          transfer: {
            amountCents,

            amount:
              centsToDollars(
                amountCents
              ),

            currency:
              normalizeString(
                allowanceTransaction
                  .currency
              ) ||
              DEFAULT_CURRENCY,

            memo,
          },

          provider: {
            name:
              "lithic",

            environment:
              getLithicEnvironment(),

            transactionToken:
              providerTransactionToken,

            status:
              nextProviderStatus,

            result:
              providerResult ||
              null,
          },

          balance,

          links: {
            card:
              "/portal/card.html",

            memberCard:
              "/api/cards/member-card",
          },

          generatedAt:
            nowIso(),
        },
        "Your Card Leo allowance transfer has been submitted and is processing."
      );
    }

    /* ======================================================================
       PROVIDER APPROVED
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "fund_allowance_success",

        memberId,

        allowanceTransactionId,

        providerTransactionToken,

        providerStatus:
          nextProviderStatus,

        amountCents,
      }
    );

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
          false,

        member:
          buildSafeMember(
            member
          ),

        allowance:
          sanitizeAllowanceTransaction(
            updatedAllowance
          ),

        transfer: {
          amountCents,

          amount:
            centsToDollars(
              amountCents
            ),

          currency:
            normalizeString(
              allowanceTransaction
                .currency
            ) ||
            DEFAULT_CURRENCY,

          memo,
        },

        provider: {
          name:
            "lithic",

          environment:
            getLithicEnvironment(),

          transactionToken:
            providerTransactionToken,

          status:
            nextProviderStatus,

          result:
            providerResult ||
            null,
        },

        balance,

        links: {
          card:
            "/portal/card.html",

          memberCard:
            "/api/cards/member-card",
        },

        generatedAt:
          nowIso(),
      },
      "Your Card Leo allowance has been funded successfully."
    );
  } catch (
    error
  ) {
    /* ======================================================================
       UNEXPECTED ERROR
    ====================================================================== */

    logRequestError(
      req,
      error,
      {
        scope:
          "fund_allowance",
      }
    );

    const debug =
      process.env.NODE_ENV ===
        "development"
        ? {
            message:
              normalizeString(
                error?.message
              ) ||
              "Unknown error",

            stack:
              normalizeString(
                error?.stack
              ) ||
              null,

            lithic:
              typeof getLithicConfigForDebug ===
                "function"
                ? getLithicConfigForDebug()
                : null,
          }
        : undefined;

    return serverError(
      res,
      "Card Leo could not process your allowance funding request.",
      {
        code:
          "FUND_ALLOWANCE_FAILED",

        debug,
      }
    );
  }
}