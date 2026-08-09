// api/billing/create-checkout-session.js
import Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    })
  : null;

const DEFAULT_SUCCESS_URL =
  process.env.CARDLEO_SUCCESS_URL ||
  "https://www.cardleorewards.com/thank-you.html?payment=success&membership=activated";

const DEFAULT_CANCEL_URL =
  process.env.CARDLEO_CANCEL_URL ||
  "https://www.cardleorewards.com/signup.html?payment=cancelled";

const ACTIVATION_PRICE_ID =
  process.env.CARDLEO_ACTIVATION_PRICE_ID || "";

const MONTHLY_PRICE_ID =
  process.env.CARDLEO_MONTHLY_PRICE_ID || "";

const ACTIVATION_FEE_AMOUNT = 25;
const MONTHLY_FEE_AMOUNT = 20;
const BILLING_DAY = 10;

// Stripe requires trial_end to be at least 2 days in the future.
// We add a small safety buffer so we do not accidentally hit the boundary.
const MINIMUM_TRIAL_SECONDS = 48 * 60 * 60 + 5 * 60;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");

  return res.end(JSON.stringify(payload));
}

function getOrigin(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "www.cardleorewards.com";

  return `${proto}://${host}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function safeUrl(value, fallback, origin) {
  const url = normalizeString(value);

  if (!url) {
    return fallback;
  }

  if (url.startsWith("/") && !url.startsWith("//")) {
    return `${origin}${url}`;
  }

  if (url.startsWith("https://") || url.startsWith("http://")) {
    return url;
  }

  return fallback;
}

function getFullName(payload) {
  const fullName = normalizeString(
    payload.fullName || payload.full_name
  );

  if (fullName) {
    return fullName;
  }

  return [
    payload.firstName || payload.first_name,
    payload.lastName || payload.last_name,
  ]
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");
}

function getSignupId(payload) {
  return normalizeString(
    payload.signup_id ||
      payload.signupId ||
      payload.id ||
      payload.member_id ||
      payload.memberId
  );
}

function getReferralName(payload) {
  return normalizeString(
    payload.referralName ||
      payload.referral_name ||
      payload.sponsor_name ||
      payload.sponsorName
  );
}

function getFirstName(payload) {
  return normalizeString(
    payload.firstName || payload.first_name
  );
}

function getLastName(payload) {
  return normalizeString(
    payload.lastName || payload.last_name
  );
}

function getPhone(payload) {
  return normalizeString(payload.phone);
}

function isMissingOptionalColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache") ||
    details.includes("does not exist") ||
    details.includes("could not find") ||
    details.includes("schema cache")
  );
}

/**
 * Returns the next BILLING_DAY that is safely more than
 * 48 hours in the future.
 *
 * Example:
 *
 * August 8 -> August 10 if August 10 is >48 hours away.
 * August 9 -> September 10 because August 10 is too close.
 *
 * This prevents Stripe's:
 * "trial_end date has to be at least 2 days in the future"
 * error.
 */
function getNextBillingDayUnixTimestamp(
  dayOfMonth = BILLING_DAY
) {
  const now = new Date();

  const minimumAllowedTime =
    now.getTime() + MINIMUM_TRIAL_SECONDS * 1000;

  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  let billingDate = new Date(
    Date.UTC(
      year,
      month,
      dayOfMonth,
      14,
      0,
      0
    )
  );

  // If this month's billing day has already passed,
  // move to the next month.
  if (billingDate.getTime() <= now.getTime()) {
    month += 1;

    billingDate = new Date(
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

  // Stripe requires trial_end to be at least 48 hours
  // in the future. If the upcoming 10th is too close,
  // move the billing date to the following month.
  if (billingDate.getTime() <= minimumAllowedTime) {
    month += 1;

    billingDate = new Date(
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

  return Math.floor(billingDate.getTime() / 1000);
}

function formatDateFromUnix(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

async function findSignup({ signupId, email }) {
  if (signupId) {
    const byId = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("id", signupId)
      .maybeSingle();

    if (byId.data?.id) {
      return byId.data;
    }
  }

  if (email) {
    const byEmail = await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike("email", email)
      .maybeSingle();

    if (byEmail.data?.id) {
      return byEmail.data;
    }
  }

  return null;
}

async function createSignupIfMissing(payload) {
  const email = normalizeEmail(payload.email);
  const firstName = getFirstName(payload);
  const lastName = getLastName(payload);
  const fullName = getFullName(payload);
  const phone = getPhone(payload);
  const referralName = getReferralName(payload);

  if (!email || !isValidEmail(email)) {
    return null;
  }

  const existing = await findSignup({
    signupId: getSignupId(payload),
    email,
  });

  if (existing?.id) {
    return existing;
  }

  const insertPayload = {
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    email,
    phone,
    referral_name: referralName,

    status: "payment_pending",
    payment_status: "unpaid",
    membership_status: "payment_pending",

    activation_fee_amount: ACTIVATION_FEE_AMOUNT,
    monthly_fee_amount: MONTHLY_FEE_AMOUNT,
    billing_day: BILLING_DAY,

    portal_login_url: "/login.html",

    source: "stripe-checkout",
    signup_page: "stripe-checkout",

    agreed: true,
  };

  let result = await supabaseAdmin
    .from("signups")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  // Fallback for databases where some optional columns
  // do not yet exist.
  if (
    result.error &&
    isMissingOptionalColumn(result.error)
  ) {
    const fallbackPayload = {
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      referral_name: referralName,

      status: "payment_pending",

      portal_login_url: "/login.html",

      source: "stripe-checkout",
      signup_page: "stripe-checkout",

      agreed: true,
    };

    result = await supabaseAdmin
      .from("signups")
      .insert(fallbackPayload)
      .select("*")
      .maybeSingle();
  }

  if (result.error) {
    throw result.error;
  }

  return result.data || null;
}

async function findOrCreateStripeCustomer({
  email,
  fullName,
  phone,
  signupId,
}) {
  const searchQuery = `email:"${email.replaceAll(
    '"',
    '\\"'
  )}"`;

  const existingCustomers =
    await stripe.customers.search({
      query: searchQuery,
      limit: 1,
    });

  if (existingCustomers.data?.[0]?.id) {
    const customer = existingCustomers.data[0];

    await stripe.customers.update(customer.id, {
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
        ...(customer.metadata || {}),
        signup_id:
          signupId ||
          customer.metadata?.signup_id ||
          "",
        source: "card-leo-rewards",
      },
    });

    return customer.id;
  }

  const customer = await stripe.customers.create({
    email,
    name: fullName || undefined,
    phone: phone || undefined,

    metadata: {
      signup_id: signupId || "",
      source: "card-leo-rewards",
    },
  });

  return customer.id;
}

