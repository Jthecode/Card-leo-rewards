// api/auth/resend-verification.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { getSiteUrl } from "../../lib/env.js";
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

const VERIFY_TOKEN_BYTES = 32;
const VERIFY_TOKEN_TTL_MINUTES = 60;
const VERIFY_EMAIL_PATH = "/api/auth/verify-email";
const DEFAULT_NEXT_PATH = "/login.html?verified=1";

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

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
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

function createVerificationToken() {
  return crypto.randomBytes(VERIFY_TOKEN_BYTES).toString("hex");
}

function hashVerificationToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function getVerificationExpirationDate() {
  return new Date(Date.now() + VERIFY_TOKEN_TTL_MINUTES * 60 * 1000);
}

function getSafeNextPath(value) {
  const raw = clean(value) || DEFAULT_NEXT_PATH;

  try {
    const url = new URL(raw, "https://cardleorewards.local");

    if (!url.pathname.startsWith("/")) {
      return DEFAULT_NEXT_PATH;
    }

    if (url.pathname.startsWith("/api/")) {
      return DEFAULT_NEXT_PATH;
    }

    return `${url.pathname}${url.search || ""}`;
  } catch {
    return DEFAULT_NEXT_PATH;
  }
}

function buildVerifyUrl(req, { token, email, next }) {
  const siteUrl = getRuntimeSiteUrl(req);
  const url = new URL(`${siteUrl}${VERIFY_EMAIL_PATH}`);

  url.searchParams.set("token", token);
  url.searchParams.set("email", email);
  url.searchParams.set("type", "signup");
  url.searchParams.set("next", getSafeNextPath(next));

  return url.toString();
}

function shouldExposeVerifyLinkForTesting() {
  const value = String(
    process.env.EXPOSE_VERIFY_EMAIL_LINK ||
      process.env.NEXT_PUBLIC_EXPOSE_VERIFY_EMAIL_LINK ||
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

function getDisplayName(member, fallback = "Member") {
  const fullName = clean(member?.full_name);
  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map(clean)
    .filter(Boolean)
    .join(" ");

  return joined || fallback;
}

function getGenericSuccessMessage() {
  return "If that email is eligible for verification, a new verification email has been created.";
}

async function findSignupByEmail(email) {
  return supabaseAdmin
    .from("signups")
    .select(
      [
        "id",
        "email",
        "first_name",
        "last_name",
        "full_name",
        "status",
        "email_verified",
        "email_verified_at",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .eq("email", email)
    .maybeSingle();
}

async function storeVerificationToken({
  signupId,
  tokenHash,
  expiresAt,
}) {
  return supabaseAdmin
    .from("signups")
    .update({
      verification_token_hash: tokenHash,
      verification_token_expires_at: expiresAt.toISOString(),
      verification_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", signupId)
    .select(
      [
        "id",
        "email",
        "first_name",
        "last_name",
        "full_name",
        "status",
        "email_verified",
        "email_verified_at",
        "verification_token_expires_at",
      ].join(", ")
    )
    .maybeSingle();
}

async function sendVerificationMessage({ email, fullName, verifyUrl }) {
  await sendVerifyEmail({
    to: email,
    email,
    fullName,
    name: fullName,
    verifyUrl,
    verificationUrl: verifyUrl,
    url: verifyUrl,
    code: "",
  });
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  const ipRate = resendVerificationRateLimit(req, res);

  if (ipRate && !ipRate.allowed) {
    return tooManyRequests(
      res,
      "Too many verification requests. Please try again later.",
      {
        retryAfter: ipRate.retryAfter ?? null,
      }
    );
  }

  try {
    const body = getRequestBody(req);
    const email = normalizeEmail(body.email);
    const requestedFullName = clean(body.fullName || body.full_name || body.name);
    const next = getSafeNextPath(body.next || DEFAULT_NEXT_PATH);

    if (!email) {
      return badRequest(res, "Email is required.");
    }

    if (!isValidEmail(email)) {
      return badRequest(res, "Enter a valid email address.");
    }

    const { data: signup, error: lookupError } = await findSignupByEmail(email);

    if (lookupError) {
      logger.error("Unable to look up signup for verification resend.", {
        email,
        error: {
          name: lookupError?.name || "SupabaseError",
          message: lookupError?.message || "Unknown lookup error",
        },
      });

      return fromCaughtError(
        res,
        lookupError,
        "Unable to resend verification email right now."
      );
    }

    /*
      Security:
      Do not reveal whether an email exists.
      If no signup exists, return success anyway.
    */
    if (!signup?.id) {
      logger.info("Verification resend requested for unknown email.", {
        email,
      });

      return ok(
        res,
        {
          sent: true,
          email,
          verificationCreated: false,
        },
        getGenericSuccessMessage()
      );
    }

    if (signup.email_verified === true || signup.email_verified_at) {
      logger.info("Verification resend skipped because email is already verified.", {
        email,
        signupId: signup.id,
      });

      return ok(
        res,
        {
          sent: true,
          email,
          alreadyVerified: true,
        },
        "This email is already verified.",
        {
          redirectTo: next,
        }
      );
    }

    const token = createVerificationToken();
    const tokenHash = hashVerificationToken(token);
    const expiresAt = getVerificationExpirationDate();

    const verifyUrl = buildVerifyUrl(req, {
      token,
      email,
      next,
    });

    const { data: updatedSignup, error: updateError } =
      await storeVerificationToken({
        signupId: signup.id,
        tokenHash,
        expiresAt,
      });

    if (updateError) {
      logger.error("Unable to store verification token.", {
        email,
        signupId: signup.id,
        error: {
          name: updateError?.name || "SupabaseError",
          message: updateError?.message || "Unknown update error",
        },
      });

      return fromCaughtError(
        res,
        updateError,
        "Unable to create a new verification email right now."
      );
    }

    const fullName = requestedFullName || getDisplayName(updatedSignup || signup);

    try {
      await sendVerificationMessage({
        email,
        fullName,
        verifyUrl,
      });
    } catch (emailError) {
      logger.error("Verification email token created but email send failed.", {
        email,
        signupId: signup.id,
        error: {
          name: emailError?.name || "EmailError",
          message: emailError?.message || "Unable to send verification email.",
        },
      });

      return fromCaughtError(
        res,
        emailError,
        "Verification was created, but the email could not be sent right now."
      );
    }

    logger.info("Verification email re-sent successfully.", {
      email,
      signupId: signup.id,
      expiresAt: expiresAt.toISOString(),
      verifyUrlExposed: shouldExposeVerifyLinkForTesting(),
    });

    return ok(
      res,
      {
        sent: true,
        email,
        verificationCreated: true,
        expiresAt: expiresAt.toISOString(),
        expiresInMinutes: VERIFY_TOKEN_TTL_MINUTES,
        verifyUrl: shouldExposeVerifyLinkForTesting() ? verifyUrl : null,
      },
      "Verification email sent successfully.",
      {
        redirectTo: shouldExposeVerifyLinkForTesting() ? verifyUrl : next,
      }
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