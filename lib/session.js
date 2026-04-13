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
  return String(value || "").trim();
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

function sanitizeSession(data) {
  const authenticated = Boolean(data?.authenticated);
  const user = data?.user || null;

  const displayName =
    normalizeText(user?.user_metadata?.full_name) ||
    normalizeText(user?.user_metadata?.name) ||
    normalizeText(user?.email?.split("@")[0]) ||
    "Member";

  return {
    success: Boolean(data?.success),
    authenticated,
    message: normalizeText(data?.message),
    redirectTo: normalizeText(data?.redirectTo) || DEFAULT_PORTAL_PATH,
    user,
    displayName,
    email: normalizeText(user?.email),
    userId: normalizeText(user?.id),
    role: normalizeText(
      data?.role ||
        data?.profile?.role ||
        user?.role ||
        user?.user_metadata?.role
    ),
    profile: data?.profile || null,
    session: data?.session || null,
    raw: data || null,
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

function redirectTo(path) {
  window.location.href = path;
}

export async function fetchSession({ force = false } = {}) {
  if (!force && isFreshCache()) {
    return sessionCache;
  }

  try {
    const data = await getCurrentSession();
    return updateCache(data);
  } catch (error) {
    clearCache();

    return sanitizeSession({
      success: false,
      authenticated: false,
      message: error?.message || "Unable to verify the current session.",
      redirectTo: DEFAULT_PORTAL_PATH,
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
  const currentSession = await fetchSession();
  return Boolean(currentSession?.authenticated);
}

export async function requireSession({
  loginPath = DEFAULT_LOGIN_PATH,
  redirectIfMissing = true,
} = {}) {
  const currentSession = await fetchSession();

  if (!currentSession.authenticated) {
    if (redirectIfMissing) {
      redirectTo(buildLoginUrl(loginPath));
    }
    return null;
  }

  return currentSession;
}

export async function requireGuestSession({
  portalPath = DEFAULT_PORTAL_PATH,
  redirectIfAuthenticated = true,
} = {}) {
  const currentSession = await fetchSession();

  if (currentSession.authenticated) {
    if (redirectIfAuthenticated) {
      redirectTo(currentSession.redirectTo || portalPath);
    }
    return null;
  }

  return currentSession;
}

export function getSessionDisplayName(currentSession = sessionCache) {
  if (!currentSession) return "Member";

  return (
    normalizeText(currentSession.displayName) ||
    normalizeText(currentSession.user?.user_metadata?.full_name) ||
    normalizeText(currentSession.user?.user_metadata?.name) ||
    normalizeText(currentSession.user?.email?.split("@")[0]) ||
    "Member"
  );
}

export function getSessionEmail(currentSession = sessionCache) {
  if (!currentSession) return "";
  return normalizeText(currentSession.email || currentSession.user?.email);
}

export function getSessionUserId(currentSession = sessionCache) {
  if (!currentSession) return "";
  return normalizeText(currentSession.userId || currentSession.user?.id);
}

export function getSessionRole(currentSession = sessionCache) {
  if (!currentSession) return "";
  return normalizeText(
    currentSession.role ||
      currentSession.profile?.role ||
      currentSession.user?.role ||
      currentSession.user?.user_metadata?.role
  );
}

export function hydrateSessionUI(currentSession = sessionCache, options = {}) {
  if (!currentSession) return null;

  const {
    nameSelector = "[data-session-name]",
    emailSelector = "[data-session-email]",
    userIdSelector = "[data-session-user-id]",
    roleSelector = "[data-session-role]",
    authStateSelector = "[data-session-auth-state]",
  } = options;

  const displayName = getSessionDisplayName(currentSession);
  const email = getSessionEmail(currentSession);
  const userId = getSessionUserId(currentSession);
  const role = getSessionRole(currentSession);
  const authState = currentSession.authenticated ? "authenticated" : "guest";

  document.querySelectorAll(nameSelector).forEach((node) => {
    node.textContent = displayName;
  });

  document.querySelectorAll(emailSelector).forEach((node) => {
    node.textContent = email;
  });

  document.querySelectorAll(userIdSelector).forEach((node) => {
    node.textContent = userId;
  });

  document.querySelectorAll(roleSelector).forEach((node) => {
    node.textContent = role;
  });

  document.querySelectorAll(authStateSelector).forEach((node) => {
    node.textContent = authState;
  });

  return {
    displayName,
    email,
    userId,
    role,
    authState,
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

        redirectTo(result?.redirectTo || redirectPath);
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
        redirectTo(buildLoginUrl(loginPath));
      }

      stop();
      return;
    }

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
  require: requireSession,
  requireGuest: requireGuestSession,
  getDisplayName: getSessionDisplayName,
  getEmail: getSessionEmail,
  getUserId: getSessionUserId,
  getRole: getSessionRole,
  hydrateUI: hydrateSessionUI,
  bindLogoutButtons,
  watch: watchSession,
};

export default session;