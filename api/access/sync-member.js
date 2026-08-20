// api/access/sync-member.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  OPEN_STATUS,
  SUSPEND_STATUS,
  buildAccessAmtImportPayload,
  buildMemberCustomerIdentifier,
  getAccessAmtConfigForDebug,
  getDesiredAccessMemberStatus,
  isAccessActiveMember,
  syncMemberAccessState,
  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
  validateAccessAmtConfiguration,
} from "../../lib/access-amt.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #16
   ACCESS AMT MEMBER SYNC ENDPOINT

   ROUTE
   -----
   POST /api/access/sync-member

   OPTIONAL DEBUG / TEST
   ---------------------
   GET /api/access/sync-member?email=member@example.com&dry_run=1&debug=1

   PURPOSE
   -------
   Sync a Card Leo member with Access Development AMT.

   The same approved Access endpoint is used for:

   - NEW MEMBER
   - MEMBER UPDATE
   - MEMBER SUSPEND

   Access AMT endpoint:
   --------------------
   Stage:
     https://amt-stage.accessdevelopment.com/api/v1/imports

   Production:
     https://amt.accessdevelopment.com/api/v1/imports

   AUTOMATIC STATUS RULE
   ---------------------
   Active / paid Card Leo member
       ↓
   Access member_status = OPEN

   Inactive / cancelled / unpaid / suspended member
       ↓
   Access member_status = SUSPEND

   IMPORTANT
   ---------
   This endpoint does NOT:

   - create rewards
   - create allowances
   - alter Growth Pool
   - create Lithic cards
   - retrieve Access offers

============================================================================ */

/* ==========================================================================
   CONFIG
============================================================================ */

