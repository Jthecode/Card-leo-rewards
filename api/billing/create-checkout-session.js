// api/billing/create-checkout-session.js

import crypto from "node:crypto";
import Stripe from "stripe";

import {
  supabaseAdmin,
} from "../../lib/supabase-admin.js";

/* ==========================================================================
   CARD LEO REWARDS
   CREATE STRIPE CHECKOUT SESSION

   ROUTE
   -----
   POST /api/billing/create-checkout-session

   PRICING
   -------
   $25.00 one-time activation fee

   $20.00 recurring monthly membership

   BILLING
   -------
   Monthly membership bills on the 10th.

   The member pays the activation fee during Checkout.

   The recurring $20 membership begins on the next eligible 10th.

   Stripe requires trial_end to be at least 48 hours in the future, so if
   the upcoming 10th is too close, Card Leo automatically moves the first
   recurring billing date to the following month's 10th.

   IMPORTANT
   ---------
   This route does NOT activate membership.

   Successful payment activation is handled by:

     api/billing/webhook.js

   The webhook remains responsible for:

   - payment confirmation
   - member activation
   - Access Perks enrollment
   - Growth Pool contribution
   - downstream provisioning

============================================================================ */

/* ==========================================================================
   STRIPE
============================================================================ */

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY ||
  "";

const stripe =
  STRIPE_SECRET_KEY
    ? new Stripe(
        STRIPE_SECRET_KEY,
        {
          apiVersion:
            "2024-06-20",
        }
      )
    : null;

/* ==========================================================================
   SITE
============================================================================ */

const CARDLEO_SITE_URL =
  (
    process.env
      .CARDLEO_SITE_URL ||
    "https://www.cardleorewards.com"
  ).replace(
    /\/+$/,
    ""
  );

const DEFAULT_SUCCESS_URL =
  process.env
    .CARDLEO_SUCCESS_URL ||
  `${CARDLEO_SITE_URL}/thank-you.html?payment=success&membership=activated`;

const DEFAULT_CANCEL_URL =
  process.env
    .CARDLEO_CANCEL_URL ||
  `${CARDLEO_SITE_URL}/signup.html?payment=cancelled`;

/* ==========================================================================
   STRIPE PRICES
============================================================================ */

const ACTIVATION_PRICE_ID =
  process.env
    .CARDLEO_ACTIVATION_PRICE_ID ||
  "";

const MONTHLY_PRICE_ID =
  process.env
    .CARDLEO_MONTHLY_PRICE_ID ||
  "";

/* ==========================================================================
   CARD LEO BILLING RULES
============================================================================ */

const ACTIVATION_FEE_AMOUNT =
  25;

const MONTHLY_FEE_AMOUNT =
  20;

const BILLING_DAY =
  10;

/*
 * Stripe requires trial_end to be at least two days in the future.
 *
 * Use 48 hours + 5 minutes to avoid hitting the exact boundary.
 */

const MINIMUM_TRIAL_SECONDS =
  (
    48 *
    60 *
    60
  ) +
  (
    5 *
    60
  );

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

const ACTIVE_PAYMENT_STATUSES =
  new Set([
    "paid",
    "active",
    "current",
    "succeeded",
    "complete",
    "completed",
  ]);

const ACTIVE_MEMBERSHIP_STATUSES =
  new Set([
    "active",
    "activated",
    "approved",
    "paid",
    "current",
  ]);

const ACTIVE_SUBSCRIPTION_STATUSES =
  new Set([
    "active",
    "trialing",
  ]);

/* ==========================================================================
   GENERAL HELPERS
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

function isValidEmail(
  value
) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value
  );
}

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

function nowIso() {
  return new Date()
    .toISOString();
}

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

function success(
  res,
  payload
) {
  return sendJson(
    res,
    200,
    {
      success:
        true,

      ok:
        true,

      ...payload,
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

function serverError(
  res,
  message,
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
   REQUEST ORIGIN
============================================================================ */

