// api/portal/sessions.js
import { createHash, randomUUID } from "crypto";
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

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const AUTH_COOKIE_ALIASES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
  "access_token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
];

const ALLOWED_ACTIONS = new Set([
  "sign_out_current",
  "sign_out_others",
  "revoke_session",
  "clear_all",
]);

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

function safeDate(value) {
  if (!value) return null;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const num = Number(value);
    const date = new Date(num > 9999999999 ? num : num * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getClientIp(req) {
  const forwarded =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"] ||
    "";

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "";
}

function maskIpAddress(ip = "") {
  const value = normalizeText(ip);

  if (!value) return "";

  if (value.includes(".")) {
    const parts = value.split(".");

    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
  }

  if (value.includes(":")) {
    const parts = value.split(":").filter(Boolean);
    return `${parts.slice(0, 2).join(":")}:****`;
  }

  return value;
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

function detectBrowser(userAgent = "") {
  const ua = String(userAgent).toLowerCase();

  if (ua.includes("edg/")) return "Microsoft Edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
  if (ua.includes("chrome/") && !ua.includes("edg/")) return "Chrome";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  if (ua.includes("msie") || ua.includes("trident/")) return "Internet Explorer";

  return "Unknown Browser";
}

function detectOs(userAgent = "") {
  const ua = String(userAgent).toLowerCase();

  if (ua.includes("windows nt")) return "Windows";
  if (ua.includes("mac os x")) return "macOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) {
    return "iOS";
  }
  if (ua.includes("linux")) return "Linux";

  return "Unknown OS";
}

function detectDeviceType(userAgent = "") {
  const ua = String(userAgent).toLowerCase();

  if (ua.includes("ipad") || ua.includes("tablet")) {
    return "tablet";
  }

  if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android")) {
    return "mobile";
  }

  return "desktop";
}

function buildSessionLabel({ browser, os, deviceType }) {
  const parts = [];

  if (browser && browser !== "Unknown Browser") parts.push(browser);
  if (os && os !== "Unknown OS") parts.push(os);
  if (deviceType) parts.push(titleCase(deviceType));

  return parts.join(" • ") || "Current Session";
}

function createSessionId(seed) {
  return createHash("sha256")
    .update(String(seed || randomUUID()))
    .digest("hex")
    .slice(0, 24);
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
    status: member.status || "",
    memberStatus: ACTIVE_STATUSES.has(status) ? "active" : status,
    tier,
    tierLabel: titleCase(tier),
    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portalAccess: ACTIVE_STATUSES.has(status),
    accessLevel: "member",
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
    role: "member",
    status: safeMember.status,
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
    "tier",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
    "portal_sessions",
  ].join(", ");

  const baseFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
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
            portal_sessions: [],
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
      response: unauthorized(res, "You must be logged in to access portal sessions."),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearEveryAuthCookie(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session has expired. Please log in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearEveryAuthCookie(res);

    return {
      ok: false,
      response: unauthorized(res, "Your session is invalid. Please log in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);
  const role = getSessionRole(sessionMeta);

  if (!signupId && !email) {
    clearEveryAuthCookie(res);

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
    clearEveryAuthCookie(res);

    return {
      ok: false,
      response: notFound(res, "We could not locate your member account."),
    };
  }

  const status = normalizeStatus(signupRecord.status || "pending");

  if (!ACTIVE_STATUSES.has(status) && !isAdminRole(role)) {
    clearEveryAuthCookie(res);

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

function normalizeStoredSession(session = {}) {
  const createdAt =
    safeDate(session.createdAt || session.created_at) ||
    new Date().toISOString();

  const lastActiveAt =
    safeDate(
      session.lastActiveAt ||
        session.last_active_at ||
        session.updatedAt ||
        session.updated_at
    ) || createdAt;

  return {
    id: normalizeText(session.id) || randomUUID(),
    current: Boolean(session.current),
    label: normalizeText(session.label) || "Saved Session",
    browser: normalizeText(session.browser) || "Unknown Browser",
    os: normalizeText(session.os) || "Unknown OS",
    deviceType:
      normalizeText(session.deviceType || session.device_type) || "desktop",
    ipAddressMasked:
      normalizeText(session.ipAddressMasked || session.ip_address_masked) ||
      maskIpAddress(session.ipAddress || session.ip_address || ""),
    userAgent: normalizeText(session.userAgent || session.user_agent),
    createdAt,
    lastActiveAt,
    expiresAt: safeDate(session.expiresAt || session.expires_at),
    revokedAt: safeDate(session.revokedAt || session.revoked_at),
  };
}

function buildCurrentSession(req, context) {
  const sessionData = context.sessionMeta?.data || {};
  const userAgent = normalizeText(req.headers?.["user-agent"]);
  const browser = detectBrowser(userAgent);
  const os = detectOs(userAgent);
  const deviceType = detectDeviceType(userAgent);
  const ipAddress = getClientIp(req);

  const existingSessionId = normalizeText(
    sessionData.sessionId ||
      sessionData.session_id ||
      sessionData.sid ||
      sessionData.jti ||
      sessionData.tokenId
  );

  const issuedAt =
    sessionData.issuedAt ||
    sessionData.iat ||
    sessionData.created_at ||
    sessionData.createdAt ||
    sessionData.session?.created_at ||
    null;

  const expiresAt =
    sessionData.expires_at ||
    sessionData.expiresAt ||
    sessionData.exp ||
    sessionData.session?.expires_at ||
    null;

  const rawSeed = [
    existingSessionId,
    context.signupRecord?.id,
    context.signupRecord?.email,
    issuedAt,
    userAgent,
  ]
    .filter(Boolean)
    .join("|");

  const id =
    existingSessionId ||
    createSessionId(rawSeed || `${context.signupRecord?.email}|${userAgent}`);

  const nowIso = new Date().toISOString();

  return {
    id,
    current: true,
    label: buildSessionLabel({ browser, os, deviceType }),
    browser,
    os,
    deviceType,
    ipAddressMasked: maskIpAddress(ipAddress),
    userAgent,
    createdAt: safeDate(issuedAt) || nowIso,
    lastActiveAt: nowIso,
    expiresAt: safeDate(expiresAt),
    revokedAt: null,
  };
}

function mergeSessions(existingSessions = [], currentSession) {
  const byId = new Map();

  for (const item of Array.isArray(existingSessions) ? existingSessions : []) {
    const normalized = normalizeStoredSession(item);

    if (!normalized.revokedAt) {
      byId.set(normalized.id, {
        ...normalized,
        current: false,
      });
    }
  }

  byId.set(currentSession.id, normalizeStoredSession(currentSession));

  return Array.from(byId.values())
    .map((item) => ({
      ...item,
      current: item.id === currentSession.id,
    }))
    .sort((a, b) => {
      if (a.current && !b.current) return -1;
      if (!a.current && b.current) return 1;

      return (
        new Date(b.lastActiveAt || b.createdAt || 0).getTime() -
        new Date(a.lastActiveAt || a.createdAt || 0).getTime()
      );
    });
}

function buildUpdatedSessionCookieValue(member, oldSessionMeta, currentSession) {
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
    sessionId: currentSession.id,
    session_id: currentSession.id,
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

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader("Set-Cookie");

  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [existing, cookieValue]);
}

function buildExpiredCookie(name, { httpOnly = true } = {}) {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax",
  ];

  if (httpOnly) parts.push("HttpOnly");
  if (process.env.NODE_ENV === "production") parts.push("Secure");

  return parts.join("; ");
}

function clearCookieAliases(res) {
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...AUTH_COOKIE_ALIASES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: true }));
    appendSetCookie(res, buildExpiredCookie(name, { httpOnly: false }));
  }
}

