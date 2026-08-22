// api/cards/card-controls.js

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

import {
  getLithicCard,
  openLithicCard,
  pauseLithicCard,
  closeLithicCard,
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
   MEMBER CARD CONTROLS

   ROUTE
   -----
   POST /api/cards/card-controls

   PURPOSE
   -------
   Allow an authenticated Card Leo member to safely control THEIR OWN
   Card Leo virtual card.

   SUPPORTED ACTIONS
   -----------------
   pause
   resume
   open

   OPTIONAL / DISABLED BY DEFAULT
   ------------------------------
   close

   SECURITY RULES
   --------------
   Browser NEVER sends or controls:

   - member_id
   - Lithic card token
   - Lithic account token
   - Lithic account-holder token
   - provider account
   - another member's card

   Browser only sends:

     {
       "action": "pause"
     }

   or:

     {
       "action": "resume"
     }

   FLOW
   ----
   1. Authenticate member.
   2. Resolve actual Card Leo member from Supabase.
   3. Confirm membership eligibility.
   4. Load member_cards by authenticated member ID.
   5. Resolve Lithic card token server-side.
   6. Confirm Lithic integration is ready.
   7. Read current provider card state.
   8. Apply requested safe control.
   9. Save safe state in Supabase.
   10. Return masked/safe card information.

============================================================================ */

/* ==========================================================================
   TABLES
============================================================================ */

const MEMBER_CARDS_TABLE =
  "member_cards";

/* ==========================================================================
   SESSION
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
   CARD ACTIONS
============================================================================ */

const ACTION_PAUSE =
  "pause";

const ACTION_OPEN =
  "open";

const ACTION_RESUME =
  "resume";

const ACTION_CLOSE =
  "close";

const ALLOWED_ACTIONS =
  new Set([
    ACTION_PAUSE,
    ACTION_OPEN,
    ACTION_RESUME,
    ACTION_CLOSE,
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

function success(
  res,
  data = {},
  message =
    "Card control updated successfully."
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
   BASIC HELPERS
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
      "enabled",
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
      "disabled",
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

  /*
   * Same compatibility behavior as the other Card Leo auth/card routes.
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
          "Please sign in before managing your Card Leo card."
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
   * IMPORTANT:
   *
   * Do not require:
   *
   * session.data.authenticated === true
   *
   * We resolve server-side identity exactly like #8-#11.
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
   * Database error is NOT authentication failure.
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
          "Your Card Leo membership payment must be current before managing your card.",
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
          "Your Card Leo membership must be active before managing your card.",
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
   UPDATE LOCAL CARD STATE
============================================================================ */

async function updateMemberCardRecord({
  recordId,
  state,
  providerState,
}) {
  const timestamp =
    nowIso();

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        MEMBER_CARDS_TABLE
      )
      .update({
        card_status:
          state,

        lithic_card_status:
          providerState ||
          state,

        card_status_updated_at:
          timestamp,

        updated_at:
          timestamp,
      })
      .eq(
        "id",
        recordId
      )
      .select()
      .single();

  if (error) {
    /*
     * Compatibility with a schema that does not yet have
     * lithic_card_status/card_status_updated_at.
     */

    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      const fallback =
        await supabaseAdmin
          .from(
            MEMBER_CARDS_TABLE
          )
          .update({
            card_status:
              state,

            updated_at:
              timestamp,
          })
          .eq(
            "id",
            recordId
          )
          .select()
          .single();

      if (
        fallback.error
      ) {
        throw fallback.error;
      }

      return fallback.data;
    }

    throw error;
  }

  return data;
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
   SAFE CARD
============================================================================ */

function buildSafeCard({
  memberCard,
  liveCard,
}) {
  const providerCard =
    liveCard ||
    {};

  const lastFour =
    normalizeString(
      providerCard
        ?.lastFour ||
      providerCard
        ?.last_four ||
      memberCard
        ?.last_four
    );

  const state =
    normalizeString(
      providerCard
        ?.state ||
      memberCard
        ?.card_status
    ).toUpperCase();

  return {
    exists:
      Boolean(
        memberCard
          ?.lithic_card_token
      ),

    type:
      normalizeString(
        providerCard
          ?.type ||
        memberCard
          ?.card_type
      ) ||
      "VIRTUAL",

    state:
      state ||
      "UNKNOWN",

    paused:
      state ===
      "PAUSED",

    open:
      state ===
      "OPEN",

    closed:
      state ===
      "CLOSED",

    lastFour:
      lastFour ||
      null,

    maskedNumber:
      lastFour
        ? `•••• •••• •••• ${lastFour}`
        : null,

    memo:
      normalizeString(
        providerCard
          ?.memo ||
        memberCard
          ?.card_memo
      ) ||
      "Card Leo Rewards",

    createdAt:
      safeDate(
        providerCard
          ?.created ||
        memberCard
          ?.lithic_card_created_at ||
        memberCard
          ?.created_at
      ),

    updatedAt:
      safeDate(
        memberCard
          ?.updated_at
      ),
  };
}

/* ==========================================================================
   NORMALIZE ACTION
============================================================================ */

function normalizeAction(
  value
) {
  let action =
    normalizeStatus(
      value
    );

  if (
    action ===
      "unpause" ||
    action ===
      "activate" ||
    action ===
      "enable"
  ) {
    action =
      ACTION_RESUME;
  }

  if (
    action ===
      "freeze" ||
    action ===
      "lock"
  ) {
    action =
      ACTION_PAUSE;
  }

  return action;
}

/* ==========================================================================
   CLOSE CARD SETTING

   Card closure is intentionally disabled by default because it is much more
   destructive than pause/resume.
============================================================================ */

function isMemberCardCloseEnabled() {
  return normalizeBoolean(
    process.env
      .CARDLEO_ALLOW_MEMBER_CARD_CLOSE,
    false
  );
}

/* ==========================================================================
   VALIDATE ACTION
============================================================================ */

function validateAction({
  action,
  body,
}) {
  if (!action) {
    return {
      valid:
        false,

      message:
        "A card action is required.",

      code:
        "CARD_ACTION_REQUIRED",
    };
  }

  if (
    !ALLOWED_ACTIONS.has(
      action
    )
  ) {
    return {
      valid:
        false,

      message:
        "Unsupported card action.",

      code:
        "INVALID_CARD_ACTION",
    };
  }

  if (
    action ===
      ACTION_CLOSE
  ) {
    if (
      !isMemberCardCloseEnabled()
    ) {
      return {
        valid:
          false,

        message:
          "Permanent card closure is not enabled for member self-service.",

        code:
          "CARD_CLOSE_DISABLED",
      };
    }

    const confirmation =
      normalizeString(
        body.confirmation ||
        body.confirm ||
        ""
      ).toUpperCase();

    if (
      confirmation !==
      "CLOSE"
    ) {
      return {
        valid:
          false,

        message:
          'Permanent closure requires confirmation: "CLOSE".',

        code:
          "CARD_CLOSE_CONFIRMATION_REQUIRED",
      };
    }
  }

  return {
    valid:
      true,
  };
}

/* ==========================================================================
   LIVE CARD
============================================================================ */

async function getLiveCard(
  cardToken
) {
  const result =
    await getLithicCard(
      cardToken
    );

  const raw =
    isObject(
      result?.data?.data
    )
      ? result.data.data
      : isObject(
          result?.data
        )
        ? result.data
        : {};

  return sanitizeLithicCard(
    raw
  );
}

/* ==========================================================================
   EXECUTE CARD ACTION
============================================================================ */

async function executeCardAction({
  action,
  cardToken,
}) {
  if (
    action ===
    ACTION_PAUSE
  ) {
    return pauseLithicCard(
      cardToken
    );
  }

  if (
    action ===
      ACTION_RESUME ||
    action ===
      ACTION_OPEN
  ) {
    return openLithicCard(
      cardToken
    );
  }

  if (
    action ===
    ACTION_CLOSE
  ) {
    return closeLithicCard(
      cardToken
    );
  }

  const error =
    new Error(
      "Unsupported card action."
    );

  error.code =
    "INVALID_CARD_ACTION";

  error.status =
    400;

  throw error;
}

/* ==========================================================================
   EXPECTED TARGET STATE
============================================================================ */

function getTargetState(
  action
) {
  if (
    action ===
    ACTION_PAUSE
  ) {
    return "PAUSED";
  }

  if (
    action ===
      ACTION_RESUME ||
    action ===
      ACTION_OPEN
  ) {
    return "OPEN";
  }

  if (
    action ===
    ACTION_CLOSE
  ) {
    return "CLOSED";
  }

  return "";
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
        "card_controls",
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
       REQUEST
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const action =
      normalizeAction(
        body.action ||
        body.cardAction ||
        body.card_action
      );

    const validation =
      validateAction({
        action,

        body,
      });

    if (
      !validation.valid
    ) {
      return badRequest(
        res,
        validation.message,
        {
          code:
            validation.code,

          allowedActions: [
            "pause",
            "resume",
          ],

          closeEnabled:
            isMemberCardCloseEnabled(),
        }
      );
    }

    /*
     * SECURITY:
     *
     * Ignore browser-supplied:
     *
     * body.member_id
     * body.memberId
     * body.card_token
     * body.cardToken
     * body.account_token
     * body.accountToken
     */

    /* ======================================================================
       MEMBER CARD
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
        }
      );
    }

    if (
      !memberCard?.id
    ) {
      return notFound(
        res,
        "Your Card Leo card account has not been created yet.",
        {
          code:
            "MEMBER_CARD_NOT_FOUND",

          nextEndpoint:
            "/api/cards/create-cardholder",
        }
      );
    }

    const cardToken =
      normalizeString(
        memberCard
          .lithic_card_token
      );

    if (
      !cardToken
    ) {
      return conflict(
        res,
        "Your Card Leo virtual card has not been created yet.",
        {
          code:
            "LITHIC_CARD_REQUIRED",

          nextEndpoint:
            "/api/cards/create-virtual-card",
        }
      );
    }

    /* ======================================================================
       LITHIC
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return serviceUnavailable(
        res,
        "Card controls are unavailable because Lithic is currently disabled.",
        {
          code:
            "LITHIC_DISABLED",

          lithic:
            getLithicIntegrationStatus(),
        }
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
       CURRENT PROVIDER STATE

       This lets us make pause/resume idempotent.
    ====================================================================== */

    let liveCard;

    try {
      liveCard =
        await getLiveCard(
          cardToken
        );
    } catch (
      error
    ) {
      logRequestError(
        req,
        error,
        {
          scope:
            "card_controls_get_card",

          memberId,

          action,

          environment:
            getLithicEnvironment(),
        }
      );

      return serviceUnavailable(
        res,
        "Card Leo could not verify the current card state.",
        {
          code:
            "LITHIC_CARD_LOOKUP_FAILED",

          authenticated:
            true,
        }
      );
    }

    const currentState =
      normalizeString(
        liveCard
          ?.state
      ).toUpperCase();

    const targetState =
      getTargetState(
        action
      );

    /* ======================================================================
       CLOSED CARD

       Do not attempt to reopen a permanently closed card.
    ====================================================================== */

    if (
      currentState ===
        "CLOSED" &&
      targetState !==
        "CLOSED"
    ) {
      return conflict(
        res,
        "This Card Leo card has been permanently closed and cannot be reopened.",
        {
          code:
            "CARD_ALREADY_CLOSED",

          card:
            buildSafeCard({
              memberCard,

              liveCard,
            }),
        }
      );
    }

    /* ======================================================================
       ALREADY IN REQUESTED STATE
    ====================================================================== */

    if (
      currentState &&
      currentState ===
        targetState
    ) {
      /*
       * Re-sync the safe local status in case Supabase was stale.
       */

      let syncedRecord =
        memberCard;

      try {
        syncedRecord =
          await updateMemberCardRecord({
            recordId:
              memberCard.id,

            state:
              currentState,

            providerState:
              currentState,
          });
      } catch (
        syncError
      ) {
        logRequestError(
          req,
          syncError,
          {
            scope:
              "card_controls_sync_existing_state",

            memberId,

            action,

            currentState,
          }
        );
      }

      return success(
        res,
        {
          authenticated:
            true,

          updated:
            false,

          alreadyInState:
            true,

          action,

          member:
            buildSafeMember(
              member
            ),

          card:
            buildSafeCard({
              memberCard:
                syncedRecord,

              liveCard,
            }),

          lithic:
            getLithicIntegrationStatus(),

          links: {
            card:
              "/portal/card.html",

            memberCard:
              "/api/cards/member-card",
          },
        },
        currentState ===
          "PAUSED"
          ? "Your Card Leo card is already paused."
          : currentState ===
              "OPEN"
            ? "Your Card Leo card is already active."
            : "Your Card Leo card is already in the requested state."
      );
    }

    /* ======================================================================
       EXECUTE
    ====================================================================== */

    let providerResult;

    try {
      providerResult =
        await executeCardAction({
          action,

          cardToken,
        });
    } catch (
      lithicError
    ) {
      logRequestError(
        req,
        lithicError,
        {
          scope:
            "card_controls_lithic_update",

          memberId,

          action,

          currentState,

          targetState,

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

          authenticated:
            true,

          message:
            lithicError
              ?.message ||
            "Card Leo could not update your card.",

          code:
            lithicError
              ?.code ||
            "LITHIC_CARD_CONTROL_FAILED",

          action,

          card: {
            state:
              currentState ||
              null,

            lastFour:
              liveCard
                ?.lastFour ||
              memberCard
                ?.last_four ||
              null,
          },
        }
      );
    }

    /* ======================================================================
       PARSE UPDATED PROVIDER CARD
    ====================================================================== */

    const rawProviderCard =
      isObject(
        providerResult
          ?.data?.data
      )
        ? providerResult
            .data
            .data
        : isObject(
            providerResult
              ?.data
          )
          ? providerResult
              .data
          : {};

    let updatedLiveCard =
      sanitizeLithicCard(
        rawProviderCard
      );

    /*
     * Some provider PATCH responses may not return the complete card.
     * Confirm the final state with one GET when necessary.
     */

    if (
      !updatedLiveCard?.state
    ) {
      try {
        updatedLiveCard =
          await getLiveCard(
            cardToken
          );
      } catch (
        verifyError
      ) {
        logRequestError(
          req,
          verifyError,
          {
            scope:
              "card_controls_verify_updated_card",

            memberId,

            action,
          }
        );
      }
    }

    const finalState =
      normalizeString(
        updatedLiveCard
          ?.state ||
        targetState
      ).toUpperCase();

    /* ======================================================================
       SAVE LOCAL STATE

       Provider operation has already happened.
       If this fails, do NOT repeat the provider action automatically.
    ====================================================================== */

    let savedRecord;

    try {
      savedRecord =
        await updateMemberCardRecord({
          recordId:
            memberCard.id,

          state:
            finalState,

          providerState:
            finalState,
        });
    } catch (
      databaseError
    ) {
      logRequestError(
        req,
        databaseError,
        {
          scope:
            "card_controls_save_state",

          memberId,

          action,

          providerUpdated:
            true,

          finalState,
        }
      );

      return serverError(
        res,
        "Your card was updated by Lithic, but Card Leo could not save the new state. Please refresh My Card before trying another action.",
        {
          code:
            "CARD_PROVIDER_UPDATED_DATABASE_SAVE_FAILED",

          authenticated:
            true,

          providerUpdated:
            true,

          requiresReconciliation:
            true,

          safeCard: {
            state:
              finalState,

            lastFour:
              updatedLiveCard
                ?.lastFour ||
              liveCard
                ?.lastFour ||
              null,
          },
        }
      );
    }

    /* ======================================================================
       LOG
    ====================================================================== */

    logRequestSuccess(
      req,
      {
        scope:
          "card_controls",

        memberId,

        action,

        previousState:
          currentState,

        finalState,

        environment:
          getLithicEnvironment(),
      }
    );

    /* ======================================================================
       SUCCESS RESPONSE
    ====================================================================== */

    let message =
      "Your Card Leo card was updated successfully.";

    if (
      finalState ===
      "PAUSED"
    ) {
      message =
        "Your Card Leo card has been paused.";
    }

    if (
      finalState ===
      "OPEN"
    ) {
      message =
        "Your Card Leo card is active and ready to use.";
    }

    if (
      finalState ===
      "CLOSED"
    ) {
      message =
        "Your Card Leo card has been permanently closed.";
    }

    return success(
      res,
      {
        authenticated:
          true,

        updated:
          true,

        alreadyInState:
          false,

        action,

        previousState:
          currentState ||
          null,

        state:
          finalState,

        member:
          buildSafeMember(
            member
          ),

        card:
          buildSafeCard({
            memberCard:
              savedRecord,

            liveCard:
              updatedLiveCard ||
              liveCard,
          }),

        controls: {
          canPause:
            finalState ===
            "OPEN",

          canResume:
            finalState ===
            "PAUSED",

          canClose:
            isMemberCardCloseEnabled() &&
            finalState !==
              "CLOSED",
        },

        lithic: {
          enabled:
            true,

          configured:
            true,

          environment:
            getLithicEnvironment(),
        },

        links: {
          card:
            "/portal/card.html",

          memberCard:
            "/api/cards/member-card",
        },

        updatedAt:
          nowIso(),
      },
      message
    );
  } catch (
    error
  ) {
    /*
     * IMPORTANT:
     *
     * Database/Lithic failures are not proof the member logged out.
     * Do not clear auth cookies here.
     */

    logRequestError(
      req,
      error,
      {
        scope:
          "card_controls_unexpected",
      }
    );

    console.error(
      "Card Leo card-controls error:",
      error
    );

    return serverError(
      res,
      "Unable to update your Card Leo card right now.",
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