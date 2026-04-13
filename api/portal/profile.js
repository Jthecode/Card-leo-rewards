// api/portal/profile.js
import {
  getPortalOverview,
  createPortalResponsePayload,
} from "../../lib/portal.js";
import {
  ok,
  unauthorized,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { getSessionCookieFromRequest, safeJsonParse } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

function normalizeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
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
    email: normalizeText(
      session.email ||
        session.userEmail ||
        profile.email ||
        user.email
    ).toLowerCase(),
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

function buildSupportPayload(overview) {
  return {
    email: normalizeText(
      overview?.support?.email,
      "support@cardleorewards.com"
    ),
    phone: normalizeText(overview?.support?.phone, ""),
    hours: normalizeText(
      overview?.support?.hours,
      "Mon–Fri, 9:00 AM – 5:00 PM"
    ),
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_profile" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const session = extractSessionPayload(req);

    if (!session) {
      return unauthorized(
        res,
        "Authentication required. Please log in to continue."
      );
    }

    const { email, portalUserId, signupId, userId } =
      extractIdentityFromSession(session);

    if (!email && !portalUserId && !signupId && !userId) {
      return unauthorized(
        res,
        "Your session is missing member identity details. Please log in again."
      );
    }

    const overview = await getPortalOverview({
      id: signupId || userId,
      email,
      portalUserId,
    });

    if (!overview || !overview.member) {
      return notFound(
        res,
        "We could not locate your Card Leo Rewards member profile.",
        {
          member: null,
          profile: null,
          support: buildSupportPayload(null),
        }
      );
    }

    const payload = createPortalResponsePayload(overview);
    const support = buildSupportPayload(overview);

    logRequestSuccess(req, {
      scope: "portal_profile",
      memberId:
        overview?.member?.id ||
        overview?.member?.signupId ||
        signupId ||
        userId ||
        null,
      email,
    });

    return ok(
      res,
      {
        ...payload,
        profile: overview.member,
        support,
      },
      "Member profile loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_profile_unexpected" });

    return serverError(
      res,
      error?.message || "We were unable to load the member profile.",
      {
        member: null,
        profile: null,
        support: buildSupportPayload(null),
      }
    );
  }
}