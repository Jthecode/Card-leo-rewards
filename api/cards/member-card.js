// api/cards/member-card.js

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  lithicRequest,
  getLithicCard,
  getLithicAccount,
  isLithicEnabled,
  isLithicConfigured,
  getLithicEnvironment,
  getLithicIntegrationStatus,
  getLithicConfigForDebug,
  getMemberId,
  normalizeString,
  sanitizeLithicCard,
  sanitizeLithicTransaction,
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
   MEMBER CARD ENDPOINT

   ROUTE
   -----
   GET /api/cards/member-card

   PURPOSE
   -------
   Returns the authenticated Card Leo member's SAFE card state.

   MAY RETURN
   ----------
   - card status
   - card type
   - last four
   - masked card number
   - account-holder readiness
   - account readiness
   - virtual-card readiness
   - live/provider balance
   - Card Leo allowance ledger
   - recent transactions
   - provider health/readiness

   NEVER RETURN
   ------------
   - PAN
   - CVV
   - complete Lithic card token
   - complete Lithic account token
   - complete account-holder token
   - raw provider responses
   - API keys
   - routing/account numbers

   AUTH RULE
   ---------
   Card/provider failures must never be treated as member logout.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

const ALLOWANCE_TRANSACTIONS_TABLE =
  "allowance_transactions";

const DEFAULT_TRANSACTION_LIMIT =
  20;

const MAX_TRANSACTION_LIMIT =
  50;

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
   STATUS RULES
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
   RESPONSES
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
    "Card information loaded successfully."
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

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    Math.max(
      value,
      minimum
    ),
    maximum
  );
}

function cents(
  value
) {
  const amount =
    Number(
      value ??
      0
    );

  return Number.isFinite(
    amount
  )
    ? Math.round(
        amount
      )
    : 0;
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

function emptyBalance() {
  return {
    source:
      "none",

    live:
      false,

    availableCents:
      0,

    available:
      0,

    pendingCents:
      0,

    pending:
      0,

    currency:
      "USD",
  };
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

   Supports:
   - direct JSON
   - Base64URL JSON

   This matches the session created by api/auth/login.js.
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

  /*
   * Same compatibility behavior as /api/auth/me:
   *
   * Missing expiration does not automatically invalidate
   * a compatible Card Leo session.
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
     * Older schema fallback can still resolve member by ID/email.
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

  if (
    !session?.data
  ) {
    return {
      member:
        null,

      response:
        unauthorized(
          res,
          "Please sign in to view your Card Leo card."
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
   * CRITICAL FIX:
   *
   * Do NOT require:
   *
   * session.data.authenticated === true
   *
   * Valid Card Leo sessions may identify the member through:
   * - member ID
   * - signup ID
   * - portal user ID
   * - email
   * - session token
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
          "Member information is missing from your session."
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
   * Database failure is not authentication failure.
   *
   * Do NOT clear cookies here.
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
          "Your Card Leo account is currently restricted.",
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
          "Your membership payment must be current to access your Card Leo card.",
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
          "Your Card Leo membership is not currently active.",
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

    membership: {
      status:
        member.status ||
        null,

      paymentStatus:
        member
          .payment_status ||
        null,

      membershipStatus:
        member
          .membership_status ||
        null,

      approvalStatus:
        member
          .approval_status ||
        null,

      paid:
        isMemberPaid(
          member
        ),

      active:
        isMemberActive(
          member
        ),
    },
  };
}

/* ==========================================================================
   MEMBER CARD DATABASE RECORD
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
   SAFE MEMBER CARD DB RECORD
============================================================================ */

function sanitizeMemberCardRecord(
  record = {}
) {
  const lastFour =
    normalizeString(
      record.last_four
    );

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

    cardCreated:
      Boolean(
        record
          .lithic_card_token
      ),

    accountHolderStatus:
      record
        .lithic_account_holder_status ||
      null,

    cardType:
      record.card_type ||
      null,

    cardStatus:
      record.card_status ||
      "NOT_CREATED",

    lastFour:
      lastFour ||
      null,

    maskedNumber:
      lastFour
        ? `•••• •••• •••• ${lastFour}`
        : null,

    memo:
      record.card_memo ||
      null,

    spendLimitCents:
      record
        .spend_limit_cents ??
      null,

    spendLimit:
      record
        .spend_limit_cents !=
      null
        ? centsToDollars(
            record
              .spend_limit_cents
          )
        : null,

    spendLimitDuration:
      record
        .spend_limit_duration ||
      null,

    createdAt:
      safeDate(
        record.created_at
      ),

    updatedAt:
      safeDate(
        record.updated_at
      ),

    lithicCardCreatedAt:
      safeDate(
        record
          .lithic_card_created_at
      ),
  };
}

/* ==========================================================================
   LOCAL ALLOWANCE LEDGER
============================================================================ */

async function getAllowanceLedger(
  memberId
) {
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
        "member_id",
        memberId
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        }
      )
      .limit(
        100
      );

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        available:
          false,

        transactions:
          [],

        creditedCents:
          0,

        debitedCents:
          0,

        pendingCents:
          0,

        failedCents:
          0,

        netCents:
          0,
      };
    }

    throw error;
  }

  const rows =
    data ||
    [];

  let creditedCents =
    0;

  let debitedCents =
    0;

  let pendingCents =
    0;

  let failedCents =
    0;

  for (
    const row
    of rows
  ) {
    const amount =
      Math.abs(
        cents(
          row.amount_cents ??
            row.amount ??
            0
        )
      );

    const status =
      normalizeStatus(
        row.status
      );

    const direction =
      normalizeStatus(
        row.direction ||
          row.type ||
          row.transaction_type ||
          "credit"
      );

    if (
      [
        "pending",
        "processing",
      ].includes(
        status
      )
    ) {
      pendingCents +=
        amount;

      continue;
    }

    if (
      [
        "failed",
        "declined",
        "cancelled",
        "canceled",
        "reversed",
      ].includes(
        status
      )
    ) {
      failedCents +=
        amount;

      continue;
    }

    const completed =
      !status ||
      [
        "completed",
        "complete",
        "succeeded",
        "settled",
        "posted",
        "approved",
      ].includes(
        status
      );

    if (!completed) {
      continue;
    }

    if (
      [
        "debit",
        "withdrawal",
        "spend",
        "purchase",
        "out",
      ].includes(
        direction
      )
    ) {
      debitedCents +=
        amount;
    } else {
      creditedCents +=
        amount;
    }
  }

  return {
    available:
      true,

    transactions:
      rows,

    creditedCents,

    debitedCents,

    pendingCents,

    failedCents,

    netCents:
      creditedCents -
      debitedCents,
  };
}

