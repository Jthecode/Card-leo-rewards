// lib/growth-pool.js

import crypto from "crypto";
import { supabaseAdmin } from "./supabase-admin.js";

/* ==========================================================================
   CARD LEO REWARDS
   STEP #22
   CENTRAL GROWTH POOL HELPER
   FINAL LEGACY-SCHEMA-COMPATIBLE VERSION

   CURRENT DATABASE
   ----------------
   public.growth_pool

     id                        = 1
     pool_name                 = Card Leo Growth Pool
     balance
     total_contributed
     total_members_contributed
     created_at
     updated_at

   public.growth_pool_transactions

     growth_pool_id
     signup_id
     member_id
     member_email
     transaction_type
     status
     amount_cents
     amount
     currency
     provider
     stripe_event_id
     stripe_event_type
     stripe_checkout_session_id
     stripe_invoice_id
     stripe_subscription_id
     stripe_customer_id
     stripe_payment_intent_id
     idempotency_key
     external_reference
     description
     metadata
     processed_at
     created_at
     updated_at

   BUSINESS RULE
   -------------
   Every qualifying NEW paid Card Leo member contributes exactly:

     $2.00

   to the Card Leo company Growth Pool.

   This happens ONCE per member activation.

   Recurring monthly subscription invoices DO NOT add another $2.

   DUPLICATE PROTECTION
   --------------------
   Protects against:

   - Stripe webhook retries
   - checkout.session.completed + invoice.paid
   - invoice.paid + invoice.payment_succeeded
   - repeated checkout sessions
   - repeated member activation processing
   - concurrent webhook processing

============================================================================ */

/* ==========================================================================
   CONSTANTS
============================================================================ */

const GROWTH_POOL_ID = 1;

const GROWTH_POOL_NAME =
  "Card Leo Growth Pool";

const GROWTH_POOL_CONTRIBUTION_CENTS =
  200;

const GROWTH_POOL_CONTRIBUTION_DOLLARS =
  2;

const GROWTH_POOL_CURRENCY =
  "USD";

const GROWTH_POOL_TRANSACTIONS_TABLE =
  "growth_pool_transactions";

const GROWTH_POOL_TABLE =
  "growth_pool";

/*
 * Kept exported for compatibility with older files that may already import it.
 * The real database currently uses numeric id = 1 rather than pool_key.
 */
const DEFAULT_GROWTH_POOL_KEY =
  "card_leo_growth_pool";

const DEFAULT_TRANSACTION_TYPE =
  "member_activation";

const DEFAULT_TRANSACTION_STATUS =
  "completed";

const DEFAULT_PROVIDER =
  "stripe";

/* ==========================================================================
   SUCCESSFUL TRANSACTION STATUSES
============================================================================ */

const SUCCESSFUL_TRANSACTION_STATUSES =
  new Set([
    "completed",
    "succeeded",
    "paid",
  ]);

/* ==========================================================================
   MEMBER STATUS VALUES
============================================================================ */

const ACTIVE_STATUS_VALUES =
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

const PAID_PAYMENT_STATUS_VALUES =
  new Set([
    "paid",
    "active",
    "current",
    "complete",
    "completed",
    "succeeded",
  ]);

const ACTIVE_MEMBERSHIP_STATUS_VALUES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
  ]);

const ACTIVE_APPROVAL_STATUS_VALUES =
  new Set([
    "approved",
    "active",
    "auto_approved",
    "complete",
    "completed",
  ]);

const INACTIVE_STATUS_VALUES =
  new Set([
    "inactive",
    "disabled",
    "suspended",
    "paused",
    "denied",
    "closed",
    "cancelled",
    "canceled",
    "past_due",
    "payment_failed",
    "failed",
    "refunded",
  ]);

/* ==========================================================================
   NORMALIZATION
============================================================================ */

function normalizeString(value) {
  return String(
    value ?? ""
  ).trim();
}

function normalizeLower(value) {
  return normalizeString(
    value
  ).toLowerCase();
}

function normalizeUpper(value) {
  return normalizeString(
    value
  ).toUpperCase();
}

