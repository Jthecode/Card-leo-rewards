// api/portal/update-profile.js
import {
  getPortalOverview,
  getPortalMember,
  createPortalResponsePayload,
} from "../../lib/portal.js";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { validateProfileInput } from "../../lib/validation.js";
import { portalProfileRateLimit } from "../../lib/rate-limit.js";
import { getSessionCookieFromRequest, safeJsonParse } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeBase64JsonParse(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function parseCookies(req) {
  if (req?.cookies && typeof req.cookies === "object") {
    return req.cookies;
  }

  const header = req?.headers?.cookie || "";
  if (!header) return {};

  return header.split(";").reduce((acc, part) => {
    const [rawKey, ...rest] = part.split("=");
    const key = normalizeText(rawKey);
    const value = rest.join("=");

    if (!key) return acc;

    acc[key] = safeDecodeURIComponent(value || "");
    return acc;
  }, {});
}

function extractSessionPayload(req) {
  const directSessionCookie = getSessionCookieFromRequest(req);

  if (directSessionCookie) {
    const jsonValue = safeJsonParse(directSessionCookie, null);
    if (jsonValue && typeof jsonValue === "object") {
      return jsonValue;
    }

    const base64Value = safeBase64JsonParse(directSessionCookie);
    if (base64Value && typeof base64Value === "object") {
      return base64Value;
    }
  }

  const cookies = parseCookies(req);

  const candidateCookieNames = [
    "cardleo_session",
    "card_leo_session",
    "member_session",
    "portal_session",
    "session",
  ];

  for (const cookieName of candidateCookieNames) {
    const rawValue = cookies[cookieName];
    if (!rawValue) continue;

    const jsonValue = safeJsonParse(rawValue, null);
    if (jsonValue && typeof jsonValue === "object") {
      return jsonValue;
    }

    const base64Value = safeBase64JsonParse(rawValue);
    if (base64Value && typeof base64Value === "object") {
      return base64Value;
    }
  }

  return null;
}

function extractIdentityFromSession(session) {
  if (!session || typeof session !== "object") {
    return {
      email: "",
      portalUserId: "",
      signupId: "",
      userId: "",
    };
  }

  const user =
    session.user && typeof session.user === "object" ? session.user : {};
  const profile =
    session.profile && typeof session.profile === "object" ? session.profile : {};

  return {
    email: normalizeEmail(
      session.email ||
        session.userEmail ||
        profile.email ||
        user.email
    ),
    portalUserId: normalizeText(
      session.portalUserId ||
        session.portal_user_id ||
        session.userId ||
        session.memberId ||
        profile.portalUserId ||
        profile.portal_user_id ||
        user.portalUserId ||
        user.portal_user_id
    ),
    signupId: normalizeText(
      session.signupId ||
        session.signup_id ||
        session.recordId ||
        profile.signupId ||
        profile.signup_id ||
        user.signupId ||
        user.signup_id
    ),
    userId: normalizeText(
      session.userId ||
        session.profileId ||
        profile.id ||
        user.id
    ),
  };
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

function buildSupportPayload(overview) {
  return {
    email: normalizeText(overview?.support?.email, "support@cardleorewards.com"),
    phone: normalizeText(overview?.support?.phone, ""),
    hours: normalizeText(
      overview?.support?.hours,
      "Mon–Fri, 9:00 AM – 5:00 PM"
    ),
  };
}

function splitFullName(fullName = "") {
  const normalized = normalizeText(fullName);
  if (!normalized) {
    return { firstName: "", lastName: "" };
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function buildAllowedUpdates(values) {
  const nameParts = splitFullName(values.fullName);

  return {
    first_name: normalizeText(nameParts.firstName),
    last_name: normalizeText(nameParts.lastName),
    phone: normalizeText(values.phone),
    city: normalizeText(values.city),
    state: normalizeText(values.state),
  };
}

function validateProfilePayload(body, sessionIdentity, existingMember = null) {
  const validation = validateProfileInput(body);

  if (!validation.valid) {
    return {
      valid: false,
      message: "Please correct the highlighted profile fields.",
      details: validation.errors,
      values: null,
    };
  }

  const incomingEmail = normalizeEmail(validation.values.email);
  const sessionEmail = normalizeEmail(sessionIdentity.email);
  const existingEmail = normalizeEmail(existingMember?.email);

  if (
    incomingEmail &&
    ((sessionEmail && incomingEmail !== sessionEmail) ||
      (existingEmail && incomingEmail !== existingEmail))
  ) {
    return {
      valid: false,
      message: "Email changes are not allowed from this form.",
      details: {
        email: "Email changes are not allowed from this form.",
      },
      values: null,
    };
  }

  const nameParts = splitFullName(validation.values.fullName);

  if (!nameParts.firstName || !nameParts.lastName) {
    return {
      valid: false,
      message: "First and last name are required.",
      details: {
        fullName: "Please enter both a first and last name.",
      },
      values: null,
    };
  }

  return {
    valid: true,
    message: "",
    details: null,
    values: validation.values,
  };
}

async function updateSignupRecord({ signupId, email, updates }) {
  let query = supabaseAdmin
    .from("signups")
    .update(updates)
    .select("id")
    .limit(1);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.eq("email", email);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message || "Unable to update your member profile.");
  }

  return data || null;
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_update_profile" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rateLimit = portalProfileRateLimit(req, res);

    if (!rateLimit.allowed) {
      return badRequest(
        res,
        "Too many profile update attempts. Please try again later.",
        { retryAfter: rateLimit.retryAfter },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const session = extractSessionPayload(req);

    if (!session) {
      return unauthorized(
        res,
        "Authentication required. Please log in to continue."
      );
    }

    const identity = extractIdentityFromSession(session);

    if (!identity.email && !identity.portalUserId && !identity.signupId && !identity.userId) {
      return unauthorized(
        res,
        "Your session is missing member identity details. Please log in again."
      );
    }

    const existingMember = await getPortalMember({
      id: identity.signupId || identity.userId,
      email: identity.email,
      portalUserId: identity.portalUserId,
    });

    if (!existingMember) {
      return notFound(
        res,
        "We could not locate your Card Leo Rewards member profile."
      );
    }

    const body = getRequestBody(req);
    const validation = validateProfilePayload(body, identity, existingMember);

    if (!validation.valid) {
      return badRequest(res, validation.message, validation.details);
    }

    const updates = buildAllowedUpdates(validation.values);

    await updateSignupRecord({
      signupId: existingMember.id || identity.signupId || identity.userId,
      email: existingMember.email || identity.email,
      updates,
    });

    const overview = await getPortalOverview({
      id: existingMember.id || identity.signupId || identity.userId,
      email: existingMember.email || identity.email,
      portalUserId: existingMember.portalUserId || identity.portalUserId,
    });

    if (!overview || !overview.member) {
      return serverError(
        res,
        "Your profile was updated, but we could not reload it afterward."
      );
    }

    const payload = createPortalResponsePayload(overview);
    const support = buildSupportPayload(overview);

    logRequestSuccess(req, {
      scope: "portal_update_profile",
      memberId:
        overview?.member?.id ||
        existingMember?.id ||
        identity.signupId ||
        identity.userId ||
        null,
      email: existingMember?.email || identity.email,
    });

    return ok(
      res,
      {
        ...payload,
        profile: overview.member,
        support,
      },
      "Your Card Leo Rewards profile was updated successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_update_profile_unexpected" });

    return serverError(
      res,
      error?.message || "We were unable to update your member profile."
    );
  }
}