/* ==========================================================================
   SAFE ALLOWANCE TRANSACTION
============================================================================ */

function sanitizeAllowanceTransaction(
  row
) {
  const amountCents =
    cents(
      row.amount_cents ??
        row.amount ??
        0
    );

  return {
    id:
      row.id ||
      null,

    direction:
      normalizeStatus(
        row.direction ||
          row.type ||
          row.transaction_type ||
          "credit"
      ),

    amountCents,

    amount:
      centsToDollars(
        amountCents
      ),

    status:
      normalizeStatus(
        row.status ||
          "pending"
      ),

    source:
      normalizeString(
        row.source
      ) ||
      null,

    sourceRewardId:
      row.source_reward_id ||
      row.reward_id ||
      null,

    externalReference:
      normalizeString(
        row.external_reference ||
          row.external_id
      ) ||
      null,

    description:
      normalizeString(
        row.description
      ) ||
      null,

    createdAt:
      safeDate(
        row.created_at
      ),

    updatedAt:
      safeDate(
        row.updated_at
      ),
  };
}

/* ==========================================================================
   LITHIC RESPONSE HELPERS
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

function unwrapLithicList(
  result
) {
  const data =
    result?.data;

  if (
    Array.isArray(
      data
    )
  ) {
    return data;
  }

  if (
    Array.isArray(
      data?.data
    )
  ) {
    return data.data;
  }

  if (
    Array.isArray(
      data?.items
    )
  ) {
    return data.items;
  }

  return [];
}

/* ==========================================================================
   LIVE LITHIC CARD
============================================================================ */

async function getLiveLithicCard(
  cardToken
) {
  if (!cardToken) {
    return null;
  }

  const result =
    await getLithicCard(
      cardToken
    );

  return sanitizeLithicCard(
    unwrapLithicData(
      result
    )
  );
}

/* ==========================================================================
   LIVE LITHIC ACCOUNT
============================================================================ */

