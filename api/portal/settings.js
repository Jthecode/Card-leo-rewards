// api/portal/settings.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { portalSettingsRateLimit } from "../../lib/rate-limit.js";
import {
  setSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_PORTAL_PATH = "/portal/index.html";
const DEFAULT_TIMEZONE = "America/New_York";

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const ALLOWED_THEMES = new Set(["dark", "light", "system"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value || "pending").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeText(value || "core").toLowerCase();

  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) {
    return tier;
  }

  return "core";
}

function normalizeTheme(value, fallback = "dark") {
  const theme = normalizeText(value).toLowerCase();

  if (ALLOWED_THEMES.has(theme)) {
    return theme;
  }

  return fallback;
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function parseCookies(req) {
  if (req?.cookies && typeof req.cookies === "object") {
    return req.cookies;
  }

  const header = req?.headers?.cookie || "";

  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!key) return cookies;

      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }

      return cookies;
    }, {});
}

function readSessionCookie(req) {
  const cookies = parseCookies(req);
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    const raw = cookies[name];

    if (!raw) continue;

    const parsed = safeJsonParse(raw, null);

    if (isObject(parsed)) {
      return {
        cookieName: name,
        raw,
        data: parsed,
      };
    }
  }

  return null;
}

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    const parsed = safeJsonParse(req.body, null);
    return isObject(parsed) ? parsed : {};
  }

  return isObject(req.body) ? req.body : {};
}

function getSessionExpiresAt(sessionMeta) {
  const session = sessionMeta?.data || {};

  const candidates = [
    session.expires_at,
    session.expiresAt,
    session.exp,
    session.session?.expires_at,
    session.session?.expiresAt,
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionMeta) {
  const expiresAt = getSessionExpiresAt(sessionMeta);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeText(
    session.member?.id ||
      session.profile?.id ||
      session.user?.id ||
      session.signupId ||
      session.signup_id ||
      session.memberId ||
      session.member_id ||
      session.id
  );
}

function getSessionEmail(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeEmail(
    session.member?.email ||
      session.profile?.email ||
      session.user?.email ||
      session.email ||
      session.userEmail
  );
}

function getSessionRole(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeText(
    session.role ||
      session.profile?.role ||
      session.user?.role ||
      session.user?.user_metadata?.role ||
      session.member?.role ||
      "member"
  ).toLowerCase();
}

function isAdminRole(role) {
  return ["admin", "support", "owner", "staff"].includes(
    normalizeText(role).toLowerCase()
  );
}

function getSessionMaxAge(sessionMeta) {
  const session = sessionMeta?.data || {};
  const remember = Boolean(session.remember);

  return remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
}

function isMissingOptionalTableOrColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache") ||
    details.includes("does not exist") ||
    details.includes("could not find") ||
    details.includes("schema cache")
  );
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes", "y", "on", "enabled"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "n", "off", "disabled"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function getDisplayName(member) {
  const fullName = normalizeText(member?.full_name);

  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");

  return joined || "Card Leo Member";
}

function normalizeMemberStatus(value) {
  const status = normalizeStatus(value);

  if (["active", "approved", "invited"].includes(status)) return "active";
  if (["pending", "reviewing"].includes(status)) return "pending";
  if (["disabled", "suspended", "paused"].includes(status)) return "suspended";
  if (["denied", "closed"].includes(status)) return status;

  return status || "pending";
}

function sanitizeMember(member) {
  if (!member) return null;

  const status = normalizeStatus(member.status);
  const tier = normalizeTier(member.tier || "core");

  return {
    id: member.id || null,
    signupId: member.id || null,
    portalUserId: member.portal_user_id || null,

    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member),
    name: getDisplayName(member),

    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    goals: member.goals || "",
    referralName: member.referral_name || "",

    status: member.status || "",
    memberStatus: normalizeMemberStatus(member.status),

    tier,
    tierLabel: titleCase(tier),
    referralCode: member.referral_code || "",

    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portalAccess: ACTIVE_STATUSES.has(status),
    accessLevel: "member",

    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,

    joinedAt: member.created_at || null,
    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,

    role: "member",
  };
}

function buildUser(member) {
  const safeMember = sanitizeMember(member);

  if (!safeMember) return null;

  return {
    id: safeMember.id,
    email: safeMember.email,
    role: "member",
    user_metadata: {
      full_name: safeMember.fullName,
      first_name: safeMember.firstName,
      last_name: safeMember.lastName,
      status: safeMember.status,
    },
    app_metadata: {
      provider: "cardleo-signups",
      role: "member",
    },
  };
}

