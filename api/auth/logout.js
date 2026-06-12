// api/auth/logout.js
import { ok, methodNotAllowed, setNoStore } from "../../lib/responses.js";
import {
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

const REDIRECT_PATH = "/login.html";

const POSSIBLE_AUTH_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
  "access_token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
];

function normalizeString(value) {
  return String(value ?? "").trim();
}

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
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

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_AUTH_COOKIE_NAMES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const decoded = decodeCookieValue(cookies[name]);
    const parsed = safeJsonParse(decoded, null);

    if (parsed && typeof parsed === "object") {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getSessionSummary(sessionCookie) {
  const value = sessionCookie?.value || {};

  return {
    cookieName: sessionCookie?.name || null,
    memberId:
      value.member?.id ||
      value.profile?.id ||
      value.user?.id ||
      value.id ||
      null,
    email:
      value.member?.email ||
      value.profile?.email ||
      value.user?.email ||
      value.email ||
      null,
    provider: value.provider || null,
    authenticated: value.authenticated === true,
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

function buildExpiredCookie(name, { httpOnly = true } = {}) {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax",
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
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_AUTH_COOKIE_NAMES]
        .map(normalizeString)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: true }));

    // Also clear a non-HttpOnly copy in case older frontend code created one.
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: false }));
  }
}

function clearEveryAuthCookie(res) {
  clearAuthCookies(res);
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
        signedOut: true,
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
        signedOut: true,
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