// api/billing/webhook.js

import Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  isAccessActiveMember,
  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
  buildMemberCustomerIdentifier,
} from "../../lib/access-amt.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "";

const STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    })
  : null;

/*
|--------------------------------------------------------------------------
| CARD LEO GROWTH POOL
|--------------------------------------------------------------------------
|
| Every successfully activated NEW Card Leo member contributes $2.00
| to the company Growth Pool.
|
| IMPORTANT:
|
| - The member still pays the normal $25 activation fee.
| - The $2 is NOT deducted from the $25.
| - The $2 is a company-side Growth Pool allocation.
| - The $2 is recorded only after checkout.session.completed.
| - Recurring $20 monthly payments do NOT create another $2 contribution.
| - Each member can only create ONE "member_join" contribution.
|
*/

const GROWTH_POOL_CONTRIBUTION = 2.0;

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

/*
|--------------------------------------------------------------------------
| RESPONSE
|--------------------------------------------------------------------------
*/

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  return res.end(
    JSON.stringify(payload)
  );
}

/*
|--------------------------------------------------------------------------
| NORMALIZATION
|--------------------------------------------------------------------------
*/

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(value)
  );
}

/*
|--------------------------------------------------------------------------
| RAW BODY
|--------------------------------------------------------------------------
*/

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

/*
|--------------------------------------------------------------------------
| DATABASE ERROR HELPERS
|--------------------------------------------------------------------------
*/

function isMissingOptionalColumn(error) {
  const code = String(
    error?.code || ""
  );

  const message = String(
    error?.message || ""
  ).toLowerCase();

  const details = String(
    error?.details || ""
  ).toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    details.includes("does not exist") ||
    details.includes("schema cache") ||
    details.includes("could not find")
  );
}

function isDuplicateError(error) {
  const code = String(
    error?.code || ""
  );

  const message = String(
    error?.message || ""
  ).toLowerCase();

  return (
    code === "23505" ||
    message.includes("duplicate") ||
    message.includes("unique constraint")
  );
}

/*
|--------------------------------------------------------------------------
| STRIPE OBJECT HELPERS
|--------------------------------------------------------------------------
*/

function getStripeCustomerIdFromEventObject(
  object = {}
) {
  return normalizeString(
    object.customer ||
      object.customer_id ||
      object.customerId ||
      object.data?.object?.customer ||
      ""
  );
}

function getStripeSubscriptionIdFromEventObject(
  object = {}
) {
  return normalizeString(
    object.subscription ||
      object.subscription_id ||
      object.subscriptionId ||
      object.id ||
      ""
  );
}

function getEmailFromEventObject(
  object = {}
) {
  return normalizeEmail(
    object.customer_details?.email ||
      object.customer_email ||
      object.receipt_email ||
      object.billing_details?.email ||
      object.metadata?.email ||
      object.metadata?.member_email ||
      object.metadata?.signup_email ||
      ""
  );
}

function getSignupIdFromEventObject(
  object = {}
) {
  return normalizeString(
    object.metadata?.signup_id ||
      object.metadata?.signupId ||
      object.metadata?.member_id ||
      object.metadata?.memberId ||
      object.client_reference_id ||
      ""
  );
}

