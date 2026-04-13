// api/auth/login.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "../../lib/env.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";
import { validateLoginInput } from "../../lib/validation.js";
import {
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setSessionCookie,
  clearAuthCookies,
} from "../../lib/cookies.js";
import { loginRateLimit } from "../../lib/rate-limit.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";

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

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id || null,
    email: user.email || null,
    email_confirmed_at: user.email_confirmed_at || null,
    last_sign_in_at: user.last_sign_in_at || null,
    role: user.role || null,
    app_metadata: user.app_metadata || {},
    user_metadata: user.user_metadata || {},
  };
}

function buildSessionCookieValue(session, remember = false) {
  return JSON.stringify({
    access_token: session?.access_token || null,
    refresh_token: session?.refresh_token || null,
    expires_at: session?.expires_at || null,
    expires_in: session?.expires_in || null,
    token_type: session?.token_type || "bearer",
    remember: Boolean(remember),
  });
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_login" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = loginRateLimit(req, res);

    if (!rateLimit.allowed) {
      return badRequest(
        res,
        "Too many login attempts. Please try again later.",
        { retryAfter: rateLimit.retryAfter },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);
    const validation = validateLoginInput(body);

    if (!validation.valid) {
      clearAuthCookies(res);
      return badRequest(res, "Email and password are required.", validation.errors);
    }

    const { email, password } = validation.values;
    const remember = Boolean(body.remember);

    const supabase = createPublicSupabaseClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data?.session || !data?.user) {
      clearAuthCookies(res);

      logAuthEvent("Login failed.", {
        email,
        reason: error?.message || "invalid_credentials",
      });

      return unauthorized(res, "Invalid email or password.");
    }

    if (
      data.user.banned_until &&
      new Date(data.user.banned_until).getTime() > Date.now()
    ) {
      clearAuthCookies(res);

      logAuthEvent("Login blocked for restricted account.", {
        email,
        bannedUntil: data.user.banned_until,
      });

      return forbidden(res, "This account is temporarily restricted.");
    }

    setAccessTokenCookie(res, data.session.access_token, {
      maxAge: Math.max(300, Number(data.session?.expires_in) || 3600),
    });

    setRefreshTokenCookie(res, data.session.refresh_token, {
      maxAge: remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24,
    });

    setSessionCookie(res, buildSessionCookieValue(data.session, remember), {
      httpOnly: true,
    });

    logAuthEvent("Login successful.", {
      email,
      userId: data.user.id,
    });

    logRequestSuccess(req, {
      scope: "auth_login",
      userId: data.user.id,
      email,
    });

    return ok(
      res,
      {
        user: sanitizeUser(data.user),
        session: {
          expires_at: data.session.expires_at || null,
          expires_in: data.session.expires_in || null,
          token_type: data.session.token_type || "bearer",
        },
      },
      "Login successful.",
      {
        redirectTo: DEFAULT_REDIRECT,
      }
    );
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, { scope: "auth_login_unexpected" });

    return serverError(
      res,
      error?.message || "Something went wrong while trying to sign you in."
    );
  }
}