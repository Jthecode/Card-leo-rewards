// lib/rate-limit.js

const store = globalThis.__CARDLEO_RATE_LIMIT_STORE__ || new Map();
globalThis.__CARDLEO_RATE_LIMIT_STORE__ = store;

function now() {
  return Date.now();
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getIpFromRequest(req) {
  const forwardedFor =
    req?.headers?.["x-forwarded-for"] ||
    req?.headers?.["X-Forwarded-For"] ||
    req?.headers?.["cf-connecting-ip"] ||
    req?.headers?.["x-real-ip"] ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    "";

  if (Array.isArray(forwardedFor)) {
    return clean(forwardedFor[0] || "unknown");
  }

  if (typeof forwardedFor === "string" && forwardedFor.includes(",")) {
    return clean(forwardedFor.split(",")[0] || "unknown");
  }

  return clean(forwardedFor) || "unknown";
}

function getRouteFromRequest(req) {
  return (
    clean(req?.url) ||
    clean(req?.originalUrl) ||
    clean(req?.pathname) ||
    "unknown-route"
  );
}

function getMethodFromRequest(req) {
  return clean(req?.method).toUpperCase() || "GET";
}

function buildKey(req, options = {}) {
  const {
    key,
    prefix = "global",
    includeMethod = false,
    includeRoute = false,
    userId,
    email,
  } = options;

  if (key) return `${prefix}:${clean(key)}`;

  const parts = [prefix];

  if (userId) parts.push(`user:${clean(userId)}`);
  if (email) parts.push(`email:${clean(email).toLowerCase()}`);
  if (!userId && !email) parts.push(`ip:${getIpFromRequest(req)}`);

  if (includeMethod) parts.push(`method:${getMethodFromRequest(req)}`);
  if (includeRoute) parts.push(`route:${getRouteFromRequest(req)}`);

  return parts.join(":");
}

function getRecord(key, windowMs) {
  const timestamp = now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= timestamp) {
    const fresh = {
      count: 0,
      resetAt: timestamp + windowMs,
    };
    store.set(key, fresh);
    return fresh;
  }

  return existing;
}

function cleanupExpiredEntries(limit = 200) {
  const timestamp = now();
  let checked = 0;

  for (const [key, value] of store.entries()) {
    if (checked >= limit) break;
    checked += 1;

    if (!value || value.resetAt <= timestamp) {
      store.delete(key);
    }
  }
}

export function getRetryAfterSeconds(resetAt) {
  const diffMs = Math.max(0, toNumber(resetAt, now()) - now());
  return Math.max(1, Math.ceil(diffMs / 1000));
}

export function setRateLimitHeaders(res, result) {
  if (!res || typeof res.setHeader !== "function" || res.headersSent) return;

  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfter));
  }
}

export function rateLimit(req, options = {}) {
  cleanupExpiredEntries();

  const limit = Math.max(1, toNumber(options.limit, 10));
  const windowMs = Math.max(1000, toNumber(options.windowMs, 60_000));

  const key = buildKey(req, options);
  const record = getRecord(key, windowMs);

  record.count += 1;
  store.set(key, record);

  const allowed = record.count <= limit;
  const remaining = Math.max(0, limit - record.count);
  const retryAfter = getRetryAfterSeconds(record.resetAt);

  return {
    key,
    allowed,
    limit,
    remaining,
    count: record.count,
    resetAt: record.resetAt,
    retryAfter,
    windowMs,
  };
}

export function applyRateLimit(req, res, options = {}) {
  const result = rateLimit(req, options);
  setRateLimitHeaders(res, result);
  return result;
}

export function isRateLimited(req, options = {}) {
  const result = rateLimit(req, options);
  return !result.allowed;
}

export function clearRateLimit(keyOrReq, options = {}) {
  const key =
    typeof keyOrReq === "string"
      ? keyOrReq
      : buildKey(keyOrReq, options);

  return store.delete(key);
}

export function getRateLimitKey(req, options = {}) {
  return buildKey(req, options);
}

export function getStoreSize() {
  return store.size;
}

export function resetAllRateLimits() {
  store.clear();
}

export function loginRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "login",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function forgotPasswordRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "forgot-password",
    limit: 3,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function resetPasswordRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "reset-password",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function contactRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "contact",
    limit: 5,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function supportRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "support",
    limit: 5,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function portalSettingsRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "portal-settings",
    limit: 20,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function signupRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "signup",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function verifyEmailRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "verify-email",
    limit: 10,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function resendVerificationRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "resend-verification",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function changePasswordRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "change-password",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function portalProfileRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "portal-profile",
    limit: 20,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function portalRewardsRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "portal-rewards",
    limit: 30,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function portalReferralsRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "portal-referrals",
    limit: 20,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function adminRateLimit(req, res) {
  return applyRateLimit(req, res, {
    prefix: "admin",
    limit: 60,
    windowMs: 10 * 60 * 1000,
    includeRoute: true,
    includeMethod: true,
  });
}

export function verifyRateLimitOrThrow(req, res, options = {}) {
  const result = applyRateLimit(req, res, options);

  if (!result.allowed) {
    const error = new Error("Too many requests. Please try again later.");
    error.code = "RATE_LIMITED";
    error.statusCode = 429;
    error.rateLimit = result;
    throw error;
  }

  return result;
}

export default {
  rateLimit,
  applyRateLimit,
  isRateLimited,
  clearRateLimit,
  getRateLimitKey,
  getRetryAfterSeconds,
  setRateLimitHeaders,
  getStoreSize,
  resetAllRateLimits,
  loginRateLimit,
  forgotPasswordRateLimit,
  resetPasswordRateLimit,
  contactRateLimit,
  supportRateLimit,
  portalSettingsRateLimit,
  signupRateLimit,
  verifyEmailRateLimit,
  resendVerificationRateLimit,
  changePasswordRateLimit,
  portalProfileRateLimit,
  portalRewardsRateLimit,
  portalReferralsRateLimit,
  adminRateLimit,
  verifyRateLimitOrThrow,
};