function getOrigin(
  req
) {
  const forwardedProto =
    normalizeString(
      req?.headers?.[
        "x-forwarded-proto"
      ]
    )
      .split(",")[0]
      .trim();

  const forwardedHost =
    normalizeString(
      req?.headers?.[
        "x-forwarded-host"
      ]
    )
      .split(",")[0]
      .trim();

  const host =
    forwardedHost ||
    normalizeString(
      req?.headers?.host
    ) ||
    "www.cardleorewards.com";

  const protocol =
    forwardedProto ||
    (
      process.env.NODE_ENV ===
        "production"
        ? "https"
        : "http"
    );

  return `${protocol}://${host}`;
}

/* ==========================================================================
   BODY
============================================================================ */

async function readJsonBody(
  req
) {
  if (
    isObject(
      req?.body
    )
  ) {
    return req.body;
  }

  if (
    typeof req?.body ===
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

  const chunks =
    [];

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

  const raw =
    Buffer
      .concat(
        chunks
      )
      .toString(
        "utf8"
      );

  if (!raw) {
    return {};
  }

  try {
    const parsed =
      JSON.parse(
        raw
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

/* ==========================================================================
   SAFE REDIRECT URL

   Prevent arbitrary external success/cancel redirects.

   Allowed:
   - relative Card Leo paths
   - CARDLEO_SITE_URL
   - current request origin

============================================================================ */

function safeUrl(
  value,
  fallback,
  origin
) {
  const raw =
    normalizeString(
      value
    );

  if (!raw) {
    return fallback;
  }

  if (
    raw.startsWith("/") &&
    !raw.startsWith("//")
  ) {
    return `${origin}${raw}`;
  }

  try {
    const url =
      new URL(
        raw
      );

    const approvedOrigins =
      new Set([
        new URL(
          CARDLEO_SITE_URL
        ).origin,

        new URL(
          origin
        ).origin,
      ]);

    if (
      !approvedOrigins.has(
        url.origin
      )
    ) {
      return fallback;
    }

    if (
      ![
        "http:",
        "https:",
      ].includes(
        url.protocol
      )
    ) {
      return fallback;
    }

    return url.toString();
  } catch {
    return fallback;
  }
}

/* ==========================================================================
   MEMBER INPUT
============================================================================ */

function getFullName(
  payload
) {
  const fullName =
    normalizeString(
      payload.fullName ||
      payload.full_name
    );

  if (fullName) {
    return fullName;
  }

  return [
    payload.firstName ||
      payload.first_name,

    payload.lastName ||
      payload.last_name,
  ]
    .map(
      normalizeString
    )
    .filter(Boolean)
    .join(" ");
}

function getSignupId(
  payload
) {
  return normalizeString(
    payload.signup_id ||
    payload.signupId ||
    payload.id ||
    payload.member_id ||
    payload.memberId
  );
}

function getReferralName(
  payload
) {
  return normalizeString(
    payload.referralName ||
    payload.referral_name ||
    payload.sponsor_name ||
    payload.sponsorName
  );
}

function getFirstName(
  payload
) {
  return normalizeString(
    payload.firstName ||
    payload.first_name
  );
}

function getLastName(
  payload
) {
  return normalizeString(
    payload.lastName ||
    payload.last_name
  );
}

function getPhone(
  payload
) {
  return normalizeString(
    payload.phone
  );
}

/* ==========================================================================
   DATABASE COMPATIBILITY
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
    code ===
      "42703" ||

    code ===
      "PGRST204" ||

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
   NEXT BILLING DATE

   Returns the next BILLING_DAY that is safely more than 48 hours away.

   Example:

   August 8:
     August 10 can be used only if it remains more than 48 hours away.

   August 9:
     September 10 is used.

   This avoids Stripe:

     "trial_end date has to be at least 2 days in the future"

============================================================================ */

function getNextBillingDayUnixTimestamp(
  dayOfMonth =
    BILLING_DAY
) {
  const now =
    new Date();

  const minimumAllowedTime =
    now.getTime() +
    (
      MINIMUM_TRIAL_SECONDS *
      1000
    );

  let year =
    now.getUTCFullYear();

  let month =
    now.getUTCMonth();

  let billingDate =
    new Date(
      Date.UTC(
        year,
        month,
        dayOfMonth,
        14,
        0,
        0
      )
    );

  /*
   * This month's billing date already passed.
   */

  if (
    billingDate.getTime() <=
    now.getTime()
  ) {
    month +=
      1;

    billingDate =
      new Date(
        Date.UTC(
          year,
          month,
          dayOfMonth,
          14,
          0,
          0
        )
      );
  }

  /*
   * Upcoming billing date exists but is too close to Stripe's
   * minimum trial_end window.
   */

  if (
    billingDate.getTime() <=
    minimumAllowedTime
  ) {
    month +=
      1;

    billingDate =
      new Date(
        Date.UTC(
          year,
          month,
          dayOfMonth,
          14,
          0,
          0
        )
      );
  }

  return Math.floor(
    billingDate.getTime() /
    1000
  );
}

function formatDateFromUnix(
  unixTimestamp
) {
  const date =
    new Date(
      Number(
        unixTimestamp
      ) *
      1000
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date
    .toISOString()
    .slice(
      0,
      10
    );
}

/* ==========================================================================
   SIGNUP LOOKUP
============================================================================ */

async function findSignup({
  signupId,
  email,
}) {
  if (signupId) {
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
          signupId
        )
        .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.id) {
      return data;
    }
  }

  if (email) {
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
          email
        )
        .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.id) {
      return data;
    }
  }

  return null;
}

/* ==========================================================================
   CREATE SIGNUP
============================================================================ */

async function createSignupIfMissing(
  payload
) {
  const email =
    normalizeEmail(
      payload.email
    );

  const firstName =
    getFirstName(
      payload
    );

  const lastName =
    getLastName(
      payload
    );

  const fullName =
    getFullName(
      payload
    );

  const phone =
    getPhone(
      payload
    );

  const referralName =
    getReferralName(
      payload
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
    await findSignup({
      signupId:
        getSignupId(
          payload
        ),

      email,
    });

  if (existing?.id) {
    return existing;
  }

  const insertPayload = {
    first_name:
      firstName,

    last_name:
      lastName,

    full_name:
      fullName,

    email,

    phone,

    referral_name:
      referralName,

    status:
      "payment_pending",

    payment_status:
      "unpaid",

    membership_status:
      "payment_pending",

    approval_status:
      "pending",

    activation_fee_amount:
      ACTIVATION_FEE_AMOUNT,

    monthly_fee_amount:
      MONTHLY_FEE_AMOUNT,

    billing_day:
      BILLING_DAY,

    portal_login_url:
      "/login.html",

    source:
      "stripe-checkout",

    signup_page:
      "stripe-checkout",

    agreed:
      true,
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

  /*
   * Compatibility for an older signups schema.
   */

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    const fallbackPayload = {
      first_name:
        firstName,

      last_name:
        lastName,

      email,

      phone,

      referral_name:
        referralName,

      status:
        "payment_pending",

      portal_login_url:
        "/login.html",

      source:
        "stripe-checkout",

      signup_page:
        "stripe-checkout",

      agreed:
        true,
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
  }

  if (result.error) {
    /*
     * A simultaneous checkout request may have inserted the same email.
     * Re-read before treating it as fatal.
     */

    const afterInsert =
      await findSignup({
        signupId:
          "",

        email,
      });

    if (afterInsert?.id) {
      return afterInsert;
    }

    throw result.error;
  }

  return (
    result.data ||
    null
  );
}

/* ==========================================================================
   ACTIVE MEMBERSHIP CHECK
============================================================================ */

function memberLooksActive(
  signup
) {
  const paymentStatus =
    normalizeLower(
      signup
        ?.payment_status
    );

  const membershipStatus =
    normalizeLower(
      signup
        ?.membership_status
    );

  return (
    ACTIVE_PAYMENT_STATUSES.has(
      paymentStatus
    ) &&
    ACTIVE_MEMBERSHIP_STATUSES.has(
      membershipStatus
    )
  );
}

/* ==========================================================================
   STRIPE CUSTOMER
============================================================================ */

async function retrieveStripeCustomer(
  customerId
) {
  const safeCustomerId =
    normalizeString(
      customerId
    );

  if (!safeCustomerId) {
    return null;
  }

  try {
    const customer =
      await stripe
        .customers
        .retrieve(
          safeCustomerId
        );

    if (
      customer?.deleted
    ) {
      return null;
    }

    return customer;
  } catch {
    return null;
  }
}

async function findStripeCustomerByEmail(
  email
) {
  const escapedEmail =
    email.replaceAll(
      '"',
      '\\"'
    );

  try {
    const result =
      await stripe
        .customers
        .search({
          query:
            `email:"${escapedEmail}"`,

          limit:
            1,
        });

    return (
      result.data?.[0] ||
      null
    );
  } catch (
    error
  ) {
    /*
     * Stripe Search can occasionally be unavailable or eventually
     * consistent. Fall back to list().
     */

    console.warn(
      "Card Leo Stripe customer search fallback:",
      error?.message ||
      error
    );

    const result =
      await stripe
        .customers
        .list({
          email,

          limit:
            1,
        });

    return (
      result.data?.[0] ||
      null
    );
  }
}

async function findOrCreateStripeCustomer({
  email,
  fullName,
  phone,
  signupId,
  existingCustomerId,
}) {
  let customer =
    await retrieveStripeCustomer(
      existingCustomerId
    );

  if (!customer) {
    customer =
      await findStripeCustomerByEmail(
        email
      );
  }

  if (customer?.id) {
    customer =
      await stripe
        .customers
        .update(
          customer.id,
          {
            email,

            name:
              fullName ||
              customer.name ||
              undefined,

            phone:
              phone ||
              customer.phone ||
              undefined,

            metadata: {
              ...(
                customer.metadata ||
                {}
              ),

              signup_id:
                signupId ||
                customer
                  .metadata
                  ?.signup_id ||
                "",

              source:
                "card-leo-rewards",
            },
          }
        );

    return customer;
  }

  return stripe
    .customers
    .create({
      email,

      name:
        fullName ||
        undefined,

      phone:
        phone ||
        undefined,

      metadata: {
        signup_id:
          signupId ||
          "",

        source:
          "card-leo-rewards",
      },
    });
}

/* ==========================================================================
   EXISTING SUBSCRIPTION

   Prevent a paid active member from accidentally starting a second
   subscription.
============================================================================ */

async function getExistingActiveSubscription(
  signup
) {
  const subscriptionId =
    normalizeString(
      signup
        ?.stripe_subscription_id
    );

  if (!subscriptionId) {
    return null;
  }

  try {
    const subscription =
      await stripe
        .subscriptions
        .retrieve(
          subscriptionId
        );

    if (
      ACTIVE_SUBSCRIPTION_STATUSES.has(
        normalizeLower(
          subscription?.status
        )
      )
    ) {
      return subscription;
    }
  } catch (
    error
  ) {
    console.warn(
      "Card Leo existing subscription check failed:",
      error?.message ||
      error
    );
  }

  return null;
}

/* ==========================================================================
   UPDATE SIGNUP BEFORE CHECKOUT
============================================================================ */

async function updateSignupBeforeCheckout({
  signupId,
  email,
  stripeCustomerId,
  stripeSessionId,
  firstMonthlyChargeDate,
}) {
  if (
    !signupId &&
    !email
  ) {
    return;
  }

  const updatePayload = {
    status:
      "payment_pending",

    payment_status:
      "unpaid",

    membership_status:
      "payment_pending",

    approval_status:
      "pending",

    activation_fee_amount:
      ACTIVATION_FEE_AMOUNT,

    monthly_fee_amount:
      MONTHLY_FEE_AMOUNT,

    billing_day:
      BILLING_DAY,

    portal_login_url:
      "/login.html",

    stripe_customer_id:
      stripeCustomerId,

    stripe_checkout_session_id:
      stripeSessionId,

    updated_at:
      nowIso(),
  };

  /*
   * If your signups schema contains this field it is useful for the admin
   * portal; compatibility fallback below handles databases without it.
   */

  if (
    firstMonthlyChargeDate
  ) {
    updatePayload
      .first_monthly_charge_date =
        firstMonthlyChargeDate;
  }

  let query =
    supabaseAdmin
      .from(
        "signups"
      )
      .update(
        updatePayload
      );

  if (signupId) {
    query =
      query.eq(
        "id",
        signupId
      );
  } else {
    query =
      query.ilike(
        "email",
        email
      );
  }

  let result =
    await query;

  if (
    result.error &&
    isMissingOptionalColumn(
      result.error
    )
  ) {
    const fallbackPayload = {
      status:
        "payment_pending",

      portal_login_url:
        "/login.html",

      stripe_customer_id:
        stripeCustomerId,

      stripe_checkout_session_id:
        stripeSessionId,

      updated_at:
        nowIso(),
    };

    let fallbackQuery =
      supabaseAdmin
        .from(
          "signups"
        )
        .update(
          fallbackPayload
        );

    if (signupId) {
      fallbackQuery =
        fallbackQuery.eq(
          "id",
          signupId
        );
    } else {
      fallbackQuery =
        fallbackQuery.ilike(
          "email",
          email
        );
    }

    result =
      await fallbackQuery;
  }

  if (result.error) {
    console.error(
      "Card Leo checkout signup update failed:",
      result.error
    );
  }
}

/* ==========================================================================
   CHECKOUT IDEMPOTENCY
============================================================================ */

function buildCheckoutIdempotencyKey({
  signupId,
  email,
}) {
  const identity =
    normalizeString(
      signupId
    ) ||
    normalizeEmail(
      email
    );

  const timeWindow =
    Math.floor(
      Date.now() /
      (
        5 *
        60 *
        1000
      )
    );

  const digest =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        [
          "cardleo",
          "checkout",
          identity,
          String(
            timeWindow
          ),
        ].join(":")
      )
      .digest(
        "hex"
      )
      .slice(
        0,
        48
      );

  return `cardleo_checkout_${digest}`;
}

/* ==========================================================================
   SAFE CHECKOUT RESPONSE
============================================================================ */

function buildCheckoutResponse({
  session,
  stripeCustomerId,
  signupId,
  firstMonthlyChargeDate,
}) {
  return {
    message:
      "Stripe Checkout session created.",

    checkout_url:
      session.url,

    checkoutUrl:
      session.url,

    url:
      session.url,

    session_id:
      session.id,

    sessionId:
      session.id,

    stripe_customer_id:
      stripeCustomerId,

    signup_id:
      signupId ||
      "",

    pricing: {
      activationFee:
        ACTIVATION_FEE_AMOUNT,

      monthlyFee:
        MONTHLY_FEE_AMOUNT,

      billingDay:
        BILLING_DAY,

      currency:
        "USD",
    },

    activation_fee_amount:
      ACTIVATION_FEE_AMOUNT,

    monthly_fee_amount:
      MONTHLY_FEE_AMOUNT,

    billing_day:
      BILLING_DAY,

    first_monthly_charge_date:
      firstMonthlyChargeDate,

    billing_note:
      `Member pays $${ACTIVATION_FEE_AMOUNT} today. The $${MONTHLY_FEE_AMOUNT} monthly membership starts on the next eligible ${BILLING_DAY}th.`,

    provisioning: {
      activatedAtCheckout:
        false,

      activationHandledByWebhook:
        true,

      accessPerksHandledByWebhook:
        true,

      growthPoolHandledByWebhook:
        true,
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
       STRIPE CONFIGURATION
    ====================================================================== */

    if (!stripe) {
      return serverError(
        res,
        "Missing STRIPE_SECRET_KEY. Add it in Vercel Environment Variables and redeploy.",
        {
          code:
            "STRIPE_NOT_CONFIGURED",
        }
      );
    }

    if (
      !ACTIVATION_PRICE_ID ||
      !MONTHLY_PRICE_ID
    ) {
      return serverError(
        res,
        "Missing CARDLEO_ACTIVATION_PRICE_ID or CARDLEO_MONTHLY_PRICE_ID.",
        {
          code:
            "STRIPE_PRICE_NOT_CONFIGURED",
        }
      );
    }

    /* ======================================================================
       REQUEST
    ====================================================================== */

    const payload =
      await readJsonBody(
        req
      );

    const origin =
      getOrigin(
        req
      );

    const email =
      normalizeEmail(
        payload.email
      );

    const firstName =
      getFirstName(
        payload
      );

    const lastName =
      getLastName(
        payload
      );

    const fullName =
      getFullName(
        payload
      );

    const phone =
      getPhone(
        payload
      );

    const referralName =
      getReferralName(
        payload
      );

    /* ======================================================================
       VALIDATION
    ====================================================================== */

    if (
      !email ||
      !isValidEmail(
        email
      )
    ) {
      return badRequest(
        res,
        "A valid email address is required to start checkout.",
        {
          code:
            "VALID_EMAIL_REQUIRED",
        }
      );
    }

    /* ======================================================================
       FIND / CREATE SIGNUP
    ====================================================================== */

    const signup =
      await createSignupIfMissing({
        ...payload,

        email,

        firstName,

        first_name:
          firstName,

        lastName,

        last_name:
          lastName,

        fullName,

        full_name:
          fullName,

        phone,

        referralName,

        referral_name:
          referralName,
      });

    if (!signup?.id) {
      return serverError(
        res,
        "Card Leo could not create or locate your membership signup.",
        {
          code:
            "SIGNUP_NOT_AVAILABLE",
        }
      );
    }

    const signupId =
      signup.id;

    /* ======================================================================
       PREVENT DUPLICATE ACTIVE MEMBERSHIP
    ====================================================================== */

    if (
      memberLooksActive(
        signup
      )
    ) {
      const activeSubscription =
        await getExistingActiveSubscription(
          signup
        );

      if (
        activeSubscription
          ?.id
      ) {
        return conflict(
          res,
          "This Card Leo membership is already active.",
          {
            code:
              "MEMBERSHIP_ALREADY_ACTIVE",

            signup_id:
              signupId,

            membership_status:
              signup
                .membership_status,

            payment_status:
              signup
                .payment_status,

            portal_login_url:
              signup
                .portal_login_url ||
              "/login.html",
          }
        );
      }
    }

    /* ======================================================================
       URLS
    ====================================================================== */

    const successUrl =
      safeUrl(
        payload.success_url ||
        payload.successUrl,

        DEFAULT_SUCCESS_URL,

        origin
      );

    const cancelUrl =
      safeUrl(
        payload.cancel_url ||
        payload.cancelUrl,

        DEFAULT_CANCEL_URL,

        origin
      );

    /* ======================================================================
       STRIPE CUSTOMER
    ====================================================================== */

    const stripeCustomer =
      await findOrCreateStripeCustomer({
        email,

        fullName,

        phone,

        signupId,

        existingCustomerId:
          signup
            .stripe_customer_id,
      });

    const stripeCustomerId =
      stripeCustomer?.id ||
      "";

    if (
      !stripeCustomerId
    ) {
      return serverError(
        res,
        "Unable to create the Card Leo Stripe customer.",
        {
          code:
            "STRIPE_CUSTOMER_FAILED",
        }
      );
    }

    /* ======================================================================
       FIRST MONTHLY BILLING DATE
    ====================================================================== */

    const firstMonthlyChargeUnix =
      getNextBillingDayUnixTimestamp(
        BILLING_DAY
      );

    const firstMonthlyChargeDate =
      formatDateFromUnix(
        firstMonthlyChargeUnix
      );

    /* ======================================================================
       CHECKOUT IDEMPOTENCY
    ====================================================================== */

    const idempotencyKey =
      buildCheckoutIdempotencyKey({
        signupId,
        email,
      });

    /* ======================================================================
       STRIPE CHECKOUT

       PAYMENT FLOW
       ------------

       TODAY
       -----
       $25 activation fee

       FIRST ELIGIBLE 10TH
       -------------------
       $20 recurring membership

       FUTURE MONTHS
       -------------
       $20 monthly

       IMPORTANT
       ---------
       The Checkout Session does NOT activate Card Leo membership itself.

       api/billing/webhook.js performs activation after Stripe confirms
       successful payment.
    ====================================================================== */

    const session =
      await stripe
        .checkout
        .sessions
        .create(
          {
            mode:
              "subscription",

            customer:
              stripeCustomerId,

            client_reference_id:
              signupId,

            payment_method_types: [
              "card",
            ],

            line_items: [
              {
                price:
                  MONTHLY_PRICE_ID,

                quantity:
                  1,
              },

              {
                price:
                  ACTIVATION_PRICE_ID,

                quantity:
                  1,
              },
            ],

            success_url:
              `${successUrl}${
                successUrl.includes(
                  "?"
                )
                  ? "&"
                  : "?"
              }session_id={CHECKOUT_SESSION_ID}`,

            cancel_url:
              cancelUrl,

            allow_promotion_codes:
              false,

            /*
             * Keep payment method attached to the subscription/customer so
             * the recurring membership can bill on the first eligible 10th.
             */

            payment_method_collection:
              "always",

            subscription_data: {
              trial_end:
                firstMonthlyChargeUnix,

              trial_settings: {
                end_behavior: {
                  missing_payment_method:
                    "cancel",
                },
              },

              metadata: {
                signup_id:
                  signupId,

                member_id:
                  signupId,

                email,

                source:
                  "card-leo-rewards",

                membership:
                  "card-leo-rewards",

                activation_fee_amount:
                  String(
                    ACTIVATION_FEE_AMOUNT
                  ),

                monthly_fee_amount:
                  String(
                    MONTHLY_FEE_AMOUNT
                  ),

                billing_day:
                  String(
                    BILLING_DAY
                  ),

                first_monthly_charge_date:
                  firstMonthlyChargeDate,

                first_monthly_charge_day:
                  String(
                    BILLING_DAY
                  ),
              },
            },

            metadata: {
              signup_id:
                signupId,

              member_id:
                signupId,

              email,

              first_name:
                firstName,

              last_name:
                lastName,

              full_name:
                fullName,

              phone,

              referral_name:
                referralName,

              source:
                "card-leo-rewards",

              membership:
                "card-leo-rewards",

              activation_fee_amount:
                String(
                  ACTIVATION_FEE_AMOUNT
                ),

              monthly_fee_amount:
                String(
                  MONTHLY_FEE_AMOUNT
                ),

              billing_day:
                String(
                  BILLING_DAY
                ),

              first_monthly_charge_date:
                firstMonthlyChargeDate,

              growth_pool_contribution_amount:
                "2.00",

              growth_pool_trigger:
                "initial_paid_membership_activation",

              growth_pool_handled_by:
                "webhook",
            },
          },

          {
            idempotencyKey,
          }
        );

    if (
      !session?.id ||
      !session?.url
    ) {
      return serverError(
        res,
        "Stripe did not return a valid checkout session.",
        {
          code:
            "INVALID_STRIPE_CHECKOUT_SESSION",
        }
      );
    }

    /* ======================================================================
       UPDATE SIGNUP
    ====================================================================== */

    await updateSignupBeforeCheckout({
      signupId,

      email,

      stripeCustomerId,

      stripeSessionId:
        session.id,

      firstMonthlyChargeDate,
    });

    /* ======================================================================
       SUCCESS
    ====================================================================== */

    console.log(
      "Card Leo checkout session created:",
      {
        signupId,

        email,

        stripeCustomerId,

        stripeSessionId:
          session.id,

        firstMonthlyChargeDate,

        billingDay:
          BILLING_DAY,
      }
    );

    return success(
      res,
      buildCheckoutResponse({
        session,

        stripeCustomerId,

        signupId,

        firstMonthlyChargeDate,
      })
    );
  } catch (
    error
  ) {
    console.error(
      "Card Leo create checkout session error:",
      error
    );

    /*
     * Never expose Stripe keys, raw request objects or Supabase secrets.
     */

    return serverError(
      res,
      error?.type ===
        "StripeInvalidRequestError"
        ? (
            error?.message ||
            "Stripe rejected the checkout configuration."
          )
        : "Unable to create a secure checkout session right now.",
      {
        code:
          error?.code ||
          "CREATE_CHECKOUT_SESSION_FAILED",

        ...(process.env
          .NODE_ENV ===
        "development"
          ? {
              debug:
                error?.message ||
                "Unknown error",
            }
          : {}),
      }
    );
  }
}