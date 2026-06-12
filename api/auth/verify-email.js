// api/auth/verify-email.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  methodNotAllowed,
  fromCaughtError,
  setNoStore,
} from "../../lib/responses.js";
import { verifyEmailRateLimit } from "../../lib/rate-limit.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("api:auth:verify-email");

const DEFAULT_SUCCESS_NEXT = "/login.html?verified=1";
const DEFAULT_FAILURE_NEXT = "/login.html?verified=0";

const ALLOWED_TYPES = new Set([
  "signup",
  "invite",
  "email",
  "email_change",
]);

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toLower(value) {
  return clean(value).toLowerCase();
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

function getValue(source, key) {
  return clean(source?.[key]);
}

function normalizeType(value) {
  const type = toLower(value || "signup");
  return ALLOWED_TYPES.has(type) ? type : "signup";
}

function normalizeEmail(value) {
  return toLower(value);
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function getVerifyParams(req) {
  const body = getRequestBody(req);
  const source = req.method === "GET" ? req.query || {} : body || {};

  const type = normalizeType(getValue(source, "type"));
  const email = normalizeEmail(getValue(source, "email"));
  const token = getValue(source, "token");
  const tokenHash =
    getValue(source, "token_hash") ||
    getValue(source, "tokenHash") ||
    getValue(source, "verification_token_hash");

  const next =
    getValue(source, "next") ||
    getValue(source, "redirectTo") ||
    getValue(source, "redirect_to") ||
    DEFAULT_SUCCESS_NEXT;

  return {
    type,
    email,
    token,
    tokenHash,
    next,
  };
}

function getSafeNextPath(value, fallback = DEFAULT_SUCCESS_NEXT) {
  const raw = clean(value) || fallback;

  try {
    const url = new URL(raw, "https://cardleorewards.local");

    if (!url.pathname.startsWith("/")) {
      return fallback;
    }

    if (url.pathname.startsWith("/api/")) {
      return fallback;
    }

    return `${url.pathname}${url.search || ""}`;
  } catch {
    return fallback;
  }
}

function buildRedirectUrl(path, updates = {}) {
  const safePath = getSafeNextPath(path, DEFAULT_FAILURE_NEXT);
  const url = new URL(safePath, "https://cardleorewards.local");

  for (const [key, value] of Object.entries(updates)) {
    const normalized = clean(value);

    if (normalized) {
      url.searchParams.set(key, normalized);
    }
  }

  return `${url.pathname}${url.search}`;
}

function redirect(res, location) {
  if (
    !res ||
    typeof res.writeHead !== "function" ||
    typeof res.end !== "function"
  ) {
    throw new Error("A valid response object is required for redirect.");
  }

  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
  });

  res.end();
}

function getTokenHashFromParams(params) {
  if (params.tokenHash) {
    return clean(params.tokenHash);
  }

  if (params.token) {
    return hashToken(params.token);
  }

  return "";
}

function isExpired(value) {
  if (!value) return true;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return true;
  }

  return date.getTime() <= Date.now();
}

function getDisplayName(signup) {
  const fullName = clean(signup?.full_name);

  if (fullName) return fullName;

  return [signup?.first_name, signup?.last_name]
    .map(clean)
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
    emailVerified: Boolean(signup.email_verified),
    emailVerifiedAt: signup.email_verified_at || null,
  };
}

async function findSignupByVerificationToken({ tokenHash, email }) {
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
        "email_verified",
        "email_verified_at",
        "verification_token_hash",
        "verification_token_expires_at",
        "verification_requested_at",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .eq("verification_token_hash", tokenHash);

  if (email) {
    query = query.eq("email", email);
  }

  const { data, error } = await query.maybeSingle();

  return {
    signup: data || null,
    error: error || null,
  };
}

async function markSignupVerified(signupId) {
  return supabaseAdmin
    .from("signups")
    .update({
      email_verified: true,
      email_verified_at: new Date().toISOString(),
      verification_token_hash: null,
      verification_token_expires_at: null,
      verification_requested_at: null,
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
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .single();
}

function missingTokenResponse(req, res) {
  const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
    verified: "0",
    reason: "missing_token",
  });

  if (req.method === "GET") {
    return redirect(res, redirectUrl);
  }

  return badRequest(res, "Verification token is required.", {
    required: "Provide token, or provide token_hash.",
  });
}

