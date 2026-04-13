// api/portal/change-password.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { getPortalOverview } from "../../lib/portal.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { changePasswordRateLimit } from "../../lib/rate-limit.js";
import { getSessionCookieFromRequest, safeJsonParse } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function safeBase64JsonParse(value) {
  try {
    const decoded = Buffer.from(String(value), "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf("=");
      if (index === -1) return acc;

      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        acc[key] = value;
      }

      return acc;
    }, {});
}

function getSessionFromRequest(req) {
  const directSessionCookie = getSessionCookieFromRequest(req);

  if (directSessionCookie) {
    const parsedDirect =
      safeJsonParse(directSessionCookie, null) ||
      safeBase64JsonParse(directSessionCookie);

    if (isObject(parsedDirect)) {
      return {
        cookieName: "cardleo_session",
        raw: directSessionCookie,
        data: parsedDirect,
      };
    }
  }

  const cookies = parseCookies(req.headers?.cookie || "");

  for (const cookieName of SESSION_COOKIE_NAMES) {
    const raw = cookies[cookieName];
    if (!raw) continue;

    const parsed =
      safeJsonParse(raw, null) ||
      safeBase64JsonParse(raw) ||
      safeJsonParse(decodeURIComponent(raw), null) ||
      safeBase64JsonParse(decodeURIComponent(raw));

    if (isObject(parsed)) {
      return {
        cookieName,
        raw,
        data: parsed,
      };
    }
  }

  return null;
}

function getRequestBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    const parsed = safeJsonParse(req.body, null);
    return isObject(parsed) ? parsed : {};
  }

  return isObject(req.body) ? req.body : {};
}

function validatePasswordStrength(password) {
  const value = String(password || "");

  if (value.length < 8) {
    return "Your new password must be at least 8 characters long.";
  }

  if (!/[A-Z]/.test(value)) {
    return "Your new password must include at least one uppercase letter.";
  }

  if (!/[a-z]/.test(value)) {
    return "Your new password must include at least one lowercase letter.";
  }

  if (!/[0-9]/.test(value)) {
    return "Your new password must include at least one number.";
  }

  if (!/[^A-Za-z0-9]/.test(value)) {
    return "Your new password must include at least one special character.";
  }

  return null;
}

function buildCurrentSessionId(sessionData = {}) {
  return normalizeText(
    sessionData.sessionId ||
      sessionData.sid ||
      sessionData.jti ||
      sessionData.id ||
      sessionData.tokenId ||
      ""
  );
}

async function getSignupRecord({ signupId, email }) {
  const baseFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "created_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  const extendedFields = `${baseFields}, portal_settings, portal_sessions`;

  const queryBuilder = () => {
    let query = supabaseAdmin.from("signups").select(extendedFields).limit(1);

    if (signupId) {
      query = query.eq("id", signupId);
    } else if (email) {
      query = query.eq("email", email);
    }

    return query.maybeSingle();
  };

  let { data, error } = await queryBuilder();

  if (error && /(portal_settings|portal_sessions)/i.test(error.message || "")) {
    let fallbackQuery = supabaseAdmin.from("signups").select(baseFields).limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else if (email) {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            portal_settings: null,
            portal_sessions: null,
            __portalSettingsColumnMissing: true,
            __portalSessionsColumnMissing: true,
          }
        : null,
      error: fallback.error,
    };
  }

  return { data, error };
}

