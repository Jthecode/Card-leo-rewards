// api/auth/verify-email.js

import { getServerEnv } from "../../lib/env.js";
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

const ALLOWED_TYPES = new Set([
  "signup",
  "invite",
  "email",
  "recovery",
  "magiclink",
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

  return req.body;
}

function getValue(source, key) {
  return clean(source?.[key]);
}

function normalizeType(value) {
  const type = toLower(value || "signup");
  return ALLOWED_TYPES.has(type) ? type : "signup";
}

function getVerifyParams(req) {
  const body = getRequestBody(req);
  const source = req.method === "GET" ? req.query || {} : body || {};

  const type = normalizeType(getValue(source, "type"));
  const email = toLower(getValue(source, "email"));
  const token = getValue(source, "token");
  const tokenHash =
    getValue(source, "token_hash") || getValue(source, "tokenHash");
  const next =
    getValue(source, "next") ||
    getValue(source, "redirectTo") ||
    "/login.html?verified=1";

  return {
    type,
    email,
    token,
    tokenHash,
    next,
  };
}

function buildSupabaseVerifyPayload(params) {
  if (params.tokenHash) {
    return {
      type: params.type,
      token_hash: params.tokenHash,
    };
  }

  if (params.email && params.token) {
    return {
      type: params.type,
      email: params.email,
      token: params.token,
    };
  }

  return null;
}

function buildRedirectUrl(path, updates = {}) {
  const base = clean(path) || "/login.html";
  const url = new URL(base, "http://localhost");

  for (const [key, value] of Object.entries(updates)) {
    const normalized = clean(value);
    if (normalized) {
      url.searchParams.set(key, normalized);
    }
  }

  return `${url.pathname}${url.search}`;
}

function redirect(res, location) {
  if (!res || typeof res.writeHead !== "function" || typeof res.end !== "function") {
    throw new Error("A valid response object is required for redirect.");
  }

  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
}

async function verifyWithSupabase(env, payload) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabasePublishableKey || env.supabaseAnonKey);

  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase verification is not configured correctly.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
    },
    body: JSON.stringify(payload),
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

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(res, ["GET", "POST"]);
  }

  const rate = verifyEmailRateLimit(req, res);

  if (!rate.allowed) {
    const redirectUrl = buildRedirectUrl("/login.html", {
      verified: "0",
      reason: "rate_limited",
    });

    if (req.method === "GET") {
      logger.warn("Verify email rate limited.", {
        ip: req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "",
      });

      return redirect(res, redirectUrl);
    }

    return unauthorized(
      res,
      "Too many verification attempts. Please try again later.",
      { retryAfter: rate.retryAfter }
    );
  }

  try {
    const env = getServerEnv();
    const params = getVerifyParams(req);
    const payload = buildSupabaseVerifyPayload(params);

    if (!payload) {
      const redirectUrl = buildRedirectUrl("/login.html", {
        verified: "0",
        reason: "missing_token",
      });

      if (req.method === "GET") {
        return redirect(res, redirectUrl);
      }

      return badRequest(res, "Verification token is required.", {
        required: "Provide token_hash, or provide both email and token.",
      });
    }

    const result = await verifyWithSupabase(env, payload);

    if (!result.ok) {
      logger.warn("Email verification failed.", {
        status: result.status,
        type: payload.type,
        hasTokenHash: Boolean(payload.token_hash),
        email: payload.email || "",
        response: result.data,
      });

      const failureReason =
        clean(result?.data?.error_code) ||
        clean(result?.data?.msg) ||
        clean(result?.data?.message) ||
        "verification_failed";

      const redirectUrl = buildRedirectUrl("/login.html", {
        verified: "0",
        reason: failureReason,
      });

      if (req.method === "GET") {
        return redirect(res, redirectUrl);
      }

      return unauthorized(
        res,
        "Email verification failed or the link is no longer valid.",
        {
          status: result.status,
          reason: failureReason,
        }
      );
    }

    logger.info("Email verified successfully.", {
      type: payload.type,
      email: payload.email || "",
      hasTokenHash: Boolean(payload.token_hash),
    });

    if (req.method === "GET") {
      const successRedirect = buildRedirectUrl(params.next, {
        verified: "1",
      });
      return redirect(res, successRedirect);
    }

    return ok(
      res,
      {
        verified: true,
        type: payload.type,
        session: result.data?.session || null,
        user: result.data?.user || null,
      },
      "Email verified successfully."
    );
  } catch (error) {
    logger.error("Unexpected verify-email error.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    if (req.method === "GET") {
      const redirectUrl = buildRedirectUrl("/login.html", {
        verified: "0",
        reason: "server_error",
      });
      return redirect(res, redirectUrl);
    }

    return fromCaughtError(res, error, "Unable to verify email right now.");
  }
}