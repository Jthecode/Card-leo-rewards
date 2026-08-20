// api/cards/create-virtual-card.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  createLithicCard,
  isLithicEnabled,
  isLithicConfigured,
  getLithicEnvironment,
  getLithicIntegrationStatus,
  getLithicConfigForDebug,
  getMemberId,
  normalizeString,
  sanitizeLithicCard,
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
   CREATE VIRTUAL CARD

   ROUTE
   -----
   POST /api/cards/create-virtual-card

   FLOW
   ----
   1. Authenticate logged-in Card Leo member
   2. Confirm membership is paid + active
   3. Confirm member_cards table exists
   4. Confirm Lithic account holder exists
   5. Confirm Lithic account token exists
   6. Prevent duplicate virtual-card creation
   7. Create Lithic VIRTUAL card
   8. Save safe card metadata in Supabase
   9. Never expose PAN / CVV to ordinary portal response

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

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

const DEFAULT_CARD_TYPE =
  "VIRTUAL";

const DEFAULT_CARD_STATE =
  "OPEN";

const DEFAULT_CARD_MEMO =
  "Card Leo Rewards";

const ALLOWED_SPEND_LIMIT_DURATIONS =
  new Set([
    "ANNUALLY",
    "FOREVER",
    "MONTHLY",
    "TRANSACTION",
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
    "Card Leo virtual card created successfully."
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

function normalizeStatus(value) {
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

  const normalized =
    normalizeString(
      value
    ).toLowerCase();

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

function nowIso() {
  return new Date()
    .toISOString();
}

function getRequestBody(req) {
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
    )
  );
}

/* ==========================================================================
   COOKIES / SESSION
============================================================================ */

function parseCookies(req) {
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

  return String(header)
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

function readSessionCookie(req) {
  const cookies =
    parseCookies(req);

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
      isObject(data)
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

  return normalizeString(
    data.member?.email ||
      data.profile?.email ||
      data.user?.email ||
      data.email ||
      data.userEmail
  ).toLowerCase();
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
   MEMBERSHIP STATUS
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

  return (
    ACTIVE_MEMBER_STATUSES.has(
      normalizeStatus(
        member?.status
      )
    ) ||
    ACTIVE_MEMBER_STATUSES.has(
      normalizeStatus(
        member?.membership_status
      )
    ) ||
    ACTIVE_APPROVAL_STATUSES.has(
      normalizeStatus(
        member?.approval_status
      )
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
      .from("signups")
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
        .from("signups")
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
    readSessionCookie(req);

  if (!session?.data) {
    return {
      member: null,

      response:
        unauthorized(
          res,
          "Please sign in before creating your Card Leo virtual card."
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
          "Your session expired. Please sign in again."
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
          "Your login session is missing member information."
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
          "Your Card Leo membership payment must be current before a virtual card can be created."
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
          "Your Card Leo membership must be active and approved before a virtual card can be created."
        ),
    };
  }

  return {
    member,
    response: null,
  };
}

/* ==========================================================================
   MEMBER CARD RECORD
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
      data || null,

    tableMissing:
      false,
  };
}

/* ==========================================================================
   SAFE CARD DB RESPONSE
============================================================================ */

function sanitizeMemberCardRecord(
  record = {}
) {
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

    cardType:
      record.card_type ||
      null,

    cardStatus:
      record.card_status ||
      null,

    lastFour:
      record.last_four ||
      null,

    maskedNumber:
      record.last_four
        ? `•••• •••• •••• ${record.last_four}`
        : null,

    memo:
      record.card_memo ||
      null,

    spendLimitCents:
      record.spend_limit_cents ??
      null,

    spendLimit:
      record.spend_limit_cents != null
        ? Number(
            record.spend_limit_cents
          ) / 100
        : null,

    spendLimitDuration:
      record.spend_limit_duration ||
      null,

    createdAt:
      record.created_at ||
      null,

    updatedAt:
      record.updated_at ||
      null,
  };
}

/* ==========================================================================
   CARD CREATION INPUT
============================================================================ */

function normalizeCardInput(
  body = {}
) {
  const memo =
    normalizeString(
      body.memo ||
        body.card_memo ||
        DEFAULT_CARD_MEMO
    ).slice(
      0,
      100
    );

  let state =
    normalizeString(
      body.state ||
        DEFAULT_CARD_STATE
    ).toUpperCase();

  if (
    ![
      "OPEN",
      "PAUSED",
    ].includes(
      state
    )
  ) {
    state =
      DEFAULT_CARD_STATE;
  }

  let spendLimit =
    normalizeInteger(
      body.spend_limit ??
        body.spendLimit ??
        0,
      0
    );

  if (
    spendLimit < 0
  ) {
    spendLimit = 0;
  }

  let spendLimitDuration =
    normalizeString(
      body.spend_limit_duration ||
        body.spendLimitDuration ||
        ""
    ).toUpperCase();

  if (
    spendLimitDuration &&
    !ALLOWED_SPEND_LIMIT_DURATIONS.has(
      spendLimitDuration
    )
  ) {
    spendLimitDuration =
      "";
  }

  const issueOpen =
    normalizeBoolean(
      body.issue_open ??
        body.issueOpen,
      true
    );

  return {
    type:
      DEFAULT_CARD_TYPE,

    memo,

    state:
      issueOpen
        ? state
        : "PAUSED",

    spendLimit,

    spendLimitDuration,
  };
}

/* ==========================================================================
   BUILD LITHIC CARD PAYLOAD
============================================================================ */

function buildLithicCardPayload({
  member,
  memberCard,
  input,
}) {
  const accountToken =
    normalizeString(
      memberCard
        ?.lithic_account_token
    );

  if (!accountToken) {
    const error =
      new Error(
        "Lithic account token is missing."
      );

    error.code =
      "LITHIC_ACCOUNT_TOKEN_MISSING";

    error.status =
      409;

    throw error;
  }

  const payload = {
    type:
      "VIRTUAL",

    state:
      input.state,

    account_token:
      accountToken,

    memo:
      input.memo ||
      `Card Leo - ${
        member.first_name ||
        "Member"
      }`,
  };

  /*
   * Only send a card program token when
   * Lithic/Card Leo has actually configured one.
   */

  const cardProgramToken =
    normalizeString(
      process.env
        .LITHIC_CARD_PROGRAM_TOKEN
    );

  if (
    cardProgramToken
  ) {
    payload.card_program_token =
      cardProgramToken;
  }

  /*
   * Spend limit is in cents.
   *
   * Lithic's card spend_limit is an integer amount.
   */

  if (
    input.spendLimit > 0
  ) {
    payload.spend_limit =
      input.spendLimit;

    payload.spend_limit_duration =
      input.spendLimitDuration ||
      "FOREVER";
  }

  return payload;
}

/* ==========================================================================
   LITHIC RESPONSE
============================================================================ */

function unwrapLithicCard(
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
   SAVE CARD
============================================================================ */

async function saveCreatedCard({
  memberCard,
  lithicCard,
  input,
}) {
  const safeCard =
    sanitizeLithicCard(
      lithicCard
    );

  if (
    !safeCard?.token
  ) {
    const error =
      new Error(
        "Lithic card response did not include a card token."
      );

    error.code =
      "LITHIC_CARD_TOKEN_MISSING";

    throw error;
  }

  const payload = {
    provider:
      "lithic",

    lithic_card_token:
      safeCard.token,

    card_type:
      safeCard.type ||
      "VIRTUAL",

    card_status:
      safeCard.state ||
      input.state ||
      "OPEN",

    last_four:
      safeCard.lastFour ||
      null,

    card_memo:
      safeCard.memo ||
      input.memo ||
      null,

    spend_limit_cents:
      input.spendLimit >
      0
        ? input.spendLimit
        : null,

    spend_limit_duration:
      input.spendLimitDuration ||
      null,

    updated_at:
      nowIso(),

    lithic_card_created_at:
      safeCard.created ||
      nowIso(),

    lithic_last_card_response: {
      token:
        safeCard.token,

      account_token:
        safeCard.accountToken,

      type:
        safeCard.type,

      state:
        safeCard.state,

      last_four:
        safeCard.lastFour,

      memo:
        safeCard.memo,

      created:
        safeCard.created,
    },
  };

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
        memberCard.id
      )
      .select()
      .single();

  if (error) {
    throw error;
  }

  return data;
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  setNoStore?.(res);

  logRequestStart(
    req,
    {
      scope:
        "create_virtual_card",
    }
  );

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

    if (
      tableMissing
    ) {
      return serviceUnavailable(
        res,
        "The Card Leo member_cards table has not been created yet.",
        {
          code:
            "MEMBER_CARDS_TABLE_MISSING",

          nextStep:
            "Complete Step 12 before enabling Lithic card creation.",
        }
      );
    }

    if (!memberCard?.id) {
      return conflict(
        res,
        "A Card Leo Lithic account holder must be created before issuing a virtual card.",
        {
          code:
            "CARDHOLDER_REQUIRED",

          nextEndpoint:
            "/api/cards/create-cardholder",
        }
      );
    }

    /* ======================================================================
       DUPLICATE PROTECTION
    ====================================================================== */

    if (
      normalizeString(
        memberCard
          .lithic_card_token
      )
    ) {
      return success(
        res,
        {
          created:
            false,

          alreadyExists:
            true,

          member: {
            id:
              member.id,

            email:
              member.email,
          },

          card:
            sanitizeMemberCardRecord(
              memberCard
            ),

          lithic:
            getLithicIntegrationStatus(),
        },
        "Your Card Leo virtual card already exists."
      );
    }

    /* ======================================================================
       LITHIC DISABLED
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return success(
        res,
        {
          created:
            false,

          alreadyExists:
            false,

          configurationRequired:
            true,

          cardholderReady:
            Boolean(
              memberCard
                .lithic_account_holder_token
            ),

          accountReady:
            Boolean(
              memberCard
                .lithic_account_token
            ),

          lithic:
            getLithicIntegrationStatus(),

          nextSteps: [
            "Obtain Lithic Sandbox approval and API credentials.",
            "Keep LITHIC_ENABLED=false until Sandbox testing is ready.",
            "Confirm the Lithic account holder is accepted.",
            "Confirm the Lithic account token exists.",
            "Then enable Lithic and create the Card Leo virtual card.",
          ],
        },
        "Virtual-card infrastructure is prepared, but Lithic is currently disabled."
      );
    }

    /* ======================================================================
       CONFIGURATION
    ====================================================================== */

    if (
      !isLithicConfigured()
    ) {
      return serviceUnavailable(
        res,
        "Lithic is enabled but not fully configured.",
        {
          code:
            "LITHIC_NOT_CONFIGURED",

          lithic:
            getLithicIntegrationStatus(),
        }
      );
    }

    /* ======================================================================
       ACCOUNT HOLDER
    ====================================================================== */

    if (
      !normalizeString(
        memberCard
          .lithic_account_holder_token
      )
    ) {
      return conflict(
        res,
        "The Card Leo member does not have a Lithic account holder yet.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_REQUIRED",

          nextEndpoint:
            "/api/cards/create-cardholder",
        }
      );
    }

    if (
      !normalizeString(
        memberCard
          .lithic_account_token
      )
    ) {
      return conflict(
        res,
        "The Lithic account holder exists, but its associated account token has not been saved yet.",
        {
          code:
            "LITHIC_ACCOUNT_TOKEN_REQUIRED",

          requiresReconciliation:
            true,
        }
      );
    }

    const accountHolderStatus =
      normalizeString(
        memberCard
          .lithic_account_holder_status
      ).toUpperCase();

    if (
      accountHolderStatus &&
      accountHolderStatus !==
        "ACCEPTED"
    ) {
      return conflict(
        res,
        "The Lithic account holder is not yet accepted for card issuance.",
        {
          code:
            "LITHIC_ACCOUNT_HOLDER_NOT_ACCEPTED",

          accountHolderStatus,
        }
      );
    }

    /* ======================================================================
       INPUT
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const input =
      normalizeCardInput(
        body
      );

    /* ======================================================================
       CREATE PAYLOAD
    ====================================================================== */

    let cardPayload;

    try {
      cardPayload =
        buildLithicCardPayload({
          member,

          memberCard,

          input,
        });
    } catch (
      payloadError
    ) {
      return badRequest(
        res,
        payloadError?.message ||
          "Unable to prepare card creation.",
        {
          code:
            payloadError?.code ||
            "CARD_PAYLOAD_ERROR",
        }
      );
    }

    /* ======================================================================
       CREATE CARD

       Lithic:
       POST /v1/cards
    ====================================================================== */

    let lithicResult;

    try {
      lithicResult =
        await createLithicCard(
          cardPayload
        );
    } catch (
      lithicError
    ) {
      logRequestError(
        req,
        lithicError,
        {
          scope:
            "lithic_create_virtual_card",

          memberId,

          environment:
            getLithicEnvironment(),
        }
      );

      const status =
        Number(
          lithicError?.status
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
            lithicError?.message ||
            "Lithic could not create the virtual card.",

          code:
            lithicError?.code ||
            "LITHIC_CREATE_CARD_FAILED",

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
       PARSE CARD
    ====================================================================== */

    const lithicCard =
      unwrapLithicCard(
        lithicResult
      );

    const safeCard =
      sanitizeLithicCard(
        lithicCard
      );

    if (
      !safeCard?.token
    ) {
      return serverError(
        res,
        "Lithic returned an unexpected card response.",
        {
          code:
            "LITHIC_CARD_TOKEN_MISSING",
        }
      );
    }

    /* ======================================================================
       SAVE
    ====================================================================== */

    let savedRecord;

    try {
      savedRecord =
        await saveCreatedCard({
          memberCard,

          lithicCard,

          input,
        });
    } catch (
      databaseError
    ) {
      logRequestError(
        req,
        databaseError,
        {
          scope:
            "save_lithic_virtual_card",

          memberId,

          lithicCardCreated:
            true,
        }
      );

      /*
       * Serious reconciliation state:
       *
       * A real card may exist at Lithic,
       * but Card Leo failed to save its token.
       *
       * Do not automatically retry and accidentally
       * create another card.
       */

      return serverError(
        res,
        "Lithic created the virtual card, but Card Leo could not save the card relationship. Do not retry automatically. An administrator must reconcile the Lithic card first.",
        {
          code:
            "LITHIC_CARD_CREATED_DATABASE_SAVE_FAILED",

          requiresReconciliation:
            true,
        }
      );
    }

    /* ======================================================================
       SUCCESS LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "create_virtual_card",

        memberId,

        email:
          member.email,

        lithicEnvironment:
          getLithicEnvironment(),

        cardType:
          safeCard.type,

        cardState:
          safeCard.state,

        lastFour:
          safeCard.lastFour,
      }
    );

    /* ======================================================================
       RESPONSE

       IMPORTANT:
       Never return PAN or CVV here.
    ====================================================================== */

    return success(
      res,
      {
        created:
          true,

        alreadyExists:
          false,

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

          cardCreated:
            true,

          type:
            safeCard.type ||
            "VIRTUAL",

          state:
            safeCard.state ||
            input.state,

          lastFour:
            safeCard.lastFour,

          maskedNumber:
            safeCard.maskedNumber,
        },

        next: {
          memberCardEndpoint:
            "/api/cards/member-card",

          memberCardPage:
            "/portal/card.html",

          message:
            "Your Card Leo virtual card has been created. The member card endpoint will safely display card status, balance information, and activity.",
        },
      },
      "Card Leo virtual card created successfully."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "create_virtual_card_unexpected",
      }
    );

    return serverError(
      res,
      "Unable to create the Card Leo virtual card right now.",
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