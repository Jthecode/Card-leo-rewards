// api/cards/fund-allowance.js

import { randomUUID } from "crypto";

import { supabaseAdmin } from "../../lib/supabase-admin.js";

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
  safeJsonParse,
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
   Move an APPROVED Card Leo allowance from the Card Leo reward/allowance
   ledger into the member's Lithic issuing financial account.

   IMPORTANT SECURITY RULE
   -----------------------
   The client/browser DOES NOT choose the dollar amount.

   The browser sends:

     {
       "allowanceTransactionId": "..."
     }

   This route then loads the amount from the Card Leo database.

   FLOW
   ----
   1. Authenticate logged-in member
   2. Confirm membership is active + paid
   3. Load member_cards record
   4. Confirm Lithic account + virtual card exist
   5. Load approved allowance_transactions record
   6. Confirm allowance belongs to this member
   7. Prevent duplicate funding
   8. Resolve member Lithic ISSUING financial account
   9. Confirm Card Leo program funding account
   10. Create Lithic book transfer
   11. Save provider transaction reference
   12. Mark allowance transaction funded/completed

   NEVER TRUST
   -----------
   - amount sent from browser
   - member_id sent from browser
   - Lithic destination token sent from browser
   - arbitrary reward IDs without database verification

============================================================================ */

/* ==========================================================================
   DATABASE TABLES
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

const ALLOWANCE_TRANSACTIONS_TABLE =
  "allowance_transactions";

/* ==========================================================================
   SESSION
============================================================================ */

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

/* ==========================================================================
   MEMBERSHIP STATUS
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
      success: true,
      ok: true,
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
      success: false,
      ok: false,
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
  message =
    "Unexpected server error.",
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

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
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
    new Date(value);

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
      return JSON.parse(
        req.body
      );
    } catch {
      return {};
    }
  }

  if (
    typeof req.body ===
    "object"
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

function generateIdempotencyToken() {
  return randomUUID();
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
    code === "42P01" ||
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
          part.indexOf("=");

        if (
          separator === -1
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
              separator + 1
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
   SESSION
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
      getSessionCookieName?.()
    );

  const names =
    Array.from(
      new Set(
        [
          configuredName,
          ...SESSION_COOKIE_NAMES,
        ].filter(Boolean)
      )
    );

  for (
    const name of names
  ) {
    const raw =
      cookies[name];

    if (!raw) {
      continue;
    }

    const data =
      safeJsonParse(
        raw,
        null
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
        data.session?.expires_at ||
        data.session?.expiresAt ||
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
      Date.now() / 1000
    )
  );
}

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

function isMemberPaid(
  member
) {
  return ACTIVE_PAYMENT_STATUSES.has(
    normalizeStatus(
      member?.payment_status
    )
  );
}

function isMemberActive(
  member
) {
  if (
    !isMemberPaid(
      member
    )
  ) {
    return false;
  }

  const status =
    normalizeStatus(
      member?.status
    );

  const membershipStatus =
    normalizeStatus(
      member?.membership_status
    );

  const approvalStatus =
    normalizeStatus(
      member?.approval_status
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

    "stripe_customer_id",
    "stripe_subscription_id",

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

  let query =
    supabaseAdmin
      .from(
        "signups"
      )
      .select(
        extendedFields
      )
      .limit(1);

  if (memberId) {
    query =
      query.eq(
        "id",
        memberId
      );
  } else {
    query =
      query.eq(
        "email",
        email
      );
  }

  let result =
    await query
      .maybeSingle();

  if (
    result.error &&
    isMissingTableOrColumn(
      result.error
    )
  ) {
    let fallback =
      supabaseAdmin
        .from(
          "signups"
        )
        .select(
          fallbackFields
        )
        .limit(1);

    if (memberId) {
      fallback =
        fallback.eq(
          "id",
          memberId
        );
    } else {
      fallback =
        fallback.eq(
          "email",
          email
        );
    }

    result =
      await fallback
        .maybeSingle();
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

  if (!session?.data) {
    return {
      member: null,

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

  if (
    session.data
      .authenticated !== true
  ) {
    clearAuthCookies(
      res
    );

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Your login session is invalid."
        ),
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
    clearAuthCookies(
      res
    );

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Member information is missing from your session."
        ),
    };
  }

  const {
    data: member,
    error,
  } =
    await getMemberRecord({
      memberId,
      email,
    });

  if (error) {
    throw error;
  }

  if (!member?.id) {
    clearAuthCookies(
      res
    );

    return {
      member: null,

      response:
        unauthorized(
          res,
          "Card Leo member account could not be found."
        ),
    };
  }

  if (
    !isMemberPaid(
      member
    )
  ) {
    return {
      member: null,

      response:
        forbidden(
          res,
          "Your Card Leo membership payment must be current before an allowance can be funded."
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
          "Your Card Leo membership must be active and approved before an allowance can be funded."
        ),
    };
  }

  return {
    member,
    response: null,
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
      .select("*")
      .eq(
        "member_id",
        memberId
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        record: null,
        tableMissing: true,
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
   ALLOWANCE TRANSACTION
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
      .select("*")
      .eq(
        "id",
        allowanceTransactionId
      )
      .eq(
        "member_id",
        memberId
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
============================================================================ */

