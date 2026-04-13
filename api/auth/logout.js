// api/auth/logout.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "../../lib/env.js";
import {
  ok,
  methodNotAllowed,
} from "../../lib/responses.js";
import {
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  clearAuthCookies,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const REDIRECT_PATH = "/login.html";

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
  logRequestStart(req, { scope: "auth_logout" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const accessToken = getAccessTokenFromRequest(req);
    const refreshToken = getRefreshTokenFromRequest(req);

    clearAuthCookies(res);

    if (!accessToken || !refreshToken) {
      logAuthEvent("Logout completed with no active session.", {
        reason: "missing_tokens",
      });

      logRequestSuccess(req, { scope: "auth_logout_no_session" });

      return ok(
        res,
        {
          signedOut: true,
        },
        "You have been signed out.",
        {
          redirectTo: REDIRECT_PATH,
        }
      );
    }

    const supabase = createPublicSupabaseClient();

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (!sessionError) {
      await supabase.auth.signOut({ scope: "global" });
    }

    logAuthEvent("Logout successful.", {
      hadSession: !sessionError,
    });

    logRequestSuccess(req, { scope: "auth_logout" });

    return ok(
      res,
      {
        signedOut: true,
      },
      "You have been signed out successfully.",
      {
        redirectTo: REDIRECT_PATH,
      }
    );
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, { scope: "auth_logout_unexpected" });

    return ok(
      res,
      {
        signedOut: true,
        warning:
          error?.message ||
          "The server could not fully verify the session before logout.",
      },
      "You have been signed out.",
      {
        redirectTo: REDIRECT_PATH,
      }
    );
  }
}