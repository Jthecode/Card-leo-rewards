// api/portal/sessions.js
import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import { getPortalOverview } from "../../lib/portal.js";
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
  getSessionCookieFromRequest,
  safeJsonParse,
  clearSessionCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
} from "../../lib/cookies.js";
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

  if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android")) {
    return "mobile";
  }
  if (ua.includes("ipad") || ua.includes("tablet")) {
    return "tablet";
  }

  return "desktop";
}

function buildSessionLabel({ browser, os, deviceType }) {
  const parts = [];

  if (browser && browser !== "Unknown Browser") parts.push(browser);
  if (os && os !== "Unknown OS") parts.push(os);
  if (deviceType) parts.push(deviceType.charAt(0).toUpperCase() + deviceType.slice(1));

  return parts.join(" • ") || "Current Session";
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

  return "";
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
    const parts = value.split(":");
    return `${parts.slice(0, 2).join(":")}:****`;
  }

  return value;
}

function createSessionId(seed) {
  return createHash("sha256").update(String(seed)).digest("hex").slice(0, 24);
}

function getSessionIdentifiers(sessionData = {}) {
  return {
    sessionId:
      sessionData.sessionId ||
      sessionData.sid ||
      sessionData.jti ||
      sessionData.id ||
      sessionData.tokenId ||
      null,
    issuedAt:
      sessionData.issuedAt ||
      sessionData.iat ||
      sessionData.createdAt ||
      sessionData.created_at ||
      null,
    expiresAt:
      sessionData.expiresAt ||
      sessionData.exp ||
      sessionData.expires_at ||
      null,
    lastActiveAt:
      sessionData.lastActiveAt ||
      sessionData.last_active_at ||
      sessionData.updatedAt ||
      sessionData.updated_at ||
      null,
  };
}

function normalizeStoredSession(session = {}) {
  return {
    id: normalizeText(session.id) || randomUUID(),
    current: !!session.current,
    label: normalizeText(session.label) || "Saved Session",
    browser: normalizeText(session.browser) || "Unknown Browser",
    os: normalizeText(session.os) || "Unknown OS",
    deviceType: normalizeText(session.deviceType || session.device_type) || "desktop",
    ipAddress: normalizeText(session.ipAddress || session.ip_address || ""),
    ipAddressMasked:
      normalizeText(session.ipAddressMasked || session.ip_address_masked || "") ||
      maskIpAddress(session.ipAddress || session.ip_address || ""),
    userAgent: normalizeText(session.userAgent || session.user_agent || ""),
    createdAt:
      session.createdAt ||
      session.created_at ||
      session.lastActiveAt ||
      session.last_active_at ||
      new Date().toISOString(),
    lastActiveAt:
      session.lastActiveAt ||
      session.last_active_at ||
      session.createdAt ||
      session.created_at ||
      new Date().toISOString(),
    expiresAt: session.expiresAt || session.expires_at || null,
    revokedAt: session.revokedAt || session.revoked_at || null,
  };
}

function buildCurrentSession(req, context) {
  const sessionMeta = context.sessionMeta || {};
  const sessionData = sessionMeta.data || {};
  const ua = req.headers?.["user-agent"] || "";

  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const deviceType = detectDeviceType(ua);
  const ipAddress = getClientIp(req);
  const ids = getSessionIdentifiers(sessionData);

  const rawSeed = [
    ids.sessionId,
    context.member?.signupId,
    context.member?.email,
    context.member?.portalUserId,
    ids.issuedAt,
    ua,
  ]
    .filter(Boolean)
    .join("|");

  const id =
    normalizeText(ids.sessionId) ||
    createSessionId(rawSeed || `${context.member?.email}|${ua}|current`);

  const createdAt =
    ids.issuedAt && !String(ids.issuedAt).includes("T")
      ? new Date(Number(ids.issuedAt) * 1000).toISOString()
      : ids.issuedAt || new Date().toISOString();

  const expiresAt =
    ids.expiresAt && !String(ids.expiresAt).includes("T")
      ? new Date(Number(ids.expiresAt) * 1000).toISOString()
      : ids.expiresAt || null;

  const lastActiveAt =
    ids.lastActiveAt && !String(ids.lastActiveAt).includes("T")
      ? new Date(Number(ids.lastActiveAt) * 1000).toISOString()
      : ids.lastActiveAt || new Date().toISOString();

  return {
    id,
    current: true,
    label: buildSessionLabel({ browser, os, deviceType }),
    browser,
    os,
    deviceType,
    ipAddress,
    ipAddressMasked: maskIpAddress(ipAddress),
    userAgent: normalizeText(ua),
    createdAt,
    lastActiveAt,
    expiresAt,
    revokedAt: null,
  };
}

function mergeSessions(existingSessions = [], currentSession) {
  const byId = new Map();

  for (const item of Array.isArray(existingSessions) ? existingSessions : []) {
    const normalized = normalizeStoredSession(item);
    if (!normalized.revokedAt) {
      byId.set(normalized.id, { ...normalized, current: false });
    }
  }

  byId.set(currentSession.id, normalizeStoredSession(currentSession));

  const merged = Array.from(byId.values())
    .map((item) => ({
      ...item,
      current: item.id === currentSession.id,
    }))
    .sort((a, b) => {
      if (a.current && !b.current) return -1;
      if (!a.current && b.current) return 1;
      return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
    });

  return merged;
}