function buildProfile(member) {
  const safeMember = sanitizeMember(member);

  if (!safeMember) return null;

  return {
    id: safeMember.id,
    email: safeMember.email,
    full_name: safeMember.fullName,
    first_name: safeMember.firstName,
    last_name: safeMember.lastName,
    phone: safeMember.phone,
    city: safeMember.city,
    state: safeMember.state,
    interest: safeMember.interest,
    goals: safeMember.goals,
    referral_name: safeMember.referralName,
    tier: safeMember.tier,
    referral_code: safeMember.referralCode,
    role: "member",
    status: safeMember.status,
    email_verified: safeMember.emailVerified,
    email_verified_at: safeMember.emailVerifiedAt,
    created_at: safeMember.createdAt,
    updated_at: safeMember.updatedAt,
  };
}

async function getSignupRecord({ signupId, email }) {
  const extendedFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "referral_name",
    "interest",
    "goals",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
    "portal_settings",
    "portal_sessions",
  ].join(", ");

  const baseFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "referral_name",
    "interest",
    "goals",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  let query = supabaseAdmin.from("signups").select(extendedFields).limit(1);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.eq("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").select(baseFields).limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            portal_settings: {},
            portal_sessions: [],
            __portalSettingsColumnMissing: true,
            __portalSessionsColumnMissing: true,
          }
        : null,
      error: fallback.error,
    };
  }

  return result;
}

async function resolvePortalContext(req, res) {
  const sessionMeta = readSessionCookie(req);

  if (!sessionMeta?.data) {
    return {
      ok: false,
      response: unauthorized(res, "You must be logged in to access portal settings."),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session has expired. Please log in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session is invalid. Please log in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);
  const role = getSessionRole(sessionMeta);

  if (!signupId && !email) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session is missing member information."),
    };
  }

  const { data: signupRecord, error } = await getSignupRecord({
    signupId,
    email,
  });

  if (error) {
    throw error;
  }

  if (!signupRecord?.id) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: notFound(res, "We could not locate your member account."),
    };
  }

  const status = normalizeStatus(signupRecord.status || "pending");

  if (!ACTIVE_STATUSES.has(status) && !isAdminRole(role)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active."
      ),
    };
  }

  return {
    ok: true,
    sessionMeta,
    signupRecord,
    role,
    response: null,
  };
}

function buildDefaultSettings(member) {
  return {
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
      emailVerified: Boolean(member?.email_verified || member?.email_verified_at),
      twoFactorEnabled: false,
      passwordLastChangedAt: null,
      changePasswordEndpoint: "/api/portal/change-password",
      sessionsEndpoint: "/api/portal/sessions",
      settingsEndpoint: "/api/portal/settings",
    },
    support: {
      email: "support@cardleorewards.com",
      phone: "",
      hours: "Mon–Fri, 9:00 AM–6:00 PM",
      endpoint: "/api/contact",
    },
  };
}

function sanitizeSettingsInput(body = {}) {
  const rawPreferences = isObject(body.preferences) ? body.preferences : {};
  const rawSecurity = isObject(body.security) ? body.security : {};

  const preferences = {};
  const security = {};

  const preferenceKeys = [
    "emailNotifications",
    "smsNotifications",
    "productUpdates",
    "marketingEmails",
    "rewardAlerts",
    "securityAlerts",
  ];

  for (const key of preferenceKeys) {
    if (hasOwn(rawPreferences, key)) {
      preferences[key] = toBoolean(rawPreferences[key]);
    }

    if (hasOwn(body, key)) {
      preferences[key] = toBoolean(body[key]);
    }
  }

  if (hasOwn(rawPreferences, "theme")) {
    preferences.theme = normalizeTheme(rawPreferences.theme);
  }

  if (hasOwn(body, "theme")) {
    preferences.theme = normalizeTheme(body.theme);
  }

  if (hasOwn(rawSecurity, "twoFactorEnabled")) {
    security.twoFactorEnabled = toBoolean(rawSecurity.twoFactorEnabled);
  }

  if (hasOwn(body, "twoFactorEnabled")) {
    security.twoFactorEnabled = toBoolean(body.twoFactorEnabled);
  }

  return {
    preferences,
    security,
  };
}

