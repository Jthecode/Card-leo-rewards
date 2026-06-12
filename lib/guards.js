// lib/guards.js
import { getNextRedirect, clearRecoveryHash } from "./auth.js";
import {
  fetchSession,
  getSessionDisplayName,
  getSessionEmail,
} from "./session.js";
import { getEnv } from "./env.js";

let runtimeEnv = {};

try {
  runtimeEnv = getEnv() || {};
} catch {
  runtimeEnv = {};
}

const DEFAULT_LOGIN_PATH = normalizePath(runtimeEnv.loginPath || "/login.html");
const DEFAULT_PORTAL_BASE_PATH = normalizePath(
  runtimeEnv.portalBasePath || "/portal"
);
const DEFAULT_PORTAL_PATH = normalizePath(
  `${DEFAULT_PORTAL_BASE_PATH}/index.html`
);

const PUBLIC_PATHS = new Set([
  "/",
  "/index.html",
  "/about.html",
  "/get-started.html",
  "/signup.html",
  "/contact.html",
  "/thank-you.html",
  "/forgot-password.html",
  "/reset-password.html",
  "/privacy.html",
  "/terms.html",
  "/404.html",
]);

const GUEST_ONLY_PATHS = new Set([
  DEFAULT_LOGIN_PATH,
  "/login.html",
]);

const AUTH_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function hasBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePath(value) {
  let path = String(value || "/").trim();

  if (!path) return "/";

  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      path = `${url.pathname}${url.search || ""}${url.hash || ""}`;
    }
  } catch {
    path = "/";
  }

  path = path.split("#")[0].split("?")[0];

  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  path = path.replace(/\/{2,}/g, "/");

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path || "/";
}

function normalizeFullPath(value) {
  let path = String(value || "/").trim();

  if (!path) return "/";

  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      path = `${url.pathname}${url.search || ""}${url.hash || ""}`;
    }
  } catch {
    path = "/";
  }

  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  path = path.replace(/\/{2,}/g, "/");

  return path || "/";
}

function getCurrentPath() {
  if (!hasBrowser()) return "/";
  return normalizePath(window.location.pathname || "/");
}

function getCurrentFullPath() {
  if (!hasBrowser()) return "/";

  const pathname = window.location.pathname || "/";
  const search = window.location.search || "";
  const hash = window.location.hash || "";

  return normalizeFullPath(`${pathname}${search}${hash}`);
}

function isSamePath(pathA, pathB) {
  return normalizePath(pathA) === normalizePath(pathB);
}

function isLoginPath(path = getCurrentPath()) {
  return isSamePath(path, DEFAULT_LOGIN_PATH) || isSamePath(path, "/login.html");
}

function isPortalPath(path = getCurrentPath()) {
  const cleanPath = normalizePath(path);
  const cleanBase = normalizePath(DEFAULT_PORTAL_BASE_PATH);

  return cleanPath === cleanBase || cleanPath.startsWith(`${cleanBase}/`);
}

function isPublicPath(path = getCurrentPath()) {
  const cleanPath = normalizePath(path);

  if (PUBLIC_PATHS.has(cleanPath)) return true;
  if (GUEST_ONLY_PATHS.has(cleanPath)) return true;

  return false;
}

function isGuestOnlyPath(path = getCurrentPath()) {
  const cleanPath = normalizePath(path);
  return GUEST_ONLY_PATHS.has(cleanPath);
}

function hasAuthCookie() {
  if (!hasBrowser()) return false;

  const cookie = document.cookie || "";

  return AUTH_COOKIE_NAMES.some((name) => {
    return cookie.includes(`${name}=`);
  });
}

function getSafeInternalPath(value, defaultPath = DEFAULT_PORTAL_PATH) {
  const fallback = normalizeFullPath(defaultPath || DEFAULT_PORTAL_PATH);
  const rawValue = normalizeText(value);

  if (!rawValue) return fallback;

  try {
    const base =
      hasBrowser() && window.location.origin
        ? window.location.origin
        : "https://cardleorewards.com";

    const url = new URL(rawValue, base);

    if (url.origin !== base) {
      return fallback;
    }

    const fullPath = normalizeFullPath(
      `${url.pathname}${url.search || ""}${url.hash || ""}`
    );

    const pathOnly = normalizePath(url.pathname);

    // Never use login or guest pages as the authenticated redirect.
    if (isLoginPath(pathOnly) || isGuestOnlyPath(pathOnly)) {
      return fallback;
    }

    return fullPath;
  } catch {
    return fallback;
  }
}

