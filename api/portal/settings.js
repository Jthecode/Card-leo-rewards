// api/portal/settings.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { getPortalOverview } from "../../lib/portal.js";
import {
  ok,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { portalSettingsRateLimit } from "../../lib/rate-limit.js";
import { getSessionCookieFromRequest, safeJsonParse } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

/**
 * Card Leo Rewards
 * api/portal/settings.js
 *
 * Assumption:
 * This route will persist settings into `public.signups.portal_settings`
 * if that JSON/JSONB column exists.
 *
 * If your `signups` table does not yet have `portal_settings`,
 * the route still works for GET and will return a non-breaking
 * response for updates, but you should add that column later.
 */

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
      acc[key] = decodeURIComponent(value);
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
      return parsedDirect;
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
      return parsed;
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

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }

  return fallback;
}

function normalizeTheme(value) {
  const theme = normalizeText(value).toLowerCase();
  if (["dark", "light", "system"].includes(theme)) return theme;
  return "dark";
}

function sanitizeSettingsInput(body = {}) {
  const rawPreferences = isObject(body.preferences) ? body.preferences : {};
  const rawSecurity = isObject(body.security) ? body.security : {};

  return {
    preferences: {
      emailNotifications: toBoolean(
        rawPreferences.emailNotifications,
        true
      ),
      smsNotifications: toBoolean(rawPreferences.smsNotifications, false),
      productUpdates: toBoolean(rawPreferences.productUpdates, true),
      marketingEmails: toBoolean(rawPreferences.marketingEmails, true),
      rewardAlerts: toBoolean(rawPreferences.rewardAlerts, true),
      securityAlerts: toBoolean(rawPreferences.securityAlerts, true),
      theme: normalizeTheme(rawPreferences.theme),
    },
    security: {
      twoFactorEnabled: toBoolean(rawSecurity.twoFactorEnabled, false),
    },
  };
}

function buildDefaultSettings(portal = {}) {
  const member = portal?.member || {};
  const support = portal?.support || {};

  return {
    member: {
      id: member.id || null,
      signupId: member.signupId || null,
      portalUserId: member.portalUserId || null,
      name: member.name || "Card Leo Member",
      firstName: member.firstName || "",
      lastName: member.lastName || "",
      email: member.email || "",
      status: member.status || "pending",
      accessLevel: member.accessLevel || "member",
      portalAccess: !!member.portalAccess,
      joinedAt: member.joinedAt || null,
    },
    settings: {
      preferences: {
        emailNotifications: true,
        smsNotifications: false,
        productUpdates: true,
        marketingEmails: true,
        rewardAlerts: true,
        securityAlerts: true,
        theme: "dark",
      },
      security: {
        emailVerified: member.emailVerified ?? true,
        twoFactorEnabled: false,
        passwordLastChangedAt: null,
        changePasswordEndpoint: "/api/portal/change-password",
        sessionsEndpoint: "/api/portal/sessions",
      },
    },
    support: {
      email: support.email || "support@cardleorewards.com",
      phone: support.phone || "",
      hours: support.hours || "Mon–Fri, 9:00 AM–6:00 PM",
    },
  };
}

async function getSignupRecord({ signupId, email }) {
  const baseFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "phone",
    "city",
    "state",
    "referral_name",
    "interest",
    "goals",
    "created_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  const extendedFields = `${baseFields}, portal_settings`;

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

  if (error && /portal_settings/i.test(error.message || "")) {
    let fallbackQuery = supabaseAdmin.from("signups").select(baseFields).limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else if (email) {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? { ...fallback.data, portal_settings: null, __portalSettingsColumnMissing: true }
        : null,
      error: fallback.error,
    };
  }

  return { data, error };
}