function mergePortalSettings(existingPortalSettings, incomingSettings, defaults) {
  const existing = isObject(existingPortalSettings) ? existingPortalSettings : {};
  const existingPreferences = isObject(existing.preferences)
    ? existing.preferences
    : {};
  const existingSecurity = isObject(existing.security) ? existing.security : {};
  const existingSupport = isObject(existing.support) ? existing.support : {};

  return {
    ...existing,
    preferences: {
      emailNotifications:
        incomingSettings.preferences.emailNotifications ??
        existingPreferences.emailNotifications ??
        defaults.preferences.emailNotifications,

      smsNotifications:
        incomingSettings.preferences.smsNotifications ??
        existingPreferences.smsNotifications ??
        defaults.preferences.smsNotifications,

      productUpdates:
        incomingSettings.preferences.productUpdates ??
        existingPreferences.productUpdates ??
        defaults.preferences.productUpdates,

      marketingEmails:
        incomingSettings.preferences.marketingEmails ??
        existingPreferences.marketingEmails ??
        defaults.preferences.marketingEmails,

      rewardAlerts:
        incomingSettings.preferences.rewardAlerts ??
        existingPreferences.rewardAlerts ??
        defaults.preferences.rewardAlerts,

      securityAlerts:
        incomingSettings.preferences.securityAlerts ??
        existingPreferences.securityAlerts ??
        defaults.preferences.securityAlerts,

      theme:
        incomingSettings.preferences.theme ||
        existingPreferences.theme ||
        defaults.preferences.theme,
    },
    security: {
      ...existingSecurity,
      emailVerified:
        existingSecurity.emailVerified ?? defaults.security.emailVerified,

      twoFactorEnabled:
        incomingSettings.security.twoFactorEnabled ??
        existingSecurity.twoFactorEnabled ??
        defaults.security.twoFactorEnabled,

      passwordLastChangedAt:
        existingSecurity.passwordLastChangedAt ??
        defaults.security.passwordLastChangedAt,

      changePasswordEndpoint: "/api/portal/change-password",
      sessionsEndpoint: "/api/portal/sessions",
      settingsEndpoint: "/api/portal/settings",
    },
    support: {
      email: existingSupport.email || defaults.support.email,
      phone: existingSupport.phone || defaults.support.phone,
      hours: existingSupport.hours || defaults.support.hours,
      endpoint: "/api/contact",
    },
    updatedAt: new Date().toISOString(),
  };
}

function buildSessionCookieValue(member, oldSessionMeta) {
  const oldValue = oldSessionMeta?.data || {};
  const remember = Boolean(oldValue.remember);

  const now = getUnixNow();
  const maxAge = getSessionMaxAge(oldSessionMeta);

  let expiresAt = Number(oldValue.expires_at || oldValue.session?.expires_at || 0);

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    expiresAt = now + maxAge;
  }

  return {
    ...oldValue,
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember,
    checked_at: now,
    expires_at: expiresAt,
    member: sanitizeMember(member),
    user: buildUser(member),
    profile: buildProfile(member),
    role: "member",
    redirectTo: DEFAULT_PORTAL_PATH,
    session: {
      access_token: null,
      refresh_token: null,
      expires_at: expiresAt,
      expires_in: Math.max(0, expiresAt - now),
      token_type: "custom",
    },
  };
}

function buildSettingsResponse({ signupRecord, persisted = true }) {
  const safeMember = sanitizeMember(signupRecord);
  const defaults = buildDefaultSettings(signupRecord);
  const portalSettings = isObject(signupRecord?.portal_settings)
    ? signupRecord.portal_settings
    : {};

  const preferences = {
    emailNotifications:
      portalSettings.preferences?.emailNotifications ??
      defaults.preferences.emailNotifications,
    smsNotifications:
      portalSettings.preferences?.smsNotifications ??
      defaults.preferences.smsNotifications,
    productUpdates:
      portalSettings.preferences?.productUpdates ??
      defaults.preferences.productUpdates,
    marketingEmails:
      portalSettings.preferences?.marketingEmails ??
      defaults.preferences.marketingEmails,
    rewardAlerts:
      portalSettings.preferences?.rewardAlerts ??
      defaults.preferences.rewardAlerts,
    securityAlerts:
      portalSettings.preferences?.securityAlerts ??
      defaults.preferences.securityAlerts,
    theme: portalSettings.preferences?.theme ?? defaults.preferences.theme,
  };

  const security = {
    emailVerified:
      portalSettings.security?.emailVerified ?? defaults.security.emailVerified,
    twoFactorEnabled:
      portalSettings.security?.twoFactorEnabled ??
      defaults.security.twoFactorEnabled,
    passwordLastChangedAt:
      portalSettings.security?.passwordLastChangedAt ??
      defaults.security.passwordLastChangedAt,
    changePasswordEndpoint: "/api/portal/change-password",
    sessionsEndpoint: "/api/portal/sessions",
    settingsEndpoint: "/api/portal/settings",
  };

  const support = {
    email: portalSettings.support?.email || defaults.support.email,
    phone: portalSettings.support?.phone || defaults.support.phone,
    hours: portalSettings.support?.hours || defaults.support.hours,
    endpoint: "/api/contact",
  };

  return {
    persisted,
    member: {
      id: safeMember.id,
      signupId: safeMember.signupId,
      portalUserId: safeMember.portalUserId,
      firstName: safeMember.firstName,
      lastName: safeMember.lastName,
      name: safeMember.fullName,
      email: safeMember.email,
      status: safeMember.status,
      memberStatus: safeMember.memberStatus,
      tier: safeMember.tier,
      tierLabel: safeMember.tierLabel,
      portalAccess: safeMember.portalAccess,
      accessLevel: safeMember.accessLevel,
      joinedAt: safeMember.joinedAt,
      portalLoginUrl: safeMember.portalLoginUrl,
    },
    settings: {
      preferences,
      security,
      support,
    },
    preferences,
    security,
    support,
    endpoints: {
      settings: "/api/portal/settings",
      profile: "/api/portal/profile",
      sessions: "/api/portal/sessions",
      changePassword: "/api/portal/change-password",
    },
    timezone: DEFAULT_TIMEZONE,
  };
}