const DEFAULT_TIMEOUT_MS =
  20000;

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

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
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
  message,
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

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeEmail(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeLower(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeUpper(
  value
) {
  return normalizeString(
    value
  ).toUpperCase();
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    typeof value === "number"
  ) {
    return value !== 0;
  }

  const normalized =
    normalizeLower(
      value
    );

  if (
    [
      "1",
      "true",
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
      "0",
      "false",
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

function isValidEmail(
  value
) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(
      value
    )
  );
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

  return date.toISOString();
}

function nowIso() {
  return new Date()
    .toISOString();
}

/* ==========================================================================
   REQUEST BODY
============================================================================ */

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

/* ==========================================================================
   OPTIONAL COLUMN DETECTION
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
      "schema cache"
    ) ||

    message.includes(
      "could not find"
    ) ||

    details.includes(
      "does not exist"
    ) ||

    details.includes(
      "schema cache"
    ) ||

    details.includes(
      "could not find"
    )
  );
}

/* ==========================================================================
   SAFE MEMBER RESPONSE
============================================================================ */

function getSafeMemberForResponse(
  member = {}
) {
  const firstName =
    normalizeString(
      member.first_name
    );

  const lastName =
    normalizeString(
      member.last_name
    );

  const fullName =
    normalizeString(
      member.full_name
    ) ||
    [
      firstName,
      lastName,
    ]
      .filter(Boolean)
      .join(" ");

  return {
    id:
      member.id ||
      null,

    email:
      normalizeEmail(
        member.email
      ),

    first_name:
      firstName,

    last_name:
      lastName,

    full_name:
      fullName,

    phone:
      normalizeString(
        member.phone
      ),

    status:
      normalizeString(
        member.status
      ),

    payment_status:
      normalizeString(
        member.payment_status
      ),

    membership_status:
      normalizeString(
        member.membership_status
      ),

    approval_status:
      normalizeString(
        member.approval_status
      ),

    access_member_identifier:
      normalizeString(
        member
          .access_member_identifier
      ),

    access_member_status:
      normalizeString(
        member
          .access_member_status
      ),

    access_perks_ready:
      Boolean(
        member
          .access_perks_ready
      ),

    access_synced_at:
      safeDate(
        member
          .access_synced_at
      ),

    access_suspended_at:
      safeDate(
        member
          .access_suspended_at
      ),

    access_sync_error:
      normalizeString(
        member
          .access_sync_error
      ),
  };
}

/* ==========================================================================
   MEMBER LOOKUP
============================================================================ */

async function findMemberByEmail(
  email
) {
  const safeEmail =
    normalizeEmail(
      email
    );

  if (
    !safeEmail ||
    !isValidEmail(
      safeEmail
    )
  ) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select("*")
      .ilike(
        "email",
        safeEmail
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    data ||
    null
  );
}

async function findMemberById(
  id
) {
  const safeId =
    normalizeString(
      id
    );

  if (!safeId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select("*")
      .eq(
        "id",
        safeId
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    data ||
    null
  );
}

/* ==========================================================================
   FIND MEMBER FROM REQUEST
============================================================================ */

async function findMember(
  req
) {
  const body =
    getRequestBody(
      req
    );

  const id =
    normalizeString(
      body.id
    ) ||
    normalizeString(
      body.member_id
    ) ||
    normalizeString(
      body.memberId
    ) ||
    normalizeString(
      req.query?.id
    ) ||
    normalizeString(
      req.query?.member_id
    ) ||
    normalizeString(
      req.query?.memberId
    );

  const email =
    normalizeEmail(
      body.email
    ) ||
    normalizeEmail(
      body.email_address
    ) ||
    normalizeEmail(
      body.emailAddress
    ) ||
    normalizeEmail(
      req.query?.email
    ) ||
    normalizeEmail(
      req.query
        ?.email_address
    ) ||
    normalizeEmail(
      req.query
        ?.emailAddress
    );

  if (id) {
    const byId =
      await findMemberById(
        id
      );

    if (
      byId?.id
    ) {
      return byId;
    }
  }

  if (email) {
    const byEmail =
      await findMemberByEmail(
        email
      );

    if (
      byEmail?.id
    ) {
      return byEmail;
    }
  }

  return null;
}

/* ==========================================================================
   REQUEST ACTION
============================================================================ */

function getRequestedAction(
  req
) {
  const body =
    getRequestBody(
      req
    );

  const raw =
    normalizeLower(
      body.action ||
      body.mode ||
      body.access_action ||
      req.query?.action ||
      req.query?.mode ||
      req.query
        ?.access_action ||
      "auto"
    );

  if (
    [
      "open",
      "activate",
      "active",
      "enroll",
      "sync",
    ].includes(
      raw
    )
  ) {
    return "open";
  }

  if (
    [
      "suspend",
      "disable",
      "inactive",
      "cancel",
      "cancelled",
      "canceled",
    ].includes(
      raw
    )
  ) {
    return "suspend";
  }

  return "auto";
}

/* ==========================================================================
   DETERMINE ACCESS STATUS
============================================================================ */

function resolveDesiredAccessStatus({
  member,
  action,
}) {
  if (
    action ===
    "open"
  ) {
    return OPEN_STATUS;
  }

  if (
    action ===
    "suspend"
  ) {
    return SUSPEND_STATUS;
  }

  return getDesiredAccessMemberStatus(
    member
  );
}

/* ==========================================================================
   BUILD ACCESS MEMBER
============================================================================ */

function buildMemberForAccess(
  member
) {
  const accessMemberIdentifier =
    buildMemberCustomerIdentifier(
      member
    );

  return {
    ...member,

    access_member_identifier:
      accessMemberIdentifier,

    member_customer_identifier:
      accessMemberIdentifier,
  };
}

/* ==========================================================================
   SAFE DEBUG ACCESS RESPONSE
============================================================================ */

function sanitizeAccessResponse(
  value
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  /*
   * Access response itself normally does not contain
   * authentication tokens, but we still recursively strip
   * common sensitive keys.
   */

  if (
    Array.isArray(
      value
    )
  ) {
    return value.map(
      sanitizeAccessResponse
    );
  }

  if (
    typeof value !==
    "object"
  ) {
    return value;
  }

  const result =
    {};

  for (
    const [
      key,
      item,
    ] of Object.entries(
      value
    )
  ) {
    const lowered =
      key.toLowerCase();

    if (
      lowered.includes(
        "token"
      ) &&
      ![
        "member_customer_identifier",
      ].includes(
        lowered
      )
    ) {
      result[key] =
        "[REDACTED]";

      continue;
    }

    if (
      lowered.includes(
        "authorization"
      ) ||
      lowered.includes(
        "secret"
      ) ||
      lowered.includes(
        "password"
      )
    ) {
      result[key] =
        "[REDACTED]";

      continue;
    }

    result[key] =
      sanitizeAccessResponse(
        item
      );
  }

  return result;
}

/* ==========================================================================
   SAVE ACCESS SUCCESS
============================================================================ */

async function saveAccessSuccess({
  member,
  accessResult,
  desiredStatus,
}) {
  const now =
    nowIso();

  const accessMemberIdentifier =
    accessResult
      ?.access_member_identifier ||
    buildMemberCustomerIdentifier(
      member
    );

  const isOpen =
    desiredStatus ===
    OPEN_STATUS;

  const payload = {
    access_member_identifier:
      accessMemberIdentifier,

    access_member_status:
      desiredStatus,

    access_synced_at:
      now,

    access_sync_error:
      null,

    access_last_payload:
      accessResult
        ?.access_payload ||
      accessResult
        ?.payload ||
      null,

    access_last_response:
      accessResult
        ?.access_response ||
      accessResult
        ?.response ||
      null,

    access_perks_ready:
      isOpen,

    updated_at:
      now,
  };

  /*
   * Only set suspended timestamp when the member is suspended.
   */

  if (
    desiredStatus ===
    SUSPEND_STATUS
  ) {
    payload.access_suspended_at =
      now;
  } else {
    payload.access_suspended_at =
      null;
  }

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        payload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    !result.error
  ) {
    return (
      result.data ||
      {
        ...member,
        ...payload,
      }
    );
  }

  /*
   * Some older Card Leo databases may still be missing
   * one or more Access columns.
   */

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    throw result.error;
  }

  /*
   * Fallback to the safest common Access fields.
   */

  const fallbackPayload = {
    access_member_identifier:
      accessMemberIdentifier,

    access_member_status:
      desiredStatus,

    access_synced_at:
      now,

    access_sync_error:
      null,

    access_perks_ready:
      isOpen,

    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fallbackPayload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    !result.error
  ) {
    return (
      result.data ||
      {
        ...member,
        ...fallbackPayload,
      }
    );
  }

  /*
   * Absolute fallback:
   * update only updated_at so successful AMT sync is not
   * turned into an API 500 merely because optional columns
   * are not installed yet.
   */

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    throw result.error;
  }

  const minimalPayload = {
    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        minimalPayload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    result.error
  ) {
    throw result.error;
  }

  return (
    result.data ||
    {
      ...member,
      ...minimalPayload,
    }
  );
}