async function getLiveLithicAccount(
  accountToken
) {
  if (!accountToken) {
    return null;
  }

  const result =
    await getLithicAccount(
      accountToken
    );

  const account =
    unwrapLithicData(
      result
    );

  /*
   * Deliberately omit account token from member response.
   */

  return {
    state:
      normalizeString(
        account.state
      ) ||
      null,

    spendLimit:
      account
        .spend_limit ??
      null,

    spendLimitDuration:
      account
        .spend_limit_duration ??
      null,

    created:
      safeDate(
        account.created
      ),
  };
}

/* ==========================================================================
   CARD BALANCE
============================================================================ */

async function getLithicCardBalance(
  cardToken
) {
  if (!cardToken) {
    return null;
  }

  const result =
    await lithicRequest(
      `/cards/${encodeURIComponent(
        cardToken
      )}/balances`,
      {
        method:
          "GET",
      }
    );

  const raw =
    unwrapLithicData(
      result
    );

  const availableCents =
    cents(
      raw.available_amount ??
        raw.available_balance ??
        raw.available ??
        raw.balance ??
        0
    );

  const pendingCents =
    cents(
      raw.pending_amount ??
        raw.pending_balance ??
        raw.pending ??
        0
    );

  const settledCents =
    cents(
      raw.settled_amount ??
        raw.settled_balance ??
        raw.settled ??
        0
    );

  return {
    availableCents,

    available:
      centsToDollars(
        availableCents
      ),

    pendingCents,

    pending:
      centsToDollars(
        pendingCents
      ),

    settledCents,

    settled:
      centsToDollars(
        settledCents
      ),

    currency:
      normalizeString(
        raw.currency
      ) ||
      "USD",

    updatedAt:
      safeDate(
        raw.updated_at ||
          raw.updated ||
          raw.created
      ),

    availableFromProvider:
      true,
  };
}

/* ==========================================================================
   ACCOUNT BALANCES
============================================================================ */

async function getLithicAccountBalances(
  accountToken
) {
  if (!accountToken) {
    return [];
  }

  const result =
    await lithicRequest(
      `/balances?account_token=${encodeURIComponent(
        accountToken
      )}`,
      {
        method:
          "GET",
      }
    );

  return unwrapLithicList(
    result
  ).map(
    (row) => {
      const availableCents =
        cents(
          row.available_amount ??
            row.available_balance ??
            row.available ??
            row.balance ??
            0
        );

      const pendingCents =
        cents(
          row.pending_amount ??
            row.pending_balance ??
            row.pending ??
            0
        );

      return {
        type:
          normalizeString(
            row.type ||
              row.financial_account_type
          ) ||
          null,

        availableCents,

        available:
          centsToDollars(
            availableCents
          ),

        pendingCents,

        pending:
          centsToDollars(
            pendingCents
          ),

        currency:
          normalizeString(
            row.currency
          ) ||
          "USD",

        updatedAt:
          safeDate(
            row.updated_at ||
              row.updated ||
              row.created
          ),
      };
    }
  );
}

/* ==========================================================================
   SAFE MERCHANT
============================================================================ */

function sanitizeMerchant(
  merchant
) {
  if (
    !merchant ||
    typeof merchant !==
      "object"
  ) {
    return null;
  }

  return {
    descriptor:
      normalizeString(
        merchant.descriptor
      ) ||
      null,

    city:
      normalizeString(
        merchant.city
      ) ||
      null,

    state:
      normalizeString(
        merchant.state
      ) ||
      null,

    country:
      normalizeString(
        merchant.country
      ) ||
      null,

    category:
      normalizeString(
        merchant.mcc
      ) ||
      normalizeString(
        merchant.category
      ) ||
      null,
  };
}

/* ==========================================================================
   LITHIC TRANSACTIONS
============================================================================ */

