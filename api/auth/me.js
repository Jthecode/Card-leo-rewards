// api/auth/me.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  methodNotAllowed,
  serverError,
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
  logAuthEvent,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT = "/portal/index.html";

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
]);

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeString(value).toLowerCase();
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

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) {
        return cookies;
      }

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!name) {
        return cookies;
      }

      cookies[name] = value;
      return cookies;
    }, {});
}

function decodeCookieValue(value) {
  const raw = String(value || "");

  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName = getSessionCookieName();

  const names = Array.from(
    new Set([
      configuredName,
      ...POSSIBLE_SESSION_COOKIE_NAMES,
    ].filter(Boolean))
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const decoded = decodeCookieValue(cookies[name]);
    const parsed = safeJsonParse(decoded, null);

    if (parsed && typeof parsed === "object") {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(sessionCookie) {
  const value = sessionCookie?.value || sessionCookie || {};

  const candidates = [
    value.expires_at,
    value.session?.expires_at,
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionCookie) {
  const expiresAt = getSessionExpiresAt(sessionCookie);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionCookie) {
  const value = sessionCookie?.value || sessionCookie || {};

  return normalizeString(
    value.member?.id ||
      value.profile?.id ||
      value.user?.id ||
      value.id
  );
}

function getSessionEmail(sessionCookie) {
  const value = sessionCookie?.value || sessionCookie || {};

  return normalizeEmail(
    value.member?.email ||
      value.profile?.email ||
      value.user?.email ||
      value.email
  );
}

function getDisplayName(member) {
  const fullName = normalizeString(member?.full_name);

  if (fullName) return fullName;

  return [member?.first_name, member?.last_name]
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");
}

function sanitizeMember(member) {
  if (!member) return null;

  return {
    id: member.id || null,
    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member) || "Card Leo Member",
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    status: member.status || "",
    portalUserId: member.portal_user_id || null,
    portalLoginUrl: member.portal_login_url || DEFAULT_REDIRECT,
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

function buildSessionCookieValue(member, oldSessionCookie) {
  const oldValue = oldSessionCookie?.value || {};
  const remember = Boolean(oldValue.remember);

  const now = getUnixNow();
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;

  let expiresAt = Number(oldValue.expires_at || oldValue.session?.expires_at || 0);

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    expiresAt = now + maxAge;
  }

  const safeMember = sanitizeMember(member);
  const user = buildUser(member);
  const profile = buildProfile(member);

  return {
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember,
    created_at: Number(oldValue.created_at || now),
    checked_at: now,
    expires_at: expiresAt,
    member: safeMember,
    user,
    profile,
    role: "member",
    redirectTo: DEFAULT_REDIRECT,
    session: {
      access_token: null,
      refresh_token: null,
      expires_at: expiresAt,
      expires_in: Math.max(0, expiresAt - now),
      token_type: "custom",
    },
  };
}

function getSessionMaxAge(sessionCookie) {
  const value = sessionCookie?.value || {};
  const remember = Boolean(value.remember);

  return remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
}

async function findMemberFromSession(sessionCookie) {
  const memberId = getSessionMemberId(sessionCookie);
  const email = getSessionEmail(sessionCookie);

  let query = supabaseAdmin
    .from("signups")
    .select(
      [
        "id",
        "first_name",
        "last_name",
        "full_name",
        "email",
        "phone",
        "city",
        "state",
        "interest",
        "agreed",
        "status",
        "portal_user_id",
        "portal_login_url",
        "created_at",
        "updated_at",
      ].join(", ")
    );

  if (memberId) {
    query = query.eq("id", memberId);
  } else if (email) {
    query = query.eq("email", email);
  } else {
    return {
      member: null,
      error: null,
    };
  }

  const { data, error } = await query.maybeSingle();

  return {
    member: data || null,
    error: error || null,
  };
}

function unauthenticatedResponse(res, message = "No active session.") {
  return ok(
    res,
    {
      authenticated: false,
      user: null,
      profile: null,
      member: null,
      session: null,
      role: "",
    },
    message
  );
}

function activeSessionResponse(res, member, sessionCookie) {
  const sessionPayload = buildSessionCookieValue(member, sessionCookie);
  const maxAge = getSessionMaxAge(sessionCookie);

  // Refresh the same custom session cookie so the portal stays logged in.
  setSessionCookie(res, JSON.stringify(sessionPayload), {
    httpOnly: true,
    maxAge,
  });

  return ok(
    res,
    {
      authenticated: true,
      user: sessionPayload.user,
      profile: sessionPayload.profile,
      member: sessionPayload.member,
      role: "member",
      session: sessionPayload.session,
    },
    "Session active.",
    {
      redirectTo: DEFAULT_REDIRECT,
    }
  );
}

export default async function handler(req, res) {
  logRequestStart(req, { scope: "auth_me" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value) {
      return unauthenticatedResponse(res, "No active session.");
    }

    if (isSessionExpired(sessionCookie)) {
      clearAuthCookies(res);

      logAuthEvent("Session expired.", {
        reason: "custom_session_expired",
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Session expired. Please sign in again."
      );
    }

    if (sessionCookie.value.authenticated !== true) {
      clearAuthCookies(res);

      logAuthEvent("Invalid session cookie.", {
        reason: "not_authenticated",
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Session invalid. Please sign in again."
      );
    }

    const { member, error: memberLookupError } =
      await findMemberFromSession(sessionCookie);

    if (memberLookupError) {
      logRequestError(req, memberLookupError, {
        scope: "auth_me_member_lookup",
        sessionCookieName: sessionCookie.name,
      });

      return serverError(res, "Unable to verify your account right now.");
    }

    if (!member?.id) {
      clearAuthCookies(res);

      logAuthEvent("Session member not found.", {
        email: getSessionEmail(sessionCookie),
        memberId: getSessionMemberId(sessionCookie),
        ip: getClientIp(req),
      });

      return unauthenticatedResponse(
        res,
        "Account not found. Please sign in again."
      );
    }

    const status = normalizeStatus(member.status || "pending");

    if (!ACTIVE_STATUSES.has(status)) {
      clearAuthCookies(res);

      logAuthEvent("Session blocked for inactive account.", {
        email: member.email,
        memberId: member.id,
        status,
        ip: getClientIp(req),
      });

      return ok(
        res,
        {
          authenticated: false,
          user: null,
          profile: null,
          member: null,
          session: null,
          role: "",
          status,
        },
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active."
      );
    }

    logAuthEvent("Session check successful.", {
      email: member.email,
      memberId: member.id,
      ip: getClientIp(req),
    });

    logRequestSuccess(req, {
      scope: "auth_me",
      memberId: member.id,
      email: member.email,
    });

    return activeSessionResponse(res, member, sessionCookie);
  } catch (error) {
    clearAuthCookies(res);

    logRequestError(req, error, {
      scope: "auth_me_unexpected",
    });

    return serverError(
      res,
      error?.message ||
        "Something went wrong while checking the current session."
    );
  }
}