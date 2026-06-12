// lib/session.js
import { getCurrentSession, logout } from "./auth.js";
import { getEnv } from "./env.js";

const runtimeEnv = getEnv();

const DEFAULT_LOGIN_PATH = runtimeEnv.loginPath || "/login.html";
const DEFAULT_PORTAL_PATH = `${runtimeEnv.portalBasePath || "/portal"}/index.html`;

let sessionCache = null;
let sessionCacheTimestamp = 0;

const SESSION_CACHE_TTL_MS = 15 * 1000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeNow() {
  return Date.now();
}

function isFreshCache() {
  return (
    sessionCache &&
    sessionCacheTimestamp > 0 &&
    safeNow() - sessionCacheTimestamp < SESSION_CACHE_TTL_MS
  );
}

function unwrapApiResponse(response) {
  if (!isObject(response)) {
    return {
      success: false,
      message: "",
      redirectTo: DEFAULT_PORTAL_PATH,
      data: {},
      raw: response || null,
    };
  }

  const data = isObject(response.data) ? response.data : response;

  return {
    success:
      response.success === true ||
      data.success === true ||
      data.authenticated === true,
    message: normalizeText(response.message || data.message),
    redirectTo: normalizeText(response.redirectTo || data.redirectTo),
    data,
    raw: response,
  };
}

function getUserMetadata(user = {}) {
  return isObject(user?.user_metadata) ? user.user_metadata : {};
}

function getAppMetadata(user = {}) {
  return isObject(user?.app_metadata) ? user.app_metadata : {};
}

function getDisplayNameFromParts({ member, profile, user }) {
  const metadata = getUserMetadata(user);

  return (
    normalizeText(member?.fullName) ||
    normalizeText(member?.full_name) ||
    normalizeText(member?.name) ||
    normalizeText(profile?.full_name) ||
    normalizeText(profile?.name) ||
    normalizeText(metadata.full_name) ||
    normalizeText(metadata.name) ||
    [member?.firstName || member?.first_name || profile?.first_name || metadata.first_name,
      member?.lastName || member?.last_name || profile?.last_name || metadata.last_name]
      .map(normalizeText)
      .filter(Boolean)
      .join(" ") ||
    normalizeText(user?.email?.split("@")[0]) ||
    normalizeText(member?.email?.split("@")[0]) ||
    "Member"
  );
}

function getEmailFromParts({ member, profile, user, data }) {
  return normalizeEmail(
    data?.email ||
      data?.userEmail ||
      member?.email ||
      profile?.email ||
      user?.email
  );
}

function getIdFromParts({ member, profile, user, data }) {
  return normalizeText(
    data?.memberId ||
      data?.member_id ||
      data?.signupId ||
      data?.signup_id ||
      member?.id ||
      member?.signupId ||
      member?.signup_id ||
      profile?.id ||
      profile?.signupId ||
      profile?.signup_id ||
      user?.id
  );
}

function getRoleFromParts({ member, profile, user, data }) {
  const metadata = getUserMetadata(user);
  const appMetadata = getAppMetadata(user);

  return normalizeText(
    data?.role ||
      member?.role ||
      profile?.role ||
      user?.role ||
      metadata.role ||
      appMetadata.role ||
      "member"
  ).toLowerCase();
}

function getMemberStatus(member = {}, profile = {}, data = {}) {
  return normalizeText(
    member?.memberStatus ||
      member?.member_status ||
      member?.status ||
      profile?.memberStatus ||
      profile?.member_status ||
      profile?.status ||
      data?.status
  ).toLowerCase();
}

function getPortalAccess(member = {}, data = {}) {
  if (typeof data?.portalAccess === "boolean") return data.portalAccess;
  if (typeof member?.portalAccess === "boolean") return member.portalAccess;
  if (typeof member?.portal_access === "boolean") return member.portal_access;

  const status = getMemberStatus(member, {}, data);

  if (["active", "approved", "invited"].includes(status)) return true;
  if (["pending", "reviewing", "disabled", "suspended", "denied"].includes(status)) {
    return false;
  }

  return Boolean(data?.authenticated);
}

