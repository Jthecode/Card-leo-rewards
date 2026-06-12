// api/auth/change-password.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  methodNotAllowed,
  tooManyRequests,
  fromCaughtError,
  setNoStore,
} from "../../lib/responses.js";
import { changePasswordRateLimit } from "../../lib/rate-limit.js";
import { createLogger } from "../../lib/logger.js";
import {
  validateChangePasswordInput,
  normalizeEmail,
} from "../../lib/validation.js";
import {
  setSessionCookie,
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";

const logger = createLogger("api:auth:change-password");

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

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeStatus(value) {
  return clean(value).toLowerCase();
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
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

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
}

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (name) {
        cookies[name] = value;
      }

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

function getSessionMemberId(sessionCookie) {
  const value = sessionCookie?.value || {};

  return clean(
    value.member?.id ||
      value.profile?.id ||
      value.user?.id ||
      value.id
  );
}

function getSessionEmail(sessionCookie) {
  const value = sessionCookie?.value || {};

  return normalizeEmail(
    value.member?.email ||
      value.profile?.email ||
      value.user?.email ||
      value.email ||
      ""
  );
}

function getSessionExpiresAt(sessionCookie) {
  const value = sessionCookie?.value || {};

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

function getDisplayName(member) {
  const fullName = clean(member?.full_name);

  if (fullName) return fullName;

  return [member?.first_name, member?.last_name]
    .map(clean)
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

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password || ""))
    .digest("hex");
}

function safeCompareHash(inputHash, storedHash) {
  const left = Buffer.from(String(inputHash || ""), "hex");
  const right = Buffer.from(String(storedHash || ""), "hex");

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function buildUpdatedSessionCookieValue(member, oldSessionCookie) {
  const oldValue = oldSessionCookie?.value || {};
  const remember = Boolean(oldValue.remember);

  const now = getUnixNow();
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;

  let expiresAt = Number(oldValue.expires_at || oldValue.session?.expires_at || 0);

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    expiresAt = now + maxAge;
  }

  const safeMember = sanitizeMember(member);

  return {
    authenticated: true,
    provider: "cardleo-signups",
    type: "member",
    remember,
    created_at: Number(oldValue.created_at || now),
    checked_at: now,
    password_changed_at: now,
    expires_at: expiresAt,
    member: safeMember,
    user: buildUser(member),
    profile: buildProfile(member),
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
        "password_hash",
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

function validatePasswords(body) {
  const validation = validateChangePasswordInput(body);

  if (validation?.valid) {
    return validation;
  }

  const currentPassword = clean(
    body.currentPassword ||
      body.current_password ||
      body.oldPassword ||
      body.old_password
  );

  const newPassword = clean(
    body.newPassword ||
      body.new_password ||
      body.password
  );

  const confirmPassword = clean(
    body.confirmPassword ||
      body.confirm_password ||
      body.confirmNewPassword ||
      body.confirm_new_password
  );

  const errors = {};

  if (!currentPassword) {
    errors.currentPassword = "Current password is required.";
  }

  if (!newPassword || newPassword.length < 8) {
    errors.newPassword = "New password must be at least 8 characters.";
  }

  if (confirmPassword && newPassword !== confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  if (currentPassword && newPassword && currentPassword === newPassword) {
    errors.newPassword = "New password must be different from current password.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: {
      currentPassword,
      newPassword,
      confirmPassword,
    },
  };
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"]);
  }

  const rate = changePasswordRateLimit(req, res);

  if (rate && !rate.allowed) {
    return tooManyRequests(
      res,
      "Too many password change attempts. Please try again later.",
      {
        retryAfter: rate.retryAfter,
      }
    );
  }

  try {
    const body = getRequestBody(req);
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value) {
      clearAuthCookies(res);

      return unauthorized(
        res,
        "You must be signed in to change your password."
      );
    }

    if (isSessionExpired(sessionCookie)) {
      clearAuthCookies(res);

      return unauthorized(
        res,
        "Your session has expired. Please sign in again."
      );
    }

    if (sessionCookie.value.authenticated !== true) {
      clearAuthCookies(res);

      return unauthorized(
        res,
        "Your session is invalid. Please sign in again."
      );
    }

    const validation = validatePasswords(body);

    if (!validation.valid) {
      return badRequest(
        res,
        "Please correct the highlighted password fields.",
        validation.errors
      );
    }

    const { currentPassword, newPassword } = validation.values;

    const { member, error: memberLookupError } =
      await findMemberFromSession(sessionCookie);

    if (memberLookupError) {
      logger.error("Unable to load member before password change.", {
        error: {
          name: memberLookupError?.name || "SupabaseError",
          message: memberLookupError?.message || "Unknown lookup error",
        },
      });

      return fromCaughtError(
        res,
        memberLookupError,
        "Unable to verify your account right now."
      );
    }

    if (!member?.id) {
      clearAuthCookies(res);

      return unauthorized(
        res,
        "Account not found. Please sign in again."
      );
    }

    const status = normalizeStatus(member.status || "pending");

    if (!ACTIVE_STATUSES.has(status)) {
      clearAuthCookies(res);

      return forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active."
      );
    }

    if (!member.password_hash) {
      return badRequest(
        res,
        "This account does not have a password yet. Please reset the account password."
      );
    }

    const currentPasswordHash = hashPassword(currentPassword);

    if (!safeCompareHash(currentPasswordHash, member.password_hash)) {
      logger.warn("Current password verification failed.", {
        email: member.email,
        memberId: member.id,
      });

      return unauthorized(
        res,
        "Your current password is incorrect."
      );
    }

    const newPasswordHash = hashPassword(newPassword);

    const { data: updatedMember, error: updateError } = await supabaseAdmin
      .from("signups")
      .update({
        password_hash: newPasswordHash,
        updated_at: new Date().toISOString(),
      })
      .eq("id", member.id)
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
      )
      .single();

    if (updateError) {
      logger.error("Unable to update password hash.", {
        email: member.email,
        memberId: member.id,
        error: {
          name: updateError?.name || "SupabaseError",
          message: updateError?.message || "Unknown update error",
        },
      });

      return fromCaughtError(
        res,
        updateError,
        "Unable to update password right now."
      );
    }

    const refreshedSession = buildUpdatedSessionCookieValue(
      updatedMember,
      sessionCookie
    );

    setSessionCookie(res, JSON.stringify(refreshedSession), {
      httpOnly: true,
      maxAge: getSessionMaxAge(sessionCookie),
    });

    logger.info("Password changed successfully.", {
      email: updatedMember.email,
      memberId: updatedMember.id,
    });

    return ok(
      res,
      {
        changed: true,
        member: sanitizeMember(updatedMember),
        user: buildUser(updatedMember),
        session: refreshedSession.session,
      },
      "Password changed successfully."
    );
  } catch (error) {
    logger.error("Unexpected change-password error.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    return fromCaughtError(
      res,
      error,
      "Unable to change password right now."
    );
  }
}