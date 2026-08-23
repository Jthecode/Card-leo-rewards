// api/billing/webhook.js

import Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

import {
  isAccessActiveMember,
  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
  buildMemberCustomerIdentifier,
} from "../../lib/access-amt.js";

import {
  GROWTH_POOL_CONTRIBUTION_CENTS,
  centsToDollars,
  processGrowthPoolMemberActivation,
} from "../../lib/growth-pool.js";

/* ==========================================================================
   CARD LEO REWARDS
   STRIPE WEBHOOK
   STEP #33

   PURPOSE
   -------
   Handles Card Leo Stripe billing events.

   RESPONSIBILITIES
   ----------------
   - Verify Stripe webhook signatures
   - Activate paid Card Leo memberships
   - Save Stripe customer/subscription/session IDs
   - Create missing signup records when necessary
   - Keep active recurring members active
   - Mark failed/cancelled memberships inactive
   - Keep Access AMT membership synchronized
   - OPEN Access AMT for active members
   - SUSPEND Access AMT for inactive members
   - Add EXACTLY ONE $2.00 company Growth Pool contribution
     for a qualifying NEW paid member activation

   IMPORTANT GROWTH POOL RULE
   --------------------------
   Growth Pool accounting lives in:

     lib/growth-pool.js

   This webhook MUST NOT manually insert Growth Pool transactions.

   Initial paid membership:
     +$2 Growth Pool

   Recurring $20 monthly invoice:
     +$0 Growth Pool

   Stripe retries:
     +$0 duplicate Growth Pool

   Second checkout for existing member:
     +$0 duplicate Growth Pool

============================================================================ */

/* ==========================================================================
   NEXT.JS / VERCEL WEBHOOK CONFIG
============================================================================ */

export const config = {
  api: {
    bodyParser: false,
  },
};

/* ==========================================================================
   STRIPE
============================================================================ */

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "";

const STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    })
  : null;

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
]);

