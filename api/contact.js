// api/contact.js
import { supabaseAdmin } from "../lib/supabase-admin.js";

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getRequestBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed. Use POST.",
    });
  }

  try {
    const body = getRequestBody(req);

    const name = normalizeText(body.name);
    const email = normalizeEmail(body.email);
    const phone = normalizeText(body.phone);
    const topic = normalizeText(body.topic);
    const message = normalizeText(body.message);
    const source = normalizeText(body.source) || "website-contact";
    const contactPage = normalizeText(body.contact_page) || "contact.html";

    if (!name || !email || !message) {
      return sendJson(res, 400, {
        success: false,
        message: "Name, email, and message are required.",
      });
    }

    if (!isValidEmail(email)) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const insertPayload = {
      name,
      email,
      phone: phone || null,
      topic: topic || null,
      message,
      source,
      contact_page: contactPage,
      status: "new",
    };

    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      console.error("Supabase contact insert error:", error);

      return sendJson(res, 500, {
        success: false,
        message: "Unable to save your message right now.",
      });
    }

    return sendJson(res, 200, {
      success: true,
      message: "Your message has been received successfully.",
      data: {
        id: data.id,
        email: data.email,
        status: data.status,
      },
    });
  } catch (error) {
    console.error("Unexpected contact error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Unexpected server error.",
    });
  }
}