/* ==========================================================================
   SAVE ACCESS FAILURE
============================================================================ */

async function saveAccessFailure({
  member,
  error,
  desiredStatus,
}) {
  const now =
    nowIso();

  const accessMemberIdentifier =
    buildMemberCustomerIdentifier(
      member
    );

  const payload = {
    access_member_identifier:
      accessMemberIdentifier,

    access_member_status:
      "sync_failed",

    access_synced_at:
      null,

    access_sync_error:
      error?.message ||
      "Access AMT sync failed for this member.",

    access_last_payload:
      error?.payload ||
      null,

    access_last_response:
      error?.response ||
      null,

    access_perks_ready:
      false,

    updated_at:
      now,
  };

  /*
   * We do NOT blindly set access_suspended_at on a failed
   * suspension because Access may not actually have accepted it.
   */

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        payload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    !result.error
  ) {
    return (
      result.data ||
      {
        ...member,
        ...payload,
      }
    );
  }

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    throw result.error;
  }

  const fallbackPayload = {
    access_member_status:
      "sync_failed",

    access_sync_error:
      error?.message ||
      "Access AMT sync failed for this member.",

    access_perks_ready:
      false,

    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fallbackPayload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    !result.error
  ) {
    return (
      result.data ||
      {
        ...member,
        ...fallbackPayload,
      }
    );
  }

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    throw result.error;
  }

  const minimalPayload = {
    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        minimalPayload
      )
      .eq(
        "id",
        member.id
      )
      .select("*")
      .maybeSingle();

  if (
    result.error
  ) {
    throw result.error;
  }

  return (
    result.data ||
    {
      ...member,
      ...minimalPayload,
    }
  );
}

/* ==========================================================================
   PERFORM ACCESS SYNC
============================================================================ */