/* ==========================================================================
   RESPONSE
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
    "no-store, no-cache, must-revalidate"
  );

  return res.end(
    JSON.stringify(
      payload
    )
  );
}

/* ==========================================================================
   NORMALIZATION
============================================================================ */

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeLower(
  value
) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeEmail(
  value
) {
  return normalizeLower(
    value
  );
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

function normalizeNumber(
  value,
  fallback = 0
) {
  const parsed =
    Number(value);

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

function nowIso() {
  return new Date()
    .toISOString();
}

/* ==========================================================================
   RAW STRIPE BODY
============================================================================ */

async function readRawBody(
  req
) {
  const chunks = [];

  for await (
    const chunk
    of req
  ) {
    chunks.push(
      Buffer.isBuffer(
        chunk
      )
        ? chunk
        : Buffer.from(
            chunk
          )
    );
  }

  return Buffer.concat(
    chunks
  );
}

/* ==========================================================================
   DATABASE ERRORS
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

function isDuplicateError(
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

  return (
    code === "23505" ||
    message.includes(
      "duplicate"
    ) ||
    message.includes(
      "unique constraint"
    )
  );
}

/* ==========================================================================
   STRIPE ID HELPERS
============================================================================ */

function extractStripeId(
  value
) {
  if (!value) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return normalizeString(
      value
    );
  }

  if (
    typeof value ===
      "object" &&
    value.id
  ) {
    return normalizeString(
      value.id
    );
  }

  return "";
}

/* ==========================================================================
   STRIPE CUSTOMER
============================================================================ */

function getStripeCustomerIdFromEventObject(
  object = {}
) {
  return (
    extractStripeId(
      object.customer
    ) ||
    normalizeString(
      object.customer_id ||
      object.customerId ||
      object.data
        ?.object
        ?.customer
    )
  );
}

/* ==========================================================================
   STRIPE SUBSCRIPTION
============================================================================ */

function getStripeSubscriptionIdFromEventObject(
  object = {}
) {
  const explicit =
    extractStripeId(
      object.subscription
    ) ||
    normalizeString(
      object.subscription_id ||
      object.subscriptionId
    );

  if (explicit) {
    return explicit;
  }

  /*
   * Only use object.id itself when this object is actually
   * a Stripe subscription.
   *
   * This prevents invoice IDs from accidentally being stored
   * as stripe_subscription_id.
   */

  if (
    normalizeString(
      object.object
    ) ===
    "subscription"
  ) {
    return normalizeString(
      object.id
    );
  }

  return "";
}

/* ==========================================================================
   STRIPE CHECKOUT SESSION
============================================================================ */

function getStripeCheckoutSessionIdFromEventObject(
  object = {}
) {
  if (
    normalizeString(
      object.object
    ) ===
    "checkout.session"
  ) {
    return normalizeString(
      object.id
    );
  }

  return normalizeString(
    object
      .metadata
      ?.stripe_checkout_session_id ||
    object
      .metadata
      ?.checkout_session_id ||
    object
      .metadata
      ?.checkoutSessionId
  );
}

/* ==========================================================================
   STRIPE INVOICE
============================================================================ */

function getStripeInvoiceIdFromEventObject(
  object = {}
) {
  if (
    normalizeString(
      object.object
    ) ===
    "invoice"
  ) {
    return normalizeString(
      object.id
    );
  }

  return normalizeString(
    object.invoice
  );
}

function getInvoiceBillingReason(
  invoice = {}
) {
  return normalizeString(
    invoice.billing_reason ||
    invoice.billingReason
  );
}

/* ==========================================================================
   STRIPE PAYMENT INTENT
============================================================================ */

function getStripePaymentIntentIdFromEventObject(
  object = {}
) {
  return (
    extractStripeId(
      object.payment_intent
    ) ||
    normalizeString(
      object.payment_intent_id ||
      object.paymentIntentId
    )
  );
}

/* ==========================================================================
   EMAIL
============================================================================ */

function getEmailFromEventObject(
  object = {}
) {
  return normalizeEmail(
    object
      .customer_details
      ?.email ||

    object
      .customer_email ||

    object
      .receipt_email ||

    object
      .billing_details
      ?.email ||

    object
      .metadata
      ?.email ||

    object
      .metadata
      ?.member_email ||

    object
      .metadata
      ?.signup_email ||

    ""
  );
}

/* ==========================================================================
   SIGNUP / MEMBER ID
============================================================================ */

function getSignupIdFromEventObject(
  object = {}
) {
  return normalizeString(
    object
      .metadata
      ?.signup_id ||

    object
      .metadata
      ?.signupId ||

    object
      .metadata
      ?.member_id ||

    object
      .metadata
      ?.memberId ||

    object
      .client_reference_id ||

    ""
  );
}

/* ==========================================================================
   STRIPE METADATA
============================================================================ */

function getStripeMetadata(
  object = {}
) {
  return (
    object &&
    typeof object.metadata ===
      "object" &&
    object.metadata !==
      null
  )
    ? object.metadata
    : {};
}

/* ==========================================================================
   CUSTOMER NAME
============================================================================ */

function getNamePartsFromStripeObject(
  object = {}
) {
  const fullName =
    normalizeString(
      object
        .customer_details
        ?.name ||

      object
        .billing_details
        ?.name ||

      object
        .metadata
        ?.full_name ||

      object
        .metadata
        ?.fullName ||

      object
        .metadata
        ?.name ||

      ""
    );

  const firstName =
    normalizeString(
      object
        .metadata
        ?.first_name ||

      object
        .metadata
        ?.firstName ||

      ""
    );

  const lastName =
    normalizeString(
      object
        .metadata
        ?.last_name ||

      object
        .metadata
        ?.lastName ||

      ""
    );

  if (
    firstName ||
    lastName
  ) {
    return {
      first_name:
        firstName,

      last_name:
        lastName,

      full_name:
        [
          firstName,
          lastName,
        ]
          .filter(Boolean)
          .join(" "),
    };
  }

  const parts =
    fullName
      .split(/\s+/)
      .filter(Boolean);

  if (
    parts.length >=
    2
  ) {
    return {
      first_name:
        parts[0],

      last_name:
        parts
          .slice(1)
          .join(" "),

      full_name:
        fullName,
    };
  }

  if (
    parts.length ===
    1
  ) {
    return {
      first_name:
        parts[0],

      last_name:
        "",

      full_name:
        fullName,
    };
  }

  return {
    first_name:
      "",

    last_name:
      "",

    full_name:
      "",
  };
}

/* ==========================================================================
   ACTIVE MEMBER STATUS
============================================================================ */

function isActiveStatus(
  member = {}
) {
  const status =
    normalizeLower(
      member.status
    );

  const paymentStatus =
    normalizeLower(
      member
        .payment_status
    );

  const membershipStatus =
    normalizeLower(
      member
        .membership_status
    );

  const approvalStatus =
    normalizeLower(
      member
        .approval_status
    );

  return (
    ACTIVE_STATUSES.has(
      status
    ) ||

    ACTIVE_STATUSES.has(
      paymentStatus
    ) ||

    ACTIVE_STATUSES.has(
      membershipStatus
    ) ||

    ACTIVE_STATUSES.has(
      approvalStatus
    )
  );
}

/* ==========================================================================
   CHECKOUT PAYMENT STATUS
============================================================================ */

function isCheckoutPaid(
  session = {}
) {
  const paymentStatus =
    normalizeLower(
      session.payment_status
    );

  return (
    paymentStatus ===
      "paid" ||

    paymentStatus ===
      "no_payment_required"
  );
}

/* ==========================================================================
   SIGNUP LOOKUPS
============================================================================ */

async function findSignupById(
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

  return data?.id
    ? data
    : null;
}

/* --------------------------------------------------------------------------
   EMAIL
--------------------------------------------------------------------------- */

async function findSignupByEmail(
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

  return data?.id
    ? data
    : null;
}

/* --------------------------------------------------------------------------
   STRIPE CUSTOMER
--------------------------------------------------------------------------- */

async function findSignupByStripeCustomer(
  customerId
) {
  const safeCustomerId =
    normalizeString(
      customerId
    );

  if (!safeCustomerId) {
    return null;
  }

  const result =
    await supabaseAdmin
      .from(
        "signups"
      )
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

  if (
    result.error
  ) {
    throw result.error;
  }

  return result.data?.id
    ? result.data
    : null;
}

/* --------------------------------------------------------------------------
   STRIPE SUBSCRIPTION
--------------------------------------------------------------------------- */

async function findSignupByStripeSubscription(
  subscriptionId
) {
  const safeSubscriptionId =
    normalizeString(
      subscriptionId
    );

  if (!safeSubscriptionId) {
    return null;
  }

  const result =
    await supabaseAdmin
      .from(
        "signups"
      )
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

  if (
    result.error
  ) {
    throw result.error;
  }

  return result.data?.id
    ? result.data
    : null;
}

/* --------------------------------------------------------------------------
   CHECKOUT SESSION
--------------------------------------------------------------------------- */

async function findSignupByCheckoutSession(
  sessionId
) {
  const safeSessionId =
    normalizeString(
      sessionId
    );

  if (!safeSessionId) {
    return null;
  }

  const result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .select("*")
      .eq(
        "stripe_checkout_session_id",
        safeSessionId
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

  if (
    result.error
  ) {
    throw result.error;
  }

  return result.data?.id
    ? result.data
    : null;
}
/* ==========================================================================
   FIND MEMBER FROM STRIPE EVENT OBJECT
============================================================================ */

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

  const checkoutSessionId =
    getStripeCheckoutSessionIdFromEventObject(
      object
    );

  if (signupId) {
    const member =
      await findSignupById(
        signupId
      );

    if (
      member?.id
    ) {
      return member;
    }
  }

  if (
    checkoutSessionId
  ) {
    const member =
      await findSignupByCheckoutSession(
        checkoutSessionId
      );

    if (
      member?.id
    ) {
      return member;
    }
  }

  if (customerId) {
    const member =
      await findSignupByStripeCustomer(
        customerId
      );

    if (
      member?.id
    ) {
      return member;
    }
  }

  if (
    subscriptionId
  ) {
    const member =
      await findSignupByStripeSubscription(
        subscriptionId
      );

    if (
      member?.id
    ) {
      return member;
    }
  }

  if (email) {
    const member =
      await findSignupByEmail(
        email
      );

    if (
      member?.id
    ) {
      return member;
    }
  }

  return null;
}

/* ==========================================================================
   CREATE MEMBER FROM STRIPE

   This is a safety fallback.

   Normally /api/signup creates the signup BEFORE Stripe Checkout.

============================================================================ */

async function createSignupFromStripeObject(
  object = {},
  {
    activate = true,
  } = {}
) {
  const email =
    getEmailFromEventObject(
      object
    );

  if (
    !email ||
    !isValidEmail(
      email
    )
  ) {
    return null;
  }

  const existing =
    await findSignupByEmail(
      email
    );

  if (
    existing?.id
  ) {
    return existing;
  }

  const names =
    getNamePartsFromStripeObject(
      object
    );

  const now =
    nowIso();

  const customerId =
    getStripeCustomerIdFromEventObject(
      object
    );

  const subscriptionId =
    getStripeSubscriptionIdFromEventObject(
      object
    );

  const checkoutSessionId =
    getStripeCheckoutSessionIdFromEventObject(
      object
    );

  const insertPayload = {
    email,

    first_name:
      names.first_name ||
      "",

    last_name:
      names.last_name ||
      "",

    full_name:
      names.full_name ||
      "",

    phone:
      normalizeString(
        object
          .customer_details
          ?.phone ||

        object
          .metadata
          ?.phone ||

        ""
      ),

    status:
      activate
        ? "active"
        : "payment_pending",

    payment_status:
      activate
        ? "paid"
        : "unpaid",

    membership_status:
      activate
        ? "active"
        : "payment_pending",

    approval_status:
      activate
        ? "approved"
        : "payment_pending",

    activation_fee_amount:
      normalizeNumber(
        object
          .metadata
          ?.activation_fee_amount,
        25
      ),

    monthly_fee_amount:
      normalizeNumber(
        object
          .metadata
          ?.monthly_fee_amount,
        20
      ),

    billing_day:
      normalizeNumber(
        object
          .metadata
          ?.billing_day,
        10
      ),

    stripe_customer_id:
      customerId ||
      null,

    stripe_subscription_id:
      subscriptionId ||
      null,

    stripe_checkout_session_id:
      checkoutSessionId ||
      null,

    portal_login_url:
      "/portal/index.html",

    created_at:
      now,

    updated_at:
      now,
  };

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .insert(
        insertPayload
      )
      .select("*")
      .maybeSingle();

  if (
    !result.error
  ) {
    return (
      result.data ||
      null
    );
  }

  /* ========================================================================
     DUPLICATE
  ======================================================================== */

  if (
    isDuplicateError(
      result.error
    )
  ) {
    return findSignupByEmail(
      email
    );
  }

  /* ========================================================================
     FALLBACK FOR OLDER SIGNUPS SCHEMA
  ======================================================================== */

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
      names.first_name ||
      "",

    last_name:
      names.last_name ||
      "",

    phone:
      normalizeString(
        object
          .customer_details
          ?.phone ||

        object
          .metadata
          ?.phone ||

        ""
      ),

    status:
      activate
        ? "active"
        : "pending",

    created_at:
      now,

    updated_at:
      now,
  };

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .insert(
        fallbackPayload
      )
      .select("*")
      .maybeSingle();

  if (
    result.error
  ) {
    if (
      isDuplicateError(
        result.error
      )
    ) {
      return findSignupByEmail(
        email
      );
    }

    throw result.error;
  }

  return (
    result.data ||
    null
  );
}

