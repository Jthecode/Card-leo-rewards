// api/auth/forgot-password.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig, getSiteUrl } from "../../lib/env.js";
import {
  ok,
  badRequest,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";
import { validateForgotPasswordInput } from "../../lib/validation.js";
import { forgotPasswordRateLimit } from "../../lib/rate-limit.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function getRuntimeSiteUrl(req) {
  const configured = getSiteUrl();
  if (configured) return configured.replace(/\/+$/, "");

  const proto =
    req?.headers?.["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req?.headers?.["x-forwarded-host"] ||
    req?.headers?.host ||
    "localhost:3000";

  return `${proto}://${host}`.replace(/\/+$/, "");
}

function createPublicSupabaseClient() {
  const { url, anonKey, publishableKey } = getSupabaseServerConfig();
  const publicKey = anonKey || publishableKey;

  if (!url || !publicKey) {
    throw new Error(
      "Supabase environment variables are missing. Add SUPABASE_URL and SUPABASE_ANON_KEY."
    );
  }

  return createClient(url, publicKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_forgot_password" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = forgotPasswordRateLimit(req, res);

    if (!rateLimit.allowed) {
      return badRequest(
        res,
        "Too many password reset attempts. Please try again later.",
        { retryAfter: rateLimit.retryAfter },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);
    const validation = validateForgotPasswordInput(body);

    if (!validation.valid) {
      return badRequest(res, "Email is required.", validation.errors);
    }

    const { email } = validation.values;

    const supabase = createPublicSupabaseClient();
    const siteUrl = getRuntimeSiteUrl(req);
    const redirectTo = `${siteUrl}/reset-password.html`;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      logRequestError(req, error, {
        scope: "auth_forgot_password_send",
        email,
      });

      return serverError(
        res,
        error.message ||
          "We could not start the password recovery process."
      );
    }

    logAuthEvent("Password reset email requested.", {
      email,
      redirectTo,
    });

    logRequestSuccess(req, {
      scope: "auth_forgot_password",
      email,
    });

    return ok(
      res,
      {
        email,
      },
      "If that email is eligible for recovery, reset instructions have been sent.",
      {
        redirectTo,
      }
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "auth_forgot_password_unexpected",
    });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while trying to send reset instructions."
    );
  }
}