async function getLithicTransactions({
  cardToken,
  accountToken,
  limit,
}) {
  if (
    !cardToken &&
    !accountToken
  ) {
    return [];
  }

  const params =
    new URLSearchParams();

  if (cardToken) {
    params.set(
      "card_token",
      cardToken
    );
  } else {
    params.set(
      "account_token",
      accountToken
    );
  }

  params.set(
    "page_size",
    String(
      limit
    )
  );

  const result =
    await lithicRequest(
      `/transactions?${params.toString()}`,
      {
        method:
          "GET",
      }
    );

  return unwrapLithicList(
    result
  )
    .slice(
      0,
      limit
    )
    .map(
      (row) => {
        const sanitized =
          sanitizeLithicTransaction(
            row
          );

        const amountCents =
          cents(
            row.amount ??
              sanitized
                ?.amountCents ??
              0
          );

        return {
          token:
            sanitized
              ?.token ||
            normalizeString(
              row.token
            ) ||
            null,

          status:
            sanitized
              ?.status ||
            normalizeString(
              row.status
            ) ||
            null,

          result:
            sanitized
              ?.result ||
            normalizeString(
              row.result
            ) ||
            null,

          amountCents,

          amount:
            centsToDollars(
              amountCents
            ),

          currency:
            normalizeString(
              row.currency
            ) ||
            "USD",

          merchant:
            sanitizeMerchant(
              row.merchant ||
                sanitized
                  ?.merchant
            ),

          createdAt:
            safeDate(
              row.created ||
                row.created_at
            ),

          settledAmountCents:
            row.settled_amount !=
            null
              ? cents(
                  row.settled_amount
                )
              : null,

          settledAmount:
            row.settled_amount !=
            null
              ? centsToDollars(
                  cents(
                    row.settled_amount
                  )
                )
              : null,
        };
      }
    );
}

/* ==========================================================================
   BALANCE SUMMARY
============================================================================ */

function buildBalanceSummary({
  liveCardBalance,
  accountBalances,
  allowanceLedger,
}) {
  const issuingBalance =
    accountBalances.find(
      (row) =>
        normalizeStatus(
          row.type
        ) ===
        "issuing"
    ) ||
    accountBalances[0] ||
    null;

  if (
    liveCardBalance
  ) {
    return {
      source:
        "lithic_card",

      live:
        true,

      availableCents:
        liveCardBalance
          .availableCents,

      available:
        liveCardBalance
          .available,

      pendingCents:
        liveCardBalance
          .pendingCents,

      pending:
        liveCardBalance
          .pending,

      currency:
        liveCardBalance
          .currency ||
        "USD",
    };
  }

  if (
    issuingBalance
  ) {
    return {
      source:
        "lithic_account",

      live:
        true,

      availableCents:
        issuingBalance
          .availableCents,

      available:
        issuingBalance
          .available,

      pendingCents:
        issuingBalance
          .pendingCents,

      pending:
        issuingBalance
          .pending,

      currency:
        issuingBalance
          .currency ||
        "USD",
    };
  }

  if (
    allowanceLedger
      .available
  ) {
    return {
      source:
        "card_leo_ledger",

      live:
        false,

      availableCents:
        allowanceLedger
          .netCents,

      available:
        centsToDollars(
          allowanceLedger
            .netCents
        ),

      pendingCents:
        allowanceLedger
          .pendingCents,

      pending:
        centsToDollars(
          allowanceLedger
            .pendingCents
        ),

      currency:
        "USD",
    };
  }

  return emptyBalance();
}

/* ==========================================================================
   CARD READINESS
============================================================================ */

function buildCardReadiness({
  memberCard,
  lithicEnabled,
  lithicConfigured,
}) {
  const accountHolderCreated =
    Boolean(
      normalizeString(
        memberCard
          ?.lithic_account_holder_token
      )
    );

  const accountCreated =
    Boolean(
      normalizeString(
        memberCard
          ?.lithic_account_token
      )
    );

  const cardCreated =
    Boolean(
      normalizeString(
        memberCard
          ?.lithic_card_token
      )
    );

  const accountHolderStatus =
    normalizeString(
      memberCard
        ?.lithic_account_holder_status
    ).toUpperCase();

  const accountHolderAccepted =
    accountHolderStatus ===
    "ACCEPTED";

  let stage =
    "not_started";

  let nextEndpoint =
    "/api/cards/create-cardholder";

  let message =
    "Create your Card Leo card account first.";

  if (
    accountHolderCreated &&
    !accountHolderAccepted
  ) {
    stage =
      "account_holder_pending";

    nextEndpoint =
      null;

    message =
      accountHolderStatus ===
      "PENDING_REVIEW"
        ? "Your Card Leo card account is under review."
        : "Your Card Leo card account must be accepted before card issuance.";
  }

  if (
    accountHolderCreated &&
    accountHolderAccepted &&
    accountCreated &&
    !cardCreated
  ) {
    stage =
      "ready_for_card";

    nextEndpoint =
      "/api/cards/create-virtual-card";

    message =
      "Your card account is ready for virtual-card creation.";
  }

  if (
    cardCreated
  ) {
    stage =
      "card_created";

    nextEndpoint =
      null;

    message =
      "Your Card Leo virtual card has been created.";
  }

  if (
    !lithicEnabled
  ) {
    stage =
      "provider_disabled";

    nextEndpoint =
      null;

    message =
      "Card Leo card infrastructure is prepared, but Lithic is not enabled yet.";
  } else if (
    lithicEnabled &&
    !lithicConfigured
  ) {
    stage =
      "provider_configuration_required";

    nextEndpoint =
      null;

    message =
      "Lithic is enabled but still requires configuration.";
  }

  return {
    stage,

    accountHolderCreated,

    accountHolderAccepted,

    accountHolderStatus:
      accountHolderStatus ||
      null,

    accountCreated,

    cardCreated,

    nextEndpoint,

    message,
  };
}