function sanitizeSession(response) {
  const unwrapped = unwrapApiResponse(response);
  const data = unwrapped.data || {};

  const member = isObject(data.member) ? data.member : null;
  const profile = isObject(data.profile) ? data.profile : null;
  const user = isObject(data.user) ? data.user : null;
  const session = isObject(data.session) ? data.session : null;

  const authenticated = Boolean(data.authenticated);
  const displayName = getDisplayNameFromParts({ member, profile, user });
  const email = getEmailFromParts({ member, profile, user, data });
  const userId = getIdFromParts({ member, profile, user, data });
  const role = getRoleFromParts({ member, profile, user, data });
  const status = getMemberStatus(member || {}, profile || {}, data);
  const portalAccess = getPortalAccess(member || {}, data);

  const redirectTo =
    normalizeText(data.redirectTo) ||
    normalizeText(unwrapped.redirectTo) ||
    normalizeText(member?.portalLoginUrl) ||
    normalizeText(member?.portal_login_url) ||
    DEFAULT_PORTAL_PATH;

  return {
    success: Boolean(unwrapped.success),
    authenticated,
    message: normalizeText(data.message || unwrapped.message),

    redirectTo,

    user,
    member,
    profile,
    session,

    displayName,
    email,
    userId,
    memberId: userId,
    signupId: normalizeText(member?.signupId || member?.signup_id || userId),
    portalUserId: normalizeText(member?.portalUserId || member?.portal_user_id),
    role,
    status,
    portalAccess,

    raw: unwrapped.raw || response || null,
    data,
  };
}

function updateCache(data) {
  sessionCache = sanitizeSession(data);
  sessionCacheTimestamp = safeNow();
  return sessionCache;
}

export function clearCache() {
  sessionCache = null;
  sessionCacheTimestamp = 0;
}

function buildLoginUrl(loginPath = DEFAULT_LOGIN_PATH) {
  const next = encodeURIComponent(
    `${window.location.pathname}${window.location.search || ""}`
  );

  return `${loginPath}?next=${next}`;
}

function redirectToPath(path) {
  window.location.href = path;
}

export async function fetchSession({ force = false } = {}) {
  if (!force && isFreshCache()) {
    return sessionCache;
  }

  try {
    const response = await getCurrentSession();
    return updateCache(response);
  } catch (error) {
    clearCache();

    return sanitizeSession({
      success: false,
      authenticated: false,
      message: error?.message || "Unable to verify the current session.",
      redirectTo: DEFAULT_PORTAL_PATH,
      data: {
        authenticated: false,
        user: null,
        profile: null,
        member: null,
        session: null,
      },
    });
  }
}

export async function refreshSession() {
  return fetchSession({ force: true });
}

export function getCachedSession() {
  return isFreshCache() ? sessionCache : null;
}

export async function hasActiveSession() {
  const currentSession = await fetchSession({ force: true });
  return Boolean(currentSession?.authenticated);
}

export async function requireSession({
  loginPath = DEFAULT_LOGIN_PATH,
  redirectIfMissing = true,
  force = true,
} = {}) {
  const currentSession = await fetchSession({ force });

  if (!currentSession.authenticated) {
    if (redirectIfMissing) {
      redirectToPath(buildLoginUrl(loginPath));
    }

    return null;
  }

  return currentSession;
}

export async function requireGuestSession({
  portalPath = DEFAULT_PORTAL_PATH,
  redirectIfAuthenticated = true,
  force = true,
} = {}) {
  const currentSession = await fetchSession({ force });

  if (currentSession.authenticated) {
    if (redirectIfAuthenticated) {
      redirectToPath(currentSession.redirectTo || portalPath);
    }

    return null;
  }

  return currentSession;
}

export function getSessionMember(currentSession = sessionCache) {
  if (!currentSession) return null;
  return currentSession.member || currentSession.data?.member || null;
}

