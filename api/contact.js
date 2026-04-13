// api/contact.js
import { supabaseAdmin } from "../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  methodNotAllowed,
  serverError,
  unprocessableEntity,
} from "../lib/responses.js";
import { validateContactInput } from "../lib/validation.js";
import { contactRateLimit } from "../lib/rate-limit.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../lib/logger.js";

const TABLE_NAME = "contact_messages";
const DEFAULT_SOURCE = "website";
const DEFAULT_CONTACT_PAGE = "contact.html";

function normalizeText(value, { preserveLineBreaks = false } = {}) {
  let text = String(value ?? "");

  text = text.replace(/\u0000/g, "");

  if (preserveLineBreaks) {
    text = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ");
    return text.trim();
  }

  return text.replace(/\s+/g, " ").trim();
}

function getRequestBody(req) {
  if (!req?.body) {
    return {};
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error("Invalid request body.");
    }
  }

  return req.body;
}

function getClientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req?.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp.trim();
  }

  return null;
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "contact" });

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST", "OPTIONS"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = contactRateLimit(req, res);

    if (!rateLimit.allowed) {
      return badRequest(
        res,
        "Too many contact attempts. Please try again later.",
        { retryAfter: rateLimit.retryAfter },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    let body = {};

    try {
      body = getRequestBody(req);
    } catch (parseError) {
      logRequestError(req, parseError, { scope: "contact_parse" });
      return badRequest(res, "Invalid request body.");
    }

    const honeypot = normalizeText(body.company || body.website || "");
    if (honeypot) {
      logRequestSuccess(req, { scope: "contact_honeypot_blocked" });
      return ok(res, null, "Your message has been received successfully.");
    }

    const validation = validateContactInput({
      name: body.name,
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      topic: body.topic,
      message: normalizeText(body.message, { preserveLineBreaks: true }),
    });

    if (!validation.valid) {
      return unprocessableEntity(
        res,
        "Please correct the highlighted fields.",
        validation.errors
      );
    }

    const {
      name,
      email,
      phone,
      topic,
      message,
    } = validation.values;

    const source = normalizeText(body.source) || DEFAULT_SOURCE;
    const contactPage =
      normalizeText(body.contact_page || body.contactPage) || DEFAULT_CONTACT_PAGE;

    const insertPayload = {
      name,
      email,
      phone: phone || null,
      topic: topic || "general",
      message,
      source,
      contact_page: contactPage,
      status: "new",
    };

    const { data, error } = await supabaseAdmin
      .from(TABLE_NAME)
      .insert(insertPayload)
      .select("id, email, status, created_at")
      .single();

    if (error) {
      logRequestError(req, error, { scope: "contact_insert", email });
      return serverError(res, "Unable to save your message right now.");
    }

    logRequestSuccess(req, {
      scope: "contact",
      contactId: data.id,
      email: data.email,
    });

    return ok(
      res,
      {
        id: data.id,
        email: data.email,
        status: data.status,
        createdAt: data.created_at,
        clientIp: getClientIp(req),
      },
      "Your message has been received successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "contact_unexpected" });
    return serverError(res, "Unexpected server error.");
  }
}