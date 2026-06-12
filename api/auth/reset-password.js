// api/auth/reset-password.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
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

const LOGIN_REDIRECT = "/login.html?passwordReset=1";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
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

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function getResetToken(body = {}) {
  return normalizeText(
    body.token ||
      body.resetToken ||
      body.reset_token ||
      body.recoveryToken ||
      body.recovery_token ||
      body.accessToken ||
      body.access_token ||
      body.code
  );
}

function getPassword(body = {}) {
  return String(
    body.password ||
      body.newPassword ||
      body.new_password ||
      ""
  );
}

function getConfirmPassword(body = {}) {
  return String(
    body.confirmPassword ||
      body.confirm_password ||
      body.confirmNewPassword ||
      body.confirm_new_password ||
      ""
  );
}

function isExpired(value) {
  if (!value) return true;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return true;

  return date.getTime() <= Date.now();
}

function validateResetPayload({ token, password, confirmPassword }) {
  const validation = validateResetPasswordInput({
    token,
    password,
    confirmPassword,
  });

  if (validation?.valid) {
    return validation;
  }

  const errors = {
    ...(validation?.errors || {}),
  };

  if (!token) {
    errors.token = "Password reset token is required.";
  }

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
    values: {
      token,
      password,
      confirmPassword,
    },
  };
}

async function findSignupByResetToken({ tokenHash, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select(
      [
        "id",
        "email",
        "first_name",
        "last_name",
        "full_name",
        "status",
        "password_hash",
        "reset_token_hash",
        "reset_token_expires_at",
        "reset_requested_at",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .eq("reset_token_hash", tokenHash);

  if (email) {
    query = query.eq("email", email);
  }

  const { data, error } = await query.maybeSingle();

  return {
    signup: data || null,
    error: error || null,
  };
}

function getDisplayName(signup) {
  const fullName = normalizeText(signup?.full_name);

  if (fullName) return fullName;

  return [signup?.first_name, signup?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function sanitizeSignup(signup) {
  if (!signup) return null;

  return {
    id: signup.id || null,
    email: signup.email || null,
    fullName: getDisplayName(signup) || "Card Leo Member",
    status: signup.status || "",
  };
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_reset_password" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = resetPasswordRateLimit(req, res);

    if (rateLimit && !rateLimit.allowed) {
      return badRequest(
        res,
        "Too many password reset attempts. Please try again later.",
        {
          retryAfter: rateLimit.retryAfter ?? null,
        },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);

    const token = getResetToken(body);
    const email = normalizeEmail(body.email);
    const password = getPassword(body);
    const confirmPassword = getConfirmPassword(body);

    const validation = validateResetPayload({
      token,
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

    const tokenHash = hashValue(token);

    const { signup, error: lookupError } = await findSignupByResetToken({
      tokenHash,
      email,
    });

    if (lookupError) {
      logRequestError(req, lookupError, {
        scope: "auth_reset_password_lookup",
        email: email || null,
      });

      return serverError(
        res,
        "Unable to verify this reset link right now."
      );
    }

    if (!signup?.id) {
      clearAuthCookies(res);

      logAuthEvent("Password reset failed.", {
        email: email || null,
        reason: "invalid_token",
      });

      return badRequest(
        res,
        "This password reset link is invalid or has already been used."
      );
    }

    if (isExpired(signup.reset_token_expires_at)) {
      clearAuthCookies(res);

      logAuthEvent("Password reset failed.", {
        email: signup.email,
        signupId: signup.id,
        reason: "expired_token",
      });

      return badRequest(
        res,
        "This password reset link has expired. Please request a new one."
      );
    }

    const newPasswordHash = hashValue(password);

    const { data: updatedSignup, error: updateError } = await supabaseAdmin
      .from("signups")
      .update({
        password_hash: newPasswordHash,
        reset_token_hash: null,
        reset_token_expires_at: null,
        reset_requested_at: null,
        reset_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", signup.id)
      .select(
        [
          "id",
          "email",
          "first_name",
          "last_name",
          "full_name",
          "status",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .single();

    if (updateError) {
      logRequestError(req, updateError, {
        scope: "auth_reset_password_update",
        email: signup.email,
        signupId: signup.id,
      });

      return serverError(
        res,
        "We could not update your password with this link."
      );
    }

    clearAuthCookies(res);

    logAuthEvent("Password reset successful.", {
      signupId: updatedSignup?.id || signup.id,
      email: updatedSignup?.email || signup.email,
    });

    logRequestSuccess(req, {
      scope: "auth_reset_password",
      signupId: updatedSignup?.id || signup.id,
      email: updatedSignup?.email || signup.email,
    });

    return ok(
      res,
      {
        reset: true,
        member: sanitizeSignup(updatedSignup),
      },
      "Your password has been updated successfully.",
      {
        redirectTo: LOGIN_REDIRECT,
      }
    );
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, {
      scope: "auth_reset_password_unexpected",
    });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while trying to reset your password."
    );
  }
}