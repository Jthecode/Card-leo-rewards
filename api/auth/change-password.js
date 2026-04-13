// api/auth/change-password.js

import { getServerEnv } from "../../lib/env.js";
import {
  ok,
  badRequest,
  unauthorized,
  methodNotAllowed,
  tooManyRequests,
  fromCaughtError,
  setNoStore,
} from "../../lib/responses.js";
import { changePasswordRateLimit } from "../../lib/rate-limit.js";
import { createLogger } from "../../lib/logger.js";
import {
  validateChangePasswordInput,
  normalizeEmail,
} from "../../lib/validation.js";
import { getAccessTokenFromRequest } from "../../lib/cookies.js";

const logger = createLogger("api:auth:change-password");

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

function getBearerToken(req) {
  const header =
    req?.headers?.authorization ||
    req?.headers?.Authorization ||
    "";

  if (!header || typeof header !== "string") return "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";

  return clean(header.slice(7));
}

function getAccessToken(req, body = {}) {
  return (
    clean(body.accessToken) ||
    clean(body.access_token) ||
    clean(body.sessionToken) ||
    clean(body.token) ||
    clean(body?.session?.access_token) ||
    getAccessTokenFromRequest(req) ||
    getBearerToken(req)
  );
}

function getSafeErrorMessage(data, fallback) {
  return (
    clean(data?.msg) ||
    clean(data?.message) ||
    clean(data?.error_description) ||
    clean(data?.error) ||
    fallback
  );
}

async function parseJsonResponse(response) {
  const raw = await response.text();

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function fetchCurrentUser(env, accessToken) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabasePublishableKey || env.supabaseAnonKey);

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await parseJsonResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function verifyCurrentPassword(env, email, currentPassword) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabasePublishableKey || env.supabaseAnonKey);

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: currentPassword,
    }),
  });

  const data = await parseJsonResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function updatePassword(env, accessToken, newPassword) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabasePublishableKey || env.supabaseAnonKey);

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: newPassword,
    }),
  });

  const data = await parseJsonResponse(response);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"]);
  }

  const rate = changePasswordRateLimit(req, res);

  if (!rate.allowed) {
    return tooManyRequests(
      res,
      "Too many password change attempts. Please try again later.",
      { retryAfter: rate.retryAfter }
    );
  }

  try {
    const env = getServerEnv();
    const body = getRequestBody(req);
    const accessToken = getAccessToken(req, body);

    if (!clean(env.supabaseUrl) || !clean(env.supabasePublishableKey || env.supabaseAnonKey)) {
      return badRequest(
        res,
        "Supabase authentication is not configured correctly."
      );
    }

    if (!accessToken) {
      return unauthorized(
        res,
        "You must be signed in to change your password."
      );
    }

    const validation = validateChangePasswordInput(body);

    if (!validation.valid) {
      return badRequest(
        res,
        "Please correct the highlighted password fields.",
        validation.errors
      );
    }

    const { currentPassword, newPassword } = validation.values;

    const currentUser = await fetchCurrentUser(env, accessToken);

    if (!currentUser.ok || !currentUser.data) {
      logger.warn("Unable to load current user before password change.", {
        status: currentUser.status,
      });

      return unauthorized(
        res,
        "Your session is invalid or has expired. Please sign in again."
      );
    }

    const email = normalizeEmail(currentUser.data?.email);

    if (!email) {
      logger.warn("Current user email missing during password change.", {
        userId: currentUser.data?.id || null,
      });

      return unauthorized(
        res,
        "Unable to verify your account for password change."
      );
    }

    const currentPasswordCheck = await verifyCurrentPassword(
      env,
      email,
      currentPassword
    );

    if (!currentPasswordCheck.ok) {
      logger.warn("Current password verification failed.", {
        email,
        status: currentPasswordCheck.status,
      });

      return unauthorized(
        res,
        "Your current password is incorrect."
      );
    }

    const passwordUpdate = await updatePassword(env, accessToken, newPassword);

    if (!passwordUpdate.ok) {
      const reason = getSafeErrorMessage(
        passwordUpdate.data,
        "Unable to update password right now."
      );

      logger.warn("Supabase rejected password update.", {
        email,
        status: passwordUpdate.status,
        reason,
      });

      return badRequest(
        res,
        "We could not update your password right now.",
        {
          reason,
          status: passwordUpdate.status,
        }
      );
    }

    logger.info("Password changed successfully.", {
      email,
      userId: currentUser.data?.id || null,
    });

    return ok(
      res,
      {
        changed: true,
        user: {
          id: currentUser.data?.id || null,
          email,
        },
      },
      "Password changed successfully."
    );
  } catch (error) {
    logger.error("Unexpected change-password error.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    return fromCaughtError(
      res,
      error,
      "Unable to change password right now."
    );
  }
}