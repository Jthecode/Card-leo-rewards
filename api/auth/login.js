// api/auth/login.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
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

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
]);

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

function normalizeStatus(value) {
  return normalizeString(value).toLowerCase();
}

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function safeCompareHash(inputHash, storedHash) {
  const left = Buffer.from(String(inputHash || ""), "hex");
  const right = Buffer.from(String(storedHash || ""), "hex");

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function getDisplayName(member) {
  const fullName = normalizeString(member?.full_name);

  if (fullName) return fullName;

  return [member?.first_name, member?.last_name]
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");
}

function sanitizeMember(member) {
  if (!member) return null;

  return {
    id: member.id || null,
    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member) || "Card Leo Member",
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    status: member.status || "",
    portalUserId: member.portal_user_id || null,
    portalLoginUrl: member.portal_login_url || DEFAULT_REDIRECT,
    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,
    role: "member",
  };
}

function buildCustomSessionCookieValue(member, remember = false) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
  const expiresAt = now + maxAge;

  const safeMember = sanitizeMember(member);

  return JSON.stringify({
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember: Boolean(remember),
    created_at: now,
    expires_at: expiresAt,
    member: safeMember,
    user: {
      id: safeMember.id,
      email: safeMember.email,
      role: "member",
      user_metadata: {
        full_name: safeMember.fullName,
        first_name: safeMember.firstName,
        last_name: safeMember.lastName,
        status: safeMember.status,
      },
      app_metadata: {
        provider: "cardleo-signups",
        role: "member",
      },
    },
    profile: {
      id: safeMember.id,
      email: safeMember.email,
      full_name: safeMember.fullName,
      first_name: safeMember.firstName,
      last_name: safeMember.lastName,
      role: "member",
      status: safeMember.status,
    },
    session: {
      access_token: null,
      refresh_token: null,
      expires_at: expiresAt,
      expires_in: maxAge,
      token_type: "custom",
    },
  });
}

async function touchLastLogin(memberId) {
  try {
    await supabaseAdmin
      .from("signups")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", memberId);
  } catch {
    // Do not block login if this update fails.
  }
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_login" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = loginRateLimit(req, res);

    if (!rateLimit?.allowed) {
      clearAuthCookies(res);

      return badRequest(
        res,
        "Too many login attempts. Please try again later.",
        { retryAfter: rateLimit?.retryAfter ?? null },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);
    const validation = validateLoginInput(body);

    if (!validation?.valid) {
      clearAuthCookies(res);

      return badRequest(
        res,
        "Email and password are required.",
        validation?.errors || {}
      );
    }

    const safeEmail = normalizeEmail(validation.values.email);
    const password = String(validation.values.password || "");
    const remember = Boolean(body.remember);

    const { data: member, error: lookupError } = await supabaseAdmin
      .from("signups")
      .select(
        [
          "id",
          "first_name",
          "last_name",
          "full_name",
          "email",
          "phone",
          "city",
          "state",
          "interest",
          "agreed",
          "status",
          "password_hash",
          "portal_user_id",
          "portal_login_url",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq("email", safeEmail)
      .maybeSingle();

    if (lookupError) {
      clearAuthCookies(res);

      logRequestError(req, lookupError, {
        scope: "auth_login_lookup",
        email: safeEmail,
      });

      return serverError(res, "Unable to check your account right now.");
    }

    if (!member?.id) {
      clearAuthCookies(res);

      logAuthEvent("Login failed.", {
        email: safeEmail,
        reason: "account_not_found",
      });

      return unauthorized(res, "Invalid email or password.");
    }

    if (!member.password_hash) {
      clearAuthCookies(res);

      logAuthEvent("Login blocked because password is missing.", {
        email: safeEmail,
        memberId: member.id,
      });

      return forbidden(
        res,
        "This account does not have a password yet. Please create a new signup or reset the account password."
      );
    }

    const inputHash = hashPassword(password);
    const passwordMatches = safeCompareHash(inputHash, member.password_hash);

    if (!passwordMatches) {
      clearAuthCookies(res);

      logAuthEvent("Login failed.", {
        email: safeEmail,
        memberId: member.id,
        reason: "invalid_password",
      });

      return unauthorized(res, "Invalid email or password.");
    }

    const status = normalizeStatus(member.status || "pending");

    if (!ACTIVE_STATUSES.has(status)) {
      clearAuthCookies(res);

      logAuthEvent("Login blocked for inactive account.", {
        email: safeEmail,
        memberId: member.id,
        status,
      });

      if (status === "pending" || status === "reviewing") {
        return forbidden(
          res,
          "Your account is pending approval. Please wait for activation before logging in."
        );
      }

      if (status === "disabled") {
        return forbidden(
          res,
          "This account has been disabled. Please contact support."
        );
      }

      if (status === "denied") {
        return forbidden(
          res,
          "This account was not approved. Please contact support for more information."
        );
      }

      return forbidden(
        res,
        "Your account is not active yet. Please contact support."
      );
    }

    const sessionCookieValue = buildCustomSessionCookieValue(member, remember);

    setSessionCookie(res, sessionCookieValue, {
      httpOnly: true,
      maxAge: remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24,
    });

    await touchLastLogin(member.id);

    const safeMember = sanitizeMember(member);

    logAuthEvent("Login successful.", {
      email: safeEmail,
      memberId: member.id,
      ip: getClientIp(req),
    });

    logRequestSuccess(req, {
      scope: "auth_login",
      memberId: member.id,
      email: safeEmail,
    });

    return ok(
      res,
      {
        member: safeMember,
        user: {
          id: safeMember.id,
          email: safeMember.email,
          role: "member",
          user_metadata: {
            full_name: safeMember.fullName,
            first_name: safeMember.firstName,
            last_name: safeMember.lastName,
            status: safeMember.status,
          },
          app_metadata: {
            provider: "cardleo-signups",
            role: "member",
          },
        },
        session: {
          provider: "cardleo-signups",
          token_type: "custom",
          remember,
        },
      },
      "Login successful.",
      {
        redirectTo:
          normalizeString(member.portal_login_url) &&
          normalizeString(member.portal_login_url) !== "/login.html"
            ? normalizeString(member.portal_login_url)
            : DEFAULT_REDIRECT,
      }
    );
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, {
      scope: "auth_login_unexpected",
    });

    return serverError(
      res,
      error?.message || "Something went wrong while trying to sign you in."
    );
  }
}