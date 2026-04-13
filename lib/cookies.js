// lib/cookies.js
import { getServerEnv, getSessionConfig } from "./env.js";

const DEFAULT_ACCESS_COOKIE_NAMES = [
  "cardleo-access-token",
  "cardleo_access_token",
  "clr-access-token",
  "clr_access_token",
  "access_token",
  "sb-access-token",
  "sb_access_token",
];

const DEFAULT_REFRESH_COOKIE_NAMES = [
  "cardleo-refresh-token",
  "cardleo_refresh_token",
  "clr-refresh-token",
  "clr_refresh_token",
  "refresh_token",
  "sb-refresh-token",
  "sb_refresh_token",
];

const DEFAULT_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function normalizeText(value) {
  return String(value || "").trim();
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return fallback;
}

function getRuntimeEnv() {
  try {
    return getServerEnv();
  } catch {
    return {};
  }
}

function getCookiePrefix() {
  const env = getRuntimeEnv();
  const prefix = normalizeText(env.COOKIE_PREFIX || "cardleo");
  return prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "cardleo";
}

function getCookieDomain() {
  const env = getRuntimeEnv();
  return normalizeText(env.COOKIE_DOMAIN || "");
}

function getCookiePath() {
  const env = getRuntimeEnv();
  return normalizeText(env.COOKIE_PATH || "/") || "/";
}

function getCookieSameSite() {
  const env = getRuntimeEnv();
  const value = normalizeText(env.COOKIE_SAME_SITE || "Lax").toLowerCase();

  if (["lax", "strict", "none"].includes(value)) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  return "Lax";
}

function getCookieSecure() {
  const env = getRuntimeEnv();
  const sessionConfig = getSessionConfig();

  if (parseBooleanEnv(env.COOKIE_SECURE, false)) {
    return true;
  }

  return Boolean(sessionConfig.secure);
}

function getCookieHttpOnly() {
  const env = getRuntimeEnv();
  return parseBooleanEnv(env.COOKIE_HTTP_ONLY, true);
}

function getCookieMaxAgeSeconds(type = "access") {
  const env = getRuntimeEnv();
  const sessionConfig = getSessionConfig();

  const raw =
    type === "refresh"
      ? env.REFRESH_COOKIE_MAX_AGE
      : type === "session"
      ? env.SESSION_COOKIE_MAX_AGE
      : env.ACCESS_COOKIE_MAX_AGE;

  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }

  if (type === "refresh") return 60 * 60 * 24 * 30;
  if (type === "session") return Math.floor((sessionConfig.ttlHours || 168) * 60 * 60);
  return 60 * 60 * 24;
}

function encodeCookieValue(value) {
  return encodeURIComponent(String(value ?? ""));
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
}

function parseCookies(cookieHeader = "") {
  const header = String(cookieHeader || "");
  const cookies = {};

  if (!header) return cookies;

  header.split(";").forEach((part) => {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = normalizeText(rawKey);

    if (!key) return;

    const value = rawValueParts.join("=");
    cookies[key] = decodeCookieValue(value);
  });

  return cookies;
}

function getRequestCookies(req) {
  return parseCookies(req?.headers?.cookie || "");
}

function getCookie(req, name, fallback = "") {
  const cookies = getRequestCookies(req);
  return cookies[name] ?? fallback;
}

function pickFirstCookie(req, names = []) {
  const cookies = getRequestCookies(req);

  for (const name of names) {
    const key = normalizeText(name);
    if (key && typeof cookies[key] === "string" && cookies[key].trim()) {
      return cookies[key];
    }
  }

  return "";
}

function getAccessTokenFromRequest(req, names = DEFAULT_ACCESS_COOKIE_NAMES) {
  const authHeader = normalizeText(req?.headers?.authorization || "");

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return pickFirstCookie(req, names);
}

function getRefreshTokenFromRequest(req, names = DEFAULT_REFRESH_COOKIE_NAMES) {
  return pickFirstCookie(req, names);
}

function getSessionCookieFromRequest(req, names = DEFAULT_SESSION_COOKIE_NAMES) {
  const configuredName = getSessionCookieName();
  return pickFirstCookie(req, [configuredName, ...names]);
}

function serializeCookie(name, value, options = {}) {
  const key = normalizeText(name);

  if (!key) {
    throw new Error("Cookie name is required.");
  }

  const parts = [`${key}=${encodeCookieValue(value)}`];

  const path = normalizeText(options.path || getCookiePath());
  if (path) parts.push(`Path=${path}`);

  const domain = normalizeText(options.domain || getCookieDomain());
  if (domain) parts.push(`Domain=${domain}`);

  const maxAge =
    Number.isFinite(Number(options.maxAge)) && Number(options.maxAge) >= 0
      ? Math.floor(Number(options.maxAge))
      : null;

  if (maxAge !== null) {
    parts.push(`Max-Age=${maxAge}`);
  }

  if (options.expires instanceof Date && !Number.isNaN(options.expires.getTime())) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  const sameSiteRaw = normalizeText(options.sameSite || getCookieSameSite());
  if (sameSiteRaw) {
    const sameSite =
      sameSiteRaw.charAt(0).toUpperCase() + sameSiteRaw.slice(1).toLowerCase();
    parts.push(`SameSite=${sameSite}`);
  }

  const secure =
    typeof options.secure === "boolean" ? options.secure : getCookieSecure();
  if (secure) parts.push("Secure");

  const httpOnly =
    typeof options.httpOnly === "boolean" ? options.httpOnly : getCookieHttpOnly();
  if (httpOnly) parts.push("HttpOnly");

  return parts.join("; ");
}