/* ==========================================================================
   UPDATE STRIPE LINKAGE WITHOUT ACTIVATING

   Used when checkout.session.completed arrives but payment_status
   is still unpaid for an asynchronous payment method.
============================================================================ */

async function updateSignupStripeLinkage(
  member,
  object = {}
) {
  if (
    !member?.id
  ) {
    return member;
  }

  const now =
    nowIso();

  const payload = {
    stripe_customer_id:
      getStripeCustomerIdFromEventObject(
        object
      ) ||
      member.stripe_customer_id ||
      null,

    stripe_subscription_id:
      getStripeSubscriptionIdFromEventObject(
        object
      ) ||
      member.stripe_subscription_id ||
      null,

    stripe_checkout_session_id:
      getStripeCheckoutSessionIdFromEventObject(
        object
      ) ||
      member.stripe_checkout_session_id ||
      null,

    updated_at:
      now,
  };

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

  result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update({
        updated_at:
          now,
      })
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
    member
  );
}

/* ==========================================================================
   ACTIVATE MEMBER
============================================================================ */

async function updateSignupActive(
  member,
  object = {}
) {
  const now =
    nowIso();

  const names =
    getNamePartsFromStripeObject(
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

  const checkoutSessionId =
    getStripeCheckoutSessionIdFromEventObject(
      object
    );

  const fullPayload = {
    status:
      "active",

    payment_status:
      "paid",

    membership_status:
      "active",

    approval_status:
      "approved",

    portal_login_url:
      "/portal/index.html",

    stripe_customer_id:
      customerId ||
      member.stripe_customer_id ||
      null,

    stripe_subscription_id:
      subscriptionId ||
      member.stripe_subscription_id ||
      null,

    stripe_checkout_session_id:
      checkoutSessionId ||
      member.stripe_checkout_session_id ||
      null,

    activation_fee_amount:
      normalizeNumber(
        member
          .activation_fee_amount ||
        object
          .metadata
          ?.activation_fee_amount,
        25
      ),

    monthly_fee_amount:
      normalizeNumber(
        member
          .monthly_fee_amount ||
        object
          .metadata
          ?.monthly_fee_amount,
        20
      ),

    billing_day:
      normalizeNumber(
        member.billing_day ||
        object
          .metadata
          ?.billing_day,
        10
      ),

    updated_at:
      now,
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
      .from(
        "signups"
      )
      .update(
        fullPayload
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
      "active",

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
    result.error
  ) {
    throw result.error;
  }

  return (
    result.data ||
    {
      ...member,
      ...fallbackPayload,
    }
  );
}

/* ==========================================================================
   INACTIVATE MEMBER
============================================================================ */

async function updateSignupPastDueOrInactive(
  member,
  statusPayload = {}
) {
  const now =
    nowIso();

  const fullPayload = {
    status:
      statusPayload.status ||
      "inactive",

    payment_status:
      statusPayload
        .payment_status ||
      "past_due",

    membership_status:
      statusPayload
        .membership_status ||
      "inactive",

    approval_status:
      statusPayload
        .approval_status ||
      "payment_required",

    access_perks_ready:
      false,

    updated_at:
      now,
  };

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fullPayload
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
    result.error
  ) {
    throw result.error;
  }

  return (
    result.data ||
    {
      ...member,
      ...fallbackPayload,
    }
  );
}

/* ==========================================================================
   ACCESS AMT DATABASE SUCCESS
============================================================================ */

async function saveAccessSuccess(
  member,
  accessResult,
  status = "OPEN"
) {
  const now =
    nowIso();

  const fullPayload = {
    access_member_identifier:
      accessResult
        ?.access_member_identifier ||
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
      status ===
      "OPEN",

    updated_at:
      now,
  };

  if (
    status ===
    "SUSPEND"
  ) {
    fullPayload.access_suspended_at =
      now;
  } else {
    fullPayload.access_suspended_at =
      null;
  }

  let result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fullPayload
      )
      .eq(
        "id",
        member.id
      );

  if (
    !result.error
  ) {
    return;
  }

  /*
   * Retry without access_suspended_at in case that optional
   * column has not been added yet.
   */

  if (
    isMissingOptionalColumn(
      result.error
    )
  ) {
    const fallbackPayload = {
      access_member_identifier:
        fullPayload
          .access_member_identifier,

      access_member_status:
        fullPayload
          .access_member_status,

      access_synced_at:
        fullPayload
          .access_synced_at,

      access_sync_error:
        null,

      access_perks_ready:
        fullPayload
          .access_perks_ready,

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
        );

    if (
      !result.error
    ) {
      return;
    }
  }

  console.error(
    "Access success save failed:",
    result.error
  );
}

