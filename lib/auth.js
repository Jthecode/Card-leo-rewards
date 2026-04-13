// lib/auth.js
import { getEnv } from "./env.js";

const runtimeEnv = getEnv();

const DEFAULT_PORTAL_PATH = `${runtimeEnv.portalBasePath || "/portal"}/index.html`;
const DEFAULT_LOGIN_PATH = runtimeEnv.loginPath || "/login.html";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password) {
  return normalizeText(password).length >= 8;
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.success === false) {
    const message =
      data?.message || `Request failed with status ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  return parseJsonResponse(response);
}

function readUrlParams() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(
    window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash
  );

  return { query, hash };
}

export function getResetRecoveryPayload() {
  const { query, hash } = readUrlParams();

  const accessToken =
    normalizeText(hash.get("access_token")) ||
    normalizeText(query.get("access_token"));

  const refreshToken =
    normalizeText(hash.get("refresh_token")) ||
    normalizeText(query.get("refresh_token"));

  const code =
    normalizeText(query.get("code")) ||
    normalizeText(hash.get("code"));

  const token =
    normalizeText(query.get("token")) ||
    normalizeText(query.get("token_hash")) ||
    normalizeText(hash.get("token")) ||
    normalizeText(hash.get("token_hash"));

  return {
    token,
    accessToken,
    refreshToken,
    code,
  };
}

export async function login({ email, password, remember = false } = {}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }

  if (!isValidEmail(normalizedEmail)) {
    throw new Error("Please enter a valid email address.");
  }

  if (!password) {
    throw new Error("Password is required.");
  }

  return apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: normalizedEmail,
      password: String(password),
      remember: Boolean(remember),
    }),
  });
}

export async function logout() {
  return apiRequest("/api/auth/logout", {
    method: "POST",
  });
}

export async function getCurrentSession() {
  return apiRequest("/api/auth/me", {
    method: "GET",
  });
}

export async function isAuthenticated() {
  try {
    const data = await getCurrentSession();
    return Boolean(data?.authenticated);
  } catch {
    return false;
  }
}

export async function redirectIfAuthenticated(
  redirectTo = DEFAULT_PORTAL_PATH
) {
  try {
    const data = await getCurrentSession();

    if (data?.authenticated) {
      window.location.href = data.redirectTo || redirectTo;
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function requireAuth({
  loginPath = DEFAULT_LOGIN_PATH,
  fallback = null,
} = {}) {
  try {
    const data = await getCurrentSession();

    if (!data?.authenticated) {
      const next = encodeURIComponent(
        `${window.location.pathname || DEFAULT_PORTAL_PATH}${window.location.search || ""}`
      );
      window.location.href = `${loginPath}?next=${next}`;
      return null;
    }

    return data;
  } catch (error) {
    if (typeof fallback === "function") {
      fallback(error);
      return null;
    }

    const next = encodeURIComponent(
      `${window.location.pathname || DEFAULT_PORTAL_PATH}${window.location.search || ""}`
    );
    window.location.href = `${loginPath}?next=${next}`;
    return null;
  }
}

export async function forgotPassword({ email } = {}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }

  if (!isValidEmail(normalizedEmail)) {
    throw new Error("Please enter a valid email address.");
  }

  return apiRequest("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({
      email: normalizedEmail,
    }),
  });
}

export async function resetPassword({
  password,
  confirmPassword = "",
  token,
  accessToken,
  refreshToken,
  code,
} = {}) {
  const nextPassword = String(password || "");
  const nextConfirmPassword = String(confirmPassword || "");

  if (!nextPassword) {
    throw new Error("A new password is required.");
  }

  if (!isValidPassword(nextPassword)) {
    throw new Error("Your new password must be at least 8 characters long.");
  }

  if (nextConfirmPassword && nextPassword !== nextConfirmPassword) {
    throw new Error("Passwords do not match.");
  }

  const baseRecovery = getResetRecoveryPayload();

  const recovery = {
    token: normalizeText(token) || baseRecovery.token,
    accessToken: normalizeText(accessToken) || baseRecovery.accessToken,
    refreshToken: normalizeText(refreshToken) || baseRecovery.refreshToken,
    code: normalizeText(code) || baseRecovery.code,
  };

  if (
    !recovery.token &&
    !recovery.code &&
    !(recovery.accessToken && recovery.refreshToken)
  ) {
    throw new Error("Missing recovery token or code.");
  }

  return apiRequest("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({
      token: recovery.accessToken || recovery.token,
      refreshToken: recovery.refreshToken || undefined,
      code: recovery.code || undefined,
      password: nextPassword,
      confirmPassword: nextConfirmPassword || undefined,
    }),
  });
}

export function getNextRedirect(defaultPath = DEFAULT_PORTAL_PATH) {
  const params = new URLSearchParams(window.location.search);
  const next = normalizeText(params.get("next"));

  if (next && next.startsWith("/")) {
    return next;
  }

  return defaultPath;
}

export function clearRecoveryHash() {
  if (window.location.hash) {
    history.replaceState(
      null,
      document.title,
      `${window.location.pathname}${window.location.search}`
    );
  }
}

export const auth = {
  login,
  logout,
  getCurrentSession,
  isAuthenticated,
  redirectIfAuthenticated,
  requireAuth,
  forgotPassword,
  resetPassword,
  getResetRecoveryPayload,
  getNextRedirect,
  clearRecoveryHash,
};

export default auth;