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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

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

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
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
    message.includes("schema cache") ||
    message.includes("could not find") ||
    details.includes("does not exist") ||
    details.includes("schema cache") ||
    details.includes("could not find")
  );
}

function getStripeCustomerIdFromEventObject(object = {}) {
  return normalizeString(
    object.customer ||
      object.customer_id ||
      object.customerId ||
      object.data?.object?.customer ||
      ""
  );
}

function getStripeSubscriptionIdFromEventObject(object = {}) {
  return normalizeString(
    object.subscription ||
      object.subscription_id ||
      object.subscriptionId ||
      object.id ||
      ""
  );
}

function getEmailFromEventObject(object = {}) {
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

function getSignupIdFromEventObject(object = {}) {
  return normalizeString(
    object.metadata?.signup_id ||
      object.metadata?.signupId ||
      object.metadata?.member_id ||
      object.metadata?.memberId ||
      object.client_reference_id ||
      ""
  );
}

function getNamePartsFromStripeObject(object = {}) {
  const fullName = normalizeString(
    object.customer_details?.name ||
      object.billing_details?.name ||
      object.metadata?.full_name ||
      object.metadata?.fullName ||
      object.metadata?.name ||
      ""
  );

  const firstName = normalizeString(
    object.metadata?.first_name || object.metadata?.firstName || ""
  );

  const lastName = normalizeString(
    object.metadata?.last_name || object.metadata?.lastName || ""
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

function isActiveStatus(member = {}) {
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

async function findSignupById(id) {
  const safeId = normalizeString(id);

  if (!safeId) return null;

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("id", safeId)
    .maybeSingle();

  if (error) throw error;

  return data?.id ? data : null;
}

async function findSignupByEmail(email) {
  const safeEmail = normalizeEmail(email);

  if (!safeEmail || !isValidEmail(safeEmail)) return null;

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .ilike("email", safeEmail)
    .maybeSingle();

  if (error) throw error;

  return data?.id ? data : null;
}

async function findSignupByStripeCustomer(customerId) {
  const safeCustomerId = normalizeString(customerId);

  if (!safeCustomerId) return null;

  let result = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("stripe_customer_id", safeCustomerId)
    .maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    return null;
  }

  if (result.error) throw result.error;

  return result.data?.id ? result.data : null;
}

async function findSignupByStripeSubscription(subscriptionId) {
  const safeSubscriptionId = normalizeString(subscriptionId);

  if (!safeSubscriptionId) return null;

  let result = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("stripe_subscription_id", safeSubscriptionId)
    .maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    return null;
  }

  if (result.error) throw result.error;

  return result.data?.id ? result.data : null;
}

async function findSignupFromStripeObject(object = {}) {
  const signupId = getSignupIdFromEventObject(object);
  const email = getEmailFromEventObject(object);
  const customerId = getStripeCustomerIdFromEventObject(object);
  const subscriptionId = getStripeSubscriptionIdFromEventObject(object);

  if (signupId) {
    const byId = await findSignupById(signupId);
    if (byId?.id) return byId;
  }

  if (customerId) {
    const byCustomer = await findSignupByStripeCustomer(customerId);
    if (byCustomer?.id) return byCustomer;
  }

  if (subscriptionId) {
    const bySubscription = await findSignupByStripeSubscription(subscriptionId);
    if (bySubscription?.id) return bySubscription;
  }

  if (email) {
    const byEmail = await findSignupByEmail(email);
    if (byEmail?.id) return byEmail;
  }

  return null;
}

async function createSignupFromStripeObject(object = {}) {
  const email = getEmailFromEventObject(object);

  if (!email || !isValidEmail(email)) return null;

  const names = getNamePartsFromStripeObject(object);
  const now = new Date().toISOString();

  const insertPayload = {
    email,
    first_name: names.first_name || "",
    last_name: names.last_name || "",
    full_name: names.full_name || "",
    phone: normalizeString(object.customer_details?.phone || object.metadata?.phone || ""),
    status: "active",
    payment_status: "paid",
    membership_status: "active",
    approval_status: "approved",
    activation_fee_amount: Number(object.metadata?.activation_fee_amount || 25),
    monthly_fee_amount: Number(object.metadata?.monthly_fee_amount || 20),
    billing_day: Number(object.metadata?.billing_day || 10),
    stripe_customer_id: getStripeCustomerIdFromEventObject(object),
    stripe_subscription_id: normalizeString(object.subscription || ""),
    stripe_checkout_session_id: normalizeString(object.id || ""),
    portal_login_url: "/portal/index.html",
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
    first_name: names.first_name || "",
    last_name: names.last_name || "",
    phone: normalizeString(object.customer_details?.phone || object.metadata?.phone || ""),
    status: "active",
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

async function updateSignupActive(member, object = {}) {
  const now = new Date().toISOString();

  const names = getNamePartsFromStripeObject(object);
  const customerId = getStripeCustomerIdFromEventObject(object);
  const subscriptionId =
    normalizeString(object.subscription) ||
    normalizeString(object.id && object.object === "subscription" ? object.id : "");

  const fullPayload = {
    status: "active",
    payment_status: "paid",
    membership_status: "active",
    approval_status: "approved",
    portal_login_url: "/portal/index.html",

    stripe_customer_id: customerId || member.stripe_customer_id || "",
    stripe_subscription_id: subscriptionId || member.stripe_subscription_id || "",
    stripe_checkout_session_id:
      object.object === "checkout.session"
        ? normalizeString(object.id)
        : member.stripe_checkout_session_id || "",

    activation_fee_amount: Number(member.activation_fee_amount || 25),
    monthly_fee_amount: Number(member.monthly_fee_amount || 20),
    billing_day: Number(member.billing_day || 10),

    updated_at: now,
  };

  if (!member.first_name && names.first_name) {
    fullPayload.first_name = names.first_name;
  }

  if (!member.last_name && names.last_name) {
    fullPayload.last_name = names.last_name;
  }

  if (!member.full_name && names.full_name) {
    fullPayload.full_name = names.full_name;
  }

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) return result.data || { ...member, ...fullPayload };

  if (!isMissingOptionalColumn(result.error)) throw result.error;

  const fallbackPayload = {
    status: "active",
    updated_at: now,
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (result.error) throw result.error;

  return result.data || { ...member, ...fallbackPayload };
}

async function updateSignupPastDueOrInactive(member, statusPayload = {}) {
  const now = new Date().toISOString();

  const fullPayload = {
    status: statusPayload.status || "inactive",
    payment_status: statusPayload.payment_status || "past_due",
    membership_status: statusPayload.membership_status || "inactive",
    approval_status: statusPayload.approval_status || "payment_required",
    access_perks_ready: false,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) return result.data || { ...member, ...fullPayload };

  if (!isMissingOptionalColumn(result.error)) throw result.error;

  const fallbackPayload = {
    status: statusPayload.status || "inactive",
    updated_at: now,
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (result.error) throw result.error;

  return result.data || { ...member, ...fallbackPayload };
}

async function saveAccessSuccess(member, accessResult, status = "OPEN") {
  const now = new Date().toISOString();

  const fullPayload = {
    access_member_identifier:
      accessResult.access_member_identifier ||
      buildMemberCustomerIdentifier(member),
    access_member_status: status,
    access_synced_at: now,
    access_sync_error: null,
    access_last_payload: accessResult.access_payload || accessResult.payload || null,
    access_last_response:
      accessResult.access_response || accessResult.response || null,
    access_perks_ready: status === "OPEN",
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", member.id);

  if (!result.error) return;

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Access success save failed:", result.error);
  }
}

async function saveAccessFailure(member, error, status = "sync_failed") {
  const now = new Date().toISOString();

  const fullPayload = {
    access_member_identifier: buildMemberCustomerIdentifier(member),
    access_member_status: status,
    access_sync_error:
      error?.message || "Access AMT request failed for this member.",
    access_last_payload: error?.payload || null,
    access_last_response: error?.response || null,
    access_perks_ready: false,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", member.id);

  if (!result.error) return;

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Access failure save failed:", result.error);
  }
}

async function syncActiveMemberToAccess(member) {
  if (!member?.id) return null;

  if (!isAccessActiveMember(member) && !isActiveStatus(member)) {
    return null;
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
      success: true,
      status: "OPEN",
      result: accessResult,
    };
  } catch (error) {
    console.error("Access AMT active sync failed:", {
      memberId: member.id,
      email: member.email,
      error,
    });

    await saveAccessFailure(member, error, "sync_failed");

    return {
      success: false,
      status: "sync_failed",
      error: error?.message || "Access sync failed.",
    };
  }
}

async function suspendMemberFromAccess(member) {
  if (!member?.id) return null;

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
      success: true,
      status: "SUSPEND",
      result: accessResult,
    };
  } catch (error) {
    console.error("Access AMT suspend failed:", {
      memberId: member.id,
      email: member.email,
      error,
    });

    await saveAccessFailure(member, error, "suspend_failed");

    return {
      success: false,
      status: "suspend_failed",
      error: error?.message || "Access suspend failed.",
    };
  }
}

async function handleCheckoutCompleted(session) {
  let member = await findSignupFromStripeObject(session);

  if (!member?.id) {
    member = await createSignupFromStripeObject(session);
  }

  if (!member?.id) {
    return {
      handled: false,
      reason: "signup_not_found_or_created",
    };
  }

  const updatedMember = await updateSignupActive(member, session);
  const accessSync = await syncActiveMemberToAccess(updatedMember);

  return {
    handled: true,
    member_id: updatedMember.id,
    email: updatedMember.email,
    status: "active",
    accessSync,
  };
}

async function handleInvoicePaid(invoice) {
  let member = await findSignupFromStripeObject(invoice);

  if (!member?.id) {
    return {
      handled: false,
      reason: "signup_not_found",
    };
  }

  const updatedMember = await updateSignupActive(member, invoice);
  const accessSync = await syncActiveMemberToAccess(updatedMember);

  return {
    handled: true,
    member_id: updatedMember.id,
    email: updatedMember.email,
    status: "active",
    accessSync,
  };
}

async function handleSubscriptionUpdated(subscription) {
  let member = await findSignupFromStripeObject(subscription);

  if (!member?.id) {
    return {
      handled: false,
      reason: "signup_not_found",
    };
  }

  const stripeStatus = normalizeString(subscription.status).toLowerCase();

  if (["active", "trialing"].includes(stripeStatus)) {
    const updatedMember = await updateSignupActive(member, subscription);
    const accessSync = await syncActiveMemberToAccess(updatedMember);

    return {
      handled: true,
      member_id: updatedMember.id,
      email: updatedMember.email,
      status: "active",
      stripe_status: stripeStatus,
      accessSync,
    };
  }

  if (
    ["past_due", "unpaid", "canceled", "cancelled", "incomplete", "incomplete_expired"].includes(
      stripeStatus
    )
  ) {
    const updatedMember = await updateSignupPastDueOrInactive(member, {
      status: "inactive",
      payment_status: stripeStatus,
      membership_status: "inactive",
      approval_status: "payment_required",
    });

    const accessSync = await suspendMemberFromAccess(updatedMember);

    return {
      handled: true,
      member_id: updatedMember.id,
      email: updatedMember.email,
      status: "inactive",
      stripe_status: stripeStatus,
      accessSync,
    };
  }

  return {
    handled: true,
    member_id: member.id,
    email: member.email,
    status: "ignored_subscription_status",
    stripe_status: stripeStatus,
  };
}

async function handleInvoicePaymentFailed(invoice) {
  const member = await findSignupFromStripeObject(invoice);

  if (!member?.id) {
    return {
      handled: false,
      reason: "signup_not_found",
    };
  }

  const updatedMember = await updateSignupPastDueOrInactive(member, {
    status: "inactive",
    payment_status: "past_due",
    membership_status: "inactive",
    approval_status: "payment_required",
  });

  const accessSync = await suspendMemberFromAccess(updatedMember);

  return {
    handled: true,
    member_id: updatedMember.id,
    email: updatedMember.email,
    status: "past_due",
    accessSync,
  };
}

async function handleSubscriptionDeleted(subscription) {
  const member = await findSignupFromStripeObject(subscription);

  if (!member?.id) {
    return {
      handled: false,
      reason: "signup_not_found",
    };
  }

  const updatedMember = await updateSignupPastDueOrInactive(member, {
    status: "inactive",
    payment_status: "canceled",
    membership_status: "inactive",
    approval_status: "canceled",
  });

  const accessSync = await suspendMemberFromAccess(updatedMember);

  return {
    handled: true,
    member_id: updatedMember.id,
    email: updatedMember.email,
    status: "canceled",
    accessSync,
  };
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

  if (!STRIPE_WEBHOOK_SECRET) {
    return sendJson(res, 500, {
      success: false,
      ok: false,
      message: "Missing STRIPE_WEBHOOK_SECRET environment variable.",
    });
  }

  let event;

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error);

    return sendJson(res, 400, {
      success: false,
      ok: false,
      message: `Webhook signature verification failed: ${error.message}`,
    });
  }

  try {
    const object = event.data?.object || {};
    let result = {
      handled: false,
      reason: "event_not_handled",
    };

    switch (event.type) {
      case "checkout.session.completed": {
        result = await handleCheckoutCompleted(object);
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        result = await handleInvoicePaid(object);
        break;
      }

      case "invoice.payment_failed": {
        result = await handleInvoicePaymentFailed(object);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        result = await handleSubscriptionUpdated(object);
        break;
      }

      case "customer.subscription.deleted": {
        result = await handleSubscriptionDeleted(object);
        break;
      }

      default: {
        result = {
          handled: false,
          reason: "unsupported_event_type",
          type: event.type,
        };
      }
    }

    return sendJson(res, 200, {
      success: true,
      ok: true,
      received: true,
      type: event.type,
      result,
    });
  } catch (error) {
    console.error("Card Leo Stripe webhook error:", {
      type: event?.type,
      error,
    });

    return sendJson(res, 500, {
      success: false,
      ok: false,
      received: true,
      type: event?.type || "",
      message: error?.message || "Stripe webhook processing failed.",
    });
  }
}