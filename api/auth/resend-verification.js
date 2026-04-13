// api/auth/resend-verification.js

import { getServerEnv, getSiteUrl } from "../../lib/env.js";
import {
  ok,
  badRequest,
  methodNotAllowed,
  fromCaughtError,
  tooManyRequests,
  setNoStore,
} from "../../lib/responses.js";
import { resendVerificationRateLimit } from "../../lib/rate-limit.js";
import { createLogger } from "../../lib/logger.js";
import { isValidEmail, normalizeEmail } from "../../lib/validation.js";
import { sendVerifyEmail } from "../../lib/email.js";

const logger = createLogger("api:auth:resend-verification");

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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

function buildVerifyUrl({ tokenHash = "", type = "signup", next = "" } = {}) {
  const basePath = "/api/auth/verify-email";
  const url = new URL(getSiteUrl(basePath) || `http://localhost:3000${basePath}`);

  if (clean(tokenHash)) {
    url.searchParams.set("token_hash", clean(tokenHash));
  }

  url.searchParams.set("type", clean(type) || "signup");

  if (clean(next)) {
    url.searchParams.set("next", clean(next));
  }

  return url.toString();
}

async function createMagicLinkWithSupabase(env, { email, redirectTo }) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabasePublishableKey || env.supabaseAnonKey);
  const serviceRoleKey = clean(env.supabaseServiceRoleKey);

  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    throw new Error("Supabase resend verification is not configured correctly.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: publishableKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      type: "signup",
      email,
      options: {
        redirect_to: redirectTo,
      },
    }),
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function extractVerificationData(result) {
  const properties = result?.data?.properties || {};
  const user = result?.data?.user || null;

  return {
    user,
    email: clean(user?.email) || clean(properties?.email) || "",
    actionLink:
      clean(properties?.action_link) ||
      clean(properties?.actionLink) ||
      "",
    hashedToken:
      clean(properties?.hashed_token) ||
      clean(properties?.hashedToken) ||
      "",
    emailOtp:
      clean(properties?.email_otp) ||
      clean(properties?.emailOtp) ||
      "",
  };
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"]);
  }

  const ipRate = resendVerificationRateLimit(req, res);

  if (!ipRate.allowed) {
    return tooManyRequests(
      res,
      "Too many verification requests. Please try again later.",
      { retryAfter: ipRate.retryAfter }
    );
  }

  try {
    const body = getRequestBody(req);
    const email = normalizeEmail(body.email);
    const fullName = clean(body.fullName || body.name || "Member");
    const next = clean(body.next || "/login.html?verified=1");

    if (!email) {
      return badRequest(res, "Email is required.");
    }

    if (!isValidEmail(email)) {
      return badRequest(res, "Enter a valid email address.");
    }

    const env = getServerEnv();

    const redirectTo = getSiteUrl(
      `/api/auth/verify-email?type=signup&next=${encodeURIComponent(next)}`
    );

    const generated = await createMagicLinkWithSupabase(env, {
      email,
      redirectTo,
    });

    if (!generated.ok) {
      logger.warn("Supabase failed to generate verification link.", {
        status: generated.status,
        email,
        response: generated.data,
      });

      return badRequest(
        res,
        "We could not generate a new verification email right now.",
        {
          status: generated.status,
          reason:
            clean(generated?.data?.error_description) ||
            clean(generated?.data?.msg) ||
            clean(generated?.data?.message) ||
            "generate_link_failed",
        }
      );
    }

    const details = extractVerificationData(generated);

    const verifyUrl =
      details.actionLink ||
      buildVerifyUrl({
        tokenHash: details.hashedToken,
        type: "signup",
        next,
      });

    await sendVerifyEmail({
      to: email,
      fullName,
      verifyUrl,
      code: details.emailOtp,
    });

    logger.info("Verification email re-sent successfully.", {
      email,
      hasActionLink: Boolean(details.actionLink),
      hasHashedToken: Boolean(details.hashedToken),
      hasOtp: Boolean(details.emailOtp),
    });

    return ok(
      res,
      {
        sent: true,
        email,
      },
      "Verification email sent successfully."
    );
  } catch (error) {
    logger.error("Unexpected resend-verification error.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    return fromCaughtError(
      res,
      error,
      "Unable to resend verification email right now."
    );
  }
}