export function getSessionProfile(currentSession = sessionCache) {
  if (!currentSession) return null;
  return currentSession.profile || currentSession.data?.profile || null;
}

export function getSessionUser(currentSession = sessionCache) {
  if (!currentSession) return null;
  return currentSession.user || currentSession.data?.user || null;
}

export function getSessionDisplayName(currentSession = sessionCache) {
  if (!currentSession) return "Member";

  const member = getSessionMember(currentSession);
  const profile = getSessionProfile(currentSession);
  const user = getSessionUser(currentSession);

  return (
    normalizeText(currentSession.displayName) ||
    getDisplayNameFromParts({ member, profile, user }) ||
    "Member"
  );
}

export function getSessionEmail(currentSession = sessionCache) {
  if (!currentSession) return "";

  const member = getSessionMember(currentSession);
  const profile = getSessionProfile(currentSession);
  const user = getSessionUser(currentSession);

  return (
    normalizeEmail(currentSession.email) ||
    getEmailFromParts({ member, profile, user, data: currentSession.data || {} })
  );
}

export function getSessionUserId(currentSession = sessionCache) {
  if (!currentSession) return "";

  const member = getSessionMember(currentSession);
  const profile = getSessionProfile(currentSession);
  const user = getSessionUser(currentSession);

  return (
    normalizeText(currentSession.userId) ||
    getIdFromParts({ member, profile, user, data: currentSession.data || {} })
  );
}

export function getSessionMemberId(currentSession = sessionCache) {
  return getSessionUserId(currentSession);
}

export function getSessionRole(currentSession = sessionCache) {
  if (!currentSession) return "";

  const member = getSessionMember(currentSession);
  const profile = getSessionProfile(currentSession);
  const user = getSessionUser(currentSession);

  return (
    normalizeText(currentSession.role) ||
    getRoleFromParts({ member, profile, user, data: currentSession.data || {} })
  );
}

export function getSessionStatus(currentSession = sessionCache) {
  if (!currentSession) return "";

  const member = getSessionMember(currentSession);
  const profile = getSessionProfile(currentSession);

  return (
    normalizeText(currentSession.status) ||
    getMemberStatus(member || {}, profile || {}, currentSession.data || {})
  );
}

export function hasPortalAccess(currentSession = sessionCache) {
  if (!currentSession) return false;
  if (!currentSession.authenticated) return false;

  const member = getSessionMember(currentSession);

  return getPortalAccess(member || {}, currentSession.data || currentSession);
}

function setText(selector, value) {
  if (!selector) return;

  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = value;
  });
}

function setValue(selector, value) {
  if (!selector) return;

  document.querySelectorAll(selector).forEach((node) => {
    if ("value" in node) {
      node.value = value;
    } else {
      node.textContent = value;
    }
  });
}

function setHidden(selector, hidden) {
  if (!selector) return;

  document.querySelectorAll(selector).forEach((node) => {
    node.hidden = Boolean(hidden);
  });
}

export function hydrateSessionUI(currentSession = sessionCache, options = {}) {
  if (!currentSession) return null;

  const {
    nameSelector = "[data-session-name], [data-member-name]",
    emailSelector = "[data-session-email], [data-member-email]",
    userIdSelector = "[data-session-user-id], [data-member-id]",
    roleSelector = "[data-session-role], [data-member-role]",
    statusSelector = "[data-session-status], [data-member-status]",
    authStateSelector = "[data-session-auth-state]",
    authenticatedSelector = "[data-authenticated]",
    guestSelector = "[data-guest]",
    profileNameInputSelector = "[data-profile-name-input]",
    profileEmailInputSelector = "[data-profile-email-input]",
  } = options;

  const displayName = getSessionDisplayName(currentSession);
  const email = getSessionEmail(currentSession);
  const userId = getSessionUserId(currentSession);
  const role = getSessionRole(currentSession);
  const status = getSessionStatus(currentSession);
  const authState = currentSession.authenticated ? "authenticated" : "guest";

  setText(nameSelector, displayName);
  setText(emailSelector, email);
  setText(userIdSelector, userId);
  setText(roleSelector, role || "member");
  setText(statusSelector, status || "active");
  setText(authStateSelector, authState);

  setValue(profileNameInputSelector, displayName);
  setValue(profileEmailInputSelector, email);

  setHidden(authenticatedSelector, !currentSession.authenticated);
  setHidden(guestSelector, currentSession.authenticated);

  return {
    displayName,
    email,
    userId,
    role,
    status,
    authState,
    member: getSessionMember(currentSession),
    profile: getSessionProfile(currentSession),
    user: getSessionUser(currentSession),
  };
}