async function performAccessSync({
  member,
  memberForAccess,
  action,
  desiredStatus,
  timeoutMs,
}) {
  /*
   * Explicit action still uses the same underlying AMT endpoint.
   */

  if (
    action ===
    "open"
  ) {
    return syncMemberToAccessAmt(
      memberForAccess,
      {
        timeoutMs,
      }
    );
  }

  if (
    action ===
    "suspend"
  ) {
    return suspendMemberInAccessAmt(
      memberForAccess,
      {
        timeoutMs,
      }
    );
  }

  /*
   * AUTO MODE
   *
   * Updated lib/access-amt.js determines whether the member
   * should be OPEN or SUSPEND.
   */

  return syncMemberAccessState(
    memberForAccess,
    {
      timeoutMs,
    }
  );
}

/* ==========================================================================
   HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  /* ========================================================================
     METHOD
  ======================================================================== */

  if (
    req.method !==
    "POST" &&
    req.method !==
    "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET, POST"
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
          "Method not allowed. Use GET or POST.",
      }
    );
  }

  try {
    /* ======================================================================
       OPTIONS
    ====================================================================== */

    const body =
      getRequestBody(
        req
      );

    const debug =
      normalizeBoolean(
        body.debug ??
        req.query?.debug,
        false
      );

    const dryRun =
      normalizeBoolean(
        body.dry_run ??
        body.dryRun ??
        req.query?.dry_run ??
        req.query?.dryRun,
        false
      );

    const force =
      normalizeBoolean(
        body.force ??
        req.query?.force,
        false
      );

    const requestedTimeoutMs =
      normalizeInteger(
        body.timeout_ms ??
        body.timeoutMs ??
        req.query?.timeout_ms ??
        req.query?.timeoutMs,
        DEFAULT_TIMEOUT_MS
      );

    const timeoutMs =
      Math.min(
        Math.max(
          requestedTimeoutMs,
          5000
        ),
        60000
      );

    const action =
      getRequestedAction(
        req
      );

    /* ======================================================================
       CONFIG VALIDATION
    ====================================================================== */

    const configuration =
      validateAccessAmtConfiguration();

    if (
      !configuration.valid
    ) {
      return serviceUnavailable(
        res,
        "Access AMT configuration is incomplete.",
        {
          code:
            "ACCESS_AMT_CONFIGURATION_INVALID",

          errors:
            configuration.errors,

          config:
            debug
              ? configuration.config
              : undefined,
        }
      );
    }

    /* ======================================================================
       MEMBER
    ====================================================================== */

    const member =
      await findMember(
        req
      );

    if (
      !member?.id
    ) {
      return notFound(
        res,
        "Member not found. Send an email or member ID to sync with Access AMT.",
        {
          code:
            "ACCESS_MEMBER_NOT_FOUND",

          example: {
            method:
              "POST",

            body: {
              email:
                "member@example.com",
            },
          },

          config:
            debug
              ? getAccessAmtConfigForDebug()
              : undefined,
        }
      );
    }

    /* ======================================================================
       ACCESS IDENTIFIER
    ====================================================================== */

    const memberForAccess =
      buildMemberForAccess(
        member
      );

    const accessMemberIdentifier =
      memberForAccess
        .access_member_identifier;

    /* ======================================================================
       STATUS
    ====================================================================== */

    const desiredStatus =
      resolveDesiredAccessStatus({
        member,
        action,
      });

    const currentlyActive =
      isAccessActiveMember(
        member
      );

    /*
     * Explicit OPEN on an inactive member is blocked unless force=true.
     *
     * This prevents manually re-enrolling an unpaid/cancelled member.
     */

    if (
      action === "open" &&
      !currentlyActive &&
      !force
    ) {
      return badRequest(
        res,
        "This member is not currently active/paid. Use automatic sync or set force=true only if you intentionally want to send OPEN.",
        {
          code:
            "ACCESS_OPEN_REQUIRES_ACTIVE_MEMBER",

          member:
            getSafeMemberForResponse(
              memberForAccess
            ),

          current_cardleo_active:
            false,

          desired_access_status:
            desiredStatus,

          config:
            debug
              ? getAccessAmtConfigForDebug()
              : undefined,
        }
      );
    }

    /* ======================================================================
       PAYLOAD PREVIEW
    ====================================================================== */

    const previewPayload =
      buildAccessAmtImportPayload(
        memberForAccess,
        desiredStatus
      );

    /* ======================================================================
       DRY RUN
    ====================================================================== */

    if (
      dryRun
    ) {
      return sendJson(
        res,
        200,
        {
          success:
            true,

          ok:
            true,

          dry_run:
            true,

          message:
            `Dry run only. Member would be sent to Access AMT with status ${desiredStatus}.`,

          action,

          cardleo_member_active:
            currentlyActive,

          desired_access_status:
            desiredStatus,

          member:
            getSafeMemberForResponse(
              memberForAccess
            ),

          access: {
            synced:
              false,

            dry_run:
              true,

            endpoint:
              getAccessAmtConfigForDebug()
                .url,

            member_status:
              desiredStatus,

            member_customer_identifier:
              accessMemberIdentifier,

            payload:
              previewPayload,
          },

          config:
            debug
              ? getAccessAmtConfigForDebug()
              : undefined,
        }
      );
    }

    /* ======================================================================
       SYNC
    ====================================================================== */

    try {
      const accessResult =
        await performAccessSync({
          member,

          memberForAccess,

          action,

          desiredStatus,

          timeoutMs,
        });

      /* ====================================================================
         SAVE SUCCESS
      ==================================================================== */

      const updatedMember =
        await saveAccessSuccess({
          member,

          accessResult,

          desiredStatus,
        });

      /* ====================================================================
         SUCCESS RESPONSE
      ==================================================================== */

      const message =
        desiredStatus ===
        OPEN_STATUS
          ? "Member synced to Access AMT successfully and is OPEN."
          : "Member synced to Access AMT successfully and is SUSPEND.";

      return sendJson(
        res,
        200,
        {
          success:
            true,

          ok:
            true,

          message,

          action,

          cardleo_member_active:
            currentlyActive,

          member:
            getSafeMemberForResponse(
              updatedMember
            ),

          access: {
            synced:
              true,

            member_status:
              desiredStatus,

            member_customer_identifier:
              accessMemberIdentifier,

            perks_ready:
              desiredStatus ===
              OPEN_STATUS,

            status:
              accessResult.status,

            statusText:
              accessResult.statusText,

            url:
              accessResult.url,

            response:
              debug
                ? sanitizeAccessResponse(
                    accessResult.response
                  )
                : undefined,
          },

          config:
            debug
              ? getAccessAmtConfigForDebug()
              : undefined,
        }
      );
    } catch (
      accessError
    ) {
      /* ====================================================================
         SAVE FAILURE
      ==================================================================== */

      let updatedMember =
        member;

      try {
        updatedMember =
          await saveAccessFailure({
            member,

            error:
              accessError,

            desiredStatus,
          });
      } catch (
        saveError
      ) {
        console.error(
          "Card Leo Access AMT failure-state save error:",
          saveError
        );
      }

      /* ====================================================================
         PROVIDER ERROR STATUS
      ==================================================================== */

      const providerStatus =
        Number(
          accessError?.status
        );

      const responseStatus =
        Number.isFinite(
          providerStatus
        ) &&
        providerStatus >= 400 &&
        providerStatus <= 599
          ? providerStatus
          : 502;

      return sendJson(
        res,
        responseStatus,
        {
          success:
            false,

          ok:
            false,

          message:
            accessError?.message ||
            "Access AMT rejected the member sync request.",

          code:
            accessError?.code ||
            "ACCESS_AMT_SYNC_FAILED",

          action,

          desired_access_status:
            desiredStatus,

          member:
            getSafeMemberForResponse(
              updatedMember
            ),

          access: {
            synced:
              false,

            member_status:
              "sync_failed",

            desired_member_status:
              desiredStatus,

            member_customer_identifier:
              accessMemberIdentifier,

            status:
              accessError?.status ||
              null,

            statusText:
              accessError?.statusText ||
              "",

            url:
              accessError?.url ||
              getAccessAmtConfigForDebug()
                .url,

            response:
              debug
                ? sanitizeAccessResponse(
                    accessError?.response
                  )
                : undefined,
          },

          config:
            debug
              ? getAccessAmtConfigForDebug()
              : undefined,
        }
      );
    }
  } catch (
    error
  ) {
    console.error(
      "Card Leo access/sync-member error:",
      error
    );

    return serverError(
      res,
      "Unable to sync member to Access AMT right now.",
      process.env.NODE_ENV ===
        "development"
        ? {
            error:
              error?.message ||
              "Unknown error.",

            code:
              error?.code ||
              null,
          }
        : {}
    );
  }
}