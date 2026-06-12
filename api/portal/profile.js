// api/portal/profile.js
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

const ALLOWED_INTERESTS = new Set([
  "",
  "savings-only",
  "savings-and-opportunity",
  "need-more-info",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
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

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!name) return cookies;

      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
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

function getDisplayName(member) {
  const fullName = normalizeText(member?.full_name);

  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map((value) => normalizeText(value))
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

  const safeStatus = normalizeStatus(member.status);
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
    portalAccess: ACTIVE_STATUSES.has(safeStatus),
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
    first_name: safeMember.firstName,
    last_name: safeMember.lastName,
    full_name: safeMember.fullName,
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

function buildSupportPayload(settings = {}) {
  const support = isObject(settings.support) ? settings.support : {};

  return {
    email: normalizeText(support.email, "support@cardleorewards.com"),
    phone: normalizeText(support.phone, ""),
    hours: normalizeText(support.hours, "Mon–Fri, 9:00 AM–6:00 PM"),
    endpoint: "/api/contact",
  };
}

function buildSecurityPayload(member, settings = {}) {
  const security = isObject(settings.security) ? settings.security : {};

  return {
    emailVerified:
      security.emailVerified ??
      Boolean(member?.email_verified || member?.email_verified_at),
    twoFactorEnabled: security.twoFactorEnabled ?? false,
    passwordLastChangedAt: security.passwordLastChangedAt || null,
    changePasswordEndpoint: "/api/portal/change-password",
    sessionsEndpoint: "/api/portal/sessions",
    settingsEndpoint: "/api/portal/settings",
  };
}

function buildPreferencesPayload(settings = {}) {
  const preferences = isObject(settings.preferences) ? settings.preferences : {};

  return {
    emailNotifications: preferences.emailNotifications ?? true,
    smsNotifications: preferences.smsNotifications ?? false,
    productUpdates: preferences.productUpdates ?? true,
    marketingEmails: preferences.marketingEmails ?? true,
    rewardAlerts: preferences.rewardAlerts ?? true,
    securityAlerts: preferences.securityAlerts ?? true,
    theme: preferences.theme || "dark",
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
    "interest",
    "goals",
    "referral_name",
    "agreed",
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
    "interest",
    "goals",
    "referral_name",
    "agreed",
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
            portal_settings: {},
            portal_sessions: [],
            __optionalProfileColumnsMissing: true,
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
      response: unauthorized(
        res,
        "Authentication required. Please log in to continue."
      ),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Session expired. Please log in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Invalid session. Please log in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);
  const role = getSessionRole(sessionMeta);

  if (!signupId && !email) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(
        res,
        "Your session is missing member identity details. Please log in again."
      ),
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
      response: notFound(
        res,
        "We could not locate your Card Leo Rewards member profile.",
        {
          member: null,
          profile: null,
          support: buildSupportPayload(),
        }
      ),
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
          : "Your account is not active.",
        {
          member: sanitizeMember(signupRecord),
          profile: buildProfile(signupRecord),
          support: buildSupportPayload(signupRecord.portal_settings || {}),
        }
      ),
    };
  }

  return {
    ok: true,
    sessionMeta,
    signupRecord,
    role,
  };
}

function buildSessionCookieValue(member, oldSessionMeta) {
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

function validateProfileUpdate(body) {
  const firstName = normalizeText(body.firstName || body.first_name);
  const lastName = normalizeText(body.lastName || body.last_name);
  const phone = normalizeText(body.phone);
  const city = normalizeText(body.city);
  const state = normalizeText(body.state);
  const interest = normalizeText(body.interest);
  const goals = normalizeText(body.goals);
  const referralName = normalizeText(body.referralName || body.referral_name);

  const errors = {};

  if (Object.prototype.hasOwnProperty.call(body, "firstName") && !firstName) {
    errors.firstName = "First name cannot be blank.";
  }

  if (Object.prototype.hasOwnProperty.call(body, "lastName") && !lastName) {
    errors.lastName = "Last name cannot be blank.";
  }

  if (phone && phone.replace(/\D/g, "").length < 10) {
    errors.phone = "Please enter a valid phone number.";
  }

  if (!ALLOWED_INTERESTS.has(interest)) {
    errors.interest = "Please choose a valid membership interest.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: {
      firstName,
      lastName,
      phone,
      city,
      state,
      interest,
      goals,
      referralName,
    },
  };
}