/* ==========================================================================
   ACCESS AMT DATABASE FAILURE
============================================================================ */

async function saveAccessFailure(
  member,
  error,
  status = "sync_failed"
) {
  const now =
    nowIso();

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

    updated_at:
      now,
  };

  const result =
    await supabaseAdmin
      .from(
        "signups"
      )
      .update(
        fullPayload
      )
      .eq(
        "id",
        member.id
      );

  if (
    !result.error
  ) {
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
/* ==========================================================================
   ACCESS OPEN
============================================================================ */

async function syncActiveMemberToAccess(
  member
) {
  if (
    !member?.id
  ) {
    return null;
  }

  if (
    !isAccessActiveMember(
      member
    ) &&
    !isActiveStatus(
      member
    )
  ) {
    return {
      success:
        false,

      skipped:
        true,

      status:
        "not_active",

      reason:
        "member_not_active",
    };
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
      success:
        true,

      status:
        "OPEN",

      memberIdentifier:
        accessMemberIdentifier,

      result:
        accessResult,
    };
  } catch (
    error
  ) {
    console.error(
      "Access AMT active sync failed:",
      {
        memberId:
          member.id,

        email:
          member.email,

        error,
      }
    );

    await saveAccessFailure(
      member,
      error,
      "sync_failed"
    );

    /*
     * Membership/payment itself succeeded.
     *
     * Access can be retried separately via /api/access/sync-member.
     */

    return {
      success:
        false,

      status:
        "sync_failed",

      error:
        error?.message ||
        "Access sync failed.",
    };
  }
}