function invalidTokenResponse(req, res, reason = "invalid_token") {
  const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
    verified: "0",
    reason,
  });

  if (req.method === "GET") {
    return redirect(res, redirectUrl);
  }

  return unauthorized(
    res,
    reason === "expired_token"
      ? "Email verification link has expired."
      : "Email verification failed or the link is no longer valid.",
    {
      reason,
    }
  );
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(res, ["GET", "POST"]);
  }

  const rate = verifyEmailRateLimit(req, res);

  if (rate && !rate.allowed) {
    const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
      verified: "0",
      reason: "rate_limited",
    });

    logger.warn("Verify email rate limited.", {
      ip: req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "",
      retryAfter: rate.retryAfter ?? null,
    });

    if (req.method === "GET") {
      return redirect(res, redirectUrl);
    }

    return unauthorized(
      res,
      "Too many verification attempts. Please try again later.",
      {
        retryAfter: rate.retryAfter ?? null,
      }
    );
  }

  try {
    const params = getVerifyParams(req);
    const tokenHash = getTokenHashFromParams(params);

    if (!tokenHash) {
      return missingTokenResponse(req, res);
    }

    const { signup, error: lookupError } =
      await findSignupByVerificationToken({
        tokenHash,
        email: params.email,
      });

    if (lookupError) {
      logger.error("Email verification lookup failed.", {
        email: params.email || "",
        type: params.type,
        error: {
          name: lookupError?.name || "SupabaseError",
          message: lookupError?.message || "Unknown lookup error",
        },
      });

      if (req.method === "GET") {
        const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
          verified: "0",
          reason: "server_error",
        });

        return redirect(res, redirectUrl);
      }

      return fromCaughtError(
        res,
        lookupError,
        "Unable to verify email right now."
      );
    }

    if (!signup?.id) {
      logger.warn("Email verification failed because token was not found.", {
        email: params.email || "",
        type: params.type,
        hasTokenHash: Boolean(tokenHash),
      });

      return invalidTokenResponse(req, res, "invalid_token");
    }

    if (signup.email_verified === true || signup.email_verified_at) {
      logger.info("Email verification skipped because account is already verified.", {
        signupId: signup.id,
        email: signup.email,
      });

      const next = buildRedirectUrl(params.next, {
        verified: "1",
        alreadyVerified: "1",
      });

      if (req.method === "GET") {
        return redirect(res, next);
      }

      return ok(
        res,
        {
          verified: true,
          alreadyVerified: true,
          member: sanitizeSignup(signup),
        },
        "Email is already verified.",
        {
          redirectTo: next,
        }
      );
    }

    if (isExpired(signup.verification_token_expires_at)) {
      logger.warn("Email verification failed because token expired.", {
        signupId: signup.id,
        email: signup.email,
        expiresAt: signup.verification_token_expires_at || null,
      });

      return invalidTokenResponse(req, res, "expired_token");
    }

    const { data: verifiedSignup, error: updateError } =
      await markSignupVerified(signup.id);

    if (updateError) {
      logger.error("Unable to mark email as verified.", {
        signupId: signup.id,
        email: signup.email,
        error: {
          name: updateError?.name || "SupabaseError",
          message: updateError?.message || "Unknown update error",
        },
      });

      if (req.method === "GET") {
        const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
          verified: "0",
          reason: "server_error",
        });

        return redirect(res, redirectUrl);
      }

      return fromCaughtError(
        res,
        updateError,
        "Unable to complete email verification right now."
      );
    }

    logger.info("Email verified successfully.", {
      signupId: verifiedSignup?.id || signup.id,
      email: verifiedSignup?.email || signup.email,
      type: params.type,
    });

    const successRedirect = buildRedirectUrl(params.next, {
      verified: "1",
    });

    if (req.method === "GET") {
      return redirect(res, successRedirect);
    }

    return ok(
      res,
      {
        verified: true,
        type: params.type,
        member: sanitizeSignup(verifiedSignup),
      },
      "Email verified successfully.",
      {
        redirectTo: successRedirect,
      }
    );
  } catch (error) {
    logger.error("Unexpected verify-email error.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    if (req.method === "GET") {
      const redirectUrl = buildRedirectUrl(DEFAULT_FAILURE_NEXT, {
        verified: "0",
        reason: "server_error",
      });

      return redirect(res, redirectUrl);
    }

    return fromCaughtError(res, error, "Unable to verify email right now.");
  }
}