function buildUpdatePayload(body, currentRecord) {
  const validation = validateProfileUpdate(body);

  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      payload: {},
    };
  }

  const values = validation.values;
  const payload = {};

  if ("firstName" in body || "first_name" in body) {
    payload.first_name = values.firstName;
  }

  if ("lastName" in body || "last_name" in body) {
    payload.last_name = values.lastName;
  }

  if ("phone" in body) {
    payload.phone = values.phone || null;
  }

  if ("city" in body) {
    payload.city = values.city || null;
  }

  if ("state" in body) {
    payload.state = values.state || null;
  }

  if ("interest" in body) {
    payload.interest = values.interest || null;
  }

  if ("goals" in body) {
    payload.goals = values.goals || null;
  }

  if ("referralName" in body || "referral_name" in body) {
    payload.referral_name = values.referralName || null;
  }

  const nextFirstName = payload.first_name ?? currentRecord.first_name ?? "";
  const nextLastName = payload.last_name ?? currentRecord.last_name ?? "";

  payload.full_name = [nextFirstName, nextLastName]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");

  payload.updated_at = new Date().toISOString();

  return {
    valid: true,
    errors: {},
    payload,
  };
}

function buildProfilePayload(member) {
  const settings = isObject(member?.portal_settings)
    ? member.portal_settings
    : {};

  const safeMember = sanitizeMember(member);
  const profile = buildProfile(member);

  return {
    member: safeMember,
    profile,
    overview: {
      member: safeMember,
      timezone: DEFAULT_TIMEZONE,
      profileCompletion: {
        hasName: Boolean(safeMember.firstName && safeMember.lastName),
        hasEmail: Boolean(safeMember.email),
        hasPhone: Boolean(safeMember.phone),
        hasLocation: Boolean(safeMember.city || safeMember.state),
      },
    },
    preferences: buildPreferencesPayload(settings),
    security: buildSecurityPayload(member, settings),
    support: buildSupportPayload(settings),
    sessions: Array.isArray(member?.portal_sessions)
      ? member.portal_sessions
      : [],
    endpoints: {
      profile: "/api/portal/profile",
      settings: "/api/portal/settings",
      changePassword: "/api/portal/change-password",
      sessions: "/api/portal/sessions",
    },
  };
}

async function handleGetProfile(req, res) {
  const context = await resolvePortalContext(req, res);

  if (!context.ok) {
    return context.response;
  }

  const { signupRecord } = context;
  const payload = buildProfilePayload(signupRecord);

  logRequestSuccess(req, {
    scope: "portal_profile",
    memberId: signupRecord.id,
    email: signupRecord.email,
    ip: getClientIp(req),
  });

  return ok(res, payload, "Member profile loaded successfully.");
}

async function handleUpdateProfile(req, res) {
  const context = await resolvePortalContext(req, res);

  if (!context.ok) {
    return context.response;
  }

  const { sessionMeta, signupRecord } = context;
  const body = getRequestBody(req);

  const built = buildUpdatePayload(body, signupRecord);

  if (!built.valid) {
    return badRequest(
      res,
      "Please correct the highlighted profile fields.",
      built.errors
    );
  }

  if (Object.keys(built.payload).length <= 1 && built.payload.updated_at) {
    return badRequest(res, "No profile changes were provided.");
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
    "interest",
    "goals",
    "referral_name",
    "agreed",
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
    "interest",
    "goals",
    "referral_name",
    "agreed",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  let { data: updatedRecord, error: updateError } = await supabaseAdmin
    .from("signups")
    .update(built.payload)
    .eq("id", signupRecord.id)
    .select(extendedSelect)
    .single();

  if (updateError && isMissingOptionalTableOrColumn(updateError)) {
    const fallback = await supabaseAdmin
      .from("signups")
      .update(built.payload)
      .eq("id", signupRecord.id)
      .select(baseSelect)
      .single();

    updatedRecord = fallback.data
      ? {
          ...fallback.data,
          portal_settings: signupRecord.portal_settings || {},
          portal_sessions: signupRecord.portal_sessions || [],
        }
      : null;

    updateError = fallback.error;
  }

  if (updateError) {
    return serverError(
      res,
      "We could not update your profile right now.",
      process.env.NODE_ENV === "development"
        ? {
            error: updateError.message || "Unknown update error.",
            code: updateError.code || null,
          }
        : null
    );
  }

  const refreshedSession = buildSessionCookieValue(updatedRecord, sessionMeta);

  setSessionCookie(res, JSON.stringify(refreshedSession), {
    httpOnly: true,
    maxAge: getSessionMaxAge(sessionMeta),
  });

  const payload = buildProfilePayload(updatedRecord);

  logRequestSuccess(req, {
    scope: "portal_profile_update",
    memberId: updatedRecord.id,
    email: updatedRecord.email,
    ip: getClientIp(req),
  });

  return ok(res, payload, "Profile updated successfully.");
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_profile" });

  try {
    if (req.method === "GET") {
      return handleGetProfile(req, res);
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      return handleUpdateProfile(req, res);
    }

    return methodNotAllowed(
      res,
      ["GET", "PATCH", "PUT"],
      "Method not allowed. Use GET, PATCH, or PUT."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_profile_unexpected",
    });

    return serverError(
      res,
      "We were unable to load or update the member profile.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown error.",
            code: error?.code || null,
          }
        : {
            member: null,
            profile: null,
            support: buildSupportPayload(),
          }
    );
  }
}