/* ==========================================================================
   ACCESS SUSPEND
============================================================================ */

async function suspendMemberFromAccess(
  member
) {
  if (
    !member?.id
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
      await suspendMemberInAccessAmt(
        memberForAccess
      );

    await saveAccessSuccess(
      member,
      accessResult,
      "SUSPEND"
    );

    return {
      success:
        true,

      status:
        "SUSPEND",

      memberIdentifier:
        accessMemberIdentifier,

      result:
        accessResult,
    };
  } catch (
    error
  ) {
    console.error(
      "Access AMT suspend failed:",
      {
        memberId:
          member.id,

        email:
          member.email,

        error,
      }
    );

    await saveAccessFailure(
      member,
      error,
      "suspend_failed"
    );

    return {
      success:
        false,

      status:
        "suspend_failed",

      error:
        error?.message ||
        "Access suspend failed.",
    };
  }
}

/* ==========================================================================
   CENTRAL GROWTH POOL PROCESSING

   THIS IS THE ONLY GROWTH POOL ENTRY POINT IN THIS WEBHOOK.

   All duplicate protection and accounting are handled by:

     lib/growth-pool.js
============================================================================ */

async function processGrowthPool({
  member,
  object,
  event,
} = {}) {
  if (
    !member?.id
  ) {
    return {
      success:
        false,

      created:
        false,

      skipped:
        true,

      reason:
        "member_not_found",
    };
  }

  const checkoutSessionId =
    getStripeCheckoutSessionIdFromEventObject(
      object
    );

  const invoiceId =
    getStripeInvoiceIdFromEventObject(
      object
    );

  const invoiceBillingReason =
    getInvoiceBillingReason(
      object
    );

  const subscriptionId =
    getStripeSubscriptionIdFromEventObject(
      object
    );

  const customerId =
    getStripeCustomerIdFromEventObject(
      object
    );

  const paymentIntentId =
    getStripePaymentIntentIdFromEventObject(
      object
    );

  const metadata =
    getStripeMetadata(
      object
    );

  const result =
    await processGrowthPoolMemberActivation({
      member,

      stripeEventId:
        normalizeString(
          event?.id
        ),

      stripeEventType:
        normalizeString(
          event?.type
        ),

      checkoutSessionId,

      invoiceId,

      invoiceBillingReason,

      subscriptionId,

      subscriptionStatus:
        normalizeString(
          object?.status
        ),

      customerId,

      paymentIntentId,

      metadata,
    });

  return {
    ...result,

    configuredContributionCents:
      GROWTH_POOL_CONTRIBUTION_CENTS,

    configuredContribution:
      centsToDollars(
        GROWTH_POOL_CONTRIBUTION_CENTS
      ),
  };
}

/* ==========================================================================
   CHECKOUT COMPLETED

   checkout.session.completed does NOT always mean the payment
   has fully settled for every payment method.

   If payment_status is unpaid:
     - preserve/link member
     - wait for async_payment_succeeded
     - do NOT activate
     - do NOT credit Growth Pool
============================================================================ */

async function handleCheckoutCompleted(
  session,
  event
) {
  let member =
    await findSignupFromStripeObject(
      session
    );

  const paid =
    isCheckoutPaid(
      session
    );

  /* ========================================================================
     CREATE FALLBACK MEMBER IF NEEDED
  ======================================================================== */

  if (
    !member?.id
  ) {
    member =
      await createSignupFromStripeObject(
        session,
        {
          activate:
            paid,
        }
      );
  }

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found_or_created",
    };
  }

  /* ========================================================================
     ASYNC PAYMENT STILL PENDING
  ======================================================================== */

  if (!paid) {
    const linkedMember =
      await updateSignupStripeLinkage(
        member,
        session
      );

    return {
      handled:
        true,

      member_id:
        linkedMember.id,

      email:
        linkedMember.email,

      status:
        "payment_pending",

      payment_status:
        normalizeString(
          session
            .payment_status ||
          "unpaid"
        ),

      growth_pool: {
        success:
          true,

        created:
          false,

        skipped:
          true,

        amount:
          0,

        reason:
          "checkout_payment_not_settled",
      },

      accessSync: {
        success:
          false,

        skipped:
          true,

        reason:
          "payment_not_settled",
      },
    };
  }

  /* ========================================================================
     ACTIVATE
  ======================================================================== */

  const updatedMember =
    await updateSignupActive(
      member,
      session
    );

  /* ========================================================================
     GROWTH POOL

     Central helper protects against:
     - duplicate Stripe event
     - duplicate Checkout Session
     - duplicate member activation
  ======================================================================== */

  const growthPool =
    await processGrowthPool({
      member:
        updatedMember,

      object:
        session,

      event,
    });

  /* ========================================================================
     ACCESS
  ======================================================================== */

  const accessSync =
    await syncActiveMemberToAccess(
      updatedMember
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "active",

    payment_status:
      "paid",

    growth_pool:
      growthPool,

    accessSync,
  };
}

