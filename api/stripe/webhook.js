// api/stripe/webhook.js
import Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(payload));
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
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

function getMetadataValue(object, keys) {
  const metadata = object?.metadata || {};

  for (const key of keys) {
    const value = normalizeString(metadata[key]);
    if (value) return value;
  }

  return "";
}

function getSessionEmail(session) {
  return normalizeEmail(
    session?.customer_details?.email ||
      session?.customer_email ||
      getMetadataValue(session, ["email", "customer_email"])
  );
}

function getSessionSignupId(session) {
  return normalizeString(
    session?.client_reference_id ||
      getMetadataValue(session, [
        "signup_id",
        "signupId",
        "member_id",
        "memberId",
      ])
  );
}

function getSubscriptionSignupId(subscription) {
  return normalizeString(
    getMetadataValue(subscription, [
      "signup_id",
      "signupId",
      "member_id",
      "memberId",
    ])
  );
}

function getSubscriptionEmail(subscription) {
  return normalizeEmail(
    getMetadataValue(subscription, ["email", "customer_email"])
  );
}

function getInvoiceSignupId(invoice) {
  return normalizeString(
    getMetadataValue(invoice, [
      "signup_id",
      "signupId",
      "member_id",
      "memberId",
    ]) ||
      getMetadataValue(invoice?.subscription_details, [
        "signup_id",
        "signupId",
        "member_id",
        "memberId",
      ])
  );
}

function getInvoiceEmail(invoice) {
  return normalizeEmail(
    invoice?.customer_email ||
      getMetadataValue(invoice, ["email", "customer_email"]) ||
      getMetadataValue(invoice?.subscription_details, ["email", "customer_email"])
  );
}

function getCustomerId(object) {
  const customer = object?.customer;

  if (typeof customer === "string") return customer;
  if (customer?.id) return customer.id;

  return "";
}

function getSubscriptionId(object) {
  const subscription = object?.subscription;

  if (typeof subscription === "string") return subscription;
  if (subscription?.id) return subscription.id;
  if (object?.id && object?.object === "subscription") return object.id;

  return "";
}

async function getCustomerEmail(customerId) {
  if (!customerId) return "";

  try {
    const customer = await stripe.customers.retrieve(customerId);

    if (customer?.deleted) return "";

    return normalizeEmail(customer?.email);
  } catch (error) {
    console.error("Unable to retrieve Stripe customer email:", error);
    return "";
  }
}

async function getSubscriptionMetadata(subscriptionId) {
  if (!subscriptionId) {
    return {
      signupId: "",
      email: "",
      status: "",
    };
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    return {
      signupId: getSubscriptionSignupId(subscription),
      email: getSubscriptionEmail(subscription),
      status: normalizeString(subscription?.status).toLowerCase(),
    };
  } catch (error) {
    console.error("Unable to retrieve Stripe subscription metadata:", error);

    return {
      signupId: "",
      email: "",
      status: "",
    };
  }
}

async function findSignup({ signupId, email, stripeCustomerId }) {
  if (signupId) {
    const byId = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("id", signupId)
      .maybeSingle();

    if (byId.data?.id) return byId.data;
  }

  if (email) {
    const byEmail = await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike("email", email)
      .maybeSingle();

    if (byEmail.data?.id) return byEmail.data;
  }

  if (stripeCustomerId) {
    const byCustomer = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();

    if (byCustomer.data?.id) return byCustomer.data;
  }

  return null;
}

async function updateSignupByIdentity({
  signupId,
  email,
  stripeCustomerId,
  updatePayload,
  fallbackPayload,
}) {
  if (!signupId && !email && !stripeCustomerId) {
    console.warn("Stripe webhook had no signup identity to update.");
    return {
      data: null,
      error: null,
      updated: false,
    };
  }

  let query = supabaseAdmin.from("signups").update(updatePayload);

  if (signupId) {
    query = query.eq("id", signupId);
  } else if (email) {
    query = query.ilike("email", email);
  } else {
    query = query.eq("stripe_customer_id", stripeCustomerId);
  }

  let result = await query.select("*").maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").update(fallbackPayload);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else if (email) {
      fallbackQuery = fallbackQuery.ilike("email", email);
    } else {
      fallbackQuery = fallbackQuery.eq("stripe_customer_id", stripeCustomerId);
    }

    result = await fallbackQuery.select("*").maybeSingle();
  }

  if (result.error) {
    console.error("Stripe webhook signup update failed:", result.error);
    return {
      data: null,
      error: result.error,
      updated: false,
    };
  }

  return {
    data: result.data,
    error: null,
    updated: Boolean(result.data?.id),
  };
}

async function markSignupActive({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  stripeCheckoutSessionId,
  eventId,
}) {
  const updatePayload = {
    status: "approved",
    payment_status: "paid",
    membership_status: "active",
    activation_fee_amount: 25,
    monthly_fee_amount: 20,
    billing_day: 10,
    portal_login_url: "/portal/index.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_checkout_session_id: stripeCheckoutSessionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: new Date().toISOString(),
  };

  const fallbackPayload = {
    status: "approved",
    portal_login_url: "/portal/index.html",
  };

  return updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    updatePayload,
    fallbackPayload,
  });
}

async function markSignupPaymentPending({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  eventId,
  reason = "payment_pending",
}) {
  const updatePayload = {
    status: "payment_pending",
    payment_status: "unpaid",
    membership_status: reason,
    portal_login_url: "/login.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: new Date().toISOString(),
  };

  const fallbackPayload = {
    status: "payment_pending",
    portal_login_url: "/login.html",
  };

  return updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    updatePayload,
    fallbackPayload,
  });
}

