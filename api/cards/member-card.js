// api/cards/member-card.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

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
   MEMBER CARD ENDPOINT

   ROUTE
   -----
   GET /api/cards/member-card

   PURPOSE
   -------
   Returns the logged-in Card Leo member's SAFE card information.

   THIS ENDPOINT MAY RETURN:
   -------------------------
   - Card status
   - Card type
   - Last four digits
   - Masked card number
   - Lithic account/card readiness
   - Available balance / allowance
   - Pending balance
   - Recent transactions
   - Card creation status
   - Member card page metadata

   THIS ENDPOINT MUST NEVER RETURN:
   --------------------------------
   - Full PAN
   - CVV
   - Full card credentials
   - Raw sensitive Lithic responses
   - API keys
   - Full financial account/routing numbers

   CARD LEO FLOW
   -------------
   signups
      ↓
   member_cards
      ↓
   Lithic Account Holder
      ↓
   Lithic Account
      ↓
   Lithic Virtual Card
      ↓
   Allowance Funding
      ↓
   portal/card.html

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

const ALLOWANCE_TRANSACTIONS_TABLE =
  "allowance_transactions";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

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

const DEFAULT_TRANSACTION_LIMIT =
  20;

const MAX_TRANSACTION_LIMIT =
  50;

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
    "Card information loaded successfully."
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
   GENERAL HELPERS
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

function money(
  value
) {
  const amount =
    Number(value || 0);

  if (
    !Number.isFinite(
      amount
    )
  ) {
    return 0;
  }

  return Number(
    amount.toFixed(2)
  );
}

function cents(
  value
) {
  const amount =
    Number(value || 0);

  if (
    !Number.isFinite(
      amount
    )
  ) {
    return 0;
  }

  return Math.round(
    amount
  );
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

  return date.toISOString();
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
   SESSION COOKIES
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

  /*
   * Some older Card Leo sessions may not
   * contain an explicit expiration value.
   */

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

    "phone",
    "city",
    "state",

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

    "phone",
    "city",
    "state",

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
      member: null,

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

  if (
    !member?.id
  ) {
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
          "Your membership payment must be current to access your Card Leo card."
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
          "Your Card Leo membership is not currently active."
        ),
    };
  }

  return {
    member,
    response: null,
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
   LOCAL ALLOWANCE LEDGER

   This is intentionally separate from Lithic's live balance.

   Once Step #13 creates allowance_transactions, this gives the member
   Card Leo's internal allowance ledger as well as the provider balance.

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
      .select("*")
      .eq(
        "member_id",
        memberId
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(100);

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        available: false,

        transactions: [],

        creditedCents: 0,
        debitedCents: 0,
        pendingCents: 0,
        failedCents: 0,
        netCents: 0,
      };
    }

    throw error;
  }

  const rows =
    data || [];

  let creditedCents = 0;
  let debitedCents = 0;
  let pendingCents = 0;
  let failedCents = 0;

  for (
    const row of rows
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
          row.transaction_type
      );

    if (
      status === "pending" ||
      status === "processing"
    ) {
      pendingCents += amount;
      continue;
    }

    if (
      status === "failed" ||
      status === "declined" ||
      status === "cancelled" ||
      status === "reversed"
    ) {
      failedCents += amount;
      continue;
    }

    if (
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
      )
    ) {
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
        debitedCents += amount;
      } else {
        creditedCents += amount;
      }
    }
  }

  const netCents =
    creditedCents -
    debitedCents;

  return {
    available: true,

    transactions:
      rows,

    creditedCents,

    debitedCents,

    pendingCents,

    failedCents,

    netCents,
  };
}

/* ==========================================================================
   SAFE DATABASE CARD
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
      record.spend_limit_cents ??
      null,

    spendLimit:
      record.spend_limit_cents != null
        ? money(
            Number(
              record.spend_limit_cents
            ) / 100
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
   LITHIC RESULT UNWRAPPER
============================================================================ */

