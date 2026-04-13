// api/signup.js
import { supabaseAdmin } from "../lib/supabase-admin.js";
import { getServerEnv } from "../lib/env.js";
import {
  created,
  badRequest,
  conflict,
  methodNotAllowed,
  serverError,
} from "../lib/responses.js";
import { validateSignupInput } from "../lib/validation.js";
import { signupRateLimit } from "../lib/rate-limit.js";
import { logRequestStart, logRequestSuccess, logRequestError } from "../lib/logger.js";

const env = getServerEnv();

const DEFAULT_REDIRECT = "/thank-you.html";
const PORTAL_REDIRECT =
  env.portalLoginUrl ||
  env.PORTAL_LOGIN_URL ||
  "https://cardleo.my-office.app";

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
  logRequestStart(req, { scope: "signup" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = signupRateLimit(req, res);

    if (!rateLimit.allowed) {
      return badRequest(
        res,
        "Too many signup attempts. Please try again later.",
        {
          retryAfter: rateLimit.retryAfter,
        },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const body = getRequestBody(req);
    const validation = validateSignupInput(body);

    if (!validation.valid) {
      return badRequest(res, "Please correct the highlighted fields.", validation.errors);
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      city,
      state,
      referralName,
      interest,
      goals,
      agreed,
    } = validation.values;

    const signupPayload = {
      first_name: firstName,
      last_name: lastName,
      email,
      phone: phone || null,
      city: city || null,
      state: state || null,
      referral_name: referralName || null,
      interest: interest || null,
      goals: goals || null,
      agreed: Boolean(agreed),
      status: "new",
      source: "website",
      signup_page: "signup.html",
    };

    const { data: signupRecord, error: signupError } = await supabaseAdmin
      .from("signups")
      .upsert(signupPayload, {
        onConflict: "email",
      })
      .select()
      .single();

    if (signupError) {
      logRequestError(req, signupError, { scope: "signup_upsert", email });

      const message = String(signupError.message || "").toLowerCase();
      if (message.includes("duplicate") || message.includes("unique")) {
        return conflict(
          res,
          "A signup with this email already exists.",
          { email }
        );
      }

      return serverError(res, "Unable to save signup right now.");
    }

    const portalResult = await createPortalAccount(signupRecord);

    let finalStatus = "reviewing";
    let redirectTo = DEFAULT_REDIRECT;

    if (portalResult.created && portalResult.loginUrl) {
      finalStatus = "invited";
      redirectTo = portalResult.loginUrl;
    } else if (String(process.env.AUTO_REDIRECT_TO_PORTAL || "").toLowerCase() === "true") {
      redirectTo = PORTAL_REDIRECT;
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
      logRequestError(req, updateError, {
        scope: "signup_status_update",
        signupId: signupRecord.id,
        email,
      });
    }

    logRequestSuccess(req, {
      scope: "signup",
      signupId: signupRecord.id,
      email,
      status: finalStatus,
    });

    return created(
      res,
      {
        id: signupRecord.id,
        email: signupRecord.email,
        status: finalStatus,
      },
      "Signup received successfully.",
      {
        redirectTo,
      }
    );
  } catch (error) {
    logRequestError(req, error, { scope: "signup_unexpected" });
    return serverError(res, "Unexpected server error.");
  }
}