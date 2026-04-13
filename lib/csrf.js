// lib/csrf.js
import crypto from "crypto";
import { getCookie, setCookie, clearCookie } from "./cookies.js";
import { getServerEnv } from "./env.js";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
const DEFAULT_HEADER_NAMES = ["x-csrf-token", "x-xsrf-token"];
const DEFAULT_BODY_FIELD_NAMES = ["csrfToken", "_csrf", "xsrfToken"];

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeMethod(value) {
  return normalizeText(value).toUpperCase();
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toPositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function getRuntimeEnv() {
  try {
    return getServerEnv();
  } catch {
    return {};
  }
}

function getCsrfCookieName() {
  const env = getRuntimeEnv();
  return normalizeText(env.CSRF_COOKIE_NAME || "cardleo-csrf-token");
}

function getCsrfHeaderNames() {
  const env = getRuntimeEnv();
  const envValue = normalizeText(env.CSRF_HEADER_NAMES || "");

  if (!envValue) return [...DEFAULT_HEADER_NAMES];

  const names = envValue
    .split(",")
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);

  return names.length ? names : [...DEFAULT_HEADER_NAMES];
}

function getCsrfBodyFieldNames() {
  const env = getRuntimeEnv();
  const envValue = normalizeText(env.CSRF_BODY_FIELD_NAMES || "");

  if (!envValue) return [...DEFAULT_BODY_FIELD_NAMES];

  const names = envValue
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);

  return names.length ? names : [...DEFAULT_BODY_FIELD_NAMES];
}

function getCsrfCookieMaxAgeSeconds() {
  const env = getRuntimeEnv();
  return toPositiveInteger(env.CSRF_COOKIE_MAX_AGE, 60 * 60 * 8);
}

function getCsrfTokenLengthBytes() {
  const env = getRuntimeEnv();
  return toPositiveInteger(env.CSRF_TOKEN_BYTES, 32);
}

