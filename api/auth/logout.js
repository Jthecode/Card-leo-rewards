// api/auth/logout.js
import { ok, methodNotAllowed, setNoStore } from "../../lib/responses.js";
import {
  clearAuthCookies,
  getSessionCookieName,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
  logAuthEvent,
} from "../../lib/logger.js";

const REDIRECT_PATH = "/login.html";

const POSSIBLE_AUTH_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_session_token",
  "cardleo_auth",
  "cardleo_member",
  "cardleo_member_id",
  "cardleo_portal_session",

  "card_leo_session",
  "member_session",
  "portal_session",

  "session",
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",

  "access_token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
];

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function getClientIp(req) {
  const forwardedFor =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (name) {
        cookies[name] = value;
      }

      return cookies;
    }, {});
}

function decodeCookieValue(value) {
  const raw = String(value || "");

  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeBase64JsonParse(value) {
  const raw = String(value || "");

  if (!raw) return null;

  const attempts = [raw, raw.replace(/-/g, "+").replace(/_/g, "/")];

  for (const attempt of attempts) {
    try {
      const padded = attempt.padEnd(Math.ceil(attempt.length / 4) * 4, "=");
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);

      if (isObject(parsed)) return parsed;
    } catch {
      // Try next decode style.
    }
  }

  return null;
}

function parseSessionValue(rawValue) {
  const decoded = decodeCookieValue(rawValue);

  if (!decoded) return null;

  const parsedJson = safeJsonParse(decoded);
  if (isObject(parsedJson)) return parsedJson;

  const parsedBase64 = safeBase64JsonParse(decoded);
  if (isObject(parsedBase64)) return parsedBase64;

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);

  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_AUTH_COOKIE_NAMES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseSessionValue(cookies[name]);

    if (isObject(parsed)) {
      return {
        name,
        raw: cookies[name],
        value: parsed,
      };
    }
  }

  return null;
}

function getSessionSummary(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const userMetadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return {
    cookieName: sessionCookie?.name || null,
    memberId:
      value.member_id ||
      value.memberId ||
      value.signup_id ||
      value.signupId ||
      member.id ||
      member.signupId ||
      member.signup_id ||
      profile.id ||
      profile.signupId ||
      profile.signup_id ||
      userMetadata.member_id ||
      userMetadata.signup_id ||
      user.id ||
      null,
    email: normalizeEmail(
      value.email ||
        member.email ||
        profile.email ||
        user.email ||
        userMetadata.email ||
        ""
    ),
    provider: value.provider || null,
    authenticated: value.authenticated === true,
    token: value.token || value.session_token || value.auth_token || null,
  };
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader("Set-Cookie");

  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [existing, cookieValue]);
}

function buildExpiredCookie(name, { httpOnly = true, sameSite = "Lax" } = {}) {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    `SameSite=${sameSite}`,
  ];

  if (httpOnly) {
    parts.push("HttpOnly");
  }

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearCookieAliases(res) {
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_AUTH_COOKIE_NAMES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    // Clear HttpOnly version.
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: true }));

    // Clear possible frontend-created non-HttpOnly version.
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: false }));

    // Clear possible older Strict cookie version.
    appendSetCookie(
      res,
      buildExpiredCookie(name, {
        httpOnly: true,
        sameSite: "Strict",
      })
    );

    appendSetCookie(
      res,
      buildExpiredCookie(name, {
        httpOnly: false,
        sameSite: "Strict",
      })
    );
  }
}

function clearEveryAuthCookie(res) {
  try {
    clearAuthCookies(res);
  } catch {
    // Continue clearing aliases below.
  }

  clearCookieAliases(res);
}

export default async function handler(req, res) {
  setNoStore?.(res);

  logRequestStart(req, { scope: "auth_logout" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  const sessionCookie = readSessionCookie(req);
  const sessionSummary = getSessionSummary(sessionCookie);

  try {
    clearEveryAuthCookie(res);

    logAuthEvent("Logout successful.", {
      hadSession: Boolean(sessionCookie?.value),
      ...sessionSummary,
      ip: getClientIp(req),
    });

    logRequestSuccess(req, {
      scope: "auth_logout",
      memberId: sessionSummary.memberId,
      email: sessionSummary.email,
    });

    return ok(
      res,
      {
        success: true,
        ok: true,
        signedOut: true,
        authenticated: false,
        redirectTo: REDIRECT_PATH,
      },
      "You have been signed out successfully.",
      {
        redirectTo: REDIRECT_PATH,
      }
    );
  } catch (error) {
    clearEveryAuthCookie(res);

    logRequestError(req, error, {
      scope: "auth_logout_unexpected",
      memberId: sessionSummary.memberId,
      email: sessionSummary.email,
    });

    return ok(
      res,
      {
        success: true,
        ok: true,
        signedOut: true,
        authenticated: false,
        redirectTo: REDIRECT_PATH,
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