function clearEveryAuthCookie(res) {
  clearAuthCookies(res);
  clearCookieAliases(res);
}

function getActionFromRequest(req) {
  const body = getRequestBody(req);

  return {
    action: normalizeText(body.action || req.query?.action).toLowerCase(),
    sessionId: normalizeText(body.sessionId || body.session_id || body.id || req.query?.sessionId),
    body,
  };
}

function buildSupportPayload() {
  return {
    email: "support@cardleorewards.com",
    phone: "",
    hours: "Mon–Fri, 9:00 AM–6:00 PM",
    endpoint: "/api/contact",
  };
}

function buildResponsePayload({
  signupRecord,
  sessions,
  persisted = true,
  signedOut = false,
}) {
  const safeMember = sanitizeMember(signupRecord);
  const currentSession = sessions.find((item) => item.current) || null;

  return {
    signedOut,
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
      portalAccess: safeMember.portalAccess,
      accessLevel: safeMember.accessLevel,
      joinedAt: safeMember.joinedAt,
    },
    sessions: {
      persisted,
      totalSessions: sessions.length,
      currentSessionId: currentSession?.id || null,
      sessions,
    },
    support: buildSupportPayload(),
  };
}

async function persistSessions(signupRecord, sessions) {
  if (signupRecord.__portalSessionsColumnMissing) {
    return {
      data: {
        ...signupRecord,
        portal_sessions: sessions,
      },
      error: null,
      persisted: false,
    };
  }

  const { data, error } = await supabaseAdmin
    .from("signups")
    .update({
      portal_sessions: sessions,
      updated_at: new Date().toISOString(),
    })
    .eq("id", signupRecord.id)
    .select(
      [
        "id",
        "email",
        "status",
        "first_name",
        "last_name",
        "full_name",
        "tier",
        "created_at",
        "updated_at",
        "portal_login_url",
        "portal_user_id",
        "portal_sessions",
      ].join(", ")
    )
    .single();

  if (error && isMissingOptionalTableOrColumn(error)) {
    const fallback = await supabaseAdmin
      .from("signups")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", signupRecord.id)
      .select(
        [
          "id",
          "email",
          "status",
          "first_name",
          "last_name",
          "full_name",
          "created_at",
          "updated_at",
          "portal_login_url",
          "portal_user_id",
        ].join(", ")
      )
      .single();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            portal_sessions: sessions,
            __portalSessionsColumnMissing: true,
          }
        : null,
      error: fallback.error,
      persisted: false,
    };
  }

  return {
    data,
    error,
    persisted: true,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, {
    scope: "portal_sessions",
    method: req.method,
  });

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return methodNotAllowed(
      res,
      ["GET", "POST", "DELETE"],
      "Method not allowed. Use GET, POST, or DELETE."
    );
  }

  try {
    const context = await resolvePortalContext(req, res);

    if (!context.ok) {
      return context.response;
    }

    const { signupRecord, sessionMeta } = context;

    const existingSessions = Array.isArray(signupRecord.portal_sessions)
      ? signupRecord.portal_sessions
      : [];

    const currentSession = buildCurrentSession(req, context);
    let sessions = mergeSessions(existingSessions, currentSession);

    if (req.method === "GET") {
      const persistedResult = await persistSessions(signupRecord, sessions);

      if (persistedResult.error) {
        return serverError(res, "We could not update your portal session list.", {
          error: persistedResult.error.message || "Unknown sessions update error.",
        });
      }

      const updatedCookie = buildUpdatedSessionCookieValue(
        persistedResult.data || signupRecord,
        sessionMeta,
        currentSession
      );

      setSessionCookie(res, JSON.stringify(updatedCookie), {
        httpOnly: true,
        maxAge: getSessionMaxAge(sessionMeta),
      });

      logRequestSuccess(req, {
        scope: "portal_sessions_get",
        signupId: signupRecord.id,
        totalSessions: sessions.length,
      });

      return ok(
        res,
        buildResponsePayload({
          signupRecord: persistedResult.data || signupRecord,
          sessions,
          persisted: persistedResult.persisted,
          signedOut: false,
        }),
        "Portal sessions loaded successfully."
      );
    }

    const { action, sessionId } = getActionFromRequest(req);

    if (!action || !ALLOWED_ACTIONS.has(action)) {
      return badRequest(
        res,
        "A valid action is required. Use sign_out_current, sign_out_others, revoke_session, or clear_all.",
        {
          allowedActions: Array.from(ALLOWED_ACTIONS),
        }
      );
    }

    let message = "Portal sessions updated successfully.";
    let signedOut = false;

    if (req.method === "DELETE" && !action) {
      return badRequest(res, "Missing session action.");
    }

    if (action === "sign_out_current") {
      sessions = sessions.filter((item) => item.id !== currentSession.id);
      clearEveryAuthCookie(res);
      signedOut = true;
      message = "Current session signed out successfully.";
    }

    if (action === "sign_out_others") {
      sessions = sessions.filter((item) => item.id === currentSession.id);
      message = "All other sessions were signed out successfully.";
    }

    if (action === "revoke_session") {
      if (!sessionId) {
        return badRequest(res, "A sessionId is required when using revoke_session.");
      }

      const isCurrent = sessionId === currentSession.id;

      sessions = sessions.filter((item) => item.id !== sessionId);

      if (isCurrent) {
        clearEveryAuthCookie(res);
        signedOut = true;
        message = "Current session revoked successfully.";
      } else {
        message = "Selected session revoked successfully.";
      }
    }

    if (action === "clear_all") {
      sessions = [];
      clearEveryAuthCookie(res);
      signedOut = true;
      message = "All sessions were cleared successfully.";
    }

    const persistedResult = await persistSessions(signupRecord, sessions);

    if (persistedResult.error) {
      return serverError(res, "We could not update your portal sessions right now.", {
        error: persistedResult.error.message || "Unknown sessions update error.",
      });
    }

    if (!signedOut) {
      const updatedCookie = buildUpdatedSessionCookieValue(
        persistedResult.data || signupRecord,
        sessionMeta,
        currentSession
      );

      setSessionCookie(res, JSON.stringify(updatedCookie), {
        httpOnly: true,
        maxAge: getSessionMaxAge(sessionMeta),
      });
    }

    logRequestSuccess(req, {
      scope: "portal_sessions_updated",
      signupId: signupRecord.id,
      totalSessions: sessions.length,
      signedOut,
      action,
    });

    return ok(
      res,
      buildResponsePayload({
        signupRecord: persistedResult.data || signupRecord,
        sessions,
        persisted: persistedResult.persisted,
        signedOut,
      }),
      persistedResult.persisted
        ? message
        : `${message} Add portal_sessions to public.signups to persist session changes.`
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_sessions_unexpected",
    });

    return serverError(
      res,
      "An unexpected error occurred while loading portal sessions.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown server error.",
            code: error?.code || null,
          }
        : null
    );
  }
}