function getSafePortalPath(value, defaultPath = DEFAULT_PORTAL_PATH) {
  const fallback = normalizeFullPath(defaultPath || DEFAULT_PORTAL_PATH);
  const safePath = getSafeInternalPath(value, fallback);
  const pathOnly = normalizePath(safePath);

  // Authenticated users should land inside the portal.
  if (!isPortalPath(pathOnly)) {
    return fallback;
  }

  return safePath;
}

function buildLoginRedirect(loginPath = DEFAULT_LOGIN_PATH) {
  const cleanLoginPath = normalizePath(loginPath || DEFAULT_LOGIN_PATH);

  if (!hasBrowser()) {
    return cleanLoginPath;
  }

  const currentPath = getCurrentPath();
  const currentFullPath = getCurrentFullPath();

  // Prevent /login.html?next=/login.html loop.
  if (isLoginPath(currentPath)) {
    return cleanLoginPath;
  }

  // Public pages should not become login "next" targets.
  if (isPublicPath(currentPath) && !isPortalPath(currentPath)) {
    return cleanLoginPath;
  }

  const next = encodeURIComponent(currentFullPath);

  return `${cleanLoginPath}?next=${next}`;
}

function redirectTo(path, { replace = false } = {}) {
  if (!hasBrowser()) return;

  const target = normalizeFullPath(path || "/");

  if (replace) {
    window.location.replace(target);
    return;
  }

  window.location.href = target;
}

function setGuardState({
  loadingSelector = "[data-guard-loading]",
  protectedSelector = "[data-guard-protected]",
  guestSelector = "[data-guard-guest]",
  mode = "idle",
} = {}) {
  if (!hasBrowser()) return;

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

  document.documentElement.dataset.guardState = mode;
}

function getSessionUser(data) {
  return data?.user || data?.member || data?.account || null;
}

function getSessionProfile(data) {
  return (
    data?.profile ||
    data?.member?.profile ||
    data?.account?.profile ||
    data?.member ||
    null
  );
}

function getSessionRole(data, user, profile) {
  return normalizeText(
    data?.role ||
      profile?.role ||
      user?.role ||
      user?.user_metadata?.role ||
      user?.app_metadata?.role ||
      data?.member?.role ||
      data?.account?.role
  );
}

function sanitizeSession(data) {
  const user = getSessionUser(data);
  const profile = getSessionProfile(data);
  const session = data?.session || null;
  const role = getSessionRole(data, user, profile);

  const hasIdentity = Boolean(user || profile || session);

  const authenticated = Boolean(
    data?.authenticated === true ||
      data?.isAuthenticated === true ||
      data?.ok === true && hasIdentity ||
      data?.success === true && hasIdentity
  );

  const rawRedirect =
    data?.redirectTo ||
    data?.redirect_to ||
    data?.next ||
    data?.portalPath ||
    DEFAULT_PORTAL_PATH;

  return {
    authenticated,
    user,
    profile,
    member: data?.member || profile || user || null,
    redirectTo: getSafePortalPath(rawRedirect, DEFAULT_PORTAL_PATH),
    message: normalizeText(data?.message),
    session,
    role,
    raw: data || null,
  };
}

