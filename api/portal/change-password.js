// api/portal/change-password.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { changePasswordRateLimit } from "../../lib/rate-limit.js";
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

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

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
  return normalizeText(value).toLowerCase();
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    const parsed = safeJsonParse(req.body, null);
    return isObject(parsed) ? parsed : {};
  }

  return isObject(req.body) ? req.body : {};
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
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
  const cookies = parseCookies(req.headers?.cookie || "");
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

function getSessionExpiresAt(sessionMeta) {
  const session = sessionMeta?.data || {};

  const candidates = [
    session.expires_at,
    session.session?.expires_at,
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
      session.id
  );
}

function getSessionEmail(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeEmail(
    session.member?.email ||
      session.profile?.email ||
      session.user?.email ||
      session.email
  );
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

function sanitizeMember(member) {
  if (!member) return null;

  return {
    id: member.id || null,
    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member),
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    status: member.status || "",
    tier: member.tier || "core",
    referralCode: member.referral_code || "",
    portalUserId: member.portal_user_id || null,
    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,
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
    role: "member",
    status: safeMember.status,
  };
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password || ""))
    .digest("hex");
}

function safeCompareHash(inputHash, storedHash) {
  const cleanInput = normalizeText(inputHash);
  const cleanStored = normalizeText(storedHash);

  if (!cleanInput || !cleanStored) return false;

  let left;
  let right;

  try {
    left = Buffer.from(cleanInput, "hex");
    right = Buffer.from(cleanStored, "hex");
  } catch {
    return false;
  }

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
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
    "interest",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "password_hash",
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
    "interest",
    "password_hash",
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
    let fallbackQuery = supabaseAdmin
      .from("signups")
      .select(baseFields)
      .limit(1);

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
            portal_settings: null,
            portal_sessions: null,
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
      response: unauthorized(res, "You must be logged in to change your password."),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session has expired. Please sign in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session is invalid. Please sign in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);

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
      response: unauthorized(res, "We could not find your member profile. Please sign in again."),
    };
  }

  const status = normalizeStatus(signupRecord.status || "pending");

  if (!ACTIVE_STATUSES.has(status)) {
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
  };
}

function buildUpdatedSessionCookieValue(member, oldSessionMeta, changedAt) {
  const oldValue = oldSessionMeta?.data || {};
  const remember = Boolean(oldValue.remember);

  const now = getUnixNow();
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;

  let expiresAt = Number(oldValue.expires_at || oldValue.session?.expires_at || 0);

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    expiresAt = now + maxAge;
  }

  return {
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember,
    created_at: Number(oldValue.created_at || now),
    checked_at: now,
    password_changed_at: Math.floor(new Date(changedAt).getTime() / 1000),
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

function getSessionMaxAge(sessionMeta) {
  const oldValue = sessionMeta?.data || {};
  const remember = Boolean(oldValue.remember);

  return remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
}

function buildMergedSettings(signupRecord, changedAt) {
  const existingSettings = isObject(signupRecord?.portal_settings)
    ? signupRecord.portal_settings
    : {};

  const existingPreferences = isObject(existingSettings.preferences)
    ? existingSettings.preferences
    : {};

  const existingSecurity = isObject(existingSettings.security)
    ? existingSettings.security
    : {};

  return {
    ...existingSettings,
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
      ...existingSecurity,
      emailVerified:
        existingSecurity.emailVerified ??
        Boolean(signupRecord.email_verified || signupRecord.email_verified_at),
      twoFactorEnabled: existingSecurity.twoFactorEnabled ?? false,
      passwordLastChangedAt: changedAt,
      changePasswordEndpoint: "/api/portal/change-password",
      sessionsEndpoint: "/api/portal/sessions",
      settingsEndpoint: "/api/portal/settings",
    },
  };
}

