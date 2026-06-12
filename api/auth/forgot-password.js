// api/auth/forgot-password.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { getSiteUrl } from "../../lib/env.js";
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

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MINUTES = 30;
const DEFAULT_RESET_PATH = "/reset-password.html";

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

function getRuntimeSiteUrl(req) {
  const configured = getSiteUrl?.();

  if (configured) {
    return String(configured).replace(/\/+$/, "");
  }

  const proto =
    req?.headers?.["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req?.headers?.["x-forwarded-host"] ||
    req?.headers?.host ||
    "localhost:3000";

  return `${proto}://${host}`.replace(/\/+$/, "");
}

function createResetToken() {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function getResetExpirationDate() {
  return new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
}

function shouldExposeResetLinkForTesting() {
  const value = String(
    process.env.EXPOSE_PASSWORD_RESET_LINK ||
      process.env.NEXT_PUBLIC_EXPOSE_PASSWORD_RESET_LINK ||
      ""
  )
    .trim()
    .toLowerCase();

  return (
    process.env.NODE_ENV !== "production" ||
    value === "true" ||
    value === "1" ||
    value === "yes"
  );
}

function buildResetUrl(req, token, email) {
  const siteUrl = getRuntimeSiteUrl(req);
  const params = new URLSearchParams();

  params.set("token", token);
  params.set("email", email);

  return `${siteUrl}${DEFAULT_RESET_PATH}?${params.toString()}`;
}

function getGenericSuccessMessage() {
  return "If that email is eligible for recovery, reset instructions have been created.";
}

async function storeResetToken({ email, tokenHash, expiresAt }) {
  return supabaseAdmin
    .from("signups")
    .update({
      reset_token_hash: tokenHash,
      reset_token_expires_at: expiresAt.toISOString(),
      reset_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("email", email)
    .select("id, email, status")
    .maybeSingle();
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_forgot_password" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = forgotPasswordRateLimit(req, res);

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
    const validation = validateForgotPasswordInput(body);

    if (!validation?.valid) {
      return badRequest(
        res,
        "Email is required.",
        validation?.errors || {}
      );
    }

    const email = normalizeEmail(validation.values.email);

    const { data: member, error: lookupError } = await supabaseAdmin
      .from("signups")
      .select("id, email, status")
      .eq("email", email)
      .maybeSingle();

    if (lookupError) {
      logRequestError(req, lookupError, {
        scope: "auth_forgot_password_lookup",
        email,
      });

      return serverError(
        res,
        "Unable to start password recovery right now."
      );
    }

    /*
      Security rule:
      Do not reveal whether an email exists.
      If no account exists, still return success.
    */
    if (!member?.id) {
      logAuthEvent("Password reset requested for unknown email.", {
        email,
      });

      logRequestSuccess(req, {
        scope: "auth_forgot_password_unknown_email",
        email,
      });

      return ok(
        res,
        {
          email,
          resetCreated: false,
        },
        getGenericSuccessMessage()
      );
    }

    const token = createResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = getResetExpirationDate();
    const resetUrl = buildResetUrl(req, token, email);

    const { data: updatedMember, error: updateError } = await storeResetToken({
      email,
      tokenHash,
      expiresAt,
    });

    if (updateError) {
      logRequestError(req, updateError, {
        scope: "auth_forgot_password_store_token",
        email,
        memberId: member.id,
      });

      return serverError(
        res,
        "Unable to create password reset instructions right now."
      );
    }

    /*
      Email sending is not wired here yet.
      For production, connect this resetUrl to your email sender.
      For testing, set EXPOSE_PASSWORD_RESET_LINK=true in Vercel to see the URL.
    */
    logAuthEvent("Password reset token created.", {
      email,
      memberId: updatedMember?.id || member.id,
      expiresAt: expiresAt.toISOString(),
      resetUrlExposed: shouldExposeResetLinkForTesting(),
    });

    logRequestSuccess(req, {
      scope: "auth_forgot_password",
      email,
      memberId: updatedMember?.id || member.id,
    });

    return ok(
      res,
      {
        email,
        resetCreated: true,
        expiresAt: expiresAt.toISOString(),
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,

        /*
          This is only returned when testing is enabled.
          Do not expose this publicly long-term.
        */
        resetUrl: shouldExposeResetLinkForTesting() ? resetUrl : null,
      },
      getGenericSuccessMessage(),
      {
        redirectTo: shouldExposeResetLinkForTesting()
          ? resetUrl
          : DEFAULT_RESET_PATH,
      }
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "auth_forgot_password_unexpected",
    });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while trying to start password recovery."
    );
  }
}