function getAllowanceAmountCents(
  transaction
) {
  /*
   * Step 13 should use amount_cents.
   *
   * We support amount as a compatibility fallback.
   */

  const amountCents =
    normalizePositiveInteger(
      transaction?.amount_cents,
      0
    );

  if (
    amountCents > 0
  ) {
    return amountCents;
  }

  const amount =
    Number(
      transaction?.amount ||
      0
    );

  if (
    Number.isFinite(amount) &&
    amount > 0
  ) {
    return Math.round(
      amount * 100
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
      transaction?.direction ||
      transaction?.type ||
      transaction?.transaction_type ||
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
   ALLOWANCE READINESS
============================================================================ */

function validateAllowanceTransaction(
  transaction
) {
  const errors = {};

  if (!transaction?.id) {
    errors.transaction =
      "Allowance transaction does not exist.";
  }

  const amountCents =
    getAllowanceAmountCents(
      transaction
    );

  if (
    amountCents <= 0
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
      transaction?.status
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
    status &&
    !READY_ALLOWANCE_STATUSES.has(
      status
    ) &&
    !COMPLETED_ALLOWANCE_STATUSES.has(
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
      ).length === 0,

    errors,

    amountCents,
  };
}

/* ==========================================================================
   IDEMPOTENCY
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

function getOrCreateIdempotencyToken(
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

  return generateIdempotencyToken();
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
   LITHIC FINANCIAL ACCOUNTS
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
    return result.data.data;
  }

  if (
    Array.isArray(
      result?.data?.items
    )
  ) {
    return result.data.items;
  }

  return [];
}

/* ==========================================================================
   FIND MEMBER ISSUING FINANCIAL ACCOUNT
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

  const financialAccounts =
    unwrapLithicList(
      result
    );

  const issuing =
    financialAccounts.find(
      (account) =>
        normalizeStatus(
          account?.type
        ) === "issuing"
    );

  if (issuing) {
    return issuing;
  }

  /*
   * Do NOT automatically use OPERATING as the
   * member destination.
   */

  return null;
}

/* ==========================================================================
   PROGRAM SOURCE ACCOUNT
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
   BOOK TRANSFER CONFIGURATION
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
   * Lithic's book transfer category and subtype are
   * program-specific. We deliberately do not guess them.
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
      ).length === 0,

    errors,

    sourceToken,

    category,

    subtype,
  };
}

/* ==========================================================================
   BUILD TRANSFER MEMO
============================================================================ */

function buildTransferMemo({
  member,
  transaction,
}) {
  const source =
    normalizeString(
      transaction?.source ||
      transaction?.description
    );

  const memberName =
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
      .join(" ");

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

  /*
   * Keep it comfortably below Lithic's documented
   * maximum memo size.
   */

  return memo
    .slice(
      0,
      300
    );
}

/* ==========================================================================
   CREATE BOOK TRANSFER
============================================================================ */

async function createLithicBookTransfer({
  fromFinancialAccountToken,
  toFinancialAccountToken,
  amountCents,
  category,
  subtype,
  memo,
  idempotencyToken,
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

  /*
   * The current book-transfer API supports an
   * Idempotency-Key request header.
   */

  return lithicRequest(
    "/book_transfers",
    {
      method:
        "POST",

      headers: {
        "Idempotency-Key":
          idempotencyToken,
      },

      body:
        payload,
    }
  );
}

/* ==========================================================================
   BOOK TRANSFER RESPONSE
============================================================================ */

function unwrapLithicObject(
  result
) {
  if (
    isObject(
      result?.data?.data
    )
  ) {
    return result.data.data;
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
        data.status ||
        data.result
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
   GET BALANCE AFTER TRANSFER
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

  const availableAmount =
    Number(
      data.available_amount ??
      data.available_balance ??
      0
    );

  const pendingAmount =
    Number(
      data.pending_amount ??
      data.pending_balance ??
      0
    );

  const totalAmount =
    Number(
      data.total_amount ??
      data.total_balance ??
      (
        availableAmount +
        pendingAmount
      )
    );

  return {
    availableCents:
      Number.isFinite(
        availableAmount
      )
        ? availableAmount
        : 0,

    available:
      centsToDollars(
        Number.isFinite(
          availableAmount
        )
          ? availableAmount
          : 0
      ),

    pendingCents:
      Number.isFinite(
        pendingAmount
      )
        ? pendingAmount
        : 0,

    pending:
      centsToDollars(
        Number.isFinite(
          pendingAmount
        )
          ? pendingAmount
          : 0
      ),

    totalCents:
      Number.isFinite(
        totalAmount
      )
        ? totalAmount
        : 0,

    total:
      centsToDollars(
        Number.isFinite(
          totalAmount
        )
          ? totalAmount
          : 0
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
      transaction.member_id ||
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
      transaction.source_reward_id ||
      transaction.reward_id ||
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
        transaction.provider_status
      ) ||
      null,

    fundedAt:
      safeDate(
        transaction.funded_at
      ),

    createdAt:
      safeDate(
        transaction.created_at
      ),

    updatedAt:
      safeDate(
        transaction.updated_at
      ),
  };
}

/* ==========================================================================
   IDEMPOTENT ALREADY FUNDED RESPONSE
============================================================================ */

function isAlreadyFunded(
  transaction
) {
  const status =
    normalizeStatus(
      transaction?.status
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
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore?.(
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
       BODY
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const allowanceTransactionId =
      normalizeString(
        body.allowanceTransactionId ||
        body.allowance_transaction_id ||
        body.transactionId ||
        body.transaction_id
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

          example: {
            allowanceTransactionId:
              "your-approved-allowance-transaction-id",
          },
        }
      );
    }

    /*
     * SECURITY:
     *
     * Ignore browser-provided amount.
     *
     * The amount must come from the database.
     */

    /* ======================================================================
       MEMBER CARD RECORD
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

          nextStep:
            "Complete Step 12.",
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
       VIRTUAL CARD READY
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
        "A Lithic account holder must be created before an allowance can be funded.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_REQUIRED",

          nextEndpoint:
            "/api/cards/create-cardholder",
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
        "Your Card Leo virtual card must be created before an allowance can be loaded.",
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

          nextStep:
            "Complete Step 13 before allowance funding is enabled.",
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
          funded:
            true,

          alreadyFunded:
            true,

          allowance:
            sanitizeAllowanceTransaction(
              allowanceTransaction
            ),

          lithic:
            getLithicIntegrationStatus(),
        },
        "This Card Leo allowance has already been funded."
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
            allowanceValidation.errors,

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
       LITHIC DISABLED
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return success(
        res,
        {
          funded:
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

          nextSteps: [
            "Obtain Lithic Sandbox credentials.",
            "Confirm Card Leo's program-level ISSUING financial account.",
            "Confirm the book-transfer category approved for Card Leo.",
            "Confirm the book-transfer subtype approved for Card Leo.",
            "Add those values to Vercel.",
            "Set LITHIC_ENABLED=true only when Sandbox testing is ready.",
          ],
        },
        "The allowance is approved and ready, but Lithic funding is currently disabled."
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

    /* ======================================================================
       BOOK TRANSFER CONFIG
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
            transferConfig.errors,

          /*
           * No sensitive tokens returned.
           */

          requirements: [
            "LITHIC_PROGRAM_ISSUING_FINANCIAL_ACCOUNT_TOKEN",
            "LITHIC_BOOK_TRANSFER_CATEGORY",
            "LITHIC_BOOK_TRANSFER_SUBTYPE",
          ],
        }
      );
    }

    /* ======================================================================
       MEMBER FINANCIAL ACCOUNT
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
        memberFinancialAccount.token
      );

    /* ======================================================================
       PREPARE IDEMPOTENCY
    ====================================================================== */

    const idempotencyToken =
      getOrCreateIdempotencyToken(
        allowanceTransaction
      );

    /*
     * Save the idempotency token BEFORE calling Lithic.
     *
     * This prevents a network retry from generating a
     * brand-new provider operation.
     */

    let processingTransaction;

    try {
      processingTransaction =
        await updateAllowanceTransaction(
          allowanceTransaction.id,
          {
            status:
              "processing",

            provider:
              "lithic",

            provider_status:
              "processing",

            idempotency_key:
              idempotencyToken,

            funding_started_at:
              nowIso(),
          }
        );
    } catch (
      error
    ) {
      logRequestError(
        req,
        error,
        {
          scope:
            "fund_allowance_mark_processing",

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

          idempotencyToken,
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
       * We mark it failed but retain the idempotency key.
       *
       * An administrator can inspect the provider before
       * deciding whether the request should be retried.
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
              lithicError?.message ||
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
              "fund_allowance_save_failure",

            memberId,

            allowanceTransactionId,
          }
        );
      }

      const providerStatus =
        Number(
          lithicError?.status
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

          funded:
            false,

          message:
            lithicError?.message ||
            "Lithic could not fund the Card Leo allowance.",

          code:
            lithicError?.code ||
            "LITHIC_BOOK_TRANSFER_FAILED",

          allowance: {
            id:
              allowanceTransaction.id,

            amountCents,

            amount:
              centsToDollars(
                amountCents
              ),
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
       * Do not retry automatically.
       *
       * A transfer may have occurred even though the
       * response was not shaped as expected.
       */

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
       DETERMINE FINAL STATUS
    ====================================================================== */

    const transferApproved =
      [
        "APPROVED",
        "COMPLETED",
        "COMPLETE",
        "SETTLED",
        "SUCCESS",
        "SUCCEEDED",
      ].includes(
        transfer.result ||
        transfer.status
      );

    /*
     * If provider returns a non-terminal/pending state,
     * leave Card Leo record as processing.
     */

    const finalStatus =
      transferApproved
        ? "funded"
        : "processing";

    /* ======================================================================
       SAVE PROVIDER REFERENCE
    ====================================================================== */

    let completedTransaction;

    try {
      completedTransaction =
        await updateAllowanceTransaction(
          allowanceTransaction.id,
          {
            status:
              finalStatus,

            provider:
              "lithic",

            provider_status:
              transfer.result ||
              transfer.status ||
              "processing",

            provider_transaction_token:
              transfer.token,

            external_reference:
              transfer.token,

            funded_at:
              transferApproved
                ? nowIso()
                : null,

            provider_response: {
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

          lithicTransferToken:
            transfer.token,
        }
      );

      /*
       * SERIOUS STATE:
       *
       * Lithic transfer exists but Supabase update failed.
       *
       * Never automatically retry the transfer.
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
      /*
       * Funding success should not be reversed because
       * a balance read failed.
       */

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

        email:
          member.email,

        allowanceTransactionId,

        amountCents,

        amount:
          centsToDollars(
            amountCents
          ),

        provider:
          "lithic",

        providerStatus:
          transfer.result ||
          transfer.status,

        funded:
          transferApproved,

        environment:
          getLithicEnvironment(),
      }
    );

    /* ======================================================================
       SAFE RESPONSE

       Do not expose:
       - financial account tokens
       - source funding account token
       - card token
       - account token
    ====================================================================== */

    return success(
      res,
      {
        funded:
          transferApproved,

        processing:
          !transferApproved,

        alreadyFunded:
          false,

        allowance:
          sanitizeAllowanceTransaction(
            completedTransaction
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
                  balance.availableCents,

                pending:
                  balance.pending,

                pendingCents:
                  balance.pendingCents,

                total:
                  balance.total,

                totalCents:
                  balance.totalCents,

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
            transfer.result ||
            transfer.status ||
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
        : "Your Card Leo allowance transfer has been submitted and is processing."
    );
  } catch (
    error
  ) {
    logRequestError(
      req,
      error,
      {
        scope:
          "fund_allowance_unexpected",
      }
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