/* ==========================================================================
   ASYNC CHECKOUT PAYMENT SUCCEEDED

   Some payment methods complete checkout before payment settles.

   This event is the paid activation fallback.
============================================================================ */

async function handleCheckoutAsyncPaymentSucceeded(
  session,
  event
) {
  let member =
    await findSignupFromStripeObject(
      session
    );

  if (
    !member?.id
  ) {
    member =
      await createSignupFromStripeObject(
        session,
        {
          activate:
            true,
        }
      );
  }

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found_or_created",
    };
  }

  const updatedMember =
    await updateSignupActive(
      member,
      session
    );

  const growthPool =
    await processGrowthPool({
      member:
        updatedMember,

      object:
        session,

      event,
    });

  const accessSync =
    await syncActiveMemberToAccess(
      updatedMember
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "active",

    payment_status:
      "paid",

    growth_pool:
      growthPool,

    accessSync,
  };
}

/* ==========================================================================
   ASYNC CHECKOUT PAYMENT FAILED
============================================================================ */

async function handleCheckoutAsyncPaymentFailed(
  session
) {
  const member =
    await findSignupFromStripeObject(
      session
    );

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupPastDueOrInactive(
      member,
      {
        status:
          "payment_pending",

        payment_status:
          "payment_failed",

        membership_status:
          "payment_pending",

        approval_status:
          "payment_required",
      }
    );

  const accessSync =
    await suspendMemberFromAccess(
      updatedMember
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "payment_failed",

    growth_pool: {
      success:
        true,

      created:
        false,

      skipped:
        true,

      amount:
        0,

      reason:
        "checkout_payment_failed",
    },

    accessSync,
  };
}

/* ==========================================================================
   INVOICE PAID

   IMPORTANT
   ---------

   subscription_create:
     May qualify as fallback initial activation.

   subscription_cycle:
     NEVER adds another $2.

   Member-level duplicate protection also ensures that if
   checkout.session.completed already added the $2, this invoice
   cannot add another $2.
============================================================================ */

async function handleInvoicePaid(
  invoice,
  event
) {
  const member =
    await findSignupFromStripeObject(
      invoice
    );

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupActive(
      member,
      invoice
    );

  /*
   * Safe to call for every successful invoice.
   *
   * lib/growth-pool.js will return:
   *
   * subscription_create → initial activation fallback
   * subscription_cycle  → skipped
   * already credited    → duplicate prevented
   */

  const growthPool =
    await processGrowthPool({
      member:
        updatedMember,

      object:
        invoice,

      event,
    });

  const accessSync =
    await syncActiveMemberToAccess(
      updatedMember
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "active",

    invoice_id:
      getStripeInvoiceIdFromEventObject(
        invoice
      ),

    billing_reason:
      getInvoiceBillingReason(
        invoice
      ),

    growth_pool:
      growthPool,

    accessSync,
  };
}

/* ==========================================================================
   INVOICE PAYMENT FAILED
============================================================================ */

