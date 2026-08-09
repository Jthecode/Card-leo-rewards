// api/signup.js

import crypto from "crypto";
import Stripe from "stripe";

import { supabaseAdmin } from "../lib/supabase-admin.js";
import { getServerEnv } from "../lib/env.js";

import {
  created,
  badRequest,
  conflict,
  methodNotAllowed,
  serverError,
} from "../lib/responses.js";

import { validateSignupInput } from "../lib/validation.js";
import { signupRateLimit } from "../lib/rate-limit.js";

import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../lib/logger.js";

const env = getServerEnv();

const DEFAULT_REDIRECT = "/thank-you.html";
const DEFAULT_LOGIN_REDIRECT = "/login.html";

const ACTIVATION_FEE = 25;
const MONTHLY_FEE = 20;
const BILLING_DAY = 10;

/*
|--------------------------------------------------------------------------
| Stripe
|--------------------------------------------------------------------------
*/

function getStripeSecretKey() {
  /*
   * Support the most common environment variable names so this route
   * does not silently fail because one project uses STRIPE_SECRET_KEY
   * and another uses STRIPE_SECRET.
   */

  return (
    process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET ||
    env?.STRIPE_SECRET_KEY ||
    env?.STRIPE_SECRET ||
    ""
  ).trim();
}

function getStripeClient() {
  const secretKey = getStripeSecretKey();

  if (!secretKey) {
    throw new Error(
      "Stripe is not configured. Missing STRIPE_SECRET_KEY."
    );
  }

  return new Stripe(secretKey);
}

/*
|--------------------------------------------------------------------------
| Request helpers
|--------------------------------------------------------------------------
*/

function getRequestBody(req) {
  if (!req?.body) {
    return {};
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeString(value).toLowerCase();

  return ["true", "1", "yes", "y", "on"].includes(normalized);
}

function splitFullName(fullName) {
  const clean = normalizeString(fullName);

  if (!clean) {
    return {
      firstName: "",
      lastName: "",
    };
  }

  const parts = clean.split(/\s+/).filter(Boolean);

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "",
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

/*
|--------------------------------------------------------------------------
| Password
|--------------------------------------------------------------------------
*/

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");
}

/*
|--------------------------------------------------------------------------
| IP
|--------------------------------------------------------------------------
*/

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

/*
|--------------------------------------------------------------------------
| Referral helpers
|--------------------------------------------------------------------------
*/

function cleanReferralCode(value) {
  const raw = normalizeString(value);

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);

    const fromUrl =
      parsed.searchParams.get("ref") ||
      parsed.searchParams.get("referral") ||
      parsed.searchParams.get("referral_code") ||
      parsed.searchParams.get("sponsor") ||
      parsed.searchParams.get("code") ||
      "";

    if (fromUrl) {
      return cleanReferralCode(fromUrl);
    }
  } catch {
    // Not a full URL.
  }

  return raw
    .replace(/^ref=/i, "")
    .replace(/^referral=/i, "")
    .replace(/^referral_code=/i, "")
    .replace(/^sponsor=/i, "")
    .replace(/^code=/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, "");
}