function mergePortalSettings(existingPortalSettings, incomingSettings, fallbackDefaults) {
  const base = isObject(existingPortalSettings) ? existingPortalSettings : {};
  const basePrefs = isObject(base.preferences) ? base.preferences : {};
  const baseSecurity = isObject(base.security) ? base.security : {};

  return {
    preferences: {
      emailNotifications:
        incomingSettings.preferences.emailNotifications ??
        basePrefs.emailNotifications ??
        fallbackDefaults.settings.preferences.emailNotifications,
      smsNotifications:
        incomingSettings.preferences.smsNotifications ??
        basePrefs.smsNotifications ??
        fallbackDefaults.settings.preferences.smsNotifications,
      productUpdates:
        incomingSettings.preferences.productUpdates ??
        basePrefs.productUpdates ??
        fallbackDefaults.settings.preferences.productUpdates,
      marketingEmails:
        incomingSettings.preferences.marketingEmails ??
        basePrefs.marketingEmails ??
        fallbackDefaults.settings.preferences.marketingEmails,
      rewardAlerts:
        incomingSettings.preferences.rewardAlerts ??
        basePrefs.rewardAlerts ??
        fallbackDefaults.settings.preferences.rewardAlerts,
      securityAlerts:
        incomingSettings.preferences.securityAlerts ??
        basePrefs.securityAlerts ??
        fallbackDefaults.settings.preferences.securityAlerts,
      theme:
        incomingSettings.preferences.theme ||
        basePrefs.theme ||
        fallbackDefaults.settings.preferences.theme,
    },
    security: {
      emailVerified:
        baseSecurity.emailVerified ??
        fallbackDefaults.settings.security.emailVerified,
      twoFactorEnabled:
        incomingSettings.security.twoFactorEnabled ??
        baseSecurity.twoFactorEnabled ??
        fallbackDefaults.settings.security.twoFactorEnabled,
      passwordLastChangedAt:
        baseSecurity.passwordLastChangedAt ??
        fallbackDefaults.settings.security.passwordLastChangedAt,
      changePasswordEndpoint:
        fallbackDefaults.settings.security.changePasswordEndpoint,
      sessionsEndpoint: fallbackDefaults.settings.security.sessionsEndpoint,
    },
  };
}

function buildSettingsResponse({ portal, signupRecord }) {
  const defaults = buildDefaultSettings(portal);
  const portalSettings = isObject(signupRecord?.portal_settings)
    ? signupRecord.portal_settings
    : {};

  return {
    member: {
      ...defaults.member,
      signupId: signupRecord?.id || defaults.member.signupId,
      portalUserId:
        signupRecord?.portal_user_id || defaults.member.portalUserId,
      firstName:
        signupRecord?.first_name || defaults.member.firstName || "",
      lastName:
        signupRecord?.last_name || defaults.member.lastName || "",
      name:
        [
          signupRecord?.first_name || defaults.member.firstName || "",
          signupRecord?.last_name || defaults.member.lastName || "",
        ]
          .join(" ")
          .trim() || defaults.member.name,
      email: signupRecord?.email || defaults.member.email,
      status: signupRecord?.status || defaults.member.status,
      joinedAt: signupRecord?.created_at || defaults.member.joinedAt,
      portalLoginUrl: signupRecord?.portal_login_url || null,
    },
    settings: {
      preferences: {
        emailNotifications:
          portalSettings?.preferences?.emailNotifications ??
          defaults.settings.preferences.emailNotifications,
        smsNotifications:
          portalSettings?.preferences?.smsNotifications ??
          defaults.settings.preferences.smsNotifications,
        productUpdates:
          portalSettings?.preferences?.productUpdates ??
          defaults.settings.preferences.productUpdates,
        marketingEmails:
          portalSettings?.preferences?.marketingEmails ??
          defaults.settings.preferences.marketingEmails,
        rewardAlerts:
          portalSettings?.preferences?.rewardAlerts ??
          defaults.settings.preferences.rewardAlerts,
        securityAlerts:
          portalSettings?.preferences?.securityAlerts ??
          defaults.settings.preferences.securityAlerts,
        theme:
          portalSettings?.preferences?.theme ??
          defaults.settings.preferences.theme,
      },
      security: {
        emailVerified:
          portalSettings?.security?.emailVerified ??
          defaults.settings.security.emailVerified,
        twoFactorEnabled:
          portalSettings?.security?.twoFactorEnabled ??
          defaults.settings.security.twoFactorEnabled,
        passwordLastChangedAt:
          portalSettings?.security?.passwordLastChangedAt ??
          defaults.settings.security.passwordLastChangedAt,
        changePasswordEndpoint:
          defaults.settings.security.changePasswordEndpoint,
        sessionsEndpoint: defaults.settings.security.sessionsEndpoint,
      },
    },
    support: defaults.support,
  };
}