async function handleInvoicePaymentFailed(
  invoice
) {
  const member =
    await findSignupFromStripeObject(
      invoice
    );

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupPastDueOrInactive(
      member,
      {
        status:
          "inactive",

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
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "past_due",

    growth_pool: {
      success:
        true,

      created:
        false,

      skipped:
        true,

      amount:
        0,

      reason:
        "failed_invoice_never_credits_growth_pool",
    },

    accessSync,
  };
}

/* ==========================================================================
   SUBSCRIPTION CREATED / UPDATED
============================================================================ */

async function handleSubscriptionUpdated(
  subscription
) {
  const member =
    await findSignupFromStripeObject(
      subscription
    );

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const stripeStatus =
    normalizeLower(
      subscription.status
    );

  /* ========================================================================
     ACTIVE
  ======================================================================== */

  if (
    [
      "active",
      "trialing",
    ].includes(
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
      handled:
        true,

      member_id:
        updatedMember.id,

      email:
        updatedMember.email,

      status:
        "active",

      stripe_status:
        stripeStatus,

      growth_pool: {
        success:
          true,

        created:
          false,

        skipped:
          true,

        amount:
          0,

        reason:
          "subscription_status_event_does_not_credit_growth_pool",
      },

      accessSync,
    };
  }
    /* ========================================================================
     PAST DUE / UNPAID / INCOMPLETE
  ======================================================================== */

  if (
    [
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ].includes(
      stripeStatus
    )
  ) {
    const updatedMember =
      await updateSignupPastDueOrInactive(
        member,
        {
          status:
            "inactive",

          payment_status:
            stripeStatus ===
            "past_due"
              ? "past_due"
              : "unpaid",

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
      handled:
        true,

      member_id:
        updatedMember.id,

      email:
        updatedMember.email,

      status:
        "inactive",

      stripe_status:
        stripeStatus,

      growth_pool: {
        success:
          true,

        created:
          false,

        skipped:
          true,

        amount:
          0,

        reason:
          "subscription_status_event_does_not_credit_growth_pool",
      },

      accessSync,
    };
  }

  /* ========================================================================
     CANCELED
  ======================================================================== */

  if (
    stripeStatus ===
    "canceled" ||
    stripeStatus ===
    "cancelled"
  ) {
    const updatedMember =
      await updateSignupPastDueOrInactive(
        member,
        {
          status:
            "cancelled",

          payment_status:
            "cancelled",

          membership_status:
            "cancelled",

          approval_status:
            "cancelled",
        }
      );

    const accessSync =
      await suspendMemberFromAccess(
        updatedMember
      );

    return {
      handled:
        true,

      member_id:
        updatedMember.id,

      email:
        updatedMember.email,

      status:
        "cancelled",

      stripe_status:
        stripeStatus,

      growth_pool: {
        success:
          true,

        created:
          false,

        skipped:
          true,

        amount:
          0,

        reason:
          "subscription_cancelled_never_credits_growth_pool",
      },

      accessSync,
    };
  }

  /* ========================================================================
     UNKNOWN / NON-ACTIONABLE STATUS
  ======================================================================== */

  return {
    handled:
      true,

    member_id:
      member.id,

    email:
      member.email,

    status:
      normalizeString(
        member.status
      ),

    stripe_status:
      stripeStatus,

    growth_pool: {
      success:
        true,

      created:
        false,

      skipped:
        true,

      amount:
        0,

      reason:
        "subscription_status_not_actionable",
    },

    accessSync: {
      success:
        false,

      skipped:
        true,

      reason:
        "subscription_status_not_actionable",
    },
  };
}

/* ==========================================================================
   SUBSCRIPTION DELETED
============================================================================ */

async function handleSubscriptionDeleted(
  subscription
) {
  const member =
    await findSignupFromStripeObject(
      subscription
    );

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupPastDueOrInactive(
      member,
      {
        status:
          "cancelled",

        payment_status:
          "cancelled",

        membership_status:
          "cancelled",

        approval_status:
          "cancelled",
      }
    );

  const accessSync =
    await suspendMemberFromAccess(
      updatedMember
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      "cancelled",

    stripe_status:
      normalizeLower(
        subscription.status ||
        "canceled"
      ),

    growth_pool: {
      success:
        true,

      created:
        false,

      skipped:
        true,

      amount:
        0,

      reason:
        "subscription_deleted_never_credits_growth_pool",
    },

    accessSync,
  };
}

/* ==========================================================================
   CUSTOMER UPDATED

   This event does not change membership state.

   We only use it to preserve Stripe customer linkage where possible.
============================================================================ */

async function handleCustomerUpdated(
  customer
) {
  const customerId =
    extractStripeId(
      customer
    );

  const email =
    getEmailFromEventObject(
      customer
    ) ||
    normalizeEmail(
      customer.email
    );

  let member =
    null;

  if (customerId) {
    member =
      await findSignupByStripeCustomer(
        customerId
      );
  }

  if (
    !member?.id &&
    email
  ) {
    member =
      await findSignupByEmail(
        email
      );
  }

  if (
    !member?.id
  ) {
    return {
      handled:
        false,

      reason:
        "signup_not_found",
    };
  }

  const updatedMember =
    await updateSignupStripeLinkage(
      member,
      {
        ...customer,

        customer:
          customerId,
      }
    );

  return {
    handled:
      true,

    member_id:
      updatedMember.id,

    email:
      updatedMember.email,

    status:
      normalizeString(
        updatedMember.status
      ),

    growth_pool: {
      success:
        true,

      created:
        false,

      skipped:
        true,

      amount:
        0,

      reason:
        "customer_update_does_not_credit_growth_pool",
    },

    accessSync: {
      success:
        false,

      skipped:
        true,

      reason:
        "customer_update_does_not_change_access",
    },
  };
}

/* ==========================================================================
   EVENT ROUTER
============================================================================ */

async function processStripeEvent(
  event
) {
  const object =
    event?.data?.object ||
    {};

  switch (
    event.type
  ) {
    /* ======================================================================
       CHECKOUT
    ====================================================================== */

    case "checkout.session.completed":
      return handleCheckoutCompleted(
        object,
        event
      );

    case "checkout.session.async_payment_succeeded":
      return handleCheckoutAsyncPaymentSucceeded(
        object,
        event
      );

    case "checkout.session.async_payment_failed":
      return handleCheckoutAsyncPaymentFailed(
        object,
        event
      );

    /* ======================================================================
       INVOICES
    ====================================================================== */

    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoicePaid(
        object,
        event
      );

    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(
        object
      );

    /* ======================================================================
       SUBSCRIPTIONS
    ====================================================================== */

    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(
        object
      );

    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(
        object
      );

    /* ======================================================================
       CUSTOMER
    ====================================================================== */

    case "customer.updated":
      return handleCustomerUpdated(
        object
      );

    /* ======================================================================
       EVERYTHING ELSE
    ====================================================================== */

    default:
      return {
        handled:
          false,

        ignored:
          true,

        reason:
          "event_type_not_used",

        event_type:
          event.type,
      };
  }
}

/* ==========================================================================
   WEBHOOK CONFIGURATION CHECK
============================================================================ */

function validateWebhookConfiguration() {
  const missing =
    [];

  if (
    !STRIPE_SECRET_KEY
  ) {
    missing.push(
      "STRIPE_SECRET_KEY"
    );
  }

  if (
    !STRIPE_WEBHOOK_SECRET
  ) {
    missing.push(
      "STRIPE_WEBHOOK_SECRET"
    );
  }

  return {
    valid:
      missing.length ===
      0,

    missing,
  };
}

/* ==========================================================================
   WEBHOOK HANDLER
============================================================================ */

export default async function handler(
  req,
  res
) {
  /* ========================================================================
     POST ONLY
  ======================================================================== */

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

  /* ========================================================================
     CONFIGURATION
  ======================================================================== */

  const configuration =
    validateWebhookConfiguration();

  if (
    !configuration.valid ||
    !stripe
  ) {
    console.error(
      "Card Leo Stripe webhook configuration is incomplete:",
      configuration.missing
    );

    return sendJson(
      res,
      500,
      {
        success:
          false,

        ok:
          false,

        message:
          "Stripe webhook is not configured.",

        code:
          "STRIPE_WEBHOOK_NOT_CONFIGURED",
      }
    );
  }

  /* ========================================================================
     STRIPE SIGNATURE
  ======================================================================== */

  const signature =
    normalizeString(
      req.headers[
        "stripe-signature"
      ]
    );

  if (!signature) {
    return sendJson(
      res,
      400,
      {
        success:
          false,

        ok:
          false,

        message:
          "Missing Stripe signature.",

        code:
          "STRIPE_SIGNATURE_MISSING",
      }
    );
  }

  let event;

  /* ========================================================================
     VERIFY RAW BODY
  ======================================================================== */

  try {
    const rawBody =
      await readRawBody(
        req
      );

    event =
      stripe
        .webhooks
        .constructEvent(
          rawBody,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
  } catch (
    error
  ) {
    console.error(
      "Card Leo Stripe webhook signature verification failed:",
      error
    );

    return sendJson(
      res,
      400,
      {
        success:
          false,

        ok:
          false,

        message:
          "Invalid Stripe webhook signature.",

        code:
          "STRIPE_SIGNATURE_INVALID",
      }
    );
  }

  /* ========================================================================
     PROCESS EVENT
  ======================================================================== */

  try {
    console.log(
      "Card Leo Stripe webhook received:",
      {
        eventId:
          event.id,

        eventType:
          event.type,

        created:
          event.created,
      }
    );

    const result =
      await processStripeEvent(
        event
      );

    /* ======================================================================
       LOG RESULT
    ====================================================================== */

    console.log(
      "Card Leo Stripe webhook processed:",
      {
        eventId:
          event.id,

        eventType:
          event.type,

        handled:
          Boolean(
            result?.handled
          ),

        ignored:
          Boolean(
            result?.ignored
          ),

        memberId:
          result?.member_id ||
          null,

        status:
          result?.status ||
          null,

        growthPoolCreated:
          Boolean(
            result
              ?.growth_pool
              ?.created
          ),

        growthPoolAmount:
          normalizeNumber(
            result
              ?.growth_pool
              ?.amount,
            0
          ),

        accessStatus:
          result
            ?.accessSync
            ?.status ||
          null,
      }
    );

    /* ======================================================================
       ACKNOWLEDGE STRIPE

       IMPORTANT:
       Return 2xx only after our event handler completes.

       If an internal operation throws, the catch below returns 500 so
       Stripe can retry the webhook.

       Growth Pool duplicate protection makes those retries safe.
    ====================================================================== */

    return sendJson(
      res,
      200,
      {
        success:
          true,

        ok:
          true,

        received:
          true,

        event_id:
          event.id,

        event_type:
          event.type,

        handled:
          Boolean(
            result?.handled
          ),

        ignored:
          Boolean(
            result?.ignored
          ),

        result:
          result ||
          null,
      }
    );
  } catch (
    error
  ) {
    /* ======================================================================
       PROCESSING ERROR

       Return 500.

       Stripe should retry this webhook.

       The Growth Pool helper is idempotent, so retrying a qualifying
       activation event must not create a second $2 contribution.
    ====================================================================== */

    console.error(
      "Card Leo Stripe webhook processing failed:",
      {
        eventId:
          event?.id ||
          null,

        eventType:
          event?.type ||
          null,

        error:
          error?.message ||
          error,

        code:
          error?.code ||
          null,

        details:
          error?.details ||
          null,

        hint:
          error?.hint ||
          null,
      }
    );

    return sendJson(
      res,
      500,
      {
        success:
          false,

        ok:
          false,

        received:
          true,

        event_id:
          event?.id ||
          null,

        event_type:
          event?.type ||
          null,

        message:
          "Card Leo could not finish processing this Stripe webhook.",

        code:
          "STRIPE_WEBHOOK_PROCESSING_FAILED",

        ...(process.env.NODE_ENV ===
        "development"
          ? {
              debug: {
                message:
                  error?.message ||
                  "Unknown error",

                code:
                  error?.code ||
                  null,

                details:
                  error?.details ||
                  null,

                hint:
                  error?.hint ||
                  null,
              },
            }
          : {}),
      }
    );
  }
}