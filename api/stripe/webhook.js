// api/stripe/webhook.js
import Stripe from "stripe";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  buildMemberCustomerIdentifier,
  isAccessActiveMember,
  syncMemberToAccessAmt,
  suspendMemberInAccessAmt,
} from "../../lib/access-amt.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function isMissingOptionalColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
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
      getMetadataValue(session, ["email", "customer_email", "member_email"])
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
    getMetadataValue(subscription, [
      "email",
      "customer_email",
      "member_email",
    ])
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
      getMetadataValue(invoice, ["email", "customer_email", "member_email"]) ||
      getMetadataValue(invoice?.subscription_details, [
        "email",
        "customer_email",
        "member_email",
      ])
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

function getCheckoutSessionId(object) {
  if (object?.object === "checkout.session") {
    return normalizeString(object.id);
  }

  return "";
}

function getNamePartsFromStripeObject(object = {}) {
  const fullName = normalizeString(
    object.customer_details?.name ||
      object.billing_details?.name ||
      getMetadataValue(object, ["full_name", "fullName", "name"])
  );

  const firstName = normalizeString(
    getMetadataValue(object, ["first_name", "firstName"])
  );

  const lastName = normalizeString(
    getMetadataValue(object, ["last_name", "lastName"])
  );

  if (firstName || lastName) {
    return {
      first_name: firstName,
      last_name: lastName,
      full_name: [firstName, lastName].filter(Boolean).join(" "),
    };
  }

  const parts = fullName.split(/\s+/).filter(Boolean);

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

function isActiveMember(member = {}) {
  const status = normalizeString(member.status).toLowerCase();
  const paymentStatus = normalizeString(member.payment_status).toLowerCase();
  const membershipStatus = normalizeString(member.membership_status).toLowerCase();
  const approvalStatus = normalizeString(member.approval_status).toLowerCase();

  return (
    ACTIVE_STATUSES.has(status) ||
    ACTIVE_STATUSES.has(paymentStatus) ||
    ACTIVE_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
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

async function findSignup({ signupId, email, stripeCustomerId, stripeSubscriptionId }) {
  if (signupId) {
    const byId = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("id", signupId)
      .maybeSingle();

    if (byId.error) throw byId.error;
    if (byId.data?.id) return byId.data;
  }

  if (email && isValidEmail(email)) {
    const byEmail = await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike("email", email)
      .maybeSingle();

    if (byEmail.error) throw byEmail.error;
    if (byEmail.data?.id) return byEmail.data;
  }

  if (stripeCustomerId) {
    const byCustomer = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();

    if (byCustomer.error && !isMissingOptionalColumn(byCustomer.error)) {
      throw byCustomer.error;
    }

    if (byCustomer.data?.id) return byCustomer.data;
  }

  if (stripeSubscriptionId) {
    const bySubscription = await supabaseAdmin
      .from("signups")
      .select("*")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();

    if (bySubscription.error && !isMissingOptionalColumn(bySubscription.error)) {
      throw bySubscription.error;
    }

    if (bySubscription.data?.id) return bySubscription.data;
  }

  return null;
}

async function updateSignupByIdentity({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  updatePayload,
  fallbackPayload,
}) {
  if (!signupId && !email && !stripeCustomerId && !stripeSubscriptionId) {
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
  } else if (stripeCustomerId) {
    query = query.eq("stripe_customer_id", stripeCustomerId);
  } else {
    query = query.eq("stripe_subscription_id", stripeSubscriptionId);
  }

  let result = await query.select("*").maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").update(fallbackPayload);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else if (email) {
      fallbackQuery = fallbackQuery.ilike("email", email);
    } else if (stripeCustomerId) {
      fallbackQuery = fallbackQuery.eq("stripe_customer_id", stripeCustomerId);
    } else {
      fallbackQuery = fallbackQuery.eq("stripe_subscription_id", stripeSubscriptionId);
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

async function createSignupFromStripeObject(object = {}) {
  const email = normalizeEmail(
    getSessionEmail(object) ||
      getInvoiceEmail(object) ||
      getSubscriptionEmail(object) ||
      object?.customer_details?.email ||
      object?.customer_email
  );

  if (!email || !isValidEmail(email)) return null;

  const existing = await findSignup({
    signupId: "",
    email,
    stripeCustomerId: getCustomerId(object),
    stripeSubscriptionId: getSubscriptionId(object),
  });

  if (existing?.id) return existing;

  const names = getNamePartsFromStripeObject(object);
  const now = new Date().toISOString();

  const insertPayload = {
    email,
    first_name: names.first_name,
    last_name: names.last_name,
    full_name: names.full_name,
    phone: normalizeString(
      object.customer_details?.phone ||
        object.billing_details?.phone ||
        getMetadataValue(object, ["phone"])
    ),
    status: "approved",
    payment_status: "paid",
    membership_status: "active",
    approval_status: "approved",
    activation_fee_amount: 25,
    monthly_fee_amount: 20,
    billing_day: 10,
    portal_login_url: "/portal/index.html",
    stripe_customer_id: getCustomerId(object) || null,
    stripe_subscription_id: getSubscriptionId(object) || null,
    stripe_checkout_session_id: getCheckoutSessionId(object) || null,
    stripe_last_event_at: now,
    created_at: now,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  if (!result.error) return result.data || null;

  if (!isMissingOptionalColumn(result.error)) throw result.error;

  const fallbackPayload = {
    email,
    first_name: names.first_name,
    last_name: names.last_name,
    phone: insertPayload.phone,
    status: "approved",
    portal_login_url: "/portal/index.html",
    created_at: now,
    updated_at: now,
  };

  result = await supabaseAdmin
    .from("signups")
    .insert(fallbackPayload)
    .select("*")
    .maybeSingle();

  if (result.error) throw result.error;

  return result.data || null;
}

async function saveAccessSuccess(member, accessResult, accessStatus = "OPEN") {
  if (!member?.id) return null;

  const now = new Date().toISOString();

  const updatePayload = {
    access_member_identifier:
      accessResult?.access_member_identifier ||
      buildMemberCustomerIdentifier(member),
    access_member_status: accessStatus,
    access_synced_at: now,
    access_sync_error: null,
    access_last_payload: accessResult?.access_payload || accessResult?.payload || null,
    access_last_response:
      accessResult?.access_response || accessResult?.response || null,
    access_perks_ready: accessStatus === "OPEN",
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) return result.data || { ...member, ...updatePayload };

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Access success save failed:", result.error);
  }

  return member;
}

async function saveAccessFailure(member, error, accessStatus = "sync_failed") {
  if (!member?.id) return null;

  const now = new Date().toISOString();

  const updatePayload = {
    access_member_identifier: buildMemberCustomerIdentifier(member),
    access_member_status: accessStatus,
    access_sync_error:
      error?.message || "Access AMT request failed for this member.",
    access_last_payload: error?.payload || null,
    access_last_response: error?.response || null,
    access_perks_ready: false,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) return result.data || { ...member, ...updatePayload };

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Access failure save failed:", result.error);
  }

  return member;
}

async function syncActiveMemberToAccess(member) {
  if (!member?.id) {
    return {
      attempted: false,
      success: false,
      reason: "missing_member",
    };
  }

  if (!isAccessActiveMember(member) && !isActiveMember(member)) {
    return {
      attempted: false,
      success: false,
      reason: "member_not_active",
    };
  }

  const accessMemberIdentifier = buildMemberCustomerIdentifier(member);

  const memberForAccess = {
    ...member,
    access_member_identifier: accessMemberIdentifier,
    member_customer_identifier: accessMemberIdentifier,
  };

  try {
    const accessResult = await syncMemberToAccessAmt(memberForAccess);
    await saveAccessSuccess(member, accessResult, "OPEN");

    return {
      attempted: true,
      success: true,
      member_status: "OPEN",
      member_customer_identifier: accessMemberIdentifier,
      status: accessResult.status,
      statusText: accessResult.statusText,
      url: accessResult.url,
      response: accessResult.response,
    };
  } catch (error) {
    console.error("Access AMT active sync failed:", {
      memberId: member.id,
      email: member.email,
      error,
    });

    await saveAccessFailure(member, error, "sync_failed");

    return {
      attempted: true,
      success: false,
      member_status: "sync_failed",
      member_customer_identifier: accessMemberIdentifier,
      status: error?.status || null,
      statusText: error?.statusText || "",
      url: error?.url || "",
      message: error?.message || "Access AMT sync failed.",
      response: error?.response || null,
    };
  }
}

async function suspendMemberFromAccess(member) {
  if (!member?.id) {
    return {
      attempted: false,
      success: false,
      reason: "missing_member",
    };
  }

  const accessMemberIdentifier = buildMemberCustomerIdentifier(member);

  const memberForAccess = {
    ...member,
    access_member_identifier: accessMemberIdentifier,
    member_customer_identifier: accessMemberIdentifier,
  };

  try {
    const accessResult = await suspendMemberInAccessAmt(memberForAccess);
    await saveAccessSuccess(member, accessResult, "SUSPEND");

    return {
      attempted: true,
      success: true,
      member_status: "SUSPEND",
      member_customer_identifier: accessMemberIdentifier,
      status: accessResult.status,
      statusText: accessResult.statusText,
      url: accessResult.url,
      response: accessResult.response,
    };
  } catch (error) {
    console.error("Access AMT suspend failed:", {
      memberId: member.id,
      email: member.email,
      error,
    });

    await saveAccessFailure(member, error, "suspend_failed");

    return {
      attempted: true,
      success: false,
      member_status: "suspend_failed",
      member_customer_identifier: accessMemberIdentifier,
      status: error?.status || null,
      statusText: error?.statusText || "",
      url: error?.url || "",
      message: error?.message || "Access AMT suspend failed.",
      response: error?.response || null,
    };
  }
}

async function markSignupActive({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  stripeCheckoutSessionId,
  eventId,
  stripeObject,
}) {
  const now = new Date().toISOString();
  const names = getNamePartsFromStripeObject(stripeObject || {});

  const updatePayload = {
    status: "approved",
    payment_status: "paid",
    membership_status: "active",
    approval_status: "approved",
    activation_fee_amount: 25,
    monthly_fee_amount: 20,
    billing_day: 10,
    portal_login_url: "/portal/index.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_checkout_session_id: stripeCheckoutSessionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: now,
    updated_at: now,
  };

  if (names.first_name) updatePayload.first_name = names.first_name;
  if (names.last_name) updatePayload.last_name = names.last_name;
  if (names.full_name) updatePayload.full_name = names.full_name;

  const fallbackPayload = {
    status: "approved",
    portal_login_url: "/portal/index.html",
    updated_at: now,
  };

  let result = await updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    updatePayload,
    fallbackPayload,
  });

  let member = result.data;

  if (!member?.id) {
    member = await findSignup({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
    });
  }

  if (!member?.id && stripeObject) {
    member = await createSignupFromStripeObject(stripeObject);
  }

  if (member?.id) {
    const accessSync = await syncActiveMemberToAccess(member);

    return {
      ...result,
      data: member,
      accessSync,
    };
  }

  return {
    ...result,
    accessSync: {
      attempted: false,
      success: false,
      reason: "member_not_found_after_active_update",
    },
  };
}

async function markSignupPaymentPending({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  eventId,
  reason = "payment_pending",
}) {
  const now = new Date().toISOString();

  const updatePayload = {
    status: "payment_pending",
    payment_status: "unpaid",
    membership_status: reason,
    approval_status: "payment_required",
    portal_login_url: "/login.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: now,
    access_perks_ready: false,
    updated_at: now,
  };

  const fallbackPayload = {
    status: "payment_pending",
    portal_login_url: "/login.html",
    updated_at: now,
  };

  const result = await updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    updatePayload,
    fallbackPayload,
  });

  const member =
    result.data ||
    (await findSignup({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
    }));

  const accessSync = member?.id
    ? await suspendMemberFromAccess(member)
    : {
        attempted: false,
        success: false,
        reason: "member_not_found_for_suspend",
      };

  return {
    ...result,
    accessSync,
  };
}