function appendSetCookieHeader(res, cookieString) {
  if (!res || typeof res.setHeader !== "function" || !cookieString) return;

  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;

  if (!existing) {
    res.setHeader("Set-Cookie", [cookieString]);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieString]);
    return;
  }

  res.setHeader("Set-Cookie", [existing, cookieString]);
}

function setCookie(res, name, value, options = {}) {
  const cookieString = serializeCookie(name, value, {
    path: getCookiePath(),
    domain: getCookieDomain(),
    sameSite: getCookieSameSite(),
    secure: getCookieSecure(),
    httpOnly: getCookieHttpOnly(),
    ...options,
  });

  appendSetCookieHeader(res, cookieString);
  return cookieString;
}

function clearCookie(res, name, options = {}) {
  const cookieString = serializeCookie(name, "", {
    path: getCookiePath(),
    domain: getCookieDomain(),
    sameSite: getCookieSameSite(),
    secure: getCookieSecure(),
    httpOnly: getCookieHttpOnly(),
    maxAge: 0,
    expires: new Date(0),
    ...options,
  });

  appendSetCookieHeader(res, cookieString);
  return cookieString;
}

function getAccessCookieName() {
  const env = getRuntimeEnv();
  return normalizeText(env.ACCESS_COOKIE_NAME || `${getCookiePrefix()}-access-token`);
}

function getRefreshCookieName() {
  const env = getRuntimeEnv();
  return normalizeText(env.REFRESH_COOKIE_NAME || `${getCookiePrefix()}-refresh-token`);
}

function getSessionCookieName() {
  const env = getRuntimeEnv();
  const sessionConfig = getSessionConfig();

  return normalizeText(
    env.SESSION_COOKIE_NAME ||
      sessionConfig.cookieName ||
      `${getCookiePrefix()}_session`
  );
}

function setAccessTokenCookie(res, token, options = {}) {
  return setCookie(res, getAccessCookieName(), token, {
    maxAge: getCookieMaxAgeSeconds("access"),
    ...options,
  });
}

function setRefreshTokenCookie(res, token, options = {}) {
  return setCookie(res, getRefreshCookieName(), token, {
    maxAge: getCookieMaxAgeSeconds("refresh"),
    ...options,
  });
}

function setSessionCookie(res, sessionValue, options = {}) {
  return setCookie(res, getSessionCookieName(), sessionValue, {
    maxAge: getCookieMaxAgeSeconds("session"),
    ...options,
  });
}

function clearAccessTokenCookie(res, options = {}) {
  return clearCookie(res, getAccessCookieName(), options);
}

function clearRefreshTokenCookie(res, options = {}) {
  return clearCookie(res, getRefreshCookieName(), options);
}

function clearSessionCookie(res, options = {}) {
  return clearCookie(res, getSessionCookieName(), options);
}

function clearAuthCookies(res, options = {}) {
  return [
    clearAccessTokenCookie(res, options),
    clearRefreshTokenCookie(res, options),
    clearSessionCookie(res, options),
  ];
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function readJsonCookie(req, name, fallback = null) {
  const raw = getCookie(req, name, "");
  if (!raw) return fallback;
  return safeJsonParse(raw, fallback);
}

function getAuthCookieConfig() {
  return {
    prefix: getCookiePrefix(),
    accessCookieName: getAccessCookieName(),
    refreshCookieName: getRefreshCookieName(),
    sessionCookieName: getSessionCookieName(),
    domain: getCookieDomain(),
    path: getCookiePath(),
    sameSite: getCookieSameSite(),
    secure: getCookieSecure(),
    httpOnly: getCookieHttpOnly(),
    accessMaxAge: getCookieMaxAgeSeconds("access"),
    refreshMaxAge: getCookieMaxAgeSeconds("refresh"),
    sessionMaxAge: getCookieMaxAgeSeconds("session"),
  };
}

export {
  DEFAULT_ACCESS_COOKIE_NAMES,
  DEFAULT_REFRESH_COOKIE_NAMES,
  DEFAULT_SESSION_COOKIE_NAMES,
  parseCookies,
  getRequestCookies,
  getCookie,
  pickFirstCookie,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  getSessionCookieFromRequest,
  serializeCookie,
  setCookie,
  clearCookie,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setSessionCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
  clearSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  readJsonCookie,
  getAuthCookieConfig,
  getAccessCookieName,
  getRefreshCookieName,
  getSessionCookieName,
};

export default {
  DEFAULT_ACCESS_COOKIE_NAMES,
  DEFAULT_REFRESH_COOKIE_NAMES,
  DEFAULT_SESSION_COOKIE_NAMES,
  parseCookies,
  getRequestCookies,
  getCookie,
  pickFirstCookie,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  getSessionCookieFromRequest,
  serializeCookie,
  setCookie,
  clearCookie,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setSessionCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
  clearSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  readJsonCookie,
  getAuthCookieConfig,
  getAccessCookieName,
  getRefreshCookieName,
  getSessionCookieName,
};