async function resolvePortalContext(req) {
  const sessionMeta = getSessionFromRequest(req);

  if (!sessionMeta?.data) {
    return {
      ok: false,
      status: 401,
      message: "You must be logged in to change your password.",
    };
  }

  const session = sessionMeta.data;

  const email = normalizeEmail(
    session.email || session.user?.email || session.member?.email
  );

  const signupId =
    session.signupId ||
    session.signup_id ||
    session.member?.signupId ||
    session.user?.signupId ||
    null;

  const portalUserId =
    session.portalUserId ||
    session.portal_user_id ||
    session.user?.id ||
    session.member?.portalUserId ||
    null;

  const portal = await getPortalOverview({
    email,
    signupId,
    portalUserId,
  });

  if (!portal) {
    return {
      ok: false,
      status: 404,
      message: "We could not find your Card Leo Rewards member profile.",
    };
  }

  const member = portal?.member || {};

  if (member.portalAccess === false) {
    return {
      ok: false,
      status: 403,
      message: "Your member account does not have portal access yet.",
    };
  }

  const { data: signupRecord, error } = await getSignupRecord({
    signupId: member.signupId || signupId,
    email: member.email || email,
  });

  if (error) {
    return {
      ok: false,
      status: 500,
      message: "We were unable to load your member profile.",
      error,
    };
  }

  if (!signupRecord) {
    return {
      ok: false,
      status: 404,
      message: "We could not locate the signup record for this member.",
    };
  }

  return {
    ok: true,
    sessionMeta,
    portal,
    member,
    signupRecord,
  };
}

