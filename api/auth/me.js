// api/auth/me.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "../../lib/env.js";
import {
  ok,
  methodNotAllowed,
  serverError,
} from "../../lib/responses.js";
import {
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";

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

function readSessionCookie(req) {
  const cookieHeader = req?.headers?.cookie || "";
  const sessionCookieName = getSessionCookieName();

  const match = String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));

  if (!match) return null;

  const [, rawValue = ""] = match.split("=");
  return safeJsonParse(decodeURIComponent(rawValue), null);
}

async function getUserFromAccessToken(supabase, accessToken) {
  if (!accessToken) return null;

  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}

async function refreshSessionFromTokens(supabase, accessToken, refreshToken) {
  if (!accessToken || !refreshToken) {
    return null;
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error || !data?.session || !data?.user) {
    return null;
  }

  return data;
}

function setAuthCookiesFromSession(res, session, remember = true) {
  setAccessTokenCookie(res, session.access_token, {
    maxAge: Math.max(300, Number(session?.expires_in) || 3600),
  });

  setRefreshTokenCookie(res, session.refresh_token, {
    maxAge: remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24,
  });

  setSessionCookie(
    res,
    JSON.stringify({
      access_token: session?.access_token || null,
      refresh_token: session?.refresh_token || null,
      expires_at: session?.expires_at || null,
      expires_in: session?.expires_in || null,
      token_type: session?.token_type || "bearer",
      remember: Boolean(remember),
    }),
    {
      httpOnly: true,
    }
  );
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_me" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const accessToken = getAccessTokenFromRequest(req);
    const refreshToken = getRefreshTokenFromRequest(req);
    const sessionCookie = readSessionCookie(req);

    const fallbackAccessToken =
      accessToken || sessionCookie?.access_token || "";
    const fallbackRefreshToken =
      refreshToken || sessionCookie?.refresh_token || "";

    if (!fallbackAccessToken && !fallbackRefreshToken) {
      return ok(
        res,
        {
          authenticated: false,
          user: null,
          session: null,
        },
        "No active session."
      );
    }

    const supabase = createPublicSupabaseClient();

    const userFromAccessToken = await getUserFromAccessToken(
      supabase,
      fallbackAccessToken
    );

    if (userFromAccessToken) {
      logAuthEvent("Session check successful.", {
        userId: userFromAccessToken.id,
        email: userFromAccessToken.email,
      });

      logRequestSuccess(req, {
        scope: "auth_me",
        userId: userFromAccessToken.id,
      });

      return ok(
        res,
        {
          authenticated: true,
          user: sanitizeUser(userFromAccessToken),
          session: sessionCookie
            ? {
                expires_at: sessionCookie.expires_at || null,
                expires_in: sessionCookie.expires_in || null,
                token_type: sessionCookie.token_type || "bearer",
              }
            : null,
        },
        "Session active.",
        {
          redirectTo: DEFAULT_REDIRECT,
        }
      );
    }

    const refreshed = await refreshSessionFromTokens(
      supabase,
      fallbackAccessToken,
      fallbackRefreshToken
    );

    if (refreshed?.user && refreshed?.session) {
      const remember = Boolean(sessionCookie?.remember ?? true);

      setAuthCookiesFromSession(res, refreshed.session, remember);

      logAuthEvent("Session refreshed successfully.", {
        userId: refreshed.user.id,
        email: refreshed.user.email,
      });

      logRequestSuccess(req, {
        scope: "auth_me_refreshed",
        userId: refreshed.user.id,
      });

      return ok(
        res,
        {
          authenticated: true,
          user: sanitizeUser(refreshed.user),
          session: {
            expires_at: refreshed.session.expires_at || null,
            expires_in: refreshed.session.expires_in || null,
            token_type: refreshed.session.token_type || "bearer",
          },
        },
        "Session active.",
        {
          redirectTo: DEFAULT_REDIRECT,
        }
      );
    }

    clearAuthCookies(res);

    logAuthEvent("Session expired.", {
      reason: "unable_to_refresh",
    });

    return ok(
      res,
      {
        authenticated: false,
        user: null,
        session: null,
      },
      "Session expired. Please sign in again."
    );
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, { scope: "auth_me_unexpected" });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while checking the current session."
    );
  }
}