async function updateSignupBeforeCheckout({
  signupId,
  email,
  stripeCustomerId,
  stripeSessionId,
}) {
  if (!signupId && !email) {
    return;
  }

  const updatePayload = {
    status: "payment_pending",
    payment_status: "unpaid",
    membership_status: "payment_pending",

    activation_fee_amount: ACTIVATION_FEE_AMOUNT,
    monthly_fee_amount: MONTHLY_FEE_AMOUNT,
    billing_day: BILLING_DAY,

    portal_login_url: "/login.html",

    stripe_customer_id: stripeCustomerId,
    stripe_checkout_session_id: stripeSessionId,
  };

  let query =
    supabaseAdmin
      .from("signups")
      .update(updatePayload);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.ilike("email", email);
  }

  let result = await query;

  if (
    result.error &&
    isMissingOptionalColumn(result.error)
  ) {
    const fallbackPayload = {
      status: "payment_pending",
      portal_login_url: "/login.html",
    };

    let fallbackQuery =
      supabaseAdmin
        .from("signups")
        .update(fallbackPayload);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq(
        "id",
        signupId
      );
    } else {
      fallbackQuery = fallbackQuery.ilike(
        "email",
        email
      );
    }

    result = await fallbackQuery;
  }

  if (result.error) {
    console.error(
      "Card Leo checkout signup update failed:",
      result.error
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use POST.",
    });
  }

  try {
    // --------------------------------------------------
    // STRIPE CONFIGURATION
    // --------------------------------------------------

    if (!stripe) {
      return sendJson(res, 500, {
        success: false,
        ok: false,
        message:
          "Missing STRIPE_SECRET_KEY. Add it in Vercel Environment Variables and redeploy.",
      });
    }

    if (
      !ACTIVATION_PRICE_ID ||
      !MONTHLY_PRICE_ID
    ) {
      return sendJson(res, 500, {
        success: false,
        ok: false,
        message:
          "Missing CARDLEO_ACTIVATION_PRICE_ID or CARDLEO_MONTHLY_PRICE_ID.",
      });
    }

    // --------------------------------------------------
    // READ REQUEST
    // --------------------------------------------------

    const payload = await readJsonBody(req);

    const origin = getOrigin(req);

    const email = normalizeEmail(payload.email);

    const firstName = getFirstName(payload);
    const lastName = getLastName(payload);
    const fullName = getFullName(payload);
    const phone = getPhone(payload);
    const referralName =
      getReferralName(payload);

    // --------------------------------------------------
    // VALIDATE EMAIL
    // --------------------------------------------------

    if (
      !email ||
      !isValidEmail(email)
    ) {
      return sendJson(res, 400, {
        success: false,
        ok: false,
        message:
          "A valid email address is required to start checkout.",
      });
    }

    // --------------------------------------------------
    // CREATE / FIND SIGNUP
    // --------------------------------------------------

    const signup =
      await createSignupIfMissing({
        ...payload,

        email,

        firstName,
        first_name: firstName,

        lastName,
        last_name: lastName,

        fullName,
        full_name: fullName,

        phone,

        referralName,
        referral_name: referralName,
      });

    const signupId =
      signup?.id ||
      getSignupId(payload);

    // --------------------------------------------------
    // SUCCESS / CANCEL URLS
    // --------------------------------------------------

    const successUrl = safeUrl(
      payload.success_url ||
        payload.successUrl,
      DEFAULT_SUCCESS_URL,
      origin
    );

    const cancelUrl = safeUrl(
      payload.cancel_url ||
        payload.cancelUrl,
      DEFAULT_CANCEL_URL,
      origin
    );

    // --------------------------------------------------
    // STRIPE CUSTOMER
    // --------------------------------------------------

    const stripeCustomerId =
      await findOrCreateStripeCustomer({
        email,
        fullName,
        phone,
        signupId,
      });

    // --------------------------------------------------
    // BILLING DATE
    // --------------------------------------------------

    /*
      Card Leo pricing:

      TODAY:
        $25 one-time activation fee

      NEXT BILLING DATE:
        $20/month recurring

      Billing day:
        10th of the month

      Stripe requires trial_end to be at least
      48 hours in the future.

      getNextBillingDayUnixTimestamp()
      automatically moves the billing date to
      the following month if the upcoming 10th
      is too close.
    */

    const firstMonthlyChargeUnix =
      getNextBillingDayUnixTimestamp(
        BILLING_DAY
      );

    const firstMonthlyChargeDate =
      formatDateFromUnix(
        firstMonthlyChargeUnix
      );

    // --------------------------------------------------
    // CREATE STRIPE CHECKOUT SESSION
    // --------------------------------------------------

    const session =
      await stripe.checkout.sessions.create({
        mode: "subscription",

        customer: stripeCustomerId,

        client_reference_id:
          signupId || email,

        payment_method_types: ["card"],

        /*
          Checkout charges:

          1. $20 monthly recurring price
          2. $25 one-time activation price

          The subscription starts today, but the
          recurring monthly charge is delayed until
          the calculated billing date.
        */

        line_items: [
          {
            price: MONTHLY_PRICE_ID,
            quantity: 1,
          },
          {
            price: ACTIVATION_PRICE_ID,
            quantity: 1,
          },
        ],

        success_url: `${successUrl}${
          successUrl.includes("?")
            ? "&"
            : "?"
        }session_id={CHECKOUT_SESSION_ID}`,

        cancel_url: cancelUrl,

        allow_promotion_codes: false,

        /*
          IMPORTANT:

          We intentionally keep trial_end because
          it lets us control the first recurring
          billing date.

          The date is calculated to always be
          MORE than 48 hours in the future.
        */

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
              signupId || "",

            email,

            source:
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
              String(BILLING_DAY),

            first_monthly_charge_date:
              firstMonthlyChargeDate,

            first_monthly_charge_day:
              String(BILLING_DAY),
          },
        },

        metadata: {
          signup_id:
            signupId || "",

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

          activation_fee_amount:
            String(
              ACTIVATION_FEE_AMOUNT
            ),

          monthly_fee_amount:
            String(
              MONTHLY_FEE_AMOUNT
            ),

          billing_day:
            String(BILLING_DAY),

          first_monthly_charge_date:
            firstMonthlyChargeDate,
        },
      });

    // --------------------------------------------------
    // UPDATE SUPABASE
    // --------------------------------------------------

    await updateSignupBeforeCheckout({
      signupId,
      email,
      stripeCustomerId,
      stripeSessionId: session.id,
    });

    // --------------------------------------------------
    // RETURN CHECKOUT URL
    // --------------------------------------------------

    return sendJson(res, 200, {
      success: true,
      ok: true,

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
        signupId || "",

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
    });
  } catch (error) {
    console.error(
      "Card Leo create checkout session error:",
      error
    );

    return sendJson(res, 500, {
      success: false,
      ok: false,

      message:
        error?.message ||
        "Unable to create a secure checkout session right now.",
    });
  }
}