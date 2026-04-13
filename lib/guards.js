// lib/guards.js
import { getNextRedirect, clearRecoveryHash } from "./auth.js";
import { fetchSession, getSessionDisplayName, getSessionEmail } from "./session.js";
import { getEnv } from "./env.js";

const runtimeEnv = getEnv();

const DEFAULT_LOGIN_PATH = runtimeEnv.loginPath || "/login.html";
const DEFAULT_PORTAL_PATH = `${runtimeEnv.portalBasePath || "/portal"}/index.html`;

function normalizeText(value) {
  return String(value || "").trim();
}

function buildLoginRedirect(loginPath = DEFAULT_LOGIN_PATH) {
  const next = encodeURIComponent(
    `${window.location.pathname}${window.location.search || ""}`
  );
  return `${loginPath}?next=${next}`;
}

function redirectTo(path) {
  window.location.href = path;
}

function setGuardState({
  loadingSelector = "[data-guard-loading]",
  protectedSelector = "[data-guard-protected]",
  guestSelector = "[data-guard-guest]",
  mode = "idle",
} = {}) {
  const loadingNodes = document.querySelectorAll(loadingSelector);
  const protectedNodes = document.querySelectorAll(protectedSelector);
  const guestNodes = document.querySelectorAll(guestSelector);

  loadingNodes.forEach((node) => {
    node.hidden = mode !== "loading";
  });

  protectedNodes.forEach((node) => {
    node.hidden = mode !== "authenticated";
  });

  guestNodes.forEach((node) => {
    node.hidden = mode !== "guest";
  });
}

function sanitizeSession(data) {
  return {
    authenticated: Boolean(data?.authenticated),
    user: data?.user || null,
    profile: data?.profile || null,
    redirectTo: normalizeText(data?.redirectTo) || DEFAULT_PORTAL_PATH,
    message: normalizeText(data?.message),
    session: data?.session || null,
    role: normalizeText(
      data?.role ||
        data?.profile?.role ||
        data?.user?.role ||
        data?.user?.user_metadata?.role
    ),
  };
}

export async function getGuardSession({ force = true } = {}) {
  try {
    const data = await fetchSession({ force });
    return sanitizeSession(data);
  } catch {
    return {
      authenticated: false,
      user: null,
      profile: null,
      redirectTo: DEFAULT_PORTAL_PATH,
      message: "Unable to verify session.",
      session: null,
      role: "",
    };
  }
}

export async function requireAuth(options = {}) {
  const {
    loginPath = DEFAULT_LOGIN_PATH,
    showWhileChecking = true,
    loadingSelector,
    protectedSelector,
    guestSelector,
    onAuthenticated,
    onUnauthenticated,
  } = options;

  if (showWhileChecking) {
    setGuardState({
      loadingSelector,
      protectedSelector,
      guestSelector,
      mode: "loading",
    });
  }

  const currentSession = await getGuardSession();

  if (!currentSession.authenticated) {
    if (typeof onUnauthenticated === "function") {
      onUnauthenticated(currentSession);
    }

    redirectTo(buildLoginRedirect(loginPath));
    return null;
  }

  setGuardState({
    loadingSelector,
    protectedSelector,
    guestSelector,
    mode: "authenticated",
  });

  if (typeof onAuthenticated === "function") {
    onAuthenticated(currentSession);
  }

  return currentSession;
}

export async function requireGuest(options = {}) {
  const {
    portalPath = DEFAULT_PORTAL_PATH,
    showWhileChecking = true,
    loadingSelector,
    protectedSelector,
    guestSelector,
    onAuthenticated,
    onGuest,
  } = options;

  if (showWhileChecking) {
    setGuardState({
      loadingSelector,
      protectedSelector,
      guestSelector,
      mode: "loading",
    });
  }

  const currentSession = await getGuardSession();

  if (currentSession.authenticated) {
    if (typeof onAuthenticated === "function") {
      onAuthenticated(currentSession);
    }

    redirectTo(currentSession.redirectTo || portalPath);
    return null;
  }

  setGuardState({
    loadingSelector,
    protectedSelector,
    guestSelector,
    mode: "guest",
  });

  if (typeof onGuest === "function") {
    onGuest(currentSession);
  }

  return currentSession;
}

export async function protectPortalPage(options = {}) {
  const {
    loginPath = DEFAULT_LOGIN_PATH,
    portalPath = DEFAULT_PORTAL_PATH,
    hydrateUser = true,
    userNameSelector = "[data-member-name]",
    userEmailSelector = "[data-member-email]",
    userRoleSelector = "[data-member-role]",
    loadingSelector,
    protectedSelector,
    guestSelector,
    onReady,
  } = options;

  const currentSession = await requireAuth({
    loginPath,
    loadingSelector,
    protectedSelector,
    guestSelector,
  });

  if (!currentSession) return null;

  if (hydrateUser) {
    const name = getSessionDisplayName(currentSession);
    const email = getSessionEmail(currentSession);
    const role =
      normalizeText(currentSession.role) ||
      normalizeText(currentSession.profile?.role) ||
      "member";

    document.querySelectorAll(userNameSelector).forEach((node) => {
      node.textContent = name;
    });

    document.querySelectorAll(userEmailSelector).forEach((node) => {
      node.textContent = email;
    });

    document.querySelectorAll(userRoleSelector).forEach((node) => {
      node.textContent = role;
    });
  }

  if (typeof onReady === "function") {
    onReady(currentSession);
  }

  return {
    ...currentSession,
    portalPath,
  };
}

export async function protectGuestPage(options = {}) {
  const {
    portalPath = DEFAULT_PORTAL_PATH,
    clearHash = true,
    loadingSelector,
    protectedSelector,
    guestSelector,
    onReady,
  } = options;

  if (clearHash) {
    clearRecoveryHash();
  }

  const currentSession = await requireGuest({
    portalPath,
    loadingSelector,
    protectedSelector,
    guestSelector,
  });

  if (!currentSession && typeof onReady === "function") {
    return null;
  }

  if (currentSession && typeof onReady === "function") {
    onReady(currentSession);
  }

  return currentSession;
}

export function getPortalRedirect(defaultPath = DEFAULT_PORTAL_PATH) {
  return getNextRedirect(defaultPath);
}

export function showGuardLoading(options = {}) {
  setGuardState({ ...options, mode: "loading" });
}

export function showGuardGuest(options = {}) {
  setGuardState({ ...options, mode: "guest" });
}

export function showGuardAuthenticated(options = {}) {
  setGuardState({ ...options, mode: "authenticated" });
}

export const guard = {
  getGuardSession,
  requireAuth,
  requireGuest,
  protectPortalPage,
  protectGuestPage,
  getPortalRedirect,
  showGuardLoading,
  showGuardGuest,
  showGuardAuthenticated,
};

export default guard;