export async function getGuardSession({ force = true } = {}) {
  try {
    const data = await fetchSession({ force });
    return sanitizeSession(data);
  } catch (error) {
    return {
      authenticated: false,
      user: null,
      profile: null,
      member: null,
      redirectTo: DEFAULT_PORTAL_PATH,
      message: error?.message || "Unable to verify session.",
      session: null,
      role: "",
      raw: null,
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

    // Safety default:
    // Only portal pages are forced to login.
    // This prevents public pages from getting trapped in a login loop.
    protectPublicPages = false,
  } = options;

  const currentPath = getCurrentPath();
  const currentIsPortal = isPortalPath(currentPath);
  const currentIsPublic = isPublicPath(currentPath);

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

    const shouldRedirectToLogin =
      currentIsPortal || protectPublicPages === true;

    // Critical loop fix:
    // If this guard is accidentally loaded on home/signup/contact,
    // do not redirect those public pages to login.
    if (!shouldRedirectToLogin && currentIsPublic) {
      setGuardState({
        loadingSelector,
        protectedSelector,
        guestSelector,
        mode: "guest",
      });

      return currentSession;
    }

    redirectTo(buildLoginRedirect(loginPath), { replace: true });
    return null;
  }

  if (hasBrowser()) {
    window.cardLeoSession = currentSession;
    window.cardLeoMember =
      currentSession.member || currentSession.profile || currentSession.user;
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

    // "auto" means:
    // - redirect authenticated users away from login page
    // - do not redirect them away from normal public pages like signup/home
    redirectAuthenticated = "auto",
  } = options;

  const currentPath = getCurrentPath();

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
    if (hasBrowser()) {
      window.cardLeoSession = currentSession;
      window.cardLeoMember =
        currentSession.member || currentSession.profile || currentSession.user;
    }

    if (typeof onAuthenticated === "function") {
      onAuthenticated(currentSession);
    }

    const shouldRedirectAuthenticated =
      redirectAuthenticated === true ||
      (redirectAuthenticated === "auto" && isGuestOnlyPath(currentPath));

    if (shouldRedirectAuthenticated) {
      redirectTo(
        getSafePortalPath(currentSession.redirectTo || portalPath, portalPath),
        { replace: true }
      );

      return null;
    }

    setGuardState({
      loadingSelector,
      protectedSelector,
      guestSelector,
      mode: "authenticated",
    });

    return currentSession;
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

  const currentPath = getCurrentPath();

  // Extra safety:
  // This function should only protect portal pages.
  // If someone accidentally imports it on /signup.html or /index.html,
  // it will not send the page to login.
  if (!isPortalPath(currentPath)) {
    const currentSession = await getGuardSession();

    setGuardState({
      loadingSelector,
      protectedSelector,
      guestSelector,
      mode: currentSession.authenticated ? "authenticated" : "guest",
    });

    if (typeof onReady === "function") {
      onReady(currentSession);
    }

    return currentSession;
  }

  const currentSession = await requireAuth({
    loginPath,
    loadingSelector,
    protectedSelector,
    guestSelector,
    protectPublicPages: false,
  });

  if (!currentSession) return null;

  if (hydrateUser && hasBrowser()) {
    const name = getSessionDisplayName(currentSession) || "Member";
    const email = getSessionEmail(currentSession) || "";
    const role =
      normalizeText(currentSession.role) ||
      normalizeText(currentSession.profile?.role) ||
      normalizeText(currentSession.member?.role) ||
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
    portalPath: getSafePortalPath(portalPath, DEFAULT_PORTAL_PATH),
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

    // Keep signup/home public.
    // Only login page should auto-send authenticated users to portal by default.
    redirectAuthenticated = "auto",
  } = options;

  if (clearHash) {
    clearRecoveryHash();
  }

  const currentSession = await requireGuest({
    portalPath,
    loadingSelector,
    protectedSelector,
    guestSelector,
    redirectAuthenticated,
  });

  if (currentSession && typeof onReady === "function") {
    onReady(currentSession);
  }

  return currentSession;
}

export function getPortalRedirect(defaultPath = DEFAULT_PORTAL_PATH) {
  const rawRedirect = getNextRedirect(defaultPath);
  return getSafePortalPath(rawRedirect, defaultPath);
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

export function isPublicPage(path = getCurrentPath()) {
  return isPublicPath(path);
}

export function isPortalPage(path = getCurrentPath()) {
  return isPortalPath(path);
}

export function isGuestOnlyPage(path = getCurrentPath()) {
  return isGuestOnlyPath(path);
}

export function hasCardLeoSessionCookie() {
  return hasAuthCookie();
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
  isPublicPage,
  isPortalPage,
  isGuestOnlyPage,
  hasCardLeoSessionCookie,
};

export default guard;