async function resolvePortalContext(req) {
  const session = getSessionFromRequest(req);

  if (!session) {
    return {
      ok: false,
      status: 401,
      message: "You must be logged in to access portal settings.",
    };
  }

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
      message: "We were unable to load your portal settings.",
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
    portal,
    signupRecord,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_settings", method: req.method });

  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return methodNotAllowed(
      res,
      ["GET", "POST", "PATCH"],
      "Method not allowed. Use GET, POST, or PATCH."
    );
  }

  try {
    const rate = portalSettingsRateLimit(req, res);

    if (!rate.allowed) {
      return badRequest(
        res,
        "Too many settings requests. Please try again later.",
        { retryAfter: rate.retryAfter },
        { statusCode: 429, error: "rate_limited" }
      );
    }

    const context = await resolvePortalContext(req);

    if (!context.ok) {
      if (context.status === 401) {
        return unauthorized(res, context.message);
      }

      if (context.status === 403) {
        return forbidden(res, context.message);
      }

      if (context.status === 404) {
        return notFound(res, context.message);
      }

      return serverError(
        res,
        context.message,
        context.error ? { error: context.error.message || "Unknown error." } : null
      );
    }

    const { portal, signupRecord } = context;

    if (req.method === "GET") {
      const payload = buildSettingsResponse({
        portal,
        signupRecord,
      });

      logRequestSuccess(req, {
        scope: "portal_settings_get",
        signupId: signupRecord?.id || null,
        email: signupRecord?.email || null,
      });

      return ok(
        res,
        payload,
        "Portal settings loaded successfully."
      );
    }

    const incomingBody = getRequestBody(req);
    const incomingSettings = sanitizeSettingsInput(incomingBody);
    const defaults = buildDefaultSettings(portal);

    const mergedSettings = mergePortalSettings(
      signupRecord.portal_settings,
      incomingSettings,
      defaults
    );

    const columnMissing = !!signupRecord.__portalSettingsColumnMissing;

    if (columnMissing) {
      const payload = buildSettingsResponse({
        portal,
        signupRecord: {
          ...signupRecord,
          portal_settings: mergedSettings,
        },
      });

      logRequestSuccess(req, {
        scope: "portal_settings_validated_only",
        signupId: signupRecord?.id || null,
        email: signupRecord?.email || null,
      });

      return ok(
        res,
        {
          persisted: false,
          ...payload,
        },
        "Settings validated successfully. Add `portal_settings` to `public.signups` to persist updates."
      );
    }

    const { data: updatedRecord, error: updateError } = await supabaseAdmin
      .from("signups")
      .update({
        portal_settings: mergedSettings,
      })
      .eq("id", signupRecord.id)
      .select(
        "id, email, status, first_name, last_name, phone, city, state, referral_name, interest, goals, created_at, portal_login_url, portal_user_id, portal_settings"
      )
      .single();

    if (updateError) {
      return serverError(
        res,
        "We could not save your portal settings right now.",
        { error: updateError.message || "Unknown settings update error." }
      );
    }

    const payload = buildSettingsResponse({
      portal,
      signupRecord: updatedRecord,
    });

    logRequestSuccess(req, {
      scope: "portal_settings_updated",
      signupId: updatedRecord?.id || null,
      email: updatedRecord?.email || null,
    });

    return ok(
      res,
      {
        persisted: true,
        ...payload,
      },
      "Portal settings updated successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_settings_unexpected" });

    return serverError(
      res,
      "An unexpected error occurred while loading portal settings.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown server error." }
        : null
    );
  }
}