function unwrapLithicData(
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

/* ==========================================================================
   LITHIC LIST UNWRAPPER
============================================================================ */

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
   LIVE CARD
============================================================================ */

async function getLiveLithicCard(
  cardToken
) {
  if (
    !cardToken
  ) {
    return null;
  }

  const result =
    await getLithicCard(
      cardToken
    );

  const card =
    unwrapLithicData(
      result
    );

  return sanitizeLithicCard(
    card
  );
}

/* ==========================================================================
   LIVE ACCOUNT
============================================================================ */

async function getLiveLithicAccount(
  accountToken
) {
  if (
    !accountToken
  ) {
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

  return {
    token:
      normalizeString(
        account.token
      ) ||
      null,

    state:
      normalizeString(
        account.state
      ) ||
      null,

    spendLimit:
      account.spend_limit ??
      null,

    spendLimitDuration:
      account.spend_limit_duration ??
      null,

    created:
      safeDate(
        account.created
      ),
  };
}

/* ==========================================================================
   CARD BALANCE

   Lithic:
   GET /v1/cards/{card_token}/balances

============================================================================ */

async function getLithicCardBalance(
  cardToken
) {
  if (
    !cardToken
  ) {
    return null;
  }

  const result =
    await lithicRequest(
      `/cards/${encodeURIComponent(
        cardToken
      )}/balances`,
      {
        method: "GET",
      }
    );

  const raw =
    unwrapLithicData(
      result
    );

  /*
   * The balance response can evolve by program.
   *
   * We preserve safe fields and calculate an available
   * amount when the common fields are present.
   */

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

   Lithic:
   GET /v1/balances?account_token=...

============================================================================ */

async function getLithicAccountBalances(
  accountToken
) {
  if (
    !accountToken
  ) {
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

  const rows =
    unwrapLithicList(
      result
    );

  return rows.map(
    (row) => ({
      token:
        normalizeString(
          row.token ||
            row.financial_account_token
        ) ||
        null,

      type:
        normalizeString(
          row.type ||
            row.financial_account_type
        ) ||
        null,

      availableCents:
        cents(
          row.available_amount ??
            row.available_balance ??
            row.available ??
            row.balance ??
            0
        ),

      available:
        centsToDollars(
          cents(
            row.available_amount ??
              row.available_balance ??
              row.available ??
              row.balance ??
              0
          )
        ),

      pendingCents:
        cents(
          row.pending_amount ??
            row.pending_balance ??
            row.pending ??
            0
        ),

      pending:
        centsToDollars(
          cents(
            row.pending_amount ??
              row.pending_balance ??
              row.pending ??
              0
          )
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
    })
  );
}

/* ==========================================================================
   TRANSACTIONS

   Lithic:
   GET /v1/transactions?card_token=...

============================================================================ */

async function getLithicTransactions({
  cardToken,
  accountToken,
  limit,
}) {
  const params =
    new URLSearchParams();

  if (
    cardToken
  ) {
    params.set(
      "card_token",
      cardToken
    );
  } else if (
    accountToken
  ) {
    params.set(
      "account_token",
      accountToken
    );
  } else {
    return [];
  }

  params.set(
    "page_size",
    String(limit)
  );

  const result =
    await lithicRequest(
      `/transactions?${params.toString()}`,
      {
        method:
          "GET",
      }
    );

  const rows =
    unwrapLithicList(
      result
    );

  return rows
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
              sanitized?.amountCents ??
              0
          );

        return {
          token:
            sanitized?.token ||
            normalizeString(
              row.token
            ) ||
            null,

          cardToken:
            sanitized?.cardToken ||
            null,

          /*
           * Do not return account tokens through
           * this public/member endpoint.
           */

          status:
            sanitized?.status ||
            normalizeString(
              row.status
            ) ||
            null,

          result:
            sanitized?.result ||
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
                sanitized?.merchant
            ),

          createdAt:
            safeDate(
              row.created ||
                row.created_at
            ),

          settledAmountCents:
            row.settled_amount != null
              ? cents(
                  row.settled_amount
                )
              : null,

          settledAmount:
            row.settled_amount != null
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
   LOCAL ALLOWANCE TRANSACTION SANITIZER
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

  const direction =
    normalizeStatus(
      row.direction ||
        row.type ||
        row.transaction_type ||
        "credit"
    );

  return {
    id:
      row.id ||
      null,

    memberId:
      row.member_id ||
      null,

    direction,

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
   BALANCE SUMMARY
============================================================================ */

function buildBalanceSummary({
  liveCardBalance,
  accountBalances,
  allowanceLedger,
}) {
  /*
   * Preferred balance:
   *
   * 1. Lithic card-level live balance
   * 2. Lithic issuing account balance
   * 3. Local Card Leo allowance ledger
   */

  const issuingBalance =
    accountBalances.find(
      (row) =>
        normalizeStatus(
          row.type
        ) === "issuing"
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

  return {
    source:
      allowanceLedger.available
        ? "card_leo_ledger"
        : "none",

    live:
      false,

    availableCents:
      allowanceLedger.netCents,

    available:
      centsToDollars(
        allowanceLedger.netCents
      ),

    pendingCents:
      allowanceLedger.pendingCents,

    pending:
      centsToDollars(
        allowanceLedger.pendingCents
      ),

    currency:
      "USD",
  };
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

  let stage =
    "not_started";

  let nextEndpoint =
    "/api/cards/create-cardholder";

  let message =
    "Create your Card Leo card account first.";

  if (
    accountHolderCreated &&
    accountCreated &&
    !cardCreated
  ) {
    stage =
      "ready_for_card";

    nextEndpoint =
      "/api/cards/create-virtual-card";

    message =
      "Your card account is ready for virtual card creation.";
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

    message =
      "Card Leo card infrastructure is prepared, but Lithic is not enabled yet.";
  } else if (
    lithicEnabled &&
    !lithicConfigured
  ) {
    stage =
      "provider_configuration_required";

    message =
      "Lithic is enabled but still requires configuration.";
  }

  return {
    stage,

    accountHolderCreated,

    accountCreated,

    cardCreated,

    nextEndpoint,

    message,
  };
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
       TRANSACTION LIMIT
    ====================================================================== */

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
     * Step #12 has not happened yet.
     *
     * Rather than throwing a 500, provide a useful state to the portal.
     */

    if (
      tableMissing
    ) {
      return success(
        res,
        {
          member: {
            id:
              member.id,

            email:
              member.email,

            firstName:
              member.first_name ||
              "",

            lastName:
              member.last_name ||
              "",

            fullName:
              member.full_name ||
              [
                member.first_name,
                member.last_name,
              ]
                .filter(Boolean)
                .join(" "),
          },

          card:
            null,

          balance: {
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
          },

          transactions:
            [],

          allowanceTransactions:
            [],

          readiness: {
            stage:
              "database_required",

            accountHolderCreated:
              false,

            accountCreated:
              false,

            cardCreated:
              false,

            nextEndpoint:
              null,

            message:
              "The Card Leo member_cards database table must be created before card features can be activated.",
          },

          lithic:
            getLithicIntegrationStatus(),

          database: {
            memberCardsReady:
              false,

            allowanceLedgerReady:
              false,
          },
        },
        "Card infrastructure is prepared, but the member_cards table has not been created yet."
      );
    }

    /* ======================================================================
       NO CARD ACCOUNT YET
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
        {
          member: {
            id:
              member.id,

            email:
              member.email,

            firstName:
              member.first_name ||
              "",

            lastName:
              member.last_name ||
              "",

            fullName:
              member.full_name ||
              [
                member.first_name,
                member.last_name,
              ]
                .filter(Boolean)
                .join(" "),
          },

          card:
            null,

          balance: {
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
          },

          transactions:
            [],

          allowanceTransactions:
            [],

          readiness,

          lithic:
            getLithicIntegrationStatus(),
        },
        "You do not have a Card Leo card account yet."
      );
    }

    /* ======================================================================
       SAFE LOCAL CARD
    ====================================================================== */

    const localCard =
      sanitizeMemberCardRecord(
        memberCard
      );

    /* ======================================================================
       LOCAL ALLOWANCE LEDGER
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

    /* ======================================================================
       LIVE LITHIC DATA

       We only call Lithic when:
       - enabled
       - configured
       - token exists
    ====================================================================== */

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

    if (
      lithicEnabled &&
      lithicConfigured
    ) {
      /* --------------------------------------------------------------------
         CARD
      -------------------------------------------------------------------- */

      if (
        cardToken
      ) {
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

        /* ------------------------------------------------------------------
           CARD BALANCE
        ------------------------------------------------------------------ */

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

      /* --------------------------------------------------------------------
         ACCOUNT
      -------------------------------------------------------------------- */

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

        /* ------------------------------------------------------------------
           ACCOUNT BALANCES
        ------------------------------------------------------------------ */

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

      /* --------------------------------------------------------------------
         TRANSACTIONS
      -------------------------------------------------------------------- */

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
       SAFE DISPLAY CARD

       Prefer live Lithic card state where available.
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
        liveCard?.lastFour ||
        localCard.lastFour ||
        null,

      maskedNumber:
        liveCard?.lastFour
          ? `•••• •••• •••• ${liveCard.lastFour}`
          : localCard.maskedNumber,

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
       DATABASE FLAGS
    ====================================================================== */

    const database = {
      memberCardsReady:
        true,

      allowanceLedgerReady:
        allowanceLedger.available,
    };

    /* ======================================================================
       PROVIDER STATUS
    ====================================================================== */

    const lithicStatus = {
      ...getLithicIntegrationStatus(),

      hasAccountHolder:
        Boolean(
          memberCard
            .lithic_account_holder_token
        ),

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
       LOG SUCCESS
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "member_card",

        memberId,

        email:
          member.email,

        cardCreated:
          readiness.cardCreated,

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
          liveTransactions.length,

        allowanceTransactionCount:
          safeAllowanceTransactions
            .length,
      }
    );

    /* ======================================================================
       RESPONSE

       IMPORTANT:
       Do not add raw memberCard, raw Lithic response,
       PAN, CVV, or provider tokens here.
    ====================================================================== */

    return success(
      res,
      {
        member: {
          id:
            member.id,

          email:
            member.email,

          firstName:
            member.first_name ||
            "",

          lastName:
            member.last_name ||
            "",

          fullName:
            member.full_name ||
            [
              member.first_name,
              member.last_name,
            ]
              .filter(Boolean)
              .join(" "),

          membership: {
            status:
              member.status ||
              null,

            paymentStatus:
              member.payment_status ||
              null,

            membershipStatus:
              member.membership_status ||
              null,

            approvalStatus:
              member.approval_status ||
              null,

            active:
              isMemberActive(
                member
              ),

            paid:
              isMemberPaid(
                member
              ),
          },
        },

        /* ================================================================
           SAFE CARD
        ================================================================= */

        card:
          displayCard,

        /* ================================================================
           CARD READINESS
        ================================================================= */

        readiness,

        /* ================================================================
           BALANCE / ALLOWANCE
        ================================================================= */

        balance,

        allowance: {
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
              allowanceLedger.available,

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

            net:
              centsToDollars(
                allowanceLedger
                  .netCents
              ),

            netCents:
              allowanceLedger
                .netCents,
          },
        },

        /* ================================================================
           LITHIC TRANSACTIONS
        ================================================================= */

        transactions:
          liveTransactions,

        /* ================================================================
           CARD LEO ALLOWANCE LEDGER
        ================================================================= */

        allowanceTransactions:
          safeAllowanceTransactions,

        /* ================================================================
           LIVE ACCOUNT — SAFE DISPLAY ONLY
        ================================================================= */

        account:
          liveAccount
            ? {
                state:
                  liveAccount.state,

                spendLimit:
                  liveAccount
                    .spendLimit,

                spendLimitDuration:
                  liveAccount
                    .spendLimitDuration,

                createdAt:
                  liveAccount
                    .created,
              }
            : null,

        /* ================================================================
           ACCOUNT BALANCES
        ================================================================= */

        accountBalances:
          accountBalances.map(
            (row) => ({
              type:
                row.type,

              available:
                row.available,

              availableCents:
                row.availableCents,

              pending:
                row.pending,

              pendingCents:
                row.pendingCents,

              currency:
                row.currency,

              updatedAt:
                row.updatedAt,
            })
          ),

        /* ================================================================
           PROVIDER
        ================================================================= */

        lithic:
          lithicStatus,

        /* ================================================================
           DATABASE STATUS
        ================================================================= */

        database,

        /* ================================================================
           MEMBER PORTAL LINKS
        ================================================================= */

        links: {
          cardPage:
            "/portal/card.html",

          createCardholder:
            readiness
              .accountHolderCreated
              ? null
              : "/api/cards/create-cardholder",

          createVirtualCard:
            readiness
              .accountCreated &&
            !readiness
              .cardCreated
              ? "/api/cards/create-virtual-card"
              : null,

          fundAllowance:
            readiness
              .cardCreated
              ? "/api/cards/fund-allowance"
              : null,
        },

        /* ================================================================
           SERVER TIMESTAMP
        ================================================================= */

        generatedAt:
          nowIso(),
      },
      readiness.cardCreated
        ? "Card Leo card information loaded successfully."
        : "Card Leo card account status loaded successfully."
    );
  } catch (
    error
  ) {
    logRequestError(
      req,
      error,
      {
        scope:
          "member_card_unexpected",
      }
    );

    return serverError(
      res,
      "Unable to load your Card Leo card right now.",
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