async function markSignupCanceled({
  signupId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  eventId,
}) {
  const now = new Date().toISOString();

  const updatePayload = {
    status: "cancelled",
    payment_status: "cancelled",
    membership_status: "cancelled",
    approval_status: "cancelled",
    portal_login_url: "/login.html",
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_last_event_id: eventId || null,
    stripe_last_event_at: now,
    access_perks_ready: false,
    updated_at: now,
  };

  const fallbackPayload = {
    status: "cancelled",
    portal_login_url: "/login.html",
    updated_at: now,
  };

  const result = await updateSignupByIdentity({
    signupId,
    email,
    stripeCustomerId,
    stripeSubscriptionId,
    updatePayload,
    fallbackPayload,
  });

  const member =
    result.data ||
    (await findSignup({
      signupId,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
    }));

  const accessSync = member?.id
    ? await suspendMemberFromAccess(member)
    : {
        attempted: false,
        success: false,
        reason: "member_not_found_for_suspend",
      };

  return {
    ...result,
    accessSync,
  };
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
      stripeObject: session,
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
    stripeObject: invoice,
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
      stripeObject: subscription,
    });
  }

  if (
    ["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(
      subscriptionStatus
    )
  ) {
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
    accessSync: {
      attempted: false,
      success: false,
      reason: "subscription_status_ignored",
    },
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
    case "invoice.paid":
      return handleInvoicePaymentSucceeded(event);

    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event);

    case "customer.subscription.created":
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