async function markSignupCanceled({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  eventId,
}) {
  const updatePayload = {
    status: "cancelled",
    payment_status: "cancelled",
    membership_status: "cancelled",
    portal_login_url: "/login.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: new Date().toISOString(),
  };

  const fallbackPayload = {
    status: "cancelled",
    portal_login_url: "/login.html",
  };

  return updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    updatePayload,
    fallbackPayload,
  });
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;

  const stripeCustomerId = getCustomerId(session);
  const stripeSubscriptionId = getSubscriptionId(session);
  const stripeCheckoutSessionId = session?.id || "";

  let signupId = getSessionSignupId(session);
  let email = getSessionEmail(session);

  if (!signupId || !email) {
    const subscriptionMeta = await getSubscriptionMetadata(stripeSubscriptionId);

    signupId = signupId || subscriptionMeta.signupId;
    email = email || subscriptionMeta.email;
  }

  if (!email) {
    email = await getCustomerEmail(stripeCustomerId);
  }

  const paymentStatus = normalizeString(session?.payment_status).toLowerCase();
  const sessionStatus = normalizeString(session?.status).toLowerCase();

  if (paymentStatus === "paid" || sessionStatus === "complete") {
    return markSignupActive({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      stripeCheckoutSessionId,
      eventId: event.id,
    });
  }

  return markSignupPaymentPending({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    eventId: event.id,
    reason: "payment_pending",
  });
}

async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;

  const stripeCustomerId = getCustomerId(invoice);
  const stripeSubscriptionId = getSubscriptionId(invoice);

  let signupId = getInvoiceSignupId(invoice);
  let email = getInvoiceEmail(invoice);

  if (!signupId || !email) {
    const subscriptionMeta = await getSubscriptionMetadata(stripeSubscriptionId);

    signupId = signupId || subscriptionMeta.signupId;
    email = email || subscriptionMeta.email;
  }

  if (!email) {
    email = await getCustomerEmail(stripeCustomerId);
  }

  return markSignupActive({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeCheckoutSessionId: "",
    eventId: event.id,
  });
}

async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;

  const stripeCustomerId = getCustomerId(invoice);
  const stripeSubscriptionId = getSubscriptionId(invoice);

  let signupId = getInvoiceSignupId(invoice);
  let email = getInvoiceEmail(invoice);

  if (!signupId || !email) {
    const subscriptionMeta = await getSubscriptionMetadata(stripeSubscriptionId);

    signupId = signupId || subscriptionMeta.signupId;
    email = email || subscriptionMeta.email;
  }

  if (!email) {
    email = await getCustomerEmail(stripeCustomerId);
  }

  return markSignupPaymentPending({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    eventId: event.id,
    reason: "past_due",
  });
}

async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;

  const stripeCustomerId = getCustomerId(subscription);
  const stripeSubscriptionId = subscription?.id || "";

  let signupId = getSubscriptionSignupId(subscription);
  let email = getSubscriptionEmail(subscription);

  if (!email) {
    email = await getCustomerEmail(stripeCustomerId);
  }

  const subscriptionStatus = normalizeString(subscription?.status).toLowerCase();

  if (["active", "trialing"].includes(subscriptionStatus)) {
    return markSignupActive({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      stripeCheckoutSessionId: "",
      eventId: event.id,
    });
  }

  if (["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(subscriptionStatus)) {
    return markSignupPaymentPending({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      eventId: event.id,
      reason: subscriptionStatus,
    });
  }

  if (["canceled", "cancelled"].includes(subscriptionStatus)) {
    return markSignupCanceled({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      eventId: event.id,
    });
  }

  return {
    updated: false,
    status: subscriptionStatus,
  };
}

async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;

  const stripeCustomerId = getCustomerId(subscription);
  const stripeSubscriptionId = subscription?.id || "";

  let signupId = getSubscriptionSignupId(subscription);
  let email = getSubscriptionEmail(subscription);

  if (!email) {
    email = await getCustomerEmail(stripeCustomerId);
  }

  return markSignupCanceled({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    eventId: event.id,
  });
}

async function handleEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(event);

    case "invoice.payment_succeeded":
      return handleInvoicePaymentSucceeded(event);

    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event);

    case "customer.subscription.updated":
      return handleSubscriptionUpdated(event);

    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event);

    default:
      return {
        updated: false,
        ignored: true,
        eventType: event.type,
      };
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
    if (!process.env.STRIPE_SECRET_KEY) {
      return sendJson(res, 500, {
        success: false,
        ok: false,
        message: "Missing STRIPE_SECRET_KEY.",
      });
    }

    if (!WEBHOOK_SECRET) {
      return sendJson(res, 500, {
        success: false,
        ok: false,
        message: "Missing STRIPE_WEBHOOK_SECRET.",
      });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
    } catch (error) {
      console.error("Stripe webhook signature verification failed:", error);

      return sendJson(res, 400, {
        success: false,
        ok: false,
        message: `Webhook signature verification failed: ${error.message}`,
      });
    }

    const result = await handleEvent(event);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      received: true,
      event_id: event.id,
      event_type: event.type,
      result,
    });
  } catch (error) {
    console.error("Card Leo Stripe webhook error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message: error?.message || "Stripe webhook failed.",
    });
  }
}