function buildResponsePayload({ portal, signupRecord, sessions, persisted = true }) {
  const member = portal?.member || {};
  const support = portal?.support || {};

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
    sessions: {
      persisted,
      totalSessions: sessions.length,
      currentSessionId: sessions.find((item) => item.current)?.id || null,
      sessions,
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
    "created_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  const extendedFields = `${baseFields}, portal_sessions`;

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

  if (error && /portal_sessions/i.test(error.message || "")) {
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
            portal_sessions: null,
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
      message: "You must be logged in to access portal sessions.",
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
      message: "We were unable to load your portal sessions.",
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

function clearSessionCookies(res) {
  clearSessionCookie(res);
  clearAccessTokenCookie(res);
  clearRefreshTokenCookie(res);
}

function getActionFromRequest(req) {
  const body = getRequestBody(req);

  return {
    action: normalizeText(body.action).toLowerCase(),
    sessionId: normalizeText(body.sessionId || body.id),
    body,
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_sessions", method: req.method });

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return methodNotAllowed(
      res,
      ["GET", "POST", "DELETE"],
      "Method not allowed. Use GET, POST, or DELETE."
    );
  }

  try {
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
    const columnMissing = !!signupRecord.__portalSessionsColumnMissing;

    const existingSessions = Array.isArray(signupRecord.portal_sessions)
      ? signupRecord.portal_sessions
      : [];

    const currentSession = buildCurrentSession(req, context);
    let sessions = mergeSessions(existingSessions, currentSession);

    if (req.method === "GET") {
      if (!columnMissing) {
        await supabaseAdmin
          .from("signups")
          .update({
            portal_sessions: sessions,
          })
          .eq("id", signupRecord.id);
      }

      logRequestSuccess(req, {
        scope: "portal_sessions_get",
        signupId: signupRecord?.id || null,
        totalSessions: sessions.length,
      });

      return ok(
        res,
        buildResponsePayload({
          portal,
          signupRecord,
          sessions,
          persisted: !columnMissing,
        }),
        "Portal sessions loaded successfully."
      );
    }

    const { action, sessionId } = getActionFromRequest(req);

    if (!action) {
      return badRequest(
        res,
        "A valid action is required. Use sign_out_current, sign_out_others, revoke_session, or clear_all."
      );
    }

    let message = "Portal sessions updated successfully.";
    let signedOut = false;

    if (action === "sign_out_current") {
      sessions = sessions.filter((item) => item.id !== currentSession.id);
      clearSessionCookies(res);
      signedOut = true;
      message = "Current session signed out successfully.";
    } else if (action === "sign_out_others") {
      sessions = sessions.filter((item) => item.id === currentSession.id);
      message = "All other sessions were signed out successfully.";
    } else if (action === "revoke_session") {
      if (!sessionId) {
        return badRequest(
          res,
          "A sessionId is required when using revoke_session."
        );
      }

      const isCurrent = sessionId === currentSession.id;
      sessions = sessions.filter((item) => item.id !== sessionId);

      if (isCurrent) {
        clearSessionCookies(res);
        signedOut = true;
        message = "Current session revoked successfully.";
      } else {
        message = "Selected session revoked successfully.";
      }
    } else if (action === "clear_all") {
      sessions = [];
      clearSessionCookies(res);
      signedOut = true;
      message = "All sessions were cleared successfully.";
    } else {
      return badRequest(
        res,
        "Invalid action. Use sign_out_current, sign_out_others, revoke_session, or clear_all."
      );
    }

    if (!columnMissing) {
      const { data: updatedRecord, error: updateError } = await supabaseAdmin
        .from("signups")
        .update({
          portal_sessions: sessions,
        })
        .eq("id", signupRecord.id)
        .select(
          "id, email, status, first_name, last_name, created_at, portal_login_url, portal_user_id, portal_sessions"
        )
        .single();

      if (updateError) {
        return serverError(
          res,
          "We could not update your portal sessions right now.",
          { error: updateError.message || "Unknown sessions update error." }
        );
      }

      logRequestSuccess(req, {
        scope: "portal_sessions_updated",
        signupId: updatedRecord?.id || null,
        totalSessions: sessions.length,
        signedOut,
      });

      return ok(
        res,
        {
          signedOut,
          ...buildResponsePayload({
            portal,
            signupRecord: updatedRecord,
            sessions,
            persisted: true,
          }),
        },
        message
      );
    }

    logRequestSuccess(req, {
      scope: "portal_sessions_validated_only",
      signupId: signupRecord?.id || null,
      totalSessions: sessions.length,
      signedOut,
    });

    return ok(
      res,
      {
        signedOut,
        persisted: false,
        ...buildResponsePayload({
          portal,
          signupRecord,
          sessions,
          persisted: false,
        }),
      },
      signedOut || action === "sign_out_current" || action === "clear_all"
        ? message
        : `${message} Add \`portal_sessions\` to \`public.signups\` to persist updates.`
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_sessions_unexpected" });

    return serverError(
      res,
      "An unexpected error occurred while loading portal sessions.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown server error." }
        : null
    );
  }
}