function getNamePartsFromStripeObject(
  object = {}
) {
  const fullName = normalizeString(
    object.customer_details?.name ||
      object.billing_details?.name ||
      object.metadata?.full_name ||
      object.metadata?.fullName ||
      object.metadata?.name ||
      ""
  );

  const firstName = normalizeString(
    object.metadata?.first_name ||
      object.metadata?.firstName ||
      ""
  );

  const lastName = normalizeString(
    object.metadata?.last_name ||
      object.metadata?.lastName ||
      ""
  );

  if (firstName || lastName) {
    return {
      first_name: firstName,
      last_name: lastName,
      full_name: [
        firstName,
        lastName,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  const parts = fullName
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      first_name: parts[0],
      last_name: parts.slice(1).join(" "),
      full_name: fullName,
    };
  }

  if (parts.length === 1) {
    return {
      first_name: parts[0],
      last_name: "",
      full_name: fullName,
    };
  }

  return {
    first_name: "",
    last_name: "",
    full_name: "",
  };
}

/*
|--------------------------------------------------------------------------
| MEMBER STATUS
|--------------------------------------------------------------------------
*/

function isActiveStatus(member = {}) {
  const status =
    normalizeString(
      member.status
    ).toLowerCase();

  const paymentStatus =
    normalizeString(
      member.payment_status
    ).toLowerCase();

  const membershipStatus =
    normalizeString(
      member.membership_status
    ).toLowerCase();

  const approvalStatus =
    normalizeString(
      member.approval_status
    ).toLowerCase();

  return (
    ACTIVE_STATUSES.has(status) ||
    ACTIVE_STATUSES.has(paymentStatus) ||
    ACTIVE_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
}

/*
|--------------------------------------------------------------------------
| SIGNUP LOOKUPS
|--------------------------------------------------------------------------
*/

async function findSignupById(id) {
  const safeId =
    normalizeString(id);

  if (!safeId) {
    return null;
  }

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("id", safeId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id
    ? data
    : null;
}

async function findSignupByEmail(email) {
  const safeEmail =
    normalizeEmail(email);

  if (
    !safeEmail ||
    !isValidEmail(safeEmail)
  ) {
    return null;
  }

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("signups")
    .select("*")
    .ilike("email", safeEmail)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id
    ? data
    : null;
}

async function findSignupByStripeCustomer(
  customerId
) {
  const safeCustomerId =
    normalizeString(customerId);

  if (!safeCustomerId) {
    return null;
  }

  const result =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .eq(
        "stripe_customer_id",
        safeCustomerId
      )
      .maybeSingle();

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    return null;
  }

  if (result.error) {
    throw result.error;
  }

  return result.data?.id
    ? result.data
    : null;
}

async function findSignupByStripeSubscription(
  subscriptionId
) {
  const safeSubscriptionId =
    normalizeString(subscriptionId);

  if (!safeSubscriptionId) {
    return null;
  }

  const result =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .eq(
        "stripe_subscription_id",
        safeSubscriptionId
      )
      .maybeSingle();

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    return null;
  }

  if (result.error) {
    throw result.error;
  }

  return result.data?.id
    ? result.data
    : null;
}

async function findSignupFromStripeObject(
  object = {}
) {
  const signupId =
    getSignupIdFromEventObject(
      object
    );

  const email =
    getEmailFromEventObject(
      object
    );

  const customerId =
    getStripeCustomerIdFromEventObject(
      object
    );

  const subscriptionId =
    getStripeSubscriptionIdFromEventObject(
      object
    );

  if (signupId) {
    const byId =
      await findSignupById(
        signupId
      );

    if (byId?.id) {
      return byId;
    }
  }

  if (customerId) {
    const byCustomer =
      await findSignupByStripeCustomer(
        customerId
      );

    if (byCustomer?.id) {
      return byCustomer;
    }
  }

  if (subscriptionId) {
    const bySubscription =
      await findSignupByStripeSubscription(
        subscriptionId
      );

    if (bySubscription?.id) {
      return bySubscription;
    }
  }

  if (email) {
    const byEmail =
      await findSignupByEmail(
        email
      );

    if (byEmail?.id) {
      return byEmail;
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| CREATE SIGNUP FROM STRIPE
|--------------------------------------------------------------------------
*/

async function createSignupFromStripeObject(
  object = {}
) {
  const email =
    getEmailFromEventObject(
      object
    );

  if (
    !email ||
    !isValidEmail(email)
  ) {
    return null;
  }

  const names =
    getNamePartsFromStripeObject(
      object
    );

  const now =
    new Date().toISOString();

  const insertPayload = {
    email,

    first_name:
      names.first_name || "",

    last_name:
      names.last_name || "",

    full_name:
      names.full_name || "",

    phone:
      normalizeString(
        object.customer_details?.phone ||
          object.metadata?.phone ||
          ""
      ),

    status: "active",

    payment_status: "paid",

    membership_status: "active",

    approval_status: "approved",

    activation_fee_amount:
      Number(
        object.metadata
          ?.activation_fee_amount ||
          25
      ),

    monthly_fee_amount:
      Number(
        object.metadata
          ?.monthly_fee_amount ||
          20
      ),

    billing_day:
      Number(
        object.metadata
          ?.billing_day ||
          10
      ),

    stripe_customer_id:
      getStripeCustomerIdFromEventObject(
        object
      ),

    stripe_subscription_id:
      normalizeString(
        object.subscription ||
          ""
      ),

    stripe_checkout_session_id:
      normalizeString(
        object.id || ""
      ),

    portal_login_url:
      "/portal/index.html",

    created_at: now,

    updated_at: now,
  };

  let result =
    await supabaseAdmin
      .from("signups")
      .insert(insertPayload)
      .select("*")
      .maybeSingle();

  if (!result.error) {
    return result.data || null;
  }

  /*
  |--------------------------------------------------------------------------
  | DUPLICATE SIGNUP
  |--------------------------------------------------------------------------
  */

  if (
    isDuplicateError(
      result.error
    )
  ) {
    return await findSignupFromStripeObject(
      object
    );
  }

  /*
  |--------------------------------------------------------------------------
  | FALLBACK IF OPTIONAL COLUMNS ARE NOT PRESENT
  |--------------------------------------------------------------------------
  */

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    throw result.error;
  }

  const fallbackPayload = {
    email,

    first_name:
      names.first_name || "",

    last_name:
      names.last_name || "",

    phone:
      normalizeString(
        object.customer_details?.phone ||
          object.metadata?.phone ||
          ""
      ),

    status: "active",

    created_at: now,

    updated_at: now,
  };

  result =
    await supabaseAdmin
      .from("signups")
      .insert(
        fallbackPayload
      )
      .select("*")
      .maybeSingle();

  if (result.error) {
    if (
      isDuplicateError(
        result.error
      )
    ) {
      return await findSignupFromStripeObject(
        object
      );
    }

    throw result.error;
  }

  return result.data || null;
}

/*
|--------------------------------------------------------------------------
| UPDATE MEMBER ACTIVE
|--------------------------------------------------------------------------
*/

async function updateSignupActive(
  member,
  object = {}
) {
  const now =
    new Date().toISOString();

  const names =
    getNamePartsFromStripeObject(
      object
    );

  const customerId =
    getStripeCustomerIdFromEventObject(
      object
    );

  const subscriptionId =
    normalizeString(
      object.subscription
    ) ||
    normalizeString(
      object.id &&
        object.object ===
          "subscription"
        ? object.id
        : ""
    );

  const fullPayload = {
    status: "active",

    payment_status: "paid",

    membership_status: "active",

    approval_status: "approved",

    portal_login_url:
      "/portal/index.html",

    stripe_customer_id:
      customerId ||
      member.stripe_customer_id ||
      "",

    stripe_subscription_id:
      subscriptionId ||
      member.stripe_subscription_id ||
      "",

    stripe_checkout_session_id:
      object.object ===
      "checkout.session"
        ? normalizeString(
            object.id
          )
        : member.stripe_checkout_session_id ||
          "",

    activation_fee_amount:
      Number(
        member.activation_fee_amount ||
          25
      ),

    monthly_fee_amount:
      Number(
        member.monthly_fee_amount ||
          20
      ),

    billing_day:
      Number(
        member.billing_day ||
          10
      ),

    updated_at: now,
  };

  if (
    !member.first_name &&
    names.first_name
  ) {
    fullPayload.first_name =
      names.first_name;
  }

  if (
    !member.last_name &&
    names.last_name
  ) {
    fullPayload.last_name =
      names.last_name;
  }

  if (
    !member.full_name &&
    names.full_name
  ) {
    fullPayload.full_name =
      names.full_name;
  }

  let result =
    await supabaseAdmin
      .from("signups")
      .update(fullPayload)
      .eq("id", member.id)
      .select("*")
      .maybeSingle();

  if (!result.error) {
    return (
      result.data || {
        ...member,
        ...fullPayload,
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
    status: "active",
    updated_at: now,
  };

  result =
    await supabaseAdmin
      .from("signups")
      .update(
        fallbackPayload
      )
      .eq("id", member.id)
      .select("*")
      .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  return (
    result.data || {
      ...member,
      ...fallbackPayload,
    }
  );
}

/*
|--------------------------------------------------------------------------
| UPDATE MEMBER INACTIVE
|--------------------------------------------------------------------------
*/

async function updateSignupPastDueOrInactive(
  member,
  statusPayload = {}
) {
  const now =
    new Date().toISOString();

  const fullPayload = {
    status:
      statusPayload.status ||
      "inactive",

    payment_status:
      statusPayload.payment_status ||
      "past_due",

    membership_status:
      statusPayload.membership_status ||
      "inactive",

    approval_status:
      statusPayload.approval_status ||
      "payment_required",

    access_perks_ready: false,

    updated_at: now,
  };

  let result =
    await supabaseAdmin
      .from("signups")
      .update(fullPayload)
      .eq("id", member.id)
      .select("*")
      .maybeSingle();

  if (!result.error) {
    return (
      result.data || {
        ...member,
        ...fullPayload,
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
    status:
      statusPayload.status ||
      "inactive",

    updated_at: now,
  };

  result =
    await supabaseAdmin
      .from("signups")
      .update(
        fallbackPayload
      )
      .eq("id", member.id)
      .select("*")
      .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  return (
    result.data || {
      ...member,
      ...fallbackPayload,
    }
  );
}

/*
|--------------------------------------------------------------------------
| GROWTH POOL
|--------------------------------------------------------------------------
|
| ONE $2 CONTRIBUTION PER NEW MEMBER.
|
| The primary protection is member_id.
|
| We first check whether this member already has a
| "member_join" contribution.
|
| A unique database constraint should also exist on member_id
| for transaction_type = "member_join".
|
| Stripe event ID is additionally stored for webhook idempotency.
|
*/

async function recordGrowthPoolContribution({
  member,
  session,
  event,
}) {
  if (!member?.id) {
    return {
      success: false,
      added: false,
      amount: 0,
      reason: "member_not_found",
    };
  }

  const stripeEventId =
    normalizeString(
      event?.id
    );

  const checkoutSessionId =
    normalizeString(
      session?.id
    );

  const stripeCustomerId =
    getStripeCustomerIdFromEventObject(
      session
    );

  const stripeSubscriptionId =
    normalizeString(
      session?.subscription
    );

  if (!stripeEventId) {
    return {
      success: false,
      added: false,
      amount: 0,
      reason:
        "missing_stripe_event_id",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | CHECK MEMBER FIRST
  |--------------------------------------------------------------------------
  |
  | This prevents a second checkout from adding another $2 for
  | an existing member.
  |
  */

  let memberContributionQuery =
    await supabaseAdmin
      .from(
        "growth_pool_transactions"
      )
      .select(
        "id, amount, stripe_event_id"
      )
      .eq(
        "member_id",
        member.id
      )
      .eq(
        "transaction_type",
        "member_join"
      )
      .limit(1)
      .maybeSingle();

  if (
    memberContributionQuery.error &&
    isMissingOptionalColumn(
      memberContributionQuery.error
    )
  ) {
    /*
    If the table itself/columns are missing, return a clear error
    instead of pretending the contribution was recorded.
    */

    return {
      success: false,
      added: false,
      amount: 0,
      reason:
        "growth_pool_schema_missing",
      error:
        memberContributionQuery.error
          .message,
    };
  }

  if (
    memberContributionQuery.error
  ) {
    throw memberContributionQuery.error;
  }

  /*
  |--------------------------------------------------------------------------
  | MEMBER ALREADY CONTRIBUTED
  |--------------------------------------------------------------------------
  */

  if (
    memberContributionQuery.data
      ?.id
  ) {
    return {
      success: true,
      added: false,
      duplicate: true,
      amount: 0,
      transaction_id:
        memberContributionQuery
          .data.id,
      reason:
        "member_already_contributed",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | CHECK STRIPE EVENT
  |--------------------------------------------------------------------------
  |
  | This protects against Stripe retrying the exact same webhook event.
  |
  */

  const existingEvent =
    await supabaseAdmin
      .from(
        "growth_pool_transactions"
      )
      .select(
        "id, amount, member_id"
      )
      .eq(
        "stripe_event_id",
        stripeEventId
      )
      .maybeSingle();

  if (
    existingEvent.error &&
    !isMissingOptionalColumn(
      existingEvent.error
    )
  ) {
    throw existingEvent.error;
  }

  if (
    existingEvent.data?.id
  ) {
    return {
      success: true,
      added: false,
      duplicate: true,
      amount: 0,
      transaction_id:
        existingEvent.data.id,
      reason:
        "stripe_event_already_recorded",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | CREATE $2 GROWTH POOL TRANSACTION
  |--------------------------------------------------------------------------
  */

  const transactionPayload = {
    member_id: member.id,

    signup_id: member.id,

    amount:
      GROWTH_POOL_CONTRIBUTION,

    transaction_type:
      "member_join",

    stripe_event_id:
      stripeEventId,

    stripe_checkout_session_id:
      checkoutSessionId || null,

    stripe_customer_id:
      stripeCustomerId || null,

    stripe_subscription_id:
      stripeSubscriptionId || null,

    description:
      "Growth Pool contribution for new Card Leo member.",

    created_at:
      new Date().toISOString(),
  };

  const insertResult =
    await supabaseAdmin
      .from(
        "growth_pool_transactions"
      )
      .insert(
        transactionPayload
      )
      .select("*")
      .maybeSingle();

  /*
  |--------------------------------------------------------------------------
  | DUPLICATE PROTECTION
  |--------------------------------------------------------------------------
  */

  if (
    insertResult.error &&
    isDuplicateError(
      insertResult.error
    )
  ) {
    return {
      success: true,
      added: false,
      duplicate: true,
      amount: 0,
      reason:
        "growth_pool_duplicate_protected",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | MISSING TABLE / SCHEMA
  |--------------------------------------------------------------------------
  */

  if (insertResult.error) {
    if (
      isMissingOptionalColumn(
        insertResult.error
      )
    ) {
      console.error(
        "Growth Pool table/schema is missing:",
        insertResult.error
      );

      return {
        success: false,
        added: false,
        amount: 0,
        reason:
          "growth_pool_schema_missing",
        error:
          insertResult.error.message,
      };
    }

    throw insertResult.error;
  }

  /*
  |--------------------------------------------------------------------------
  | SUCCESS
  |--------------------------------------------------------------------------
  */

  return {
    success: true,

    added: true,

    duplicate: false,

    amount:
      GROWTH_POOL_CONTRIBUTION,

    transaction_id:
      insertResult.data?.id ||
      null,

    stripe_event_id:
      stripeEventId,

    member_id:
      member.id,

    reason:
      "growth_pool_contribution_recorded",
  };
}

/*
|--------------------------------------------------------------------------
| ACCESS AMT
|--------------------------------------------------------------------------
*/

async function saveAccessSuccess(
  member,
  accessResult,
  status = "OPEN"
) {
  const now =
    new Date().toISOString();

  const fullPayload = {
    access_member_identifier:
      accessResult.access_member_identifier ||
      buildMemberCustomerIdentifier(
        member
      ),

    access_member_status:
      status,

    access_synced_at:
      now,

    access_sync_error:
      null,

    access_last_payload:
      accessResult.access_payload ||
      accessResult.payload ||
      null,

    access_last_response:
      accessResult.access_response ||
      accessResult.response ||
      null,

    access_perks_ready:
      status === "OPEN",

    updated_at: now,
  };

  const result =
    await supabaseAdmin
      .from("signups")
      .update(fullPayload)
      .eq("id", member.id);

  if (!result.error) {
    return;
  }

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    console.error(
      "Access success save failed:",
      result.error
    );
  }
}

async function saveAccessFailure(
  member,
  error,
  status = "sync_failed"
) {
  const now =
    new Date().toISOString();

  const fullPayload = {
    access_member_identifier:
      buildMemberCustomerIdentifier(
        member
      ),

    access_member_status:
      status,

    access_sync_error:
      error?.message ||
      "Access AMT request failed for this member.",

    access_last_payload:
      error?.payload ||
      null,

    access_last_response:
      error?.response ||
      null,

    access_perks_ready:
      false,

    updated_at: now,
  };

  const result =
    await supabaseAdmin
      .from("signups")
      .update(fullPayload)
      .eq("id", member.id);

  if (!result.error) {
    return;
  }

  if (
    !isMissingOptionalColumn(
      result.error
    )
  ) {
    console.error(
      "Access failure save failed:",
      result.error
    );
  }
}

async function syncActiveMemberToAccess(
  member
) {
  if (!member?.id) {
    return null;
  }

  if (
    !isAccessActiveMember(member) &&
    !isActiveStatus(member)
  ) {
    return null;
  }

  const accessMemberIdentifier =
    buildMemberCustomerIdentifier(
      member
    );

  const memberForAccess = {
    ...member,

    access_member_identifier:
      accessMemberIdentifier,

    member_customer_identifier:
      accessMemberIdentifier,
  };

  try {
    const accessResult =
      await syncMemberToAccessAmt(
        memberForAccess
      );

    await saveAccessSuccess(
      member,
      accessResult,
      "OPEN"
    );

    return {
      success: true,
      status: "OPEN",
      result: accessResult,
    };
  } catch (error) {
    console.error(
      "Access AMT active sync failed:",
      {
        memberId: member.id,
        email: member.email,
        error,
      }
    );

    await saveAccessFailure(
      member,
      error,
      "sync_failed"
    );

    return {
      success: false,
      status: "sync_failed",
      error:
        error?.message ||
        "Access sync failed.",
    };
  }
}

async function suspendMemberFromAccess(
  member
) {
  if (!member?.id) {
    return null;
  }

  const accessMemberIdentifier =
    buildMemberCustomerIdentifier(
      member
    );

  const memberForAccess = {
    ...member,

    access_member_identifier:
      accessMemberIdentifier,

    member_customer_identifier:
      accessMemberIdentifier,
  };

  try {
    const accessResult =
      await suspendMemberInAccessAmt(
        memberForAccess
      );

    await saveAccessSuccess(
      member,
      accessResult,
      "SUSPEND"
    );

    return {
      success: true,
      status: "SUSPEND",
      result: accessResult,
    };
  } catch (error) {
    console.error(
      "Access AMT suspend failed:",
      {
        memberId: member.id,
        email: member.email,
        error,
      }
    );

    await saveAccessFailure(
      member,
      error,
      "suspend_failed"
    );

    return {
      success: false,
      status: "suspend_failed",
      error:
        error?.message ||
        "Access suspend failed.",
    };
  }
}

/*
|--------------------------------------------------------------------------
| CHECKOUT COMPLETED
|--------------------------------------------------------------------------
|
| THIS IS THE ONLY PLACE WHERE THE $2 NEW-MEMBER CONTRIBUTION IS CREATED.
|
*/

async function handleCheckoutCompleted(
  session,
  event
) {
  let member =
    await findSignupFromStripeObject(
      session
    );

  /*
  |--------------------------------------------------------------------------
  | CREATE MEMBER IF NECESSARY
  |--------------------------------------------------------------------------
  */

  if (!member?.id) {
    member =
      await createSignupFromStripeObject(
        session
      );
  }

  if (!member?.id) {
    return {
      handled: false,
      reason:
        "signup_not_found_or_created",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | ACTIVATE MEMBER
  |--------------------------------------------------------------------------
  */

  const updatedMember =
    await updateSignupActive(
      member,
      session
    );

  /*
  |--------------------------------------------------------------------------
  | GROWTH POOL
  |--------------------------------------------------------------------------
  |
  | IMPORTANT:
  |
  | We do NOT use "wasAlreadyActive" here.
  |
  | Instead, recordGrowthPoolContribution()
  | checks the actual Growth Pool ledger.
  |
  | This is much safer because:
  |
  | 1. Existing members cannot generate another $2.
  | 2. Stripe retries cannot generate another $2.
  | 3. A new member created directly by the webhook still gets $2.
  |
  */

  const growthPool =
    await recordGrowthPoolContribution({
      member:
        updatedMember,

      session,

      event,
    });

  /*
  |--------------------------------------------------------------------------
  | ACCESS AMT
  |--------------------------------------------------------------------------
  */

  const accessSync =
    await syncActiveMemberToAccess(
      updatedMember
    );

  return {
    handled: true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status: "active",

    growth_pool:
      growthPool,

    accessSync,
  };
}

/*
|--------------------------------------------------------------------------
| INVOICE PAID
|--------------------------------------------------------------------------
|
| NO $2 CONTRIBUTION HERE.
|
| invoice.paid also fires for recurring $20 membership payments.
|
*/

async function handleInvoicePaid(
  invoice
) {
  const member =
    await findSignupFromStripeObject(
      invoice
    );

  if (!member?.id) {
    return {
      handled: false,
      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupActive(
      member,
      invoice
    );

  const accessSync =
    await syncActiveMemberToAccess(
      updatedMember
    );

  return {
    handled: true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status: "active",

    growth_pool: {
      added: false,
      amount: 0,
      reason:
        "invoice_payment_no_growth_pool_contribution",
    },

    accessSync,
  };
}

/*
|--------------------------------------------------------------------------
| SUBSCRIPTION UPDATED
|--------------------------------------------------------------------------
*/

async function handleSubscriptionUpdated(
  subscription
) {
  const member =
    await findSignupFromStripeObject(
      subscription
    );

  if (!member?.id) {
    return {
      handled: false,
      reason:
        "signup_not_found",
    };
  }

  const stripeStatus =
    normalizeString(
      subscription.status
    ).toLowerCase();

  /*
  |--------------------------------------------------------------------------
  | ACTIVE / TRIALING
  |--------------------------------------------------------------------------
  */

  if (
    ["active", "trialing"].includes(
      stripeStatus
    )
  ) {
    const updatedMember =
      await updateSignupActive(
        member,
        subscription
      );

    const accessSync =
      await syncActiveMemberToAccess(
        updatedMember
      );

    return {
      handled: true,

      member_id:
        updatedMember.id,

      email:
        updatedMember.email,

      status: "active",

      stripe_status:
        stripeStatus,

      growth_pool: {
        added: false,
        amount: 0,
        reason:
          "subscription_update_no_growth_pool_contribution",
      },

      accessSync,
    };
  }

  /*
  |--------------------------------------------------------------------------
  | INACTIVE / FAILED
  |--------------------------------------------------------------------------
  */

  if (
    [
      "past_due",
      "unpaid",
      "canceled",
      "cancelled",
      "incomplete",
      "incomplete_expired",
    ].includes(
      stripeStatus
    )
  ) {
    const updatedMember =
      await updateSignupPastDueOrInactive(
        member,
        {
          status: "inactive",

          payment_status:
            stripeStatus,

          membership_status:
            "inactive",

          approval_status:
            "payment_required",
        }
      );

    const accessSync =
      await suspendMemberFromAccess(
        updatedMember
      );

    return {
      handled: true,

      member_id:
        updatedMember.id,

      email:
        updatedMember.email,

      status: "inactive",

      stripe_status:
        stripeStatus,

      accessSync,
    };
  }

  return {
    handled: true,

    member_id:
      member.id,

    email:
      member.email,

    status:
      "ignored_subscription_status",

    stripe_status:
      stripeStatus,
  };
}

/*
|--------------------------------------------------------------------------
| INVOICE PAYMENT FAILED
|--------------------------------------------------------------------------
*/

async function handleInvoicePaymentFailed(
  invoice
) {
  const member =
    await findSignupFromStripeObject(
      invoice
    );

  if (!member?.id) {
    return {
      handled: false,
      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupPastDueOrInactive(
      member,
      {
        status: "inactive",

        payment_status:
          "past_due",

        membership_status:
          "inactive",

        approval_status:
          "payment_required",
      }
    );

  const accessSync =
    await suspendMemberFromAccess(
      updatedMember
    );

  return {
    handled: true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status: "past_due",

    accessSync,
  };
}

/*
|--------------------------------------------------------------------------
| SUBSCRIPTION DELETED
|--------------------------------------------------------------------------
*/

async function handleSubscriptionDeleted(
  subscription
) {
  const member =
    await findSignupFromStripeObject(
      subscription
    );

  if (!member?.id) {
    return {
      handled: false,
      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupPastDueOrInactive(
      member,
      {
        status: "inactive",

        payment_status:
          "canceled",

        membership_status:
          "inactive",

        approval_status:
          "canceled",
      }
    );

  const accessSync =
    await suspendMemberFromAccess(
      updatedMember
    );

  return {
    handled: true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status: "canceled",

    accessSync,
  };
}

/*
|--------------------------------------------------------------------------
| MAIN WEBHOOK HANDLER
|--------------------------------------------------------------------------
*/

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
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

  /*
  |--------------------------------------------------------------------------
  | STRIPE CONFIGURATION
  |--------------------------------------------------------------------------
  */

  if (!stripe) {
    return sendJson(
      res,
      500,
      {
        success: false,
        ok: false,

        message:
          "Missing STRIPE_SECRET_KEY environment variable.",
      }
    );
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    return sendJson(
      res,
      500,
      {
        success: false,
        ok: false,

        message:
          "Missing STRIPE_WEBHOOK_SECRET environment variable.",
      }
    );
  }

  let event;

  /*
  |--------------------------------------------------------------------------
  | VERIFY STRIPE SIGNATURE
  |--------------------------------------------------------------------------
  */

  try {
    const rawBody =
      await readRawBody(req);

    const signature =
      req.headers[
        "stripe-signature"
      ];

    if (!signature) {
      return sendJson(
        res,
        400,
        {
          success: false,
          ok: false,

          message:
            "Missing Stripe signature.",
        }
      );
    }

    event =
      stripe.webhooks.constructEvent(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed:",
      error
    );

    return sendJson(
      res,
      400,
      {
        success: false,
        ok: false,

        message:
          `Webhook signature verification failed: ${
            error?.message ||
            "Invalid signature."
          }`,
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | PROCESS EVENT
  |--------------------------------------------------------------------------
  */

  try {
    const object =
      event.data?.object || {};

    let result = {
      handled: false,

      reason:
        "event_not_handled",
    };

    switch (event.type) {
      /*
      |--------------------------------------------------------------------------
      | NEW MEMBER
      |--------------------------------------------------------------------------
      */

      case "checkout.session.completed": {
        result =
          await handleCheckoutCompleted(
            object,
            event
          );

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | RECURRING PAYMENT
      |--------------------------------------------------------------------------
      */

      case "invoice.paid":

      case "invoice.payment_succeeded": {
        result =
          await handleInvoicePaid(
            object
          );

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | FAILED PAYMENT
      |--------------------------------------------------------------------------
      */

      case "invoice.payment_failed": {
        result =
          await handleInvoicePaymentFailed(
            object
          );

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | SUBSCRIPTION CREATED / UPDATED
      |--------------------------------------------------------------------------
      */

      case "customer.subscription.created":

      case "customer.subscription.updated": {
        result =
          await handleSubscriptionUpdated(
            object
          );

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | SUBSCRIPTION CANCELED
      |--------------------------------------------------------------------------
      */

      case "customer.subscription.deleted": {
        result =
          await handleSubscriptionDeleted(
            object
          );

        break;
      }

      /*
      |--------------------------------------------------------------------------
      | OTHER STRIPE EVENTS
      |--------------------------------------------------------------------------
      */

      default: {
        result = {
          handled: false,

          reason:
            "unsupported_event_type",

          type:
            event.type,
        };

        break;
      }
    }

    /*
    |--------------------------------------------------------------------------
    | SUCCESSFUL WEBHOOK RESPONSE
    |--------------------------------------------------------------------------
    */

    return sendJson(
      res,
      200,
      {
        success: true,

        ok: true,

        received: true,

        type:
          event.type,

        event_id:
          event.id,

        result,
      }
    );
  } catch (error) {
    console.error(
      "Card Leo Stripe webhook error:",
      {
        type:
          event?.type,

        event_id:
          event?.id,

        error,
      }
    );

    /*
    |--------------------------------------------------------------------------
    | RETURNING 500 TELLS STRIPE TO RETRY
    |--------------------------------------------------------------------------
    */

    return sendJson(
      res,
      500,
      {
        success: false,

        ok: false,

        received: true,

        type:
          event?.type || "",

        event_id:
          event?.id || "",

        message:
          error?.message ||
          "Stripe webhook processing failed.",
      }
    );
  }
}