function getReferralEmail(value) {
  const cleaned = cleanReferralCode(value);

  if (!cleaned) {
    return "";
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailRegex.test(cleaned)
    ? normalizeEmail(cleaned)
    : "";
}

/*
|--------------------------------------------------------------------------
| Normalize signup payload
|--------------------------------------------------------------------------
*/

function normalizeSignupPayload(rawBody) {
  const body = rawBody || {};

  const firstNameRaw = normalizeString(
    body.firstName || body.first_name
  );

  const lastNameRaw = normalizeString(
    body.lastName || body.last_name
  );

  const fullNameRaw = normalizeString(
    body.fullName || body.full_name
  );

  const splitName = splitFullName(fullNameRaw);

  const firstName =
    firstNameRaw || splitName.firstName;

  const lastName =
    lastNameRaw || splitName.lastName;

  const fullName = normalizeString(
    fullNameRaw ||
      [firstName, lastName]
        .filter(Boolean)
        .join(" ")
  );

  const referralName = normalizeString(
    body.referralName ||
      body.referral_name ||
      body.sponsorName ||
      body.sponsor_name
  );

  const referralCode = cleanReferralCode(
    body.referral_code ||
      body.referralCode ||
      body.sponsor_code ||
      referralName
  );

  const referralEmail =
    normalizeEmail(
      body.referral_email ||
        body.referralEmail ||
        body.sponsor_email
    ) ||
    getReferralEmail(referralCode) ||
    getReferralEmail(referralName);

  return {
    firstName,
    first_name: firstName,

    lastName,
    last_name: lastName,

    fullName,
    full_name: fullName,

    email: normalizeEmail(body.email),

    phone: normalizeString(body.phone),

    city: normalizeString(body.city),

    state: normalizeString(body.state),

    password: String(body.password || ""),

    confirmPassword: String(
      body.confirmPassword ||
        body.confirm_password ||
        ""
    ),

    referralName,
    referral_name: referralName,
    sponsor_name: referralName,

    referralCode,
    referral_code: referralCode,
    sponsor_code: referralCode,

    referralEmail,
    referral_email: referralEmail,
    sponsor_email: referralEmail,

    referral_source: normalizeString(
      body.referral_source ||
        body.referralSource
    ),

    referral_url: normalizeString(
      body.referral_url ||
        body.referralUrl
    ),

    interest: normalizeString(body.interest),

    goals: normalizeString(body.goals),

    agreed: normalizeBoolean(
      body.agreed ?? body.agree
    ),

    source:
      normalizeString(body.source) ||
      "website-signup",

    signup_page:
      normalizeString(
        body.signup_page ||
          body.signupPage
      ) || "signup.html",

    portal_login_url:
      normalizeString(
        body.portal_login_url ||
          body.portalLoginUrl
      ) || DEFAULT_LOGIN_REDIRECT,
  };
}

/*
|--------------------------------------------------------------------------
| Password validation
|--------------------------------------------------------------------------
*/

function validatePasswordFields(normalizedBody) {
  const errors = {};

  const password = String(
    normalizedBody.password || ""
  );

  const confirmPassword = String(
    normalizedBody.confirmPassword || ""
  );

  if (!password || password.length < 8) {
    errors.password =
      "Password must be at least 8 characters.";
  }

  if (!confirmPassword) {
    errors.confirmPassword =
      "Please confirm your password.";
  }

  if (
    password &&
    confirmPassword &&
    password !== confirmPassword
  ) {
    errors.confirmPassword =
      "Passwords do not match.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/*
|--------------------------------------------------------------------------
| Duplicate detection
|--------------------------------------------------------------------------
*/

function isDuplicateError(error) {
  const message = String(
    error?.message || ""
  ).toLowerCase();

  const details = String(
    error?.details || ""
  ).toLowerCase();

  return (
    error?.code === "23505" ||
    message.includes("duplicate") ||
    message.includes("unique") ||
    details.includes("duplicate") ||
    details.includes("unique")
  );
}

/*
|--------------------------------------------------------------------------
| Determine whether an existing signup can continue
|--------------------------------------------------------------------------
*/

function isPendingSignup(record) {
  if (!record) {
    return false;
  }

  const status = normalizeString(
    record.status
  ).toLowerCase();

  const paymentStatus = normalizeString(
    record.payment_status
  ).toLowerCase();

  const membershipStatus = normalizeString(
    record.membership_status
  ).toLowerCase();

  /*
   * These statuses are safe to continue.
   *
   * A person who started signup but did not finish payment
   * should NOT be told that their email is permanently used.
   */

  const pendingStatuses = new Set([
    "",
    "pending",
    "payment_pending",
    "pending_payment",
    "unpaid",
    "created",
  ]);

  const pendingPaymentStatuses = new Set([
    "",
    "unpaid",
    "pending",
    "payment_pending",
    "requires_payment",
  ]);

  const pendingMembershipStatuses = new Set([
    "",
    "pending",
    "payment_pending",
    "inactive",
  ]);

  return (
    pendingStatuses.has(status) &&
    pendingPaymentStatuses.has(paymentStatus) &&
    pendingMembershipStatuses.has(membershipStatus)
  );
}

/*
|--------------------------------------------------------------------------
| Update an existing pending signup
|--------------------------------------------------------------------------
*/

async function updateExistingPendingSignup(
  existingRecord,
  normalizedBody
) {
  const now = new Date().toISOString();

  const passwordHash = hashPassword(
    normalizedBody.password
  );

  const updatePayload = {
    first_name: normalizedBody.firstName,
    last_name: normalizedBody.lastName,
    full_name: normalizedBody.fullName || null,

    phone: normalizedBody.phone || null,
    city: normalizedBody.city || null,
    state: normalizedBody.state || null,

    referral_name:
      normalizedBody.referralName || null,

    interest:
      normalizedBody.interest || null,

    goals:
      normalizedBody.goals || null,

    agreed:
      Boolean(normalizedBody.agreed),

    password_hash: passwordHash,

    status: "payment_pending",

    payment_status: "unpaid",

    membership_status: "payment_pending",

    approval_status: "payment_pending",

    activation_fee_amount:
      ACTIVATION_FEE,

    monthly_fee_amount:
      MONTHLY_FEE,

    billing_day:
      BILLING_DAY,

    portal_login_url:
      DEFAULT_LOGIN_REDIRECT,

    source:
      normalizedBody.source ||
      "website-signup",

    signup_page:
      normalizedBody.signup_page ||
      "signup.html",

    updated_at: now,
  };

  /*
   * Only include referral columns if your table supports them.
   * They are already part of the requested signup structure.
   */

  updatePayload.referral_code =
    normalizedBody.referralCode || null;

  updatePayload.referral_email =
    normalizedBody.referralEmail || null;

  updatePayload.referral_source =
    normalizedBody.referral_source || null;

  updatePayload.referral_url =
    normalizedBody.referral_url || null;

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", existingRecord.id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| Create a brand-new signup
|--------------------------------------------------------------------------
*/

async function createNewSignup(normalizedBody) {
  const passwordHash = hashPassword(
    normalizedBody.password
  );

  const now = new Date().toISOString();

  const signupPayload = {
    first_name:
      normalizedBody.firstName,

    last_name:
      normalizedBody.lastName,

    full_name:
      normalizedBody.fullName || null,

    email:
      normalizedBody.email,

    phone:
      normalizedBody.phone || null,

    city:
      normalizedBody.city || null,

    state:
      normalizedBody.state || null,

    referral_name:
      normalizedBody.referralName || null,

    referral_code:
      normalizedBody.referralCode || null,

    referral_email:
      normalizedBody.referralEmail || null,

    referral_source:
      normalizedBody.referral_source || null,

    referral_url:
      normalizedBody.referral_url || null,

    interest:
      normalizedBody.interest || null,

    goals:
      normalizedBody.goals || null,

    agreed:
      Boolean(normalizedBody.agreed),

    /*
     * IMPORTANT:
     *
     * The account is NOT active yet.
     * It becomes active after Stripe confirms payment.
     */

    status:
      "payment_pending",

    payment_status:
      "unpaid",

    membership_status:
      "payment_pending",

    approval_status:
      "payment_pending",

    password_hash:
      passwordHash,

    portal_login_url:
      DEFAULT_LOGIN_REDIRECT,

    portal_user_id:
      null,

    activation_fee_amount:
      ACTIVATION_FEE,

    monthly_fee_amount:
      MONTHLY_FEE,

    billing_day:
      BILLING_DAY,

    source:
      normalizedBody.source ||
      "website-signup",

    signup_page:
      normalizedBody.signup_page ||
      "signup.html",

    created_at:
      now,

    updated_at:
      now,
  };

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("signups")
    .insert(signupPayload)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| Stripe price helpers
|--------------------------------------------------------------------------
*/

function getEnvironmentValue(...keys) {
  for (const key of keys) {
    const value =
      process.env[key] ||
      env?.[key];

    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return "";
}

function getActivationPriceId() {
  return getEnvironmentValue(
    "STRIPE_ACTIVATION_PRICE_ID",
    "STRIPE_ACTIVATION_PRICE",
    "STRIPE_PRICE_ACTIVATION"
  );
}

function getMonthlyPriceId() {
  return getEnvironmentValue(
    "STRIPE_MONTHLY_PRICE_ID",
    "STRIPE_MONTHLY_PRICE",
    "STRIPE_PRICE_MONTHLY"
  );
}

/*
|--------------------------------------------------------------------------
| Create Stripe Checkout Session
|--------------------------------------------------------------------------
*/

async function createStripeCheckoutSession({
  signupRecord,
  normalizedBody,
}) {
  const stripe = getStripeClient();

  const activationPriceId =
    getActivationPriceId();

  const monthlyPriceId =
    getMonthlyPriceId();

  if (!activationPriceId) {
    throw new Error(
      "Missing STRIPE_ACTIVATION_PRICE_ID."
    );
  }

  if (!monthlyPriceId) {
    throw new Error(
      "Missing STRIPE_MONTHLY_PRICE_ID."
    );
  }

  const origin =
    normalizeString(
      process.env.PUBLIC_SITE_URL ||
        process.env.NEXT_PUBLIC_SITE_URL ||
        env?.PUBLIC_SITE_URL ||
        env?.NEXT_PUBLIC_SITE_URL
    ) ||
    `https://${normalizeString(
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
        ""
    )}`;

  /*
   * In production your public domain should be:
   *
   * https://www.cardleorewards.com
   */

  const siteOrigin =
    origin ||
    "https://www.cardleorewards.com";

  const successUrl =
    `${siteOrigin}/thank-you.html` +
    `?payment=success` +
    `&membership=activated` +
    `&session_id={CHECKOUT_SESSION_ID}`;

  const cancelUrl =
    `${siteOrigin}/signup.html` +
    `?payment=cancelled` +
    `&signup_id=${encodeURIComponent(
      signupRecord.id
    )}`;

  /*
   * Stripe allows a one-time Price and recurring Price
   * in the same subscription Checkout Session.
   *
   * This results in:
   *
   * $25 activation today
   * +
   * $20/month recurring
   */

  const session =
    await stripe.checkout.sessions.create({
      mode: "subscription",

      customer_email:
        normalizedBody.email,

      line_items: [
        {
          price: activationPriceId,
          quantity: 1,
        },
        {
          price: monthlyPriceId,
          quantity: 1,
        },
      ],

      allow_promotion_codes: true,

      billing_address_collection:
        "auto",

      phone_number_collection: {
        enabled: true,
      },

      metadata: {
        signup_id:
          String(signupRecord.id),

        member_id:
          String(signupRecord.id),

        email:
          normalizedBody.email,

        first_name:
          normalizedBody.firstName,

        last_name:
          normalizedBody.lastName,

        referral_code:
          normalizedBody.referralCode || "",

        referral_email:
          normalizedBody.referralEmail || "",

        source:
          normalizedBody.source ||
          "website-signup",
      },

      subscription_data: {
        metadata: {
          signup_id:
            String(signupRecord.id),

          member_id:
            String(signupRecord.id),

          email:
            normalizedBody.email,

          referral_code:
            normalizedBody.referralCode || "",

          referral_email:
            normalizedBody.referralEmail || "",
        },
      },

      success_url:
        successUrl,

      cancel_url:
        cancelUrl,
    });

  if (!session?.url) {
    throw new Error(
      "Stripe Checkout did not return a payment URL."
    );
  }

  /*
   * Save the Stripe session ID if the column exists.
   *
   * We deliberately do not fail the entire signup if your
   * current signups table does not yet have stripe_checkout_session_id.
   */

  try {
    await supabaseAdmin
      .from("signups")
      .update({
        stripe_checkout_session_id:
          session.id,

        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        signupRecord.id
      );
  } catch (stripeRecordError) {
    logRequestError(
      null,
      stripeRecordError,
      {
        scope:
          "signup_stripe_session_metadata_update",
        signupId:
          signupRecord.id,
      }
    );
  }

  return session;
}

/*
|--------------------------------------------------------------------------
| Optional portal account
|--------------------------------------------------------------------------
*/

async function createPortalAccount(_signupRecord) {
  /*
   * IMPORTANT:
   *
   * Stripe payment should be the activation event.
   *
   * Do NOT mark the account active here.
   *
   * Your Stripe webhook should later:
   *
   * payment_status = paid
   * membership_status = active
   * approval_status = approved
   * status = active
   */

  return {
    created: false,
    portalUserId: null,
    loginUrl: null,
  };
}

/*
|--------------------------------------------------------------------------
| Main handler
|--------------------------------------------------------------------------
*/

export default async function handler(
  req,
  res
) {
  logRequestStart(req, {
    scope: "signup",
    ip: getClientIp(req),
  });

  if (req.method !== "POST") {
    return methodNotAllowed(
      res,
      ["POST"],
      "Method not allowed. Use POST."
    );
  }

  try {
    /*
     * Rate limiting
     */

    const rateLimit =
      signupRateLimit(req, res);

    if (!rateLimit?.allowed) {
      return res.status(429).json({
        success: false,
        ok: false,
        message:
          "Too many signup attempts. Please try again later.",
        error:
          "rate_limited",
        retryAfter:
          rateLimit?.retryAfter ?? null,
      });
    }

    /*
     * Parse body
     */

    const rawBody =
      getRequestBody(req);

    const normalizedBody =
      normalizeSignupPayload(
        rawBody
      );

    /*
     * Validate standard fields
     */

    const validation =
      validateSignupInput(
        normalizedBody
      );

    /*
     * Validate password
     */

    const passwordValidation =
      validatePasswordFields(
        normalizedBody
      );

    if (
      !validation?.valid ||
      !passwordValidation.valid
    ) {
      return badRequest(
        res,
        "Please correct the highlighted fields.",
        {
          ...(validation?.errors || {}),
          ...(passwordValidation.errors || {}),
        }
      );
    }

    /*
     * Use validated values when available.
     */

    const validatedValues =
      validation.values || {};

    const firstName =
      normalizeString(
        validatedValues.firstName ||
          validatedValues.first_name ||
          normalizedBody.firstName
      );

    const lastName =
      normalizeString(
        validatedValues.lastName ||
          validatedValues.last_name ||
          normalizedBody.lastName
      );

    const email =
      normalizeEmail(
        validatedValues.email ||
          normalizedBody.email
      );

    const phone =
      normalizeString(
        validatedValues.phone ||
          normalizedBody.phone
      );

    const city =
      normalizeString(
        validatedValues.city ||
          normalizedBody.city
      );

    const state =
      normalizeString(
        validatedValues.state ||
          normalizedBody.state
      );

    const referralName =
      normalizeString(
        validatedValues.referralName ||
          validatedValues.referral_name ||
          normalizedBody.referralName
      );

    const interest =
      normalizeString(
        validatedValues.interest ||
          normalizedBody.interest
      );

    const goals =
      normalizeString(
        validatedValues.goals ||
          normalizedBody.goals
      );

    const agreed =
      Boolean(
        validatedValues.agreed ??
          normalizedBody.agreed
      );

    /*
     * Rebuild normalized data using validated values.
     */

    normalizedBody.firstName =
      firstName;

    normalizedBody.lastName =
      lastName;

    normalizedBody.fullName =
      normalizeString(
        normalizedBody.fullName ||
          [firstName, lastName]
            .filter(Boolean)
            .join(" ")
      );

    normalizedBody.email =
      email;

    normalizedBody.phone =
      phone;

    normalizedBody.city =
      city;

    normalizedBody.state =
      state;

    normalizedBody.referralName =
      referralName;

    normalizedBody.interest =
      interest;

    normalizedBody.goals =
      goals;

    normalizedBody.agreed =
      agreed;

    /*
     * Final email safety check.
     */

    if (!email) {
      return badRequest(
        res,
        "Email address is required."
      );
    }

    /*
     * Find existing account.
     *
     * IMPORTANT:
     * We do NOT automatically reject an existing record.
     *
     * If the record is still unpaid/pending,
     * we reuse it and send the person back to Stripe.
     */

    const {
      data: existingSignup,
      error: existingSignupError,
    } =
      await supabaseAdmin
        .from("signups")
        .select(
          [
            "id",
            "email",
            "status",
            "payment_status",
            "membership_status",
            "approval_status",
            "password_hash",
            "stripe_checkout_session_id",
          ].join(", ")
        )
        .eq(
          "email",
          email
        )
        .maybeSingle();

    if (existingSignupError) {
      logRequestError(
        req,
        existingSignupError,
        {
          scope:
            "signup_lookup",
          email,
        }
      );

      return serverError(
        res,
        "Unable to verify signup status right now."
      );
    }

    let signupRecord;
    let isExistingPendingSignup =
      false;

    /*
     * EXISTING RECORD
     */

    if (existingSignup?.id) {
      /*
       * If already active/paid, don't create another
       * membership for the same email.
       */

      const paymentStatus =
        normalizeString(
          existingSignup.payment_status
        ).toLowerCase();

      const membershipStatus =
        normalizeString(
          existingSignup.membership_status
        ).toLowerCase();

      const status =
        normalizeString(
          existingSignup.status
        ).toLowerCase();

      const isPaid =
        paymentStatus === "paid";

      const isActive =
        membershipStatus ===
          "active" ||
        status === "active";

      if (
        isPaid ||
        isActive
      ) {
        return conflict(
          res,
          "An active Card Leo Rewards membership already exists for this email. Please use Member Login.",
          {
            email,
            status:
              existingSignup.status ||
              "active",
            payment_status:
              existingSignup.payment_status ||
              null,
            membership_status:
              existingSignup.membership_status ||
              null,
            login_url:
              DEFAULT_LOGIN_REDIRECT,
          }
        );
      }

      /*
       * Pending/unpaid account:
       *
       * UPDATE it rather than saying "email exists".
       */

      if (
        isPendingSignup(
          existingSignup
        )
      ) {
        isExistingPendingSignup =
          true;

        signupRecord =
          await updateExistingPendingSignup(
            existingSignup,
            normalizedBody
          );
      } else {
        /*
         * Unknown non-active status.
         *
         * Still do not create a second account because
         * email is normally unique.
         */

        return conflict(
          res,
          "An account with this email already exists. Please use Member Login or contact support.",
          {
            email,
            status:
              existingSignup.status ||
              "existing",
            payment_status:
              existingSignup.payment_status ||
              null,
            membership_status:
              existingSignup.membership_status ||
              null,
            login_url:
              DEFAULT_LOGIN_REDIRECT,
          }
        );
      }
    }

    /*
     * NEW RECORD
     */

    if (!signupRecord) {
      try {
        signupRecord =
          await createNewSignup(
            normalizedBody
          );
      } catch (signupInsertError) {
        logRequestError(
          req,
          signupInsertError,
          {
            scope:
              "signup_insert",
            email,
          }
        );

        /*
         * Race condition protection:
         *
         * Another request may have created the same email
         * between our lookup and insert.
         */

        if (
          isDuplicateError(
            signupInsertError
          )
        ) {
          const {
            data: racedSignup,
            error: racedLookupError,
          } =
            await supabaseAdmin
              .from("signups")
              .select(
                [
                  "id",
                  "email",
                  "status",
                  "payment_status",
                  "membership_status",
                  "approval_status",
                  "password_hash",
                  "stripe_checkout_session_id",
                ].join(", ")
              )
              .eq(
                "email",
                email
              )
              .maybeSingle();

          if (
            racedLookupError ||
            !racedSignup
          ) {
            return conflict(
              res,
              "A signup with this email already exists. Please use Member Login.",
              {
                email,
              }
            );
          }

          if (
            isPendingSignup(
              racedSignup
            )
          ) {
            signupRecord =
              await updateExistingPendingSignup(
                racedSignup,
                normalizedBody
              );

            isExistingPendingSignup =
              true;
          } else {
            return conflict(
              res,
              "An account with this email already exists. Please use Member Login.",
              {
                email,
                status:
                  racedSignup.status ||
                  "existing",
              }
            );
          }
        } else {
          return serverError(
            res,
            signupInsertError?.message ||
              "Unable to save signup right now. Please try again in a moment."
          );
        }
      }
    }

    /*
     * Safety check.
     */

    if (!signupRecord?.id) {
      return serverError(
        res,
        "Your signup could not be saved. Please try again."
      );
    }

    /*
     * Ensure pending payment fields are correct.
     */

    try {
      const {
        data: refreshedSignup,
        error:
          refreshError,
      } =
        await supabaseAdmin
          .from("signups")
          .update({
            status:
              "payment_pending",

            payment_status:
              "unpaid",

            membership_status:
              "payment_pending",

            approval_status:
              "payment_pending",

            activation_fee_amount:
              ACTIVATION_FEE,

            monthly_fee_amount:
              MONTHLY_FEE,

            billing_day:
              BILLING_DAY,

            updated_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            signupRecord.id
          )
          .select()
          .single();

      if (
        !refreshError &&
        refreshedSignup
      ) {
        signupRecord =
          refreshedSignup;
      }
    } catch (refreshError) {
      /*
       * Do not stop the signup because of
       * this non-critical refresh operation.
       */

      logRequestError(
        req,
        refreshError,
        {
          scope:
            "signup_pending_status_update",
          signupId:
            signupRecord.id,
          email,
        }
      );
    }

    /*
     * Stripe Checkout
     *
     * THIS IS THE CRITICAL FIX.
     *
     * The signup API itself now creates the Stripe
     * Checkout Session and returns checkout_url.
     */

    let checkoutSession;

    try {
      checkoutSession =
        await createStripeCheckoutSession({
          signupRecord,
          normalizedBody,
        });
    } catch (stripeError) {
      logRequestError(
        req,
        stripeError,
        {
          scope:
            "signup_stripe_checkout",
          signupId:
            signupRecord.id,
          email,
        }
      );

      /*
       * The account exists, but payment could not be started.
       *
       * Keep it payment_pending so the customer can try again.
       */

      return serverError(
        res,
        stripeError?.message ||
          "Your account was created, but secure Stripe Checkout could not be started. Please try again."
      );
    }

    /*
     * Optional portal creation.
     *
     * This intentionally does NOT activate the member.
     */

    let finalStatus =
      signupRecord.status ||
      "payment_pending";

    let redirectTo =
      checkoutSession.url;

    try {
      const portalResult =
        await createPortalAccount(
          signupRecord
        );

      if (
        portalResult?.created
      ) {
        /*
         * Do not make the member active here.
         * Payment webhook should be the activation authority.
         */

        const {
          error:
            portalUpdateError,
        } =
          await supabaseAdmin
            .from("signups")
            .update({
              portal_user_id:
                portalResult.portalUserId ||
                null,

              portal_login_url:
                normalizeString(
                  portalResult.loginUrl
                ) ||
                DEFAULT_LOGIN_REDIRECT,

              updated_at:
                new Date().toISOString(),
            })
            .eq(
              "id",
              signupRecord.id
            );

        if (
          portalUpdateError
        ) {
          logRequestError(
            req,
            portalUpdateError,
            {
              scope:
                "signup_portal_update",
              signupId:
                signupRecord.id,
              email,
            }
          );
        }
      }
    } catch (portalError) {
      logRequestError(
        req,
        portalError,
        {
          scope:
            "signup_portal_create",
          signupId:
            signupRecord.id,
          email,
        }
      );
    }

    /*
     * Log success.
     */

    logRequestSuccess(
      req,
      {
        scope:
          "signup",
        signupId:
          signupRecord.id,
        email,
        status:
          finalStatus,
        existingPendingSignup:
          isExistingPendingSignup,
        stripeCheckoutSessionId:
          checkoutSession.id,
      }
    );

    /*
     * FINAL RESPONSE
     *
     * Your frontend can now simply:
     *
     * window.location.href = result.checkout_url;
     */

    return created(
      res,
      {
        id:
          signupRecord.id,

        signup_id:
          signupRecord.id,

        email:
          signupRecord.email,

        fullName:
          signupRecord.full_name ||
          normalizedBody.fullName,

        status:
          finalStatus,

        payment_status:
          "unpaid",

        membership_status:
          "payment_pending",

        approval_status:
          "payment_pending",

        hasPassword:
          Boolean(
            signupRecord.password_hash
          ),

        portalLoginUrl:
          signupRecord.portal_login_url ||
          DEFAULT_LOGIN_REDIRECT,

        checkout_url:
          checkoutSession.url,

        checkoutUrl:
          checkoutSession.url,

        stripe_checkout_session_id:
          checkoutSession.id,

        existing_pending_signup:
          isExistingPendingSignup,
      },

      isExistingPendingSignup
        ? "Your pending account was found. Sending you back to secure Stripe Checkout."
        : "Signup created successfully. Sending you to secure Stripe Checkout.",

      {
        redirectTo:
          checkoutSession.url,

        checkout_url:
          checkoutSession.url,
      }
    );
  } catch (error) {
    logRequestError(
      req,
      error,
      {
        scope:
          "signup_unexpected",
      }
    );

    return serverError(
      res,
      error?.message ||
        "Unexpected server error."
    );
  }
}