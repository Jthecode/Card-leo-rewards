// lib/logger.js

const APP_NAMESPACE = "cardleo";

const LOG_LEVELS = Object.freeze({
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
});

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function getEnvironment() {
  try {
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV) {
      return process.env.NODE_ENV;
    }
  } catch {}

  try {
    if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.MODE) {
      return import.meta.env.MODE;
    }
  } catch {}

  return "development";
}

function shouldLogDebug() {
  const env = getEnvironment();
  return env !== "production";
}

function getRequestId(req) {
  return (
    clean(req?.headers?.["x-request-id"]) ||
    clean(req?.headers?.["X-Request-Id"]) ||
    clean(req?.id) ||
    ""
  );
}

function getIp(req) {
  const forwarded =
    req?.headers?.["x-forwarded-for"] ||
    req?.headers?.["X-Forwarded-For"] ||
    req?.headers?.["cf-connecting-ip"] ||
    req?.headers?.["x-real-ip"] ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    "";

  if (Array.isArray(forwarded)) {
    return clean(forwarded[0]);
  }

  if (typeof forwarded === "string" && forwarded.includes(",")) {
    return clean(forwarded.split(",")[0]);
  }

  return clean(forwarded);
}

function getUserAgent(req) {
  return (
    clean(req?.headers?.["user-agent"]) ||
    clean(req?.headers?.["User-Agent"]) ||
    ""
  );
}

function getRoute(req) {
  return (
    clean(req?.url) ||
    clean(req?.originalUrl) ||
    clean(req?.pathname) ||
    ""
  );
}

function getMethod(req) {
  return clean(req?.method).toUpperCase() || "";
}

function sanitizeHeaders(headers = {}) {
  const blocked = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "apikey",
    "api-key",
  ]);

  const result = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = clean(key).toLowerCase();
    if (!normalizedKey) continue;

    if (blocked.has(normalizedKey)) {
      result[normalizedKey] = "[redacted]";
      continue;
    }

    if (Array.isArray(value)) {
      result[normalizedKey] = value.map((item) => clean(item));
      continue;
    }

    result[normalizedKey] = clean(value);
  }

  return result;
}

function serializeError(error) {
  if (!error) return null;

  return {
    name: clean(error.name) || "Error",
    message: clean(error.message) || "Unknown error",
    stack: clean(error.stack) || null,
    code: clean(error.code) || null,
    statusCode:
      typeof error.statusCode === "number"
        ? error.statusCode
        : typeof error.status === "number"
          ? error.status
          : null,
  };
}

function safeClone(value, depth = 0) {
  if (depth > 4) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);

  if (Array.isArray(value)) {
    return value.map((item) => safeClone(item, depth + 1));
  }

  if (isObject(value)) {
    const output = {};

    for (const [key, item] of Object.entries(value)) {
      const lowerKey = clean(key).toLowerCase();

      if (
        lowerKey.includes("password") ||
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("cookie") ||
        lowerKey.includes("service_role")
      ) {
        output[key] = "[redacted]";
      } else {
        output[key] = safeClone(item, depth + 1);
      }
    }

    return output;
  }

  return String(value);
}

function buildBaseEntry(level, message, meta = {}) {
  return {
    timestamp: nowIso(),
    namespace: APP_NAMESPACE,
    level,
    env: getEnvironment(),
    message: clean(message) || "Log entry",
    ...safeClone(meta),
  };
}

function write(level, entry) {
  if (level === LOG_LEVELS.ERROR) {
    console.error(entry);
    return;
  }

  if (level === LOG_LEVELS.WARN) {
    console.warn(entry);
    return;
  }

  if (level === LOG_LEVELS.INFO) {
    console.info(entry);
    return;
  }

  console.log(entry);
}

export function createLogger(scope = "app") {
  const normalizedScope = clean(scope) || "app";

  function log(level, message, meta = {}) {
    if (level === LOG_LEVELS.DEBUG && !shouldLogDebug()) {
      return;
    }

    const entry = buildBaseEntry(level, message, {
      scope: normalizedScope,
      ...meta,
    });

    write(level, entry);
  }

  return {
    debug(message, meta = {}) {
      log(LOG_LEVELS.DEBUG, message, meta);
    },

    info(message, meta = {}) {
      log(LOG_LEVELS.INFO, message, meta);
    },

    warn(message, meta = {}) {
      log(LOG_LEVELS.WARN, message, meta);
    },

    error(message, meta = {}) {
      log(LOG_LEVELS.ERROR, message, meta);
    },

    child(childScope = "child", childMeta = {}) {
      const nextScope = `${normalizedScope}:${clean(childScope) || "child"}`;
      const childLogger = createLogger(nextScope);

      return {
        debug(message, meta = {}) {
          childLogger.debug(message, { ...childMeta, ...meta });
        },
        info(message, meta = {}) {
          childLogger.info(message, { ...childMeta, ...meta });
        },
        warn(message, meta = {}) {
          childLogger.warn(message, { ...childMeta, ...meta });
        },
        error(message, meta = {}) {
          childLogger.error(message, { ...childMeta, ...meta });
        },
      };
    },
  };
}

export function buildRequestLogMeta(req, extra = {}) {
  return {
    requestId: getRequestId(req),
    method: getMethod(req),
    route: getRoute(req),
    ip: getIp(req),
    userAgent: getUserAgent(req),
    headers: sanitizeHeaders(req?.headers || {}),
    ...safeClone(extra),
  };
}

export function logRequestStart(req, meta = {}) {
  const requestLogger = createLogger("request");
  requestLogger.info("Request started.", buildRequestLogMeta(req, meta));
}

export function logRequestSuccess(req, meta = {}) {
  const requestLogger = createLogger("request");
  requestLogger.info("Request completed successfully.", buildRequestLogMeta(req, meta));
}

export function logRequestWarn(req, message = "Request warning.", meta = {}) {
  const requestLogger = createLogger("request");
  requestLogger.warn(message, buildRequestLogMeta(req, meta));
}

export function logRequestError(req, error, meta = {}) {
  const requestLogger = createLogger("request");
  requestLogger.error("Request failed.", buildRequestLogMeta(req, {
    ...meta,
    error: serializeError(error),
  }));
}

export function logAuthEvent(event, meta = {}) {
  const authLogger = createLogger("auth");
  authLogger.info(clean(event) || "Authentication event.", meta);
}

export function logPortalEvent(event, meta = {}) {
  const portalLogger = createLogger("portal");
  portalLogger.info(clean(event) || "Portal event.", meta);
}

export function logSystemEvent(event, meta = {}) {
  const systemLogger = createLogger("system");
  systemLogger.info(clean(event) || "System event.", meta);
}

export function logCaughtError(scope, error, meta = {}) {
  const scopedLogger = createLogger(scope || "error");
  scopedLogger.error("Caught error.", {
    ...meta,
    error: serializeError(error),
  });
}

export const logger = createLogger("app");

export default {
  logger,
  createLogger,
  buildRequestLogMeta,
  logRequestStart,
  logRequestSuccess,
  logRequestWarn,
  logRequestError,
  logAuthEvent,
  logPortalEvent,
  logSystemEvent,
  logCaughtError,
};