function normalizeEmail(value) {
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

function normalizeCents(
  value,
  fallback = 0
) {
  return Math.max(
    0,
    normalizeInteger(
      value,
      fallback
    )
  );
}

function centsToDollars(value) {
  return Number(
    (
      normalizeNumber(
        value,
        0
      ) / 100
    ).toFixed(2)
  );
}

function dollarsToCents(value) {
  return Math.round(
    normalizeNumber(
      value,
      0
    ) * 100
  );
}

function isObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function nowIso() {
  return new Date()
    .toISOString();
}

function safeDate(value) {
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
   HASHING
============================================================================ */

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(
      String(
        value ?? ""
      )
    )
    .digest("hex");
}

/* ==========================================================================
   ERROR HELPERS
============================================================================ */

function isDuplicateError(error) {
  const code =
    normalizeString(
      error?.code
    );

  const message =
    normalizeLower(
      error?.message
    );

  const details =
    normalizeLower(
      error?.details
    );

  return (
    code === "23505" ||
    message.includes("duplicate") ||
    message.includes("unique") ||
    details.includes("duplicate") ||
    details.includes("unique")
  );
}

function isMissingTableOrColumn(error) {
  const code =
    normalizeString(
      error?.code
    );

  const message =
    normalizeLower(
      error?.message
    );

  const details =
    normalizeLower(
      error?.details
    );

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
   IDEMPOTENCY KEY
============================================================================ */

function buildGrowthPoolIdempotencyKey({
  stripeEventId = "",
  checkoutSessionId = "",
  invoiceId = "",
  memberId = "",
  transactionType =
    DEFAULT_TRANSACTION_TYPE,
} = {}) {
  const eventId =
    normalizeString(
      stripeEventId
    );

  if (eventId) {
    return `growth:event:${eventId}`;
  }

  const sessionId =
    normalizeString(
      checkoutSessionId
    );

  if (sessionId) {
    return `growth:checkout:${sessionId}`;
  }

  const invoice =
    normalizeString(
      invoiceId
    );

  if (invoice) {
    return `growth:invoice:${invoice}`;
  }

  const member =
    normalizeString(
      memberId
    );

  if (member) {
    return (
      `growth:member:${member}:` +
      normalizeLower(
        transactionType
      )
    );
  }

  return "";
}

/* ==========================================================================
   EXTERNAL REFERENCE
============================================================================ */

function buildGrowthPoolReference({
  stripeEventId = "",
  checkoutSessionId = "",
  memberId = "",
} = {}) {
  const source =
    [
      normalizeString(
        stripeEventId
      ),

      normalizeString(
        checkoutSessionId
      ),

      normalizeString(
        memberId
      ),
    ]
      .filter(Boolean)
      .join("|");

  if (!source) {
    return "";
  }

  return (
    "gp_" +
    sha256(
      source
    ).slice(
      0,
      32
    )
  );
}

/* ==========================================================================
   MEMBER STATUS SNAPSHOT
============================================================================ */

function getMemberStatusSnapshot(
  member = {}
) {
  return {
    status:
      normalizeLower(
        member.status
      ),

    paymentStatus:
      normalizeLower(
        member.payment_status ||
        member.paymentStatus
      ),

    membershipStatus:
      normalizeLower(
        member.membership_status ||
        member.membershipStatus
      ),

    /*
     * approval_status does not currently exist in your real signups schema,
     * but keeping this optional lookup makes this helper forward-compatible.
     */
    approvalStatus:
      normalizeLower(
        member.approval_status ||
        member.approvalStatus
      ),
  };
}

/* ==========================================================================
   QUALIFYING MEMBER
============================================================================ */

function isGrowthPoolQualifyingMember(
  member = {}
) {
  if (
    !member ||
    !isObject(member)
  ) {
    return false;
  }

  const {
    status,
    paymentStatus,
    membershipStatus,
    approvalStatus,
  } =
    getMemberStatusSnapshot(
      member
    );

  /*
   * Explicit payment failure / membership failure wins.
   *
   * IMPORTANT:
   * status = approved by itself does not mean paid.
   */

  if (
    INACTIVE_STATUS_VALUES.has(
      paymentStatus
    ) ||
    INACTIVE_STATUS_VALUES.has(
      membershipStatus
    )
  ) {
    return false;
  }

  const paid =
    PAID_PAYMENT_STATUS_VALUES.has(
      paymentStatus
    );

  if (!paid) {
    return false;
  }

  const active =
    ACTIVE_STATUS_VALUES.has(
      status
    ) ||
    ACTIVE_MEMBERSHIP_STATUS_VALUES.has(
      membershipStatus
    ) ||
    ACTIVE_APPROVAL_STATUS_VALUES.has(
      approvalStatus
    );

  return active;
}

/* ==========================================================================
   QUALIFYING STRIPE EVENTS
============================================================================ */

function isQualifyingGrowthPoolEventType(
  eventType
) {
  const type =
    normalizeLower(
      eventType
    );

  return new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "invoice.paid",
    "invoice.payment_succeeded",
  ]).has(type);
}

/* ==========================================================================
   INITIAL ACTIVATION ONLY
============================================================================ */

function isInitialMembershipActivation({
  eventType = "",
  checkoutSessionId = "",
  invoiceBillingReason = "",
  subscriptionStatus = "",
  metadata = {},
} = {}) {
  const type =
    normalizeLower(
      eventType
    );

  const billingReason =
    normalizeLower(
      invoiceBillingReason
    );

  const explicitActivation =
    normalizeBoolean(
      metadata
        ?.growth_pool_activation ??
      metadata
        ?.initial_membership_activation ??
      metadata
        ?.is_initial_activation,
      false
    );

  if (explicitActivation) {
    return true;
  }

  /* ------------------------------------------------------------------------
     PRIMARY ACTIVATION EVENT
  ------------------------------------------------------------------------ */

  if (
    type ===
      "checkout.session.completed" ||
    type ===
      "checkout.session.async_payment_succeeded"
  ) {
    return Boolean(
      normalizeString(
        checkoutSessionId
      )
    );
  }

  /* ------------------------------------------------------------------------
     INITIAL SUBSCRIPTION INVOICE FALLBACK
  ------------------------------------------------------------------------ */

  if (
    (
      type ===
        "invoice.paid" ||
      type ===
        "invoice.payment_succeeded"
    ) &&
    [
      "subscription_create",
      "subscription_create_prorations",
    ].includes(
      billingReason
    )
  ) {
    return true;
  }

  /* ------------------------------------------------------------------------
     NEVER COUNT MONTHLY RECURRING BILLING
  ------------------------------------------------------------------------ */

  if (
    billingReason ===
    "subscription_cycle"
  ) {
    return false;
  }

  const subscription =
    normalizeLower(
      subscriptionStatus
    );

  if (
    type.startsWith(
      "invoice."
    ) &&
    [
      "active",
      "trialing",
    ].includes(
      subscription
    )
  ) {
    return false;
  }

  return false;
}