async function updateSignupSettings(signupRecord, mergedSettings) {
  const updatePayload = {
    updated_at: new Date().toISOString(),
  };

  if (!signupRecord.__portalSettingsColumnMissing) {
    updatePayload.portal_settings = mergedSettings;
  }

  const extendedSelect = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "referral_name",
    "interest",
    "goals",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
    "portal_settings",
    "portal_sessions",
  ].join(", ");

  const baseSelect = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "referral_name",
    "interest",
    "goals",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  let { data, error } = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", signupRecord.id)
    .select(extendedSelect)
    .single();

  if (error && isMissingOptionalTableOrColumn(error)) {
    const fallback = await supabaseAdmin
      .from("signups")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", signupRecord.id)
      .select(baseSelect)
      .single();

    data = fallback.data
      ? {
          ...fallback.data,
          portal_settings: mergedSettings,
          portal_sessions: signupRecord.portal_sessions || [],
          __portalSettingsColumnMissing: true,
        }
      : null;

    error = fallback.error;

    return {
      data,
      error,
      persisted: false,
    };
  }

  return {
    data: data
      ? {
          ...data,
          portal_settings: isObject(data.portal_settings)
            ? data.portal_settings
            : mergedSettings,
        }
      : null,
    error,
    persisted: !signupRecord.__portalSettingsColumnMissing,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, {
    scope: "portal_settings",
    method: req.method,
  });

  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return methodNotAllowed(
      res,
      ["GET", "POST", "PATCH"],
      "Method not allowed. Use GET, POST, or PATCH."
    );
  }

  try {
    const rate = portalSettingsRateLimit(req, res);

    if (rate && !rate.allowed) {
      return badRequest(
        res,
        "Too many settings requests. Please try again later.",
        {
          retryAfter: rate.retryAfter ?? null,
        },
        {
          statusCode: 429,
          error: "rate_limited",
        }
      );
    }

    const context = await resolvePortalContext(req, res);

    if (!context.ok) {
      return context.response;
    }

    const { sessionMeta, signupRecord } = context;

    if (req.method === "GET") {
      logRequestSuccess(req, {
        scope: "portal_settings_get",
        signupId: signupRecord.id,
        email: signupRecord.email,
      });

      return ok(
        res,
        buildSettingsResponse({
          signupRecord,
          persisted: !signupRecord.__portalSettingsColumnMissing,
        }),
        "Portal settings loaded successfully."
      );
    }

    const body = getRequestBody(req);
    const incomingSettings = sanitizeSettingsInput(body);
    const defaults = buildDefaultSettings(signupRecord);

    const mergedSettings = mergePortalSettings(
      signupRecord.portal_settings,
      incomingSettings,
      defaults
    );

    const updateResult = await updateSignupSettings(
      signupRecord,
      mergedSettings
    );

    if (updateResult.error) {
      return serverError(
        res,
        "We could not save your portal settings right now.",
        process.env.NODE_ENV === "development"
          ? {
              error: updateResult.error.message || "Unknown settings update error.",
              code: updateResult.error.code || null,
            }
          : null
      );
    }

    const updatedRecord = updateResult.data || {
      ...signupRecord,
      portal_settings: mergedSettings,
    };

    const refreshedSession = buildSessionCookieValue(updatedRecord, sessionMeta);

    setSessionCookie(res, JSON.stringify(refreshedSession), {
      httpOnly: true,
      maxAge: getSessionMaxAge(sessionMeta),
    });

    logRequestSuccess(req, {
      scope: "portal_settings_updated",
      signupId: updatedRecord.id,
      email: updatedRecord.email,
      persisted: updateResult.persisted,
    });

    return ok(
      res,
      buildSettingsResponse({
        signupRecord: updatedRecord,
        persisted: updateResult.persisted,
      }),
      updateResult.persisted
        ? "Portal settings updated successfully."
        : "Settings validated successfully. Add portal_settings to public.signups to persist updates."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_settings_unexpected",
    });

    return serverError(
      res,
      "An unexpected error occurred while loading portal settings.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown server error.",
            code: error?.code || null,
          }
        : null
    );
  }
}