function buildResponsePayload({ signupRecord, passwordLastChangedAt }) {
  const safeMember = sanitizeMember(signupRecord);
  const existingSettings = isObject(signupRecord?.portal_settings)
    ? signupRecord.portal_settings
    : {};
  const existingSecurity = isObject(existingSettings.security)
    ? existingSettings.security
    : {};

  return {
    changed: true,
    member: {
      id: safeMember.id,
      signupId: safeMember.id,
      portalUserId: safeMember.portalUserId,
      firstName: safeMember.firstName,
      lastName: safeMember.lastName,
      name: safeMember.fullName,
      email: safeMember.email,
      status: safeMember.status,
      portalAccess: true,
      accessLevel: "member",
      joinedAt: safeMember.createdAt,
    },
    security: {
      emailVerified:
        existingSecurity.emailVerified ??
        Boolean(signupRecord.email_verified || signupRecord.email_verified_at),
      twoFactorEnabled: existingSecurity.twoFactorEnabled ?? false,
      passwordLastChangedAt: passwordLastChangedAt || null,
      sessionsEndpoint: "/api/portal/sessions",
      settingsEndpoint: "/api/portal/settings",
    },
    support: {
      email: "support@cardleorewards.com",
      phone: "",
      hours: "Mon–Fri, 9:00 AM–6:00 PM",
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

    if (rate && !rate.allowed) {
      return badRequest(
        res,
        "Too many password change attempts. Please try again later.",
        { retryAfter: rate.retryAfter ?? null },
        { statusCode: 429, error: "rate_limited" }
      );
    }

    const context = await resolvePortalContext(req, res);

    if (!context.ok) {
      return context.response;
    }

    const { sessionMeta, signupRecord } = context;
    const body = getRequestBody(req);

    const currentPassword = String(
      body.currentPassword ||
        body.current_password ||
        body.oldPassword ||
        body.old_password ||
        ""
    );

    const newPassword = String(
      body.newPassword ||
        body.new_password ||
        body.password ||
        ""
    );

    const confirmNewPassword = String(
      body.confirmNewPassword ||
        body.confirm_new_password ||
        body.confirmPassword ||
        body.confirm_password ||
        ""
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

    if (!signupRecord.password_hash) {
      return badRequest(
        res,
        "This account does not have a password yet. Please reset your password first."
      );
    }

    const currentPasswordHash = hashPassword(currentPassword);
    const currentPasswordMatches = safeCompareHash(
      currentPasswordHash,
      signupRecord.password_hash
    );

    if (!currentPasswordMatches) {
      return unauthorized(res, "Your current password is incorrect.");
    }

    const changedAt = new Date().toISOString();
    const newPasswordHash = hashPassword(newPassword);
    const mergedSettings = buildMergedSettings(signupRecord, changedAt);

    const currentSessionId = buildCurrentSessionId(sessionMeta.data);

    let nextSessions = Array.isArray(signupRecord.portal_sessions)
      ? signupRecord.portal_sessions
      : [];

    if (signOutOtherSessions && nextSessions.length) {
      nextSessions = nextSessions.filter((session) => {
        const id = normalizeText(session?.id);
        return id && currentSessionId && id === currentSessionId;
      });
    }

    const updatePayload = {
      password_hash: newPasswordHash,
      updated_at: changedAt,
    };

    if (!signupRecord.__portalSettingsColumnMissing) {
      updatePayload.portal_settings = mergedSettings;
    }

    if (!signupRecord.__portalSessionsColumnMissing) {
      updatePayload.portal_sessions = nextSessions;
    }

    let updateQuery = supabaseAdmin
      .from("signups")
      .update(updatePayload)
      .eq("id", signupRecord.id)
      .select(
        [
          "id",
          "email",
          "status",
          "first_name",
          "last_name",
          "full_name",
          "phone",
          "city",
          "state",
          "interest",
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
        ].join(", ")
      )
      .single();

    let { data: updatedRecord, error: updateError } = await updateQuery;

    if (updateError && isMissingOptionalTableOrColumn(updateError)) {
      const fallbackPayload = {
        password_hash: newPasswordHash,
        updated_at: changedAt,
      };

      const fallback = await supabaseAdmin
        .from("signups")
        .update(fallbackPayload)
        .eq("id", signupRecord.id)
        .select(
          [
            "id",
            "email",
            "status",
            "first_name",
            "last_name",
            "full_name",
            "phone",
            "city",
            "state",
            "interest",
            "created_at",
            "updated_at",
            "portal_login_url",
            "portal_user_id",
          ].join(", ")
        )
        .single();

      updatedRecord = fallback.data
        ? {
            ...fallback.data,
            portal_settings: mergedSettings,
            portal_sessions: nextSessions,
          }
        : null;

      updateError = fallback.error;
    }

    if (updateError) {
      return serverError(
        res,
        "We could not change your password right now.",
        {
          error: updateError.message || "Unknown password update error.",
        }
      );
    }

    const refreshedSession = buildUpdatedSessionCookieValue(
      updatedRecord,
      sessionMeta,
      changedAt
    );

    setSessionCookie(res, JSON.stringify(refreshedSession), {
      httpOnly: true,
      maxAge: getSessionMaxAge(sessionMeta),
    });

    logRequestSuccess(req, {
      scope: "portal_change_password_success",
      signupId: updatedRecord?.id || signupRecord.id,
      email: updatedRecord?.email || signupRecord.email,
      signOutOtherSessions,
      ip: getClientIp(req),
    });

    return ok(
      res,
      buildResponsePayload({
        signupRecord: updatedRecord,
        passwordLastChangedAt:
          updatedRecord?.portal_settings?.security?.passwordLastChangedAt ||
          changedAt,
      }),
      signOutOtherSessions
        ? "Password changed successfully. Other sessions were signed out."
        : "Password changed successfully."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_change_password_unexpected",
    });

    return serverError(
      res,
      "An unexpected error occurred while changing your password.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown server error.",
            code: error?.code || null,
          }
        : null
    );
  }
}