/* ==========================================================================
   SAFE MEMBER
============================================================================ */

function sanitizeGrowthPoolMember(
  member = {}
) {
  const fullName =
    normalizeString(
      member.full_name ||
      member.fullName
    ) ||
    [
      member.first_name ||
      member.firstName,

      member.last_name ||
      member.lastName,
    ]
      .map(
        normalizeString
      )
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

    fullName,

    status:
      normalizeString(
        member.status
      ),

    paymentStatus:
      normalizeString(
        member.payment_status ||
        member.paymentStatus
      ),

    membershipStatus:
      normalizeString(
        member.membership_status ||
        member.membershipStatus
      ),

    approvalStatus:
      normalizeString(
        member.approval_status ||
        member.approvalStatus
      ),
  };
}

/* ==========================================================================
   MEMBER LOOKUPS
============================================================================ */

async function getGrowthPoolMemberById(
  memberId
) {
  const id =
    normalizeString(
      memberId
    );

  if (!id) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .eq(
        "id",
        id
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function getGrowthPoolMemberByEmail(
  email
) {
  const safeEmail =
    normalizeEmail(
      email
    );

  if (!safeEmail) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike(
        "email",
        safeEmail
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

/* ==========================================================================
   GROWTH POOL SUMMARY ROW
============================================================================ */

async function getGrowthPoolSummaryRow() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TABLE
      )
      .select("*")
      .eq(
        "id",
        GROWTH_POOL_ID
      )
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

/* ==========================================================================
   TRANSACTION LOOKUPS
============================================================================ */

async function getGrowthPoolTransactionByIdempotencyKey(
  idempotencyKey
) {
  const key =
    normalizeString(
      idempotencyKey
    );

  if (!key) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "idempotency_key",
        key
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

async function getGrowthPoolTransactionByStripeEvent(
  stripeEventId
) {
  const eventId =
    normalizeString(
      stripeEventId
    );

  if (!eventId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "stripe_event_id",
        eventId
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

async function getGrowthPoolTransactionByCheckoutSession(
  checkoutSessionId
) {
  const sessionId =
    normalizeString(
      checkoutSessionId
    );

  if (!sessionId) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "stripe_checkout_session_id",
        sessionId
      )
      .eq(
        "transaction_type",
        DEFAULT_TRANSACTION_TYPE
      )
      .in(
        "status",
        [
          "completed",
          "succeeded",
          "paid",
        ]
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

async function getGrowthPoolActivationForMember(
  memberId
) {
  const id =
    normalizeString(
      memberId
    );

  if (!id) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "member_id",
        id
      )
      .eq(
        "transaction_type",
        DEFAULT_TRANSACTION_TYPE
      )
      .in(
        "status",
        [
          "completed",
          "succeeded",
          "paid",
        ]
      )
      .order(
        "created_at",
        {
          ascending: true,
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return null;
    }

    throw error;
  }

  return data || null;
}

/* ==========================================================================
   SANITIZE TRANSACTION
============================================================================ */

function sanitizeGrowthPoolTransaction(
  transaction
) {
  if (!transaction) {
    return null;
  }

  const amountCents =
    normalizeCents(
      transaction.amount_cents,
      dollarsToCents(
        transaction.amount
      ) ||
        GROWTH_POOL_CONTRIBUTION_CENTS
    );

  return {
    id:
      transaction.id ||
      null,

    growthPoolId:
      transaction
        .growth_pool_id ??
      GROWTH_POOL_ID,

    signupId:
      transaction
        .signup_id ||
      null,

    memberId:
      transaction
        .member_id ||
      null,

    memberEmail:
      normalizeEmail(
        transaction
          .member_email
      ),

    transactionType:
      normalizeString(
        transaction
          .transaction_type
      ),

    status:
      normalizeString(
        transaction.status
      ),

    amountCents,

    amount:
      centsToDollars(
        amountCents
      ),

    currency:
      normalizeUpper(
        transaction.currency ||
        GROWTH_POOL_CURRENCY
      ),

    provider:
      normalizeString(
        transaction.provider ||
        DEFAULT_PROVIDER
      ),

    stripeEventId:
      normalizeString(
        transaction
          .stripe_event_id
      ),

    stripeEventType:
      normalizeString(
        transaction
          .stripe_event_type
      ),

    stripeCheckoutSessionId:
      normalizeString(
        transaction
          .stripe_checkout_session_id
      ),

    stripeInvoiceId:
      normalizeString(
        transaction
          .stripe_invoice_id
      ),

    stripeSubscriptionId:
      normalizeString(
        transaction
          .stripe_subscription_id
      ),

    stripeCustomerId:
      normalizeString(
        transaction
          .stripe_customer_id
      ),

    stripePaymentIntentId:
      normalizeString(
        transaction
          .stripe_payment_intent_id
      ),

    idempotencyKey:
      normalizeString(
        transaction
          .idempotency_key
      ),

    externalReference:
      normalizeString(
        transaction
          .external_reference
      ),

    description:
      normalizeString(
        transaction
          .description
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
   FIND EXISTING CONTRIBUTION
============================================================================ */

async function findExistingGrowthPoolContribution({
  idempotencyKey = "",
  stripeEventId = "",
  checkoutSessionId = "",
  memberId = "",
} = {}) {
  /* ------------------------------------------------------------------------
     IDEMPOTENCY KEY
  ------------------------------------------------------------------------ */

  if (
    normalizeString(
      idempotencyKey
    )
  ) {
    const existing =
      await getGrowthPoolTransactionByIdempotencyKey(
        idempotencyKey
      );

    if (existing) {
      return existing;
    }
  }

  /* ------------------------------------------------------------------------
     STRIPE EVENT
  ------------------------------------------------------------------------ */

  if (
    normalizeString(
      stripeEventId
    )
  ) {
    const existing =
      await getGrowthPoolTransactionByStripeEvent(
        stripeEventId
      );

    if (existing) {
      return existing;
    }
  }

  /* ------------------------------------------------------------------------
     CHECKOUT SESSION
  ------------------------------------------------------------------------ */

  if (
    normalizeString(
      checkoutSessionId
    )
  ) {
    const existing =
      await getGrowthPoolTransactionByCheckoutSession(
        checkoutSessionId
      );

    if (existing) {
      return existing;
    }
  }

  /* ------------------------------------------------------------------------
     MEMBER-LEVEL BUSINESS RULE

     One successful member_activation transaction per member.
  ------------------------------------------------------------------------ */

  if (
    normalizeString(
      memberId
    )
  ) {
    const existing =
      await getGrowthPoolActivationForMember(
        memberId
      );

    if (existing) {
      return existing;
    }
  }

  return null;
}

/* ==========================================================================
   TRANSACTION PAYLOAD

   IMPORTANT:
   Your database requires:

     growth_pool_id = 1

   and preserves the legacy signup_id UUID relationship.
============================================================================ */

function buildGrowthPoolTransactionPayload({
  member,
  stripeEventId = "",
  stripeEventType = "",
  checkoutSessionId = "",
  invoiceId = "",
  subscriptionId = "",
  customerId = "",
  paymentIntentId = "",
  amountCents =
    GROWTH_POOL_CONTRIBUTION_CENTS,
  idempotencyKey = "",
  externalReference = "",
  metadata = {},
} = {}) {
  const safeAmount =
    normalizeCents(
      amountCents,
      GROWTH_POOL_CONTRIBUTION_CENTS
    ) ||
    GROWTH_POOL_CONTRIBUTION_CENTS;

  const memberId =
    normalizeString(
      member?.id
    );

  if (!memberId) {
    throw new Error(
      "Growth Pool transaction requires member.id."
    );
  }

  const finalIdempotencyKey =
    normalizeString(
      idempotencyKey
    ) ||
    buildGrowthPoolIdempotencyKey({
      stripeEventId,

      checkoutSessionId,

      invoiceId,

      memberId,

      transactionType:
        DEFAULT_TRANSACTION_TYPE,
    });

  const finalReference =
    normalizeString(
      externalReference
    ) ||
    buildGrowthPoolReference({
      stripeEventId,

      checkoutSessionId,

      memberId,
    });

  return {
    /* ----------------------------------------------------------------------
       EXISTING DATABASE RELATIONSHIPS
    ---------------------------------------------------------------------- */

    growth_pool_id:
      GROWTH_POOL_ID,

    /*
     * signups.id is UUID.
     *
     * Supabase/Postgres accepts the UUID string here.
     */
    signup_id:
      memberId,

    /*
     * New helper also keeps the text ID for easier API comparisons.
     */
    member_id:
      memberId,

    member_email:
      normalizeEmail(
        member?.email
      ) ||
      null,

    /* ----------------------------------------------------------------------
       TRANSACTION
    ---------------------------------------------------------------------- */

    transaction_type:
      DEFAULT_TRANSACTION_TYPE,

    status:
      DEFAULT_TRANSACTION_STATUS,

    amount_cents:
      safeAmount,

    /*
     * Legacy amount column is still maintained.
     */
    amount:
      centsToDollars(
        safeAmount
      ),

    currency:
      GROWTH_POOL_CURRENCY,

    provider:
      DEFAULT_PROVIDER,

    /* ----------------------------------------------------------------------
       STRIPE
    ---------------------------------------------------------------------- */

    stripe_event_id:
      normalizeString(
        stripeEventId
      ) ||
      null,

    stripe_event_type:
      normalizeString(
        stripeEventType
      ) ||
      null,

    stripe_checkout_session_id:
      normalizeString(
        checkoutSessionId
      ) ||
      null,

    stripe_invoice_id:
      normalizeString(
        invoiceId
      ) ||
      null,

    stripe_subscription_id:
      normalizeString(
        subscriptionId
      ) ||
      null,

    stripe_customer_id:
      normalizeString(
        customerId
      ) ||
      null,

    stripe_payment_intent_id:
      normalizeString(
        paymentIntentId
      ) ||
      null,

    /* ----------------------------------------------------------------------
       IDEMPOTENCY
    ---------------------------------------------------------------------- */

    idempotency_key:
      finalIdempotencyKey ||
      null,

    external_reference:
      finalReference ||
      null,

    /* ----------------------------------------------------------------------
       DESCRIPTION
    ---------------------------------------------------------------------- */

    description:
      "Card Leo Growth Pool contribution from qualifying new paid member activation.",

    metadata: {
      ...(isObject(metadata)
        ? metadata
        : {}),

      growth_pool_id:
        GROWTH_POOL_ID,

      growth_pool_name:
        GROWTH_POOL_NAME,

      growth_pool_contribution:
        true,

      growth_pool_amount_cents:
        safeAmount,

      growth_pool_amount:
        centsToDollars(
          safeAmount
        ),

      member_id:
        memberId,

      member_email:
        normalizeEmail(
          member?.email
        ) ||
        null,

      contribution_rule:
        "initial_paid_membership_activation",

      recurring_payment_contribution:
        false,

      created_by:
        "lib/growth-pool.js",
    },

    processed_at:
      nowIso(),

    created_at:
      nowIso(),

    updated_at:
      nowIso(),
  };
}

/* ==========================================================================
   CALCULATE LEDGER TOTALS

   IMPORTANT:
   Only successful member_activation transactions for growth_pool_id = 1
   count toward the real Growth Pool.
============================================================================ */

async function calculateGrowthPoolTotalsFromTransactions() {
  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select(
        [
          "member_id",
          "amount_cents",
          "amount",
          "transaction_type",
          "status",
          "created_at",
        ].join(", ")
      )
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .eq(
        "transaction_type",
        DEFAULT_TRANSACTION_TYPE
      )
      .in(
        "status",
        [
          "completed",
          "succeeded",
          "paid",
        ]
      );

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return {
        totalCents: 0,
        total: 0,
        contributionCount: 0,
        uniqueMemberCount: 0,
        lastContributionAt: null,
      };
    }

    throw error;
  }

  const rows =
    Array.isArray(data)
      ? data
      : [];

  let totalCents =
    0;

  let lastContributionAt =
    null;

  const memberIds =
    new Set();

  for (const row of rows) {
    const status =
      normalizeLower(
        row.status
      );

    if (
      !SUCCESSFUL_TRANSACTION_STATUSES.has(
        status
      )
    ) {
      continue;
    }

    let amountCents =
      normalizeCents(
        row.amount_cents,
        0
      );

    if (
      amountCents <= 0
    ) {
      amountCents =
        dollarsToCents(
          row.amount
        );
    }

    totalCents +=
      amountCents;

    if (
      normalizeString(
        row.member_id
      )
    ) {
      memberIds.add(
        normalizeString(
          row.member_id
        )
      );
    }

    const createdAt =
      safeDate(
        row.created_at
      );

    if (
      createdAt &&
      (
        !lastContributionAt ||
        createdAt >
          lastContributionAt
      )
    ) {
      lastContributionAt =
        createdAt;
    }
  }

  return {
    totalCents,

    total:
      centsToDollars(
        totalCents
      ),

    contributionCount:
      rows.length,

    uniqueMemberCount:
      memberIds.size,

    lastContributionAt,
  };
}

/* ==========================================================================
   SYNC EXISTING growth_pool ROW

   NO pool_key.
   NO balance_cents.
   NO total_contributions_cents.

   Your actual row is:

     id = 1
     balance
     total_contributed
     total_members_contributed
============================================================================ */

async function syncGrowthPoolSummary() {
  const totals =
    await calculateGrowthPoolTotalsFromTransactions();

  const existing =
    await getGrowthPoolSummaryRow();

  /* ------------------------------------------------------------------------
     CREATE POOL IF SOMEHOW MISSING
  ------------------------------------------------------------------------ */

  if (!existing) {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          GROWTH_POOL_TABLE
        )
        .insert({
          id:
            GROWTH_POOL_ID,

          pool_name:
            GROWTH_POOL_NAME,

          balance:
            totals.total,

          total_contributed:
            totals.total,

          total_members_contributed:
            totals.uniqueMemberCount,

          created_at:
            nowIso(),

          updated_at:
            nowIso(),
        })
        .select("*")
        .single();

    if (error) {
      throw error;
    }

    return {
      synced: true,
      created: true,
      row: data,
      totals,
    };
  }

  /* ------------------------------------------------------------------------
     UPDATE EXISTING POOL
  ------------------------------------------------------------------------ */

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TABLE
      )
      .update({
        balance:
          totals.total,

        total_contributed:
          totals.total,

        total_members_contributed:
          totals.uniqueMemberCount,

        updated_at:
          nowIso(),
      })
      .eq(
        "id",
        GROWTH_POOL_ID
      )
      .select("*")
      .single();

  if (error) {
    throw error;
  }

  return {
    synced: true,
    created: false,
    row: data,
    totals,
  };
}

/* ==========================================================================
   CREATE CONTRIBUTION
============================================================================ */

async function createGrowthPoolContribution({
  member,

  stripeEventId = "",

  stripeEventType = "",

  checkoutSessionId = "",

  invoiceId = "",

  invoiceBillingReason = "",

  subscriptionId = "",

  subscriptionStatus = "",

  customerId = "",

  paymentIntentId = "",

  amountCents =
    GROWTH_POOL_CONTRIBUTION_CENTS,

  metadata = {},

  force = false,
} = {}) {
  /* ------------------------------------------------------------------------
     MEMBER REQUIRED
  ------------------------------------------------------------------------ */

  if (!member?.id) {
    const error =
      new Error(
        "A Card Leo member is required to create a Growth Pool contribution."
      );

    error.code =
      "GROWTH_POOL_MEMBER_REQUIRED";

    throw error;
  }

  /* ------------------------------------------------------------------------
     QUALIFYING MEMBER
  ------------------------------------------------------------------------ */

  const qualifyingMember =
    isGrowthPoolQualifyingMember(
      member
    );

  if (
    !qualifyingMember &&
    !force
  ) {
    return {
      success: true,
      created: false,
      skipped: true,
      alreadyExists: false,

      reason:
        "member_not_qualifying",

      message:
        "Growth Pool contribution skipped because this member is not active and paid.",

      member:
        sanitizeGrowthPoolMember(
          member
        ),
    };
  }

  /* ------------------------------------------------------------------------
     EVENT TYPE
  ------------------------------------------------------------------------ */

  const eventType =
    normalizeString(
      stripeEventType
    );

  if (
    eventType &&
    !isQualifyingGrowthPoolEventType(
      eventType
    ) &&
    !force
  ) {
    return {
      success: true,
      created: false,
      skipped: true,
      alreadyExists: false,

      reason:
        "event_not_qualifying",

      eventType,

      message:
        "Stripe event does not qualify for a Growth Pool contribution.",
    };
  }

  /* ------------------------------------------------------------------------
     INITIAL ACTIVATION
  ------------------------------------------------------------------------ */

  const initialActivation =
    isInitialMembershipActivation({
      eventType,

      checkoutSessionId,

      invoiceBillingReason,

      subscriptionStatus,

      metadata,
    });

  if (
    !initialActivation &&
    !force
  ) {
    return {
      success: true,
      created: false,
      skipped: true,
      alreadyExists: false,

      reason:
        "not_initial_activation",

      message:
        "Growth Pool contribution skipped because this is not the member's initial paid activation.",

      eventType,

      invoiceBillingReason:
        normalizeString(
          invoiceBillingReason
        ),
    };
  }

  /* ------------------------------------------------------------------------
     IDEMPOTENCY
  ------------------------------------------------------------------------ */

  const idempotencyKey =
    buildGrowthPoolIdempotencyKey({
      stripeEventId,

      checkoutSessionId,

      invoiceId,

      memberId:
        member.id,

      transactionType:
        DEFAULT_TRANSACTION_TYPE,
    });

  /* ------------------------------------------------------------------------
     DUPLICATE CHECK
  ------------------------------------------------------------------------ */

  const existing =
    await findExistingGrowthPoolContribution({
      idempotencyKey,

      stripeEventId,

      checkoutSessionId,

      memberId:
        member.id,
    });

  if (existing) {
    /*
     * Reconcile summary even when transaction already exists.
     *
     * This is useful if a previous transaction succeeded but summary sync
     * did not.
     */

    let summary =
      null;

    try {
      summary =
        await syncGrowthPoolSummary();
    } catch (
      summaryError
    ) {
      console.error(
        "Growth Pool reconciliation after duplicate:",
        summaryError
      );
    }

    return {
      success: true,
      created: false,
      alreadyExists: true,
      skipped: false,

      reason:
        "already_contributed",

      message:
        "Growth Pool contribution already exists. Duplicate credit was prevented.",

      transaction:
        sanitizeGrowthPoolTransaction(
          existing
        ),

      summary,
    };
  }

  /* ------------------------------------------------------------------------
     PAYLOAD
  ------------------------------------------------------------------------ */

  const payload =
    buildGrowthPoolTransactionPayload({
      member,

      stripeEventId,

      stripeEventType,

      checkoutSessionId,

      invoiceId,

      subscriptionId,

      customerId,

      paymentIntentId,

      amountCents,

      idempotencyKey,

      metadata,
    });

  /* ------------------------------------------------------------------------
     INSERT
  ------------------------------------------------------------------------ */

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .insert(
        payload
      )
      .select("*")
      .single();

  if (error) {
    /* ----------------------------------------------------------------------
       TABLE / COLUMN MISSING
    ---------------------------------------------------------------------- */

    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      const tableError =
        new Error(
          "Growth Pool database schema is not ready for automatic contributions."
        );

      tableError.code =
        "GROWTH_POOL_SCHEMA_NOT_READY";

      tableError.originalError =
        error;

      throw tableError;
    }

    /* ----------------------------------------------------------------------
       DATABASE UNIQUE CONSTRAINT CAUGHT A RACE
    ---------------------------------------------------------------------- */

    if (
      isDuplicateError(
        error
      )
    ) {
      const duplicate =
        await findExistingGrowthPoolContribution({
          idempotencyKey,

          stripeEventId,

          checkoutSessionId,

          memberId:
            member.id,
        });

      if (duplicate) {
        let summary =
          null;

        try {
          summary =
            await syncGrowthPoolSummary();
        } catch (
          summaryError
        ) {
          console.error(
            "Growth Pool duplicate reconciliation failed:",
            summaryError
          );
        }

        return {
          success: true,
          created: false,
          alreadyExists: true,
          skipped: false,

          reason:
            "duplicate_prevented",

          message:
            "Duplicate Growth Pool contribution was prevented.",

          transaction:
            sanitizeGrowthPoolTransaction(
              duplicate
            ),

          summary,
        };
      }
    }

    throw error;
  }

  /* ------------------------------------------------------------------------
     SUMMARY
  ------------------------------------------------------------------------ */

  let summary =
    null;

  try {
    summary =
      await syncGrowthPoolSummary();
  } catch (
    summaryError
  ) {
    /*
     * Transaction already succeeded.
     *
     * Do NOT insert a second transaction because summary update failed.
     */

    console.error(
      "Card Leo Growth Pool summary sync error:",
      summaryError
    );

    summary = {
      synced: false,

      error:
        summaryError?.message ||
        "Growth Pool summary could not be synchronized.",
    };
  }

  return {
    success: true,

    created: true,

    alreadyExists: false,

    skipped: false,

    amountCents:
      payload.amount_cents,

    amount:
      centsToDollars(
        payload.amount_cents
      ),

    message:
      `$${centsToDollars(
        payload.amount_cents
      ).toFixed(2)} added to the Card Leo Growth Pool.`,

    member:
      sanitizeGrowthPoolMember(
        member
      ),

    transaction:
      sanitizeGrowthPoolTransaction(
        data
      ),

    summary,
  };
}

/* ==========================================================================
   PROCESS MEMBER ACTIVATION

   PRIMARY FUNCTION USED BY:

     api/billing/webhook.js
============================================================================ */

async function processGrowthPoolMemberActivation({
  memberId = "",

  email = "",

  member = null,

  stripeEventId = "",

  stripeEventType = "",

  checkoutSessionId = "",

  invoiceId = "",

  invoiceBillingReason = "",

  subscriptionId = "",

  subscriptionStatus = "",

  customerId = "",

  paymentIntentId = "",

  metadata = {},

  force = false,
} = {}) {
  let resolvedMember =
    member;

  /* ------------------------------------------------------------------------
     MEMBER ID
  ------------------------------------------------------------------------ */

  if (
    !resolvedMember?.id &&
    normalizeString(
      memberId
    )
  ) {
    resolvedMember =
      await getGrowthPoolMemberById(
        memberId
      );
  }

  /* ------------------------------------------------------------------------
     EMAIL
  ------------------------------------------------------------------------ */

  if (
    !resolvedMember?.id &&
    normalizeEmail(
      email
    )
  ) {
    resolvedMember =
      await getGrowthPoolMemberByEmail(
        email
      );
  }

  /* ------------------------------------------------------------------------
     NOT FOUND
  ------------------------------------------------------------------------ */

  if (
    !resolvedMember?.id
  ) {
    return {
      success: false,
      created: false,
      skipped: true,
      alreadyExists: false,

      reason:
        "member_not_found",

      message:
        "Growth Pool contribution could not be created because the Card Leo member was not found.",
    };
  }

  return createGrowthPoolContribution({
    member:
      resolvedMember,

    stripeEventId,

    stripeEventType,

    checkoutSessionId,

    invoiceId,

    invoiceBillingReason,

    subscriptionId,

    subscriptionStatus,

    customerId,

    paymentIntentId,

    metadata,

    force,
  });
}

/* ==========================================================================
   GET TOTALS
============================================================================ */

async function getGrowthPoolTotals() {
  const [
    summary,
    ledger,
  ] =
    await Promise.all([
      getGrowthPoolSummaryRow(),

      calculateGrowthPoolTotalsFromTransactions(),
    ]);

  /* ------------------------------------------------------------------------
     DATABASE SUMMARY EXISTS
  ------------------------------------------------------------------------ */

  if (summary) {
    const balance =
      normalizeNumber(
        summary.balance,
        ledger.total
      );

    const totalContributed =
      normalizeNumber(
        summary.total_contributed,
        ledger.total
      );

    const totalMembers =
      normalizeInteger(
        summary.total_members_contributed,
        ledger.uniqueMemberCount
      );

    return {
      growthPoolId:
        summary.id ??
        GROWTH_POOL_ID,

      poolKey:
        DEFAULT_GROWTH_POOL_KEY,

      poolName:
        normalizeString(
          summary.pool_name ||
          GROWTH_POOL_NAME
        ),

      currency:
        GROWTH_POOL_CURRENCY,

      balanceCents:
        dollarsToCents(
          balance
        ),

      balance,

      totalContributionsCents:
        dollarsToCents(
          totalContributed
        ),

      totalContributionsAmount:
        totalContributed,

      contributionCount:
        totalMembers,

      transactionCount:
        ledger.contributionCount,

      uniqueMemberCount:
        totalMembers,

      contributionAmountCents:
        GROWTH_POOL_CONTRIBUTION_CENTS,

      contributionAmount:
        GROWTH_POOL_CONTRIBUTION_DOLLARS,

      lastContributionAt:
        ledger.lastContributionAt,

      updatedAt:
        safeDate(
          summary.updated_at
        ),

      createdAt:
        safeDate(
          summary.created_at
        ),

      source:
        "growth_pool",

      reconciliation: {
        summaryBalanceCents:
          dollarsToCents(
            balance
          ),

        ledgerBalanceCents:
          ledger.totalCents,

        differenceCents:
          dollarsToCents(
            balance
          ) -
          ledger.totalCents,

        matches:
          dollarsToCents(
            balance
          ) ===
            ledger.totalCents &&
          totalMembers ===
            ledger.uniqueMemberCount,
      },
    };
  }

  /* ------------------------------------------------------------------------
     LEDGER FALLBACK
  ------------------------------------------------------------------------ */

  return {
    growthPoolId:
      GROWTH_POOL_ID,

    poolKey:
      DEFAULT_GROWTH_POOL_KEY,

    poolName:
      GROWTH_POOL_NAME,

    currency:
      GROWTH_POOL_CURRENCY,

    balanceCents:
      ledger.totalCents,

    balance:
      ledger.total,

    totalContributionsCents:
      ledger.totalCents,

    totalContributionsAmount:
      ledger.total,

    contributionCount:
      ledger.uniqueMemberCount,

    transactionCount:
      ledger.contributionCount,

    uniqueMemberCount:
      ledger.uniqueMemberCount,

    contributionAmountCents:
      GROWTH_POOL_CONTRIBUTION_CENTS,

    contributionAmount:
      GROWTH_POOL_CONTRIBUTION_DOLLARS,

    lastContributionAt:
      ledger.lastContributionAt,

    updatedAt:
      null,

    createdAt:
      null,

    source:
      "growth_pool_transactions",

    reconciliation: {
      summaryBalanceCents:
        null,

      ledgerBalanceCents:
        ledger.totalCents,

      differenceCents:
        null,

      matches:
        false,
    },
  };
}

/* ==========================================================================
   RECENT TRANSACTIONS
============================================================================ */

async function getRecentGrowthPoolTransactions({
  limit = 50,
} = {}) {
  const safeLimit =
    Math.min(
      Math.max(
        normalizeInteger(
          limit,
          50
        ),
        1
      ),
      500
    );

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        GROWTH_POOL_TRANSACTIONS_TABLE
      )
      .select("*")
      .eq(
        "growth_pool_id",
        GROWTH_POOL_ID
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(
        safeLimit
      );

  if (error) {
    if (
      isMissingTableOrColumn(
        error
      )
    ) {
      return [];
    }

    throw error;
  }

  return (
    Array.isArray(data)
      ? data
      : []
  ).map(
    sanitizeGrowthPoolTransaction
  );
}

/* ==========================================================================
   MEMBER CONTRIBUTION STATUS
============================================================================ */

async function getMemberGrowthPoolContributionStatus(
  memberId
) {
  const id =
    normalizeString(
      memberId
    );

  if (!id) {
    return {
      contributed: false,
      transaction: null,
    };
  }

  const transaction =
    await getGrowthPoolActivationForMember(
      id
    );

  return {
    contributed:
      Boolean(transaction),

    transaction:
      sanitizeGrowthPoolTransaction(
        transaction
      ),
  };
}

/* ==========================================================================
   REBUILD SUMMARY
============================================================================ */

async function rebuildGrowthPoolSummary() {
  return syncGrowthPoolSummary();
}

/* ==========================================================================
   DEBUG
============================================================================ */

function getGrowthPoolConfigForDebug() {
  return {
    growthPoolId:
      GROWTH_POOL_ID,

    poolName:
      GROWTH_POOL_NAME,

    transactionsTable:
      GROWTH_POOL_TRANSACTIONS_TABLE,

    summaryTable:
      GROWTH_POOL_TABLE,

    poolKey:
      DEFAULT_GROWTH_POOL_KEY,

    transactionType:
      DEFAULT_TRANSACTION_TYPE,

    contributionCents:
      GROWTH_POOL_CONTRIBUTION_CENTS,

    contributionAmount:
      GROWTH_POOL_CONTRIBUTION_DOLLARS,

    currency:
      GROWTH_POOL_CURRENCY,

    provider:
      DEFAULT_PROVIDER,

    schema: {
      growthPool: {
        primaryId:
          GROWTH_POOL_ID,

        balanceColumn:
          "balance",

        totalContributedColumn:
          "total_contributed",

        totalMembersColumn:
          "total_members_contributed",
      },

      transactions: {
        growthPoolIdColumn:
          "growth_pool_id",

        signupIdColumn:
          "signup_id",

        memberIdColumn:
          "member_id",

        amountCentsColumn:
          "amount_cents",

        legacyAmountColumn:
          "amount",
      },
    },
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  /* ------------------------------------------------------------------------
     REAL POOL
  ------------------------------------------------------------------------ */

  GROWTH_POOL_ID,

  GROWTH_POOL_NAME,

  /* ------------------------------------------------------------------------
     CONSTANTS
  ------------------------------------------------------------------------ */

  GROWTH_POOL_CONTRIBUTION_CENTS,

  GROWTH_POOL_CONTRIBUTION_DOLLARS,

  GROWTH_POOL_CURRENCY,

  GROWTH_POOL_TRANSACTIONS_TABLE,

  GROWTH_POOL_TABLE,

  DEFAULT_GROWTH_POOL_KEY,

  DEFAULT_TRANSACTION_TYPE,

  /* ------------------------------------------------------------------------
     MEMBER
  ------------------------------------------------------------------------ */

  getGrowthPoolMemberById,

  getGrowthPoolMemberByEmail,

  sanitizeGrowthPoolMember,

  isGrowthPoolQualifyingMember,

  /* ------------------------------------------------------------------------
     EVENT QUALIFICATION
  ------------------------------------------------------------------------ */

  isQualifyingGrowthPoolEventType,

  isInitialMembershipActivation,

  /* ------------------------------------------------------------------------
     IDEMPOTENCY
  ------------------------------------------------------------------------ */

  buildGrowthPoolIdempotencyKey,

  buildGrowthPoolReference,

  findExistingGrowthPoolContribution,

  getGrowthPoolTransactionByIdempotencyKey,

  getGrowthPoolTransactionByStripeEvent,

  getGrowthPoolTransactionByCheckoutSession,

  getGrowthPoolActivationForMember,

  /* ------------------------------------------------------------------------
     CONTRIBUTIONS
  ------------------------------------------------------------------------ */

  buildGrowthPoolTransactionPayload,

  createGrowthPoolContribution,

  processGrowthPoolMemberActivation,

  sanitizeGrowthPoolTransaction,

  /* ------------------------------------------------------------------------
     TOTALS
  ------------------------------------------------------------------------ */

  getGrowthPoolSummaryRow,

  calculateGrowthPoolTotalsFromTransactions,

  syncGrowthPoolSummary,

  rebuildGrowthPoolSummary,

  getGrowthPoolTotals,

  getRecentGrowthPoolTransactions,

  getMemberGrowthPoolContributionStatus,

  /* ------------------------------------------------------------------------
     UTILITIES
  ------------------------------------------------------------------------ */

  centsToDollars,

  dollarsToCents,

  getGrowthPoolConfigForDebug,
};