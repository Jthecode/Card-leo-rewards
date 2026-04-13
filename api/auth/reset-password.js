// api/auth/reset-password.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "../../lib/env.js";
import {
  ok,
  badRequest,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";
import { validateResetPasswordInput } from "../../lib/validation.js";
import { resetPasswordRateLimit } from "../../lib/rate-limit.js";
import { clearAuthCookies } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

function normalizeText(value) {
  return String(value || "").trim();
}

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

async function establishRecoverySession(supabase, options) {
  const token = normalizeText(options.token);
  const refreshToken = normalizeText(options.refreshToken);
  const code = normalizeText(options.code);

  if (token && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: token,
      refresh_token: refreshToken,
    });

    if (error) {
      throw new Error(error.message || "Invalid or expired recovery session.");
    }

    if (!data?.session || !data?.user) {
      throw new Error("Recovery session could not be established.");
    }

    return data;
  }

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      throw new Error(error.message || "Invalid or expired recovery code.");
    }

    if (!data?.session || !data?.user) {
      throw new Error("Recovery code could not be exchanged for a session.");
    }

    return data;
  }

  if (token) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: "recovery",
    });

    if (error) {
      throw new Error(error.message || "Invalid or expired recovery token.");
    }

    if (!data?.session || !data?.user) {
      throw new Error("Recovery token could not be verified.");
    }

    return data;
  }

  throw new Error("A valid recovery token or code is required.");
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_reset_password" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = resetPasswordRateLimit(req, res);

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

    const accessToken = normalizeText(body.token || body.accessToken);
    const refreshToken = normalizeText(body.refreshToken);
    const code = normalizeText(body.code);
    const password = String(body.password || "");
    const confirmPassword = String(body.confirmPassword || "");

    const validation = validateResetPasswordInput({
      token: accessToken || code || refreshToken,
      password,
      confirmPassword,
    });

    if (!validation.valid) {
      return badRequest(
        res,
        "Please correct the highlighted fields.",
        validation.errors
      );
    }

    if (!accessToken && !refreshToken && !code) {
      return badRequest(res, "Missing recovery token or code.");
    }

    const supabase = createPublicSupabaseClient();

    await establishRecoverySession(supabase, {
      token: accessToken,
      refreshToken,
      code,
    });

    const { data, error } = await supabase.auth.updateUser({
      password,
    });

    if (error) {
      logRequestError(req, error, { scope: "auth_reset_password_update" });

      return badRequest(
        res,
        error.message || "We could not update your password with this link."
      );
    }

    clearAuthCookies(res);

    logAuthEvent("Password reset successful.", {
      userId: data?.user?.id || null,
      email: data?.user?.email || null,
    });

    logRequestSuccess(req, {
      scope: "auth_reset_password",
      userId: data?.user?.id || null,
    });

    return ok(
      res,
      {
        user: data?.user
          ? {
              id: data.user.id || null,
              email: data.user.email || null,
            }
          : null,
      },
      "Your password has been updated successfully.",
      {
        redirectTo: "/login.html",
      }
    );
  } catch (error) {
    logRequestError(req, error, { scope: "auth_reset_password_unexpected" });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while trying to reset your password."
    );
  }
}