/* ==========================================================================
   EMPTY CARD RESPONSE
============================================================================ */

function buildEmptyCardResponse({
  member,
  readiness,
  lithic,
  memberCardsReady = true,
}) {
  return {
    authenticated:
      true,

    portalAccess:
      true,

    member:
      buildSafeMember(
        member
      ),

    card:
      null,

    balance:
      emptyBalance(),

    allowance: {
      available:
        0,

      availableCents:
        0,

      pending:
        0,

      pendingCents:
        0,

      currency:
        "USD",

      source:
        "none",

      live:
        false,

      internalLedger: {
        enabled:
          false,

        totalCredited:
          0,

        totalCreditedCents:
          0,

        totalDebited:
          0,

        totalDebitedCents:
          0,

        pending:
          0,

        pendingCents:
          0,

        failed:
          0,

        failedCents:
          0,

        net:
          0,

        netCents:
          0,
      },
    },

    transactions:
      [],

    allowanceTransactions:
      [],

    readiness,

    lithic,

    database: {
      memberCardsReady,

      allowanceLedgerReady:
        false,
    },
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
        "member_card",
    }
  );

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

    const requestedLimit =
      normalizeInteger(
        req.query
          ?.limit,
        DEFAULT_TRANSACTION_LIMIT
      );

    const transactionLimit =
      clamp(
        requestedLimit,
        1,
        MAX_TRANSACTION_LIMIT
      );

    /* ======================================================================
       MEMBER CARD RECORD
    ====================================================================== */

    const {
      record:
        memberCard,

      tableMissing,
    } =
      await getMemberCardRecord(
        memberId
      );

    /*
     * A missing card table is NOT an auth failure.
     */

    if (
      tableMissing
    ) {
      const readiness = {
        stage:
          "database_required",

        accountHolderCreated:
          false,

        accountHolderAccepted:
          false,

        accountHolderStatus:
          null,

        accountCreated:
          false,

        cardCreated:
          false,

        nextEndpoint:
          null,

        message:
          "The Card Leo member_cards table must be created before card features can be activated.",
      };

      return success(
        res,
        buildEmptyCardResponse({
          member,

          readiness,

          lithic:
            getLithicIntegrationStatus(),

          memberCardsReady:
            false,
        }),
        "Card infrastructure is prepared, but the member_cards table has not been created yet."
      );
    }

    /* ======================================================================
       NO CARD RECORD YET
    ====================================================================== */

    if (
      !memberCard
    ) {
      const readiness =
        buildCardReadiness({
          memberCard:
            null,

          lithicEnabled:
            isLithicEnabled(),

          lithicConfigured:
            isLithicConfigured(),
        });

      return success(
        res,
        buildEmptyCardResponse({
          member,

          readiness,

          lithic:
            getLithicIntegrationStatus(),
        }),
        "You do not have a Card Leo card account yet."
      );
    }

    const localCard =
      sanitizeMemberCardRecord(
        memberCard
      );

    /* ======================================================================
       ALLOWANCE LEDGER

       Failure here must not fail the whole My Card page.
    ====================================================================== */

    let allowanceLedger;

    try {
      allowanceLedger =
        await getAllowanceLedger(
          memberId
        );
    } catch (
      ledgerError
    ) {
      logRequestError(
        req,
        ledgerError,
        {
          scope:
            "member_card_allowance_ledger",

          memberId,
        }
      );

      allowanceLedger = {
        available:
          false,

        transactions:
          [],

        creditedCents:
          0,

        debitedCents:
          0,

        pendingCents:
          0,

        failedCents:
          0,

        netCents:
          0,
      };
    }

    const safeAllowanceTransactions =
      allowanceLedger
        .transactions
        .slice(
          0,
          transactionLimit
        )
        .map(
          sanitizeAllowanceTransaction
        );

    /* ======================================================================
       PROVIDER STATE
    ====================================================================== */

    const lithicEnabled =
      isLithicEnabled();

    const lithicConfigured =
      isLithicConfigured();

    const cardToken =
      normalizeString(
        memberCard
          .lithic_card_token
      );

    const accountToken =
      normalizeString(
        memberCard
          .lithic_account_token
      );

    let liveCard =
      null;

    let liveAccount =
      null;

    let liveCardBalance =
      null;

    let accountBalances =
      [];

    let liveTransactions =
      [];

    const providerErrors =
      [];

    /* ======================================================================
       LIVE PROVIDER DATA

       Every provider call is isolated.

       One failed Lithic call must not turn My Card into an auth failure.
    ====================================================================== */

    if (
      lithicEnabled &&
      lithicConfigured
    ) {
      if (cardToken) {
        try {
          liveCard =
            await getLiveLithicCard(
              cardToken
            );
        } catch (
          error
        ) {
          providerErrors.push({
            scope:
              "card",

            message:
              error?.message ||
              "Unable to load Lithic card.",
          });

          logRequestError(
            req,
            error,
            {
              scope:
                "member_card_lithic_card",

              memberId,
            }
          );
        }

        try {
          liveCardBalance =
            await getLithicCardBalance(
              cardToken
            );
        } catch (
          error
        ) {
          providerErrors.push({
            scope:
              "card_balance",

            message:
              error?.message ||
              "Unable to load card balance.",
          });

          logRequestError(
            req,
            error,
            {
              scope:
                "member_card_lithic_balance",

              memberId,
            }
          );
        }
      }

      if (
        accountToken
      ) {
        try {
          liveAccount =
            await getLiveLithicAccount(
              accountToken
            );
        } catch (
          error
        ) {
          providerErrors.push({
            scope:
              "account",

            message:
              error?.message ||
              "Unable to load Lithic account.",
          });

          logRequestError(
            req,
            error,
            {
              scope:
                "member_card_lithic_account",

              memberId,
            }
          );
        }

        try {
          accountBalances =
            await getLithicAccountBalances(
              accountToken
            );
        } catch (
          error
        ) {
          providerErrors.push({
            scope:
              "account_balances",

            message:
              error?.message ||
              "Unable to load Lithic account balances.",
          });

          logRequestError(
            req,
            error,
            {
              scope:
                "member_card_account_balances",

              memberId,
            }
          );
        }
      }

      if (
        cardToken ||
        accountToken
      ) {
        try {
          liveTransactions =
            await getLithicTransactions({
              cardToken,

              accountToken,

              limit:
                transactionLimit,
            });
        } catch (
          error
        ) {
          providerErrors.push({
            scope:
              "transactions",

            message:
              error?.message ||
              "Unable to load card transactions.",
          });

          logRequestError(
            req,
            error,
            {
              scope:
                "member_card_lithic_transactions",

              memberId,
            }
          );
        }
      }
    }

    /* ======================================================================
       DISPLAY CARD
    ====================================================================== */

    const displayCard = {
      ...localCard,

      cardType:
        liveCard?.type ||
        localCard.cardType ||
        null,

      cardStatus:
        liveCard?.state ||
        localCard.cardStatus ||
        "NOT_CREATED",

      lastFour:
        liveCard
          ?.lastFour ||
        localCard.lastFour ||
        null,

      maskedNumber:
        liveCard
          ?.lastFour
          ? `•••• •••• •••• ${liveCard.lastFour}`
          : localCard
              .maskedNumber,

      memo:
        liveCard?.memo ||
        localCard.memo ||
        "Card Leo Rewards",
    };

    /* ======================================================================
       BALANCE
    ====================================================================== */

    const balance =
      buildBalanceSummary({
        liveCardBalance,

        accountBalances,

        allowanceLedger,
      });

    /* ======================================================================
       READINESS
    ====================================================================== */

    const readiness =
      buildCardReadiness({
        memberCard,

        lithicEnabled,

        lithicConfigured,
      });

    /* ======================================================================
       SAFE LITHIC STATUS
    ====================================================================== */

    const lithicStatus = {
      ...getLithicIntegrationStatus(),

      hasAccountHolder:
        Boolean(
          memberCard
            .lithic_account_holder_token
        ),

      accountHolderStatus:
        normalizeString(
          memberCard
            .lithic_account_holder_status
        ) ||
        null,

      hasAccount:
        Boolean(
          accountToken
        ),

      hasCard:
        Boolean(
          cardToken
        ),

      liveDataLoaded:
        Boolean(
          liveCard ||
          liveAccount ||
          liveCardBalance ||
          accountBalances.length ||
          liveTransactions.length
        ),

      partialFailure:
        providerErrors.length >
        0,

      providerErrors,
    };

    /* ======================================================================
       ALLOWANCE RESPONSE
    ====================================================================== */

    const allowance = {
      available:
        balance.available,

      availableCents:
        balance.availableCents,

      pending:
        balance.pending,

      pendingCents:
        balance.pendingCents,

      currency:
        balance.currency,

      source:
        balance.source,

      live:
        balance.live,

      internalLedger: {
        enabled:
          allowanceLedger
            .available,

        totalCredited:
          centsToDollars(
            allowanceLedger
              .creditedCents
          ),

        totalCreditedCents:
          allowanceLedger
            .creditedCents,

        totalDebited:
          centsToDollars(
            allowanceLedger
              .debitedCents
          ),

        totalDebitedCents:
          allowanceLedger
            .debitedCents,

        pending:
          centsToDollars(
            allowanceLedger
              .pendingCents
          ),

        pendingCents:
          allowanceLedger
            .pendingCents,

        failed:
          centsToDollars(
            allowanceLedger
              .failedCents
          ),

        failedCents:
          allowanceLedger
            .failedCents,

        net:
          centsToDollars(
            allowanceLedger
              .netCents
          ),

        netCents:
          allowanceLedger
            .netCents,
      },
    };

    /* ======================================================================
       DATABASE STATUS
    ====================================================================== */

    const database = {
      memberCardsReady:
        true,

      allowanceLedgerReady:
        allowanceLedger
          .available,
    };

    /* ======================================================================
       SUCCESS LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "member_card",

        memberId,

        cardCreated:
          readiness
            .cardCreated,

        cardStatus:
          displayCard
            .cardStatus,

        balanceSource:
          balance.source,

        availableBalance:
          balance.available,

        lithicEnabled,

        lithicConfigured,

        liveTransactionCount:
          liveTransactions
            .length,

        allowanceTransactionCount:
          safeAllowanceTransactions
            .length,

        providerPartialFailure:
          providerErrors.length >
          0,
      }
    );

    /* ======================================================================
       RESPONSE

       CRITICAL:
       Do not add memberCard raw object or Lithic provider tokens.
    ====================================================================== */

    return success(
      res,
      {
        authenticated:
          true,

        portalAccess:
          true,

        member:
          buildSafeMember(
            member
          ),

        card:
          displayCard,

        readiness,

        balance,

        allowance,

        transactions:
          liveTransactions,

        allowanceTransactions:
          safeAllowanceTransactions,

        account: {
          available:
            Boolean(
              liveAccount
            ),

          state:
            liveAccount
              ?.state ||
            null,

          spendLimit:
            liveAccount
              ?.spendLimit ??
            null,

          spendLimitDuration:
            liveAccount
              ?.spendLimitDuration ??
            null,

          created:
            liveAccount
              ?.created ||
            null,
        },

        lithic:
          lithicStatus,

        database,

        page: {
          title:
            "My Card",

          url:
            "/portal/card.html",

          createCardholderEndpoint:
            "/api/cards/create-cardholder",

          createVirtualCardEndpoint:
            "/api/cards/create-virtual-card",

          memberCardEndpoint:
            "/api/cards/member-card",
        },
      },
      providerErrors.length
        ? "Card information loaded. Some live card data is temporarily unavailable."
        : "Card information loaded successfully."
    );
  } catch (
    error
  ) {
    /*
     * CRITICAL LOGIN-LOOP RULE
     * ------------------------
     *
     * A Supabase, Lithic, balance, or transaction failure is NOT proof that
     * the member's authentication session is invalid.
     *
     * Never clear auth cookies here.
     */

    logRequestError(
      req,
      error,
      {
        scope:
          "member_card_unexpected",
      }
    );

    console.error(
      "Card Leo member-card error:",
      error
    );

    return serverError(
      res,
      "Unable to load Card Leo card information right now.",
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