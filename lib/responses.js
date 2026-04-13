// lib/responses.js

function normalizeMessage(message, fallback) {
  const value = String(message || "").trim();
  return value || fallback;
}

function normalizeDetails(details) {
  if (details === undefined || details === null) return null;
  return details;
}

function buildPayload({
  success = true,
  message = "",
  data,
  error,
  details,
  meta,
  redirectTo,
} = {}) {
  const payload = { success: Boolean(success) };

  if (message !== undefined && message !== null && String(message).trim()) {
    payload.message = String(message).trim();
  }

  if (data !== undefined) {
    payload.data = data;
  }

  if (error !== undefined) {
    payload.error = error;
  }

  const normalizedDetails = normalizeDetails(details);
  if (normalizedDetails !== null) {
    payload.details = normalizedDetails;
  }

  if (meta !== undefined) {
    payload.meta = meta;
  }

  if (redirectTo !== undefined && redirectTo !== null && String(redirectTo).trim()) {
    payload.redirectTo = String(redirectTo).trim();
  }

  return payload;
}

function canWriteHeaders(res) {
  return res && typeof res.setHeader === "function" && !res.headersSent;
}

export function setNoStore(res) {
  if (canWriteHeaders(res)) {
    res.setHeader("Cache-Control", "no-store");
  }
}

export function setJsonHeaders(res) {
  if (canWriteHeaders(res)) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
}

export function sendJson(res, statusCode = 200, payload = {}) {
  if (!res || typeof res.status !== "function" || typeof res.json !== "function") {
    throw new Error("sendJson requires a valid response object with status() and json().");
  }

  setJsonHeaders(res);
  return res.status(statusCode).json(payload);
}

export function sendSuccess(
  res,
  {
    statusCode = 200,
    message = "Request completed successfully.",
    data,
    details,
    meta,
    redirectTo,
    noStore = true,
  } = {}
) {
  if (noStore) setNoStore(res);

  return sendJson(
    res,
    statusCode,
    buildPayload({
      success: true,
      message,
      data,
      details,
      meta,
      redirectTo,
    })
  );
}

export function sendError(
  res,
  {
    statusCode = 500,
    message = "Something went wrong.",
    error = "server_error",
    details,
    meta,
    redirectTo,
    noStore = true,
  } = {}
) {
  if (noStore) setNoStore(res);

  return sendJson(
    res,
    statusCode,
    buildPayload({
      success: false,
      message,
      error,
      details,
      meta,
      redirectTo,
    })
  );
}

export function ok(res, data = null, message = "Success.", options = {}) {
  return sendSuccess(res, {
    statusCode: 200,
    message: normalizeMessage(message, "Success."),
    data,
    ...options,
  });
}

export function created(res, data = null, message = "Created successfully.", options = {}) {
  return sendSuccess(res, {
    statusCode: 201,
    message: normalizeMessage(message, "Created successfully."),
    data,
    ...options,
  });
}

export function accepted(res, data = null, message = "Request accepted.", options = {}) {
  return sendSuccess(res, {
    statusCode: 202,
    message: normalizeMessage(message, "Request accepted."),
    data,
    ...options,
  });
}

export function noContent(res) {
  if (!res || typeof res.status !== "function" || typeof res.end !== "function") {
    throw new Error("noContent requires a valid response object with status() and end().");
  }

  if (canWriteHeaders(res)) {
    res.setHeader("Cache-Control", "no-store");
  }

  return res.status(204).end();
}

export function badRequest(
  res,
  message = "Bad request.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 400,
    message: normalizeMessage(message, "Bad request."),
    error: "bad_request",
    details,
    ...options,
  });
}

export function unauthorized(
  res,
  message = "You must be signed in to continue.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 401,
    message: normalizeMessage(message, "You must be signed in to continue."),
    error: "unauthorized",
    details,
    ...options,
  });
}

export function forbidden(
  res,
  message = "You do not have permission to perform this action.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 403,
    message: normalizeMessage(
      message,
      "You do not have permission to perform this action."
    ),
    error: "forbidden",
    details,
    ...options,
  });
}

export function notFound(
  res,
  message = "The requested resource was not found.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 404,
    message: normalizeMessage(message, "The requested resource was not found."),
    error: "not_found",
    details,
    ...options,
  });
}

export function methodNotAllowed(
  res,
  allowedMethods = [],
  message = "Method not allowed.",
  options = {}
) {
  const methods = Array.isArray(allowedMethods)
    ? allowedMethods.filter(Boolean).map((method) => String(method).toUpperCase())
    : [];

  if (canWriteHeaders(res) && methods.length > 0) {
    res.setHeader("Allow", methods.join(", "));
  }

  return sendError(res, {
    statusCode: 405,
    message: normalizeMessage(message, "Method not allowed."),
    error: "method_not_allowed",
    details: methods.length > 0 ? { allowedMethods: methods } : null,
    ...options,
  });
}

export function conflict(
  res,
  message = "A conflict prevented this request from completing.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 409,
    message: normalizeMessage(
      message,
      "A conflict prevented this request from completing."
    ),
    error: "conflict",
    details,
    ...options,
  });
}

export function unprocessableEntity(
  res,
  message = "Some fields need attention.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 422,
    message: normalizeMessage(message, "Some fields need attention."),
    error: "validation_error",
    details,
    ...options,
  });
}

export function tooManyRequests(
  res,
  message = "Too many requests. Please try again later.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 429,
    message: normalizeMessage(message, "Too many requests. Please try again later."),
    error: "rate_limited",
    details,
    ...options,
  });
}

export function serverError(
  res,
  message = "Something went wrong on our side.",
  details = null,
  options = {}
) {
  return sendError(res, {
    statusCode: 500,
    message: normalizeMessage(message, "Something went wrong on our side."),
    error: "server_error",
    details,
    ...options,
  });
}

export function fromCaughtError(
  res,
  err,
  fallbackMessage = "Unexpected server error.",
  options = {}
) {
  const message =
    err && typeof err.message === "string" && err.message.trim()
      ? err.message.trim()
      : fallbackMessage;

  const details =
    process?.env?.NODE_ENV !== "production" && err
      ? {
          name: err.name || "Error",
          stack: err.stack || null,
        }
      : null;

  return serverError(res, message, details, options);
}

export default {
  setNoStore,
  setJsonHeaders,
  sendJson,
  sendSuccess,
  sendError,
  ok,
  created,
  accepted,
  noContent,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  conflict,
  unprocessableEntity,
  tooManyRequests,
  serverError,
  fromCaughtError,
};