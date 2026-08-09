// api/signup.js
import crypto from "crypto";
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

function getRequestBody(req) {
  if (!req?.body) return {};

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
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

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

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function normalizeSignupPayload(rawBody) {
  const body = rawBody || {};

  const firstNameRaw = normalizeString(body.firstName || body.first_name);
  const lastNameRaw = normalizeString(body.lastName || body.last_name);
  const fullNameRaw = normalizeString(body.fullName || body.full_name);

  const splitName = splitFullName(fullNameRaw);

  const firstName = firstNameRaw || splitName.firstName;
  const lastName = lastNameRaw || splitName.lastName;
  const fullName = normalizeString(
    fullNameRaw || [firstName, lastName].filter(Boolean).join(" ")
  );

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
      body.confirmPassword || body.confirm_password || ""
    ),

    referralName: normalizeString(
      body.referralName ||
        body.referral_name ||
        body.sponsorName ||
        body.sponsor_name
    ),

    interest: normalizeString(body.interest),
    goals: normalizeString(body.goals),
    agreed: normalizeBoolean(body.agreed ?? body.agree),

    source: normalizeString(body.source) || "website-signup",
    signup_page:
      normalizeString(body.signup_page || body.signupPage) || "signup.html",

    portal_login_url:
      normalizeString(body.portal_login_url || body.portalLoginUrl) ||
      DEFAULT_LOGIN_REDIRECT,
  };
}

function validatePasswordFields(normalizedBody) {
  const errors = {};
  const password = String(normalizedBody.password || "");
  const confirmPassword = String(normalizedBody.confirmPassword || "");

  if (!password || password.length < 8) {
    errors.password = "Password must be at least 8 characters.";
  }

  if (!confirmPassword) {
    errors.confirmPassword = "Please confirm your password.";
  }

  if (password && confirmPassword && password !== confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

function isDuplicateError(error) {
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    error?.code === "23505" ||
    message.includes("duplicate") ||
    message.includes("unique") ||
    details.includes("duplicate") ||
    details.includes("unique")
  );
}

/*
  OPTIONAL:
  Replace this later with a real external portal/back-office account creation API.
*/
async function createPortalAccount(_signupRecord) {
  return {
    created: false,
    portalUserId: null,
    loginUrl: null,
  };
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "signup" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = signupRateLimit(req, res);

    if (!rateLimit?.allowed) {
      return res.status(429).json({
        success: false,
        ok: false,
        message: "Too many signup attempts. Please try again later.",
        error: "rate_limited",
        retryAfter: rateLimit?.retryAfter ?? null,
      });
    }

    const rawBody = getRequestBody(req);
    const normalizedBody = normalizeSignupPayload(rawBody);

    const validation = validateSignupInput(normalizedBody);
    const passwordValidation = validatePasswordFields(normalizedBody);

    if (!validation?.valid || !passwordValidation.valid) {
      return badRequest(
        res,
        "Please correct the highlighted fields.",
        {
          ...(validation?.errors || {}),
          ...(passwordValidation.errors || {}),
        }
      );
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      city,
      state,
      referralName,
      interest,
      goals,
      agreed,
    } = validation.values;

    const safeEmail = normalizeEmail(email);
    const fullName = normalizeString(
      normalizedBody.fullName ||
        [firstName, lastName].filter(Boolean).join(" ")
    );

    const passwordHash = hashPassword(normalizedBody.password);

    const { data: existingSignup, error: existingSignupError } =
      await supabaseAdmin
        .from("signups")
        .select("id, email, status")
        .eq("email", safeEmail)
        .maybeSingle();

    if (existingSignupError) {
      logRequestError(req, existingSignupError, {
        scope: "signup_lookup",
        email: safeEmail,
      });

      return serverError(res, "Unable to verify signup status right now.");
    }

    if (existingSignup?.id) {
      return conflict(res, "A signup with this email already exists.", {
        email: safeEmail,
        status: existingSignup.status || "existing",
      });
    }

    const signupPayload = {
      first_name: firstName,
      last_name: lastName,
      full_name: fullName || null,
      email: safeEmail,
      phone: phone || null,
      city: city || null,
      state: state || null,
      referral_name: referralName || null,
      interest: interest || null,
      goals: goals || null,
      agreed: Boolean(agreed),

      // New account starts pending until you approve it in Supabase.
      status: "pending",

      // Login fields.
      password_hash: passwordHash,
      portal_login_url: DEFAULT_LOGIN_REDIRECT,
      portal_user_id: null,

      source: normalizedBody.source || "website-signup",
      signup_page: normalizedBody.signup_page || "signup.html",

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: signupRecord, error: signupInsertError } = await supabaseAdmin
      .from("signups")
      .insert(signupPayload)
      .select()
      .single();

    if (signupInsertError) {
      logRequestError(req, signupInsertError, {
        scope: "signup_insert",
        email: safeEmail,
      });

      if (isDuplicateError(signupInsertError)) {
        return conflict(res, "A signup with this email already exists.", {
          email: safeEmail,
        });
      }

      return serverError(
        res,
        signupInsertError?.message ||
          "Unable to save signup right now. Please try again in a moment."
      );
    }

    let finalStatus = signupRecord.status || "pending";
    let redirectTo = DEFAULT_REDIRECT;

    try {
      const portalResult = await createPortalAccount(signupRecord);

      if (portalResult?.created) {
        finalStatus = "invited";
        redirectTo =
          normalizeString(portalResult.loginUrl) || DEFAULT_LOGIN_REDIRECT;

        const { error: updateError } = await supabaseAdmin
          .from("signups")
          .update({
            status: finalStatus,
            portal_user_id: portalResult.portalUserId || null,
            portal_login_url: redirectTo,
            updated_at: new Date().toISOString(),
          })
          .eq("id", signupRecord.id);

        if (updateError) {
          logRequestError(req, updateError, {
            scope: "signup_portal_update",
            signupId: signupRecord.id,
            email: safeEmail,
          });
        }
      }
    } catch (portalError) {
      logRequestError(req, portalError, {
        scope: "signup_portal_create",
        signupId: signupRecord?.id || null,
        email: safeEmail,
      });
    }

    logRequestSuccess(req, {
      scope: "signup",
      signupId: signupRecord.id,
      email: safeEmail,
      status: finalStatus,
    });

    return created(
      res,
      {
        id: signupRecord.id,
        email: signupRecord.email,
        fullName: signupRecord.full_name || fullName,
        status: finalStatus,
        hasPassword: Boolean(signupRecord.password_hash || passwordHash),
        portalLoginUrl: signupRecord.portal_login_url || DEFAULT_LOGIN_REDIRECT,
      },
      "Signup received successfully.",
      {
        redirectTo,
      }
    );
  } catch (error) {
    logRequestError(req, error, { scope: "signup_unexpected" });

    return serverError(
      res,
      error?.message || "Unexpected server error."
    );
  }
}