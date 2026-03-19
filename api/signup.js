// api/signup.js
import { supabaseAdmin } from "../lib/supabase-admin.js";

const DEFAULT_REDIRECT = "./thank-you.html";
const PORTAL_REDIRECT =
  process.env.PORTAL_LOGIN_URL || "https://cardleo.my-office.app";

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

function isValidPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10;
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

/*
  OPTIONAL:
  Replace this later with your real portal/back-office API call.
  Right now it just returns a "not wired yet" response.
*/
async function createPortalAccount(_signupRecord) {
  return {
    created: false,
    portalUserId: null,
    loginUrl: null,
  };
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

    const firstName = normalizeText(body.firstName);
    const lastName = normalizeText(body.lastName);
    const email = normalizeEmail(body.email);
    const phone = normalizeText(body.phone);
    const city = normalizeText(body.city);
    const state = normalizeText(body.state);
    const referralName = normalizeText(body.referralName);
    const interest = normalizeText(body.interest);
    const goals = normalizeText(body.goals);
    const agree =
      body.agree === true ||
      body.agree === "true" ||
      body.agree === "on" ||
      body.agree === "yes" ||
      body.agree === 1 ||
      body.agree === "1";

    if (!firstName || !lastName || !email || !phone || !interest) {
      return sendJson(res, 400, {
        success: false,
        message:
          "Missing required fields. First name, last name, email, phone, and interest are required.",
      });
    }

    if (!isValidEmail(email)) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    if (!isValidPhone(phone)) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid phone number.",
      });
    }

    if (!agree) {
      return sendJson(res, 400, {
        success: false,
        message: "You must agree before continuing.",
      });
    }

    const signupPayload = {
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      city: city || null,
      state: state || null,
      referral_name: referralName || null,
      interest,
      goals: goals || null,
      agreed: true,
      status: "pending",
      source: "website-signup",
      signup_page: "signup.html",
    };

    /*
      IMPORTANT:
      In Supabase, make "email" unique on the signups table if you want upsert to work cleanly.
      Example unique index:
      create unique index signups_email_key on public.signups (email);
    */
    const { data: signupRecord, error: signupError } = await supabaseAdmin
      .from("signups")
      .upsert(signupPayload, {
        onConflict: "email",
      })
      .select()
      .single();

    if (signupError) {
      console.error("Supabase signup insert error:", signupError);
      return sendJson(res, 500, {
        success: false,
        message: "Unable to save signup right now.",
      });
    }

    /*
      OPTIONAL PORTAL STEP:
      If you later get an API for cardleo.my-office.app,
      wire it into createPortalAccount(signupRecord).
    */
    const portalResult = await createPortalAccount(signupRecord);

    let finalStatus = "saved";
    let redirect = DEFAULT_REDIRECT;

    if (portalResult.created && portalResult.loginUrl) {
      finalStatus = "portal_created";
      redirect = portalResult.loginUrl;
    } else if (process.env.AUTO_REDIRECT_TO_PORTAL === "true") {
      redirect = PORTAL_REDIRECT;
    }

    const updatePayload = {
      status: finalStatus,
      portal_user_id: portalResult.portalUserId || null,
      portal_login_url: portalResult.loginUrl || null,
    };

    const { error: updateError } = await supabaseAdmin
      .from("signups")
      .update(updatePayload)
      .eq("id", signupRecord.id);

    if (updateError) {
      console.error("Supabase signup status update error:", updateError);
    }

    return sendJson(res, 200, {
      success: true,
      message: "Signup received successfully.",
      redirect,
      data: {
        id: signupRecord.id,
        email: signupRecord.email,
        status: finalStatus,
      },
    });
  } catch (error) {
    console.error("Unexpected signup error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Unexpected server error.",
    });
  }
}