function buildResponsePayload({ portal, signupRecord, passwordLastChangedAt }) {
  const member = portal?.member || {};
  const support = portal?.support || {};
  const existingSettings = isObject(signupRecord?.portal_settings)
    ? signupRecord.portal_settings
    : {};
  const existingSecurity = isObject(existingSettings.security)
    ? existingSettings.security
    : {};

  return {
    member: {
      id: member.id || null,
      signupId: signupRecord?.id || member.signupId || null,
      portalUserId: signupRecord?.portal_user_id || member.portalUserId || null,
      firstName: signupRecord?.first_name || member.firstName || "",
      lastName: signupRecord?.last_name || member.lastName || "",
      name:
        [
          signupRecord?.first_name || member.firstName || "",
          signupRecord?.last_name || member.lastName || "",
        ]
          .join(" ")
          .trim() || member.name || "Card Leo Member",
      email: signupRecord?.email || member.email || "",
      status: signupRecord?.status || member.status || "pending",
      portalAccess: member.portalAccess !== false,
      accessLevel: member.accessLevel || "member",
      joinedAt: signupRecord?.created_at || member.joinedAt || null,
    },
    security: {
      emailVerified: existingSecurity.emailVerified ?? true,
      twoFactorEnabled: existingSecurity.twoFactorEnabled ?? false,
      passwordLastChangedAt: passwordLastChangedAt || null,
      sessionsEndpoint: "/api/portal/sessions",
      settingsEndpoint: "/api/portal/settings",
    },
    support: {
      email: support.email || "support@cardleorewards.com",
      phone: support.phone || "",
      hours: support.hours || "Mon–Fri, 9:00 AM–6:00 PM",
    },
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_change_password" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rate = changePasswordRateLimit(req, res);

    if (!rate.allowed) {
      return badRequest(
        res,
        "Too many password change attempts. Please try again later.",
        { retryAfter: rate.retryAfter },
        { statusCode: 429, error: "rate_limited" }
      );
    }

    const context = await resolvePortalContext(req);

    if (!context.ok) {
      if (context.status === 401) return unauthorized(res, context.message);
      if (context.status === 403) return forbidden(res, context.message);
      if (context.status === 404) return notFound(res, context.message);

      return serverError(
        res,
        context.message,
        context.error ? { error: context.error.message || "Unknown error." } : null
      );
    }

    const { sessionMeta, portal, signupRecord } = context;
    const body = getRequestBody(req);

    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const confirmNewPassword = String(
      body.confirmNewPassword || body.confirmPassword || ""
    );
    const signOutOtherSessions = body.signOutOtherSessions !== false;

    if (!currentPassword) {
      return badRequest(res, "Current password is required.");
    }

    if (!newPassword) {
      return badRequest(res, "New password is required.");
    }

    if (!confirmNewPassword) {
      return badRequest(res, "Please confirm your new password.");
    }

    if (newPassword !== confirmNewPassword) {
      return badRequest(res, "New password and confirmation do not match.");
    }

    if (currentPassword === newPassword) {
      return badRequest(
        res,
        "Your new password must be different from your current password."
      );
    }

    const passwordError = validatePasswordStrength(newPassword);

    if (passwordError) {
      return badRequest(res, passwordError);
    }

    const portalUserId = normalizeText(signupRecord.portal_user_id);

    if (!portalUserId) {
      return conflict(
        res,
        "This member account is not linked to a portal user yet. Please contact support."
      );
    }

    const changedAt = new Date().toISOString();

    const { error: authError } =
      await supabaseAdmin.auth.admin.updateUserById(portalUserId, {
        password: newPassword,
      });

    if (authError) {
      return serverError(
        res,
        "We could not change your password right now.",
        { error: authError.message || "Unknown password update error." }
      );
    }

    const existingSettings = isObject(signupRecord.portal_settings)
      ? signupRecord.portal_settings
      : {};
    const existingPreferences = isObject(existingSettings.preferences)
      ? existingSettings.preferences
      : {};
    const existingSecurity = isObject(existingSettings.security)
      ? existingSettings.security
      : {};

    const mergedSettings = {
      preferences: {
        emailNotifications: existingPreferences.emailNotifications ?? true,
        smsNotifications: existingPreferences.smsNotifications ?? false,
        productUpdates: existingPreferences.productUpdates ?? true,
        marketingEmails: existingPreferences.marketingEmails ?? true,
        rewardAlerts: existingPreferences.rewardAlerts ?? true,
        securityAlerts: existingPreferences.securityAlerts ?? true,
        theme: existingPreferences.theme || "dark",
      },
      security: {
        emailVerified: existingSecurity.emailVerified ?? true,
        twoFactorEnabled: existingSecurity.twoFactorEnabled ?? false,
        passwordLastChangedAt: changedAt,
        changePasswordEndpoint: "/api/portal/change-password",
        sessionsEndpoint: "/api/portal/sessions",
      },
    };

    const currentSessionId = buildCurrentSessionId(sessionMeta.data);
    let nextSessions = Array.isArray(signupRecord.portal_sessions)
      ? signupRecord.portal_sessions
      : [];

    if (signOutOtherSessions && nextSessions.length) {
      nextSessions = nextSessions.filter((session) => {
        const id = normalizeText(session?.id);
        return id && id === currentSessionId;
      });
    }

    const updatePayload = {};
    const settingsColumnMissing = !!signupRecord.__portalSettingsColumnMissing;
    const sessionsColumnMissing = !!signupRecord.__portalSessionsColumnMissing;

    if (!settingsColumnMissing) {
      updatePayload.portal_settings = mergedSettings;
    }

    if (!sessionsColumnMissing) {
      updatePayload.portal_sessions = nextSessions;
    }

    let finalSignupRecord = {
      ...signupRecord,
      portal_settings: mergedSettings,
      portal_sessions: nextSessions,
    };

    if (Object.keys(updatePayload).length > 0) {
      const { data: updatedRecord, error: updateError } = await supabaseAdmin
        .from("signups")
        .update(updatePayload)
        .eq("id", signupRecord.id)
        .select(
          "id, email, status, first_name, last_name, created_at, portal_login_url, portal_user_id, portal_settings, portal_sessions"
        )
        .single();

      if (updateError) {
        return serverError(
          res,
          "Your password was changed, but we could not finish updating your portal security settings.",
          { error: updateError.message || "Unknown profile update error." }
        );
      }

      finalSignupRecord = updatedRecord;
    }

    logRequestSuccess(req, {
      scope: "portal_change_password_success",
      signupId: finalSignupRecord?.id || null,
      portalUserId,
      signOutOtherSessions,
    });

    return ok(
      res,
      buildResponsePayload({
        portal,
        signupRecord: finalSignupRecord,
        passwordLastChangedAt:
          finalSignupRecord?.portal_settings?.security?.passwordLastChangedAt ||
          changedAt,
      }),
      signOutOtherSessions
        ? "Password changed successfully. Other sessions were signed out."
        : "Password changed successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_change_password_unexpected" });

    return serverError(
      res,
      "An unexpected error occurred while changing your password.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown server error." }
        : null
    );
  }
}