function getCsrfCookieSameSite() {
  const env = getRuntimeEnv();
  const raw = normalizeText(env.CSRF_COOKIE_SAME_SITE || "Lax").toLowerCase();

  if (["lax", "strict", "none"].includes(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  return "Lax";
}

function shouldUseSecureCookie() {
  const env = getRuntimeEnv();

  if (parseBooleanEnv(env.CSRF_COOKIE_SECURE, false)) return true;
  if (parseBooleanEnv(env.SESSION_SECURE, false)) return true;

  return env.nodeEnv === "production" || process.env.NODE_ENV === "production";
}

function shouldUseHttpOnlyCookie() {
  const env = getRuntimeEnv();
  return parseBooleanEnv(env.CSRF_COOKIE_HTTP_ONLY, false);
}

function isSafeMethod(method) {
  return SAFE_METHODS.includes(normalizeMethod(method));
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

function randomToken(bytes = getCsrfTokenLengthBytes()) {
  return crypto.randomBytes(bytes).toString("hex");
}

function generateCsrfToken() {
  return randomToken();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length === 0 || right.length === 0) return false;
  if (left.length !== right.length) return false;

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function getHeaderToken(req, headerNames = getCsrfHeaderNames()) {
  const headers = req?.headers || {};

  for (const headerName of headerNames) {
    const direct = headers[headerName];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }

    const alt = headers[headerName.toLowerCase()];
    if (typeof alt === "string" && alt.trim()) {
      return alt.trim();
    }
  }

  return "";
}

function getBodyToken(req, bodyFieldNames = getCsrfBodyFieldNames()) {
  const body = getRequestBody(req);

  for (const fieldName of bodyFieldNames) {
    const value = body?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function getQueryToken(req, bodyFieldNames = getCsrfBodyFieldNames()) {
  const query = req?.query || {};

  for (const fieldName of bodyFieldNames) {
    const value = query?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function getCsrfTokenFromRequest(
  req,
  {
    headerNames = getCsrfHeaderNames(),
    bodyFieldNames = getCsrfBodyFieldNames(),
  } = {}
) {
  return (
    getHeaderToken(req, headerNames) ||
    getBodyToken(req, bodyFieldNames) ||
    getQueryToken(req, bodyFieldNames) ||
    ""
  );
}

function getCsrfCookieFromRequest(req, cookieName = getCsrfCookieName()) {
  return getCookie(req, cookieName, "");
}

function setCsrfCookie(
  res,
  token,
  {
    cookieName = getCsrfCookieName(),
    maxAge = getCsrfCookieMaxAgeSeconds(),
    sameSite = getCsrfCookieSameSite(),
    secure = shouldUseSecureCookie(),
    httpOnly = shouldUseHttpOnlyCookie(),
    path = "/",
  } = {}
) {
  return setCookie(res, cookieName, token, {
    maxAge,
    sameSite,
    secure,
    httpOnly,
    path,
  });
}

function clearCsrfCookie(
  res,
  {
    cookieName = getCsrfCookieName(),
    sameSite = getCsrfCookieSameSite(),
    secure = shouldUseSecureCookie(),
    httpOnly = shouldUseHttpOnlyCookie(),
    path = "/",
  } = {}
) {
  return clearCookie(res, cookieName, {
    sameSite,
    secure,
    httpOnly,
    path,
  });
}

function issueCsrfToken(
  res,
  {
    token = generateCsrfToken(),
    cookieName = getCsrfCookieName(),
    maxAge = getCsrfCookieMaxAgeSeconds(),
    sameSite = getCsrfCookieSameSite(),
    secure = shouldUseSecureCookie(),
    httpOnly = shouldUseHttpOnlyCookie(),
    path = "/",
  } = {}
) {
  setCsrfCookie(res, token, {
    cookieName,
    maxAge,
    sameSite,
    secure,
    httpOnly,
    path,
  });

  return token;
}

function ensureCsrfToken(
  req,
  res,
  {
    cookieName = getCsrfCookieName(),
    maxAge = getCsrfCookieMaxAgeSeconds(),
    sameSite = getCsrfCookieSameSite(),
    secure = shouldUseSecureCookie(),
    httpOnly = shouldUseHttpOnlyCookie(),
    path = "/",
  } = {}
) {
  const existing = getCsrfCookieFromRequest(req, cookieName);
  if (existing) return existing;

  return issueCsrfToken(res, {
    cookieName,
    maxAge,
    sameSite,
    secure,
    httpOnly,
    path,
  });
}

function verifyCsrf(
  req,
  {
    cookieName = getCsrfCookieName(),
    headerNames = getCsrfHeaderNames(),
    bodyFieldNames = getCsrfBodyFieldNames(),
    skipSafeMethods = true,
  } = {}
) {
  const method = normalizeMethod(req?.method || "GET");

  if (skipSafeMethods && isSafeMethod(method)) {
    return {
      ok: true,
      reason: "safe_method",
      method,
      token: "",
      cookieToken: "",
    };
  }

  const token = getCsrfTokenFromRequest(req, { headerNames, bodyFieldNames });
  const cookieToken = getCsrfCookieFromRequest(req, cookieName);

  if (!cookieToken) {
    return {
      ok: false,
      reason: "missing_cookie_token",
      method,
      token,
      cookieToken: "",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "missing_request_token",
      method,
      token: "",
      cookieToken,
    };
  }

  if (!safeEqual(token, cookieToken)) {
    return {
      ok: false,
      reason: "token_mismatch",
      method,
      token,
      cookieToken,
    };
  }

  return {
    ok: true,
    reason: "verified",
    method,
    token,
    cookieToken,
  };
}

function assertCsrf(req, options = {}) {
  const result = verifyCsrf(req, options);

  if (!result.ok) {
    const error = new Error(
      result.reason === "missing_cookie_token"
        ? "Missing CSRF cookie token."
        : result.reason === "missing_request_token"
          ? "Missing CSRF request token."
          : result.reason === "token_mismatch"
            ? "Invalid CSRF token."
            : "CSRF verification failed."
    );

    error.code = "CSRF_VALIDATION_FAILED";
    error.status = 403;
    error.details = result;

    throw error;
  }

  return result;
}

function shouldEnforceCsrf(req, { skipSafeMethods = true } = {}) {
  if (!req) return false;
  if (!skipSafeMethods) return true;
  return !isSafeMethod(req.method);
}

function csrfFailureResponse(
  res,
  {
    message = "Invalid or missing CSRF token.",
    statusCode = 403,
    reason = "csrf_validation_failed",
    details = null,
  } = {}
) {
  if (!res || typeof res.status !== "function" || typeof res.json !== "function") {
    return null;
  }

  return res.status(statusCode).json({
    success: false,
    message,
    error: reason,
    details,
  });
}

function withCsrf(handler, options = {}) {
  if (typeof handler !== "function") {
    throw new Error("withCsrf requires a handler function.");
  }

  return async function csrfWrappedHandler(req, res) {
    try {
      if (shouldEnforceCsrf(req, options)) {
        assertCsrf(req, options);
      }

      return await handler(req, res);
    } catch (error) {
      if (error?.code === "CSRF_VALIDATION_FAILED") {
        return csrfFailureResponse(res, {
          message: error.message,
          reason: error.code,
          details: error.details || null,
        });
      }

      throw error;
    }
  };
}

function getCsrfConfig() {
  return {
    cookieName: getCsrfCookieName(),
    headerNames: getCsrfHeaderNames(),
    bodyFieldNames: getCsrfBodyFieldNames(),
    cookieMaxAge: getCsrfCookieMaxAgeSeconds(),
    cookieSameSite: getCsrfCookieSameSite(),
    cookieSecure: shouldUseSecureCookie(),
    cookieHttpOnly: shouldUseHttpOnlyCookie(),
    safeMethods: [...SAFE_METHODS],
  };
}

export {
  SAFE_METHODS,
  DEFAULT_HEADER_NAMES,
  DEFAULT_BODY_FIELD_NAMES,
  getCsrfCookieName,
  getCsrfHeaderNames,
  getCsrfBodyFieldNames,
  getCsrfConfig,
  isSafeMethod,
  generateCsrfToken,
  getCsrfTokenFromRequest,
  getCsrfCookieFromRequest,
  setCsrfCookie,
  clearCsrfCookie,
  issueCsrfToken,
  ensureCsrfToken,
  verifyCsrf,
  assertCsrf,
  shouldEnforceCsrf,
  csrfFailureResponse,
  withCsrf,
};

export default {
  SAFE_METHODS,
  DEFAULT_HEADER_NAMES,
  DEFAULT_BODY_FIELD_NAMES,
  getCsrfCookieName,
  getCsrfHeaderNames,
  getCsrfBodyFieldNames,
  getCsrfConfig,
  isSafeMethod,
  generateCsrfToken,
  getCsrfTokenFromRequest,
  getCsrfCookieFromRequest,
  setCsrfCookie,
  clearCsrfCookie,
  issueCsrfToken,
  ensureCsrfToken,
  verifyCsrf,
  assertCsrf,
  shouldEnforceCsrf,
  csrfFailureResponse,
  withCsrf,
};