export function bindLogoutButtons({
  selector = "[data-logout]",
  redirectTo: redirectPath = DEFAULT_LOGIN_PATH,
  onBeforeLogout,
  onAfterLogout,
  onError,
} = {}) {
  const buttons = document.querySelectorAll(selector);

  buttons.forEach((button) => {
    if (button.dataset.logoutBound === "true") return;

    button.dataset.logoutBound = "true";

    button.addEventListener("click", async (event) => {
      event.preventDefault();

      const originalText =
        "value" in button ? button.value : button.textContent;
      const shouldSwapText =
        button.tagName === "BUTTON" || button.tagName === "INPUT";

      try {
        if (typeof onBeforeLogout === "function") {
          await onBeforeLogout();
        }

        if (shouldSwapText) {
          if (button.tagName === "INPUT") {
            button.value = "Signing out...";
          } else {
            button.textContent = "Signing out...";
          }

          button.disabled = true;
        }

        const result = await logout();

        clearCache();

        if (typeof onAfterLogout === "function") {
          await onAfterLogout(result);
        }

        redirectToPath(result?.redirectTo || result?.data?.redirectTo || redirectPath);
      } catch (error) {
        if (shouldSwapText) {
          if (button.tagName === "INPUT") {
            button.value = originalText;
          } else {
            button.textContent = originalText;
          }

          button.disabled = false;
        }

        if (typeof onError === "function") {
          onError(error);
          return;
        }

        alert(error?.message || "Something went wrong while signing out.");
      }
    });
  });

  return buttons;
}

export function watchSession({
  intervalMs = 60 * 1000,
  loginPath = DEFAULT_LOGIN_PATH,
  onAuthenticated,
  onExpired,
  stopWhenHidden = false,
} = {}) {
  let timerId = null;

  async function tick() {
    if (stopWhenHidden && document.hidden) {
      return;
    }

    const currentSession = await refreshSession();

    if (!currentSession.authenticated) {
      if (typeof onExpired === "function") {
        onExpired(currentSession);
      } else {
        redirectToPath(buildLoginUrl(loginPath));
      }

      stop();
      return;
    }

    hydrateSessionUI(currentSession);

    if (typeof onAuthenticated === "function") {
      onAuthenticated(currentSession);
    }
  }

  function start() {
    if (timerId) return timerId;

    timerId = window.setInterval(
      tick,
      Math.max(10000, Number(intervalMs) || 60000)
    );

    return timerId;
  }

  function stop() {
    if (!timerId) return;

    window.clearInterval(timerId);
    timerId = null;
  }

  return {
    start,
    stop,
    tick,
  };
}

export const session = {
  fetch: fetchSession,
  refresh: refreshSession,
  getCached: getCachedSession,
  clearCache,

  hasActiveSession,
  hasPortalAccess,

  require: requireSession,
  requireGuest: requireGuestSession,

  getMember: getSessionMember,
  getProfile: getSessionProfile,
  getUser: getSessionUser,
  getDisplayName: getSessionDisplayName,
  getEmail: getSessionEmail,
  getUserId: getSessionUserId,
  getMemberId: getSessionMemberId,
  getRole: getSessionRole,
  getStatus: getSessionStatus,

  hydrateUI: hydrateSessionUI,
  bindLogoutButtons,
  watch,
};

export default session;