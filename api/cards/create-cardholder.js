// api/cards/create-cardholder.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  lithicRequest,
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
   CREATE LITHIC ACCOUNT HOLDER / CARDHOLDER

   ROUTE
   -----
   POST /api/cards/create-cardholder

   PURPOSE
   -------
   1. Authenticate Card Leo member
   2. Confirm member is paid + active
   3. Confirm Lithic integration is enabled
   4. Validate required cardholder information
   5. Prevent duplicate Lithic account-holder creation
   6. Create Lithic account holder
   7. Capture:
        - Lithic account holder token
        - Lithic account token
        - Lithic onboarding status
   8. Store tokens safely in Supabase member_cards
   9. Return ONLY safe information to browser

   IMPORTANT
   ---------
   This route does NOT create the actual virtual card.

   That happens in:

   api/cards/create-virtual-card.js

   This route creates the account holder/account relationship needed first.

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const MEMBER_CARDS_TABLE =
  "member_cards";

const DEFAULT_COUNTRY =
  "USA";

const DEFAULT_WORKFLOW =
  "";

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
    "Lithic account holder created successfully."
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
  message
) {
  return sendJson(
    res,
    403,
    {
      success: false,
      ok: false,
      message,
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
   GENERIC HELPERS
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
    new Date(clean);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date
    .toISOString()
    .slice(0, 10);
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
    new Date(clean);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toISOString();
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
    raw.startsWith("+");

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

  /*
   * US default.
   */

  if (
    digits.length === 10
  ) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
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
    .slice(0, 20);
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

function nowIso() {
  return new Date()
    .toISOString();
}

/* ==========================================================================
   ERROR COMPATIBILITY
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
    )
  );
}

/* ==========================================================================
   SESSION COOKIE
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
   CARD LEO MEMBER STATUS
============================================================================ */

function isMemberPaid(
  member
) {
  return (
    ACTIVE_PAYMENT_STATUSES.has(
      normalizeStatus(
        member?.payment_status
      )
    )
  );
}

function isMemberActive(
  member
) {
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

  const paid =
    isMemberPaid(
      member
    );

  if (!paid) {
    return false;
  }

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
    let fallbackQuery =
      supabaseAdmin
        .from(
          "signups"
        )
        .select(
          fallbackFields
        )
        .limit(1);

    if (memberId) {
      fallbackQuery =
        fallbackQuery.eq(
          "id",
          memberId
        );
    } else {
      fallbackQuery =
        fallbackQuery.eq(
          "email",
          email
        );
    }

    result =
      await fallbackQuery
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

  if (!session?.data) {
    return {
      member: null,

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
          "Member information is missing from your login session."
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
          "Your Card Leo membership payment must be current before a Card Leo allowance card account can be created."
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
          "Your Card Leo membership must be active and approved before a card account can be created."
        ),
    };
  }

  return {
    member,
    response: null,
  };
}

/* ==========================================================================
   MEMBER CARDS RECORD
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

        error: null,
      };
    }

    throw error;
  }

  return {
    record:
      data || null,

    tableMissing:
      false,

    error: null,
  };
}

/* ==========================================================================
   CREATE / UPDATE MEMBER CARDS RECORD
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
  };

  /*
   * Only add created_at for new records.
   */

  if (
    !existingRecord?.id
  ) {
    payload.created_at =
      timestamp;
  }

  /*
   * Optional debugging column.
   *
   * Step 12 can include this JSONB column.
   */

  payload.lithic_last_response =
    lithicResponse ||
    null;

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

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        MEMBER_CARDS_TABLE
      )
      .insert(
        payload
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
   ONBOARDING INPUT
============================================================================ */

function normalizeCardholderInput(
  member,
  rawBody
) {
  const body =
    isObject(rawBody)
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
      body.workflow ||
        process.env
          .LITHIC_ACCOUNT_HOLDER_WORKFLOW ||
        DEFAULT_WORKFLOW
    ).toUpperCase();

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
   * We intentionally DO NOT choose one for the user.
   *
   * Lithic controls which workflow Card Leo is approved to use.
   */

  const knownWorkflows =
    new Set([
      "KYC_EXEMPT",
      "KYC_BYO",
      "KYC_BASIC",
    ]);

  if (!clean) {
    return {
      valid: false,

      message:
        "Lithic account-holder workflow has not been configured. Add LITHIC_ACCOUNT_HOLDER_WORKFLOW only after Lithic confirms the workflow approved for Card Leo Rewards.",
    };
  }

  if (
    !knownWorkflows.has(
      clean
    )
  ) {
    return {
      valid: false,

      message:
        `Unsupported Lithic individual workflow: ${clean}.`,
    };
  }

  return {
    valid: true,
    workflow: clean,
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
      "Phone number is required for cardholder onboarding.";
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
   * BYO KYC requires substantially more identity information.
   *
   * We validate the obvious fields but still rely on Lithic
   * to enforce the exact program-specific schema.
   */

  if (
    input.workflow ===
    "KYC_BYO"
  ) {
    if (!input.dob) {
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
      !input.address.address1
    ) {
      errors.address1 =
        "Street address is required for KYC_BYO.";
    }

    if (
      !input.address.city
    ) {
      errors.city =
        "City is required for KYC_BYO.";
    }

    if (
      !input.address.state
    ) {
      errors.state =
        "State is required for KYC_BYO.";
    }

    if (
      !input.address.postalCode
    ) {
      errors.postalCode =
        "Postal code is required for KYC_BYO.";
    }
  }

  /*
   * Do not hardcode the complete field requirements for
   * KYC_BASIC/KYC_EXEMPT here because the exact approved
   * Lithic program configuration controls them.
   */

  return {
    valid:
      Object.keys(
        errors
      ).length === 0,

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

  if (input.dob) {
    individual.dob =
      input.dob;
  }

  if (
    input.governmentId
  ) {
    individual.government_id =
      input.governmentId;
  }

  const hasAddress =
    Boolean(
      input.address.address1 ||
        input.address.city ||
        input.address.state ||
        input.address.postalCode
    );

  if (hasAddress) {
    individual.address = {
      address1:
        input.address.address1,

      city:
        input.address.city,

      state:
        input.address.state,

      postal_code:
        input.address.postalCode,

      country:
        input.address.country,
    };

    if (
      input.address.address2
    ) {
      individual.address.address2 =
        input.address.address2;
    }
  }

  return individual;
}

/* ==========================================================================
   BUILD ACCOUNT HOLDER PAYLOAD
============================================================================ */

function buildLithicAccountHolderPayload(
  input
) {
  const payload = {
    workflow:
      input.workflow,

    tos_timestamp:
      input.tosTimestamp,

    external_id:
      input.externalId,

    individual:
      buildLithicIndividual(
        input
      ),
  };

  return payload;
}

/* ==========================================================================
   PARSE LITHIC RESPONSE
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

    raw:
      data,
  };
}

/* ==========================================================================
   SAFE RECORD
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

/* ==========================================================================
   EXISTING ACCOUNT HOLDER RESPONSE
============================================================================ */

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
   ROUTE
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
        "create_lithic_cardholder",
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
       CHECK CURRENT MEMBER CARD RECORD
    ====================================================================== */

    const existingResult =
      await getExistingMemberCard(
        memberId
      );

    /*
     * Step 12 creates this table.
     *
     * Before Lithic is enabled, this does not need to block development.
     *
     * Once Lithic is enabled, however, we MUST have somewhere safe to
     * persist the returned account holder/account tokens before creating
     * a financial account.
     */

    if (
      existingResult.tableMissing &&
      isLithicEnabled()
    ) {
      return serviceUnavailable(
        res,
        "The Card Leo member_cards table has not been created yet. Complete Step 12 before enabling Lithic account creation.",
        {
          code:
            "MEMBER_CARDS_TABLE_MISSING",

          nextStep:
            "Create the Supabase member_cards table before setting LITHIC_ENABLED=true.",
        }
      );
    }

    const existingRecord =
      existingResult.record;

    /* ======================================================================
       ALREADY CREATED
    ====================================================================== */

    if (
      hasExistingAccountHolder(
        existingRecord
      )
    ) {
      return successResponse(
        res,
        {
          alreadyExists: true,

          created: false,

          member: {
            id:
              member.id,

            email:
              member.email,

            fullName:
              member.full_name ||
              [
                member.first_name,
                member.last_name,
              ]
                .filter(Boolean)
                .join(" "),
          },

          cardAccount:
            sanitizeMemberCardRecord(
              existingRecord
            ),

          lithic:
            getLithicIntegrationStatus(),
        },
        "Your Card Leo Lithic account holder already exists."
      );
    }

    /* ======================================================================
       LITHIC DISABLED

       This is EXPECTED until Card Leo has Lithic credentials.
    ====================================================================== */

    if (
      !isLithicEnabled()
    ) {
      return successResponse(
        res,
        {
          created: false,

          alreadyExists: false,

          configurationRequired:
            true,

          member: {
            id:
              member.id,

            email:
              member.email,

            fullName:
              member.full_name ||
              [
                member.first_name,
                member.last_name,
              ]
                .filter(Boolean)
                .join(" "),
          },

          lithic:
            getLithicIntegrationStatus(),

          nextSteps: [
            "Obtain Card Leo Rewards Lithic program approval.",
            "Obtain the Lithic Sandbox API key.",
            "Confirm the individual account-holder workflow Card Leo is approved to use.",
            "Create the member_cards Supabase table in Step 12.",
            "Add the Lithic environment variables in Vercel.",
            "Set LITHIC_ENABLED=true only when Sandbox testing is ready.",
          ],
        },
        "Card Leo card infrastructure is prepared, but Lithic is currently disabled."
      );
    }

    /* ======================================================================
       LITHIC CONFIGURED?
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
       MEMBER CARDS TABLE REQUIRED
    ====================================================================== */

    if (
      existingResult.tableMissing
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
       BUILD PAYLOAD
    ====================================================================== */

    const lithicPayload =
      buildLithicAccountHolderPayload(
        input
      );

    /* ======================================================================
       CREATE LITHIC ACCOUNT HOLDER

       Current Lithic endpoint:

       POST /v1/account_holders

       lib/lithic.js already includes /v1 in base URL.
    ====================================================================== */

    let lithicResult;

    try {
      lithicResult =
        await lithicRequest(
          "/account_holders",
          {
            method:
              "POST",

            body:
              lithicPayload,
          }
        );
    } catch (
      lithicError
    ) {
      logRequestError(
        req,
        lithicError,
        {
          scope:
            "lithic_create_account_holder",

          memberId,

          email:
            member.email,

          workflow:
            input.workflow,
        }
      );

      const status =
        Number(
          lithicError?.status
        ) || 502;

      return sendJson(
        res,
        status >= 400 &&
        status <= 599
          ? status
          : 502,
        {
          success: false,

          ok: false,

          message:
            lithicError?.message ||
            "Lithic could not create the account holder.",

          code:
            lithicError?.code ||
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
      !created.accountHolderToken
    ) {
      logRequestError(
        req,
        new Error(
          "Lithic response did not include an account holder token."
        ),
        {
          scope:
            "lithic_account_holder_missing_token",

          memberId,

          workflow:
            input.workflow,
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
       SAVE TOKENS IN SUPABASE

       IMPORTANT:
       Tokens stay server-side.
    ====================================================================== */

    let savedRecord;

    try {
      savedRecord =
        await saveMemberCardRecord({
          member,

          existingRecord,

          accountHolderToken:
            created.accountHolderToken,

          accountToken:
            created.accountToken,

          lithicStatus:
            created.status,

          lithicResponse: {
            status:
              created.status,

            status_reasons:
              created.statusReasons,

            /*
             * Do not persist government ID / request PII here.
             */
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
       * This is intentionally treated as a serious error.
       *
       * Lithic may now contain the account holder, but Card Leo failed
       * to persist its token. Do NOT automatically create another holder.
       */

      return serverError(
        res,
        "The Lithic account holder was created, but Card Leo could not save the account relationship. Do not retry automatically. An administrator should reconcile the Lithic account holder first.",
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

    logRequestSuccess(
      req,
      {
        scope:
          "create_lithic_cardholder",

        memberId,

        email:
          member.email,

        lithicEnvironment:
          getLithicEnvironment(),

        workflow:
          input.workflow,

        lithicStatus:
          created.status,

        hasAccountHolderToken:
          Boolean(
            created
              .accountHolderToken
          ),

        hasAccountToken:
          Boolean(
            created
              .accountToken
          ),
      }
    );

    return successResponse(
      res,
      {
        created: true,

        alreadyExists: false,

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

        cardAccount:
          sanitizeMemberCardRecord(
            savedRecord
          ),

        lithic: {
          enabled: true,

          configured: true,

          environment:
            getLithicEnvironment(),

          status:
            created.status,

          accepted:
            created.status ===
            "ACCEPTED",

          pendingReview:
            created.status ===
              "PENDING_REVIEW",

          statusReasons:
            created.statusReasons,

          /*
           * Do not return raw Lithic tokens to browser.
           */

          accountHolderCreated:
            Boolean(
              created
                .accountHolderToken
            ),

          accountCreated:
            Boolean(
              created
                .accountToken
            ),
        },

        next: {
          canCreateVirtualCard:
            created.status ===
              "ACCEPTED" &&
            Boolean(
              created.accountToken
            ),

          endpoint:
            "/api/cards/create-virtual-card",

          message:
            created.status ===
              "ACCEPTED"
              ? "Your Lithic account is ready for Card Leo virtual card creation."
              : "Your Lithic account holder exists, but onboarding must be accepted before a card can be issued.",
        },
      },
      created.status ===
        "ACCEPTED"
        ? "Card Leo card account created successfully."
        : "Card Leo card account was submitted to Lithic."
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "create_lithic_cardholder_unexpected",
      }
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