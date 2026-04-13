// lib/env.js

const DEFAULTS = Object.freeze({
  APP_NAME: "Card Leo Rewards",
  PORTAL_BASE_PATH: "/portal",
  LOGIN_PATH: "/login.html",
  LOGOUT_REDIRECT_PATH: "/login.html",
  SESSION_COOKIE_NAME: "cardleo_session",
  SESSION_TTL_HOURS: 24 * 7,
  SUPPORT_EMAIL: "support@cardleorewards.com",
  FROM_EMAIL: "no-reply@cardleorewards.com",
});

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

export const isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";

export const isServer = !isBrowser;

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function readWindowEnv() {
  if (!isBrowser) return {};

  return (
    window.CARDLEO_ENV ||
    window.__CARDLEO_ENV__ ||
    window.APP_ENV ||
    {}
  );
}

function readImportMetaEnv() {
  try {
    return import.meta?.env || {};
  } catch {
    return {};
  }
}

function readProcessEnv() {
  try {
    if (typeof process !== "undefined" && process?.env) {
      return process.env;
    }
  } catch {}

  return {};
}

function readMeta(name) {
  if (!isBrowser) return "";

  const el = document.querySelector(`meta[name="${name}"]`);
  return clean(el?.content);
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }

  return "";
}

function readRaw(primaryKey, aliases = [], metaNames = []) {
  const win = readWindowEnv();
  const meta = readImportMetaEnv();
  const proc = readProcessEnv();

  const keys = [primaryKey, ...aliases].filter(Boolean);
  const values = [];

  for (const key of keys) {
    values.push(win[key]);
    values.push(meta[key]);
    values.push(proc[key]);
  }

  for (const metaName of metaNames) {
    values.push(readMeta(metaName));
  }

  return firstNonEmpty(values);
}

function readString(primaryKey, options = {}) {
  const {
    aliases = [],
    fallback = "",
    metaNames = [],
  } = options;

  return firstNonEmpty([
    readRaw(primaryKey, aliases, metaNames),
    fallback,
  ]);
}

function readBoolean(primaryKey, options = {}) {
  const {
    aliases = [],
    fallback = false,
    metaNames = [],
  } = options;

  const raw = clean(readRaw(primaryKey, aliases, metaNames)).toLowerCase();

  if (!raw) return fallback;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function readNumber(primaryKey, options = {}) {
  const {
    aliases = [],
    fallback = 0,
    metaNames = [],
    min,
    max,
  } = options;

  const raw = clean(readRaw(primaryKey, aliases, metaNames));
  if (!raw) return fallback;

  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;

  let value = num;

  if (typeof min === "number" && value < min) value = min;
  if (typeof max === "number" && value > max) value = max;

  return value;
}

function stripTrailingSlash(value) {
  const normalized = clean(value);
  if (!normalized) return "";
  return normalized.replace(/\/+$/, "");
}

function ensureLeadingSlash(value, fallback = "") {
  const normalized = clean(value || fallback);
  if (!normalized) return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function buildBaseEnv() {
  const nodeEnv = readString("NODE_ENV", {
    aliases: ["MODE"],
    fallback: "development",
  });

  const appName = readString("APP_NAME", {
    aliases: ["NEXT_PUBLIC_APP_NAME", "VITE_APP_NAME"],
    fallback: DEFAULTS.APP_NAME,
    metaNames: ["app-name"],
  });

  const siteUrl = stripTrailingSlash(
    readString("SITE_URL", {
      aliases: [
        "APP_URL",
        "NEXT_PUBLIC_SITE_URL",
        "NEXT_PUBLIC_APP_URL",
        "VITE_SITE_URL",
        "URL",
      ],
      metaNames: ["site-url", "app-url"],
    })
  );

  const portalBasePath = ensureLeadingSlash(
    readString("PORTAL_BASE_PATH", {
      aliases: ["NEXT_PUBLIC_PORTAL_BASE_PATH", "VITE_PORTAL_BASE_PATH"],
      fallback: DEFAULTS.PORTAL_BASE_PATH,
      metaNames: ["portal-base-path"],
    }),
    DEFAULTS.PORTAL_BASE_PATH
  );

  const loginPath = ensureLeadingSlash(
    readString("LOGIN_PATH", {
      aliases: ["NEXT_PUBLIC_LOGIN_PATH", "VITE_LOGIN_PATH"],
      fallback: DEFAULTS.LOGIN_PATH,
      metaNames: ["login-path"],
    }),
    DEFAULTS.LOGIN_PATH
  );

  const logoutRedirectPath = ensureLeadingSlash(
    readString("LOGOUT_REDIRECT_PATH", {
      aliases: [
        "NEXT_PUBLIC_LOGOUT_REDIRECT_PATH",
        "VITE_LOGOUT_REDIRECT_PATH",
      ],
      fallback: DEFAULTS.LOGOUT_REDIRECT_PATH,
      metaNames: ["logout-redirect-path"],
    }),
    DEFAULTS.LOGOUT_REDIRECT_PATH
  );

  const supportEmail = readString("SUPPORT_EMAIL", {
    aliases: ["CONTACT_TO_EMAIL", "NEXT_PUBLIC_SUPPORT_EMAIL"],
    fallback: DEFAULTS.SUPPORT_EMAIL,
    metaNames: ["support-email"],
  });

  const fromEmail = readString("FROM_EMAIL", {
    aliases: ["MAIL_FROM", "EMAIL_FROM"],
    fallback: DEFAULTS.FROM_EMAIL,
  });

  const turnstileSiteKey = readString("TURNSTILE_SITE_KEY", {
    aliases: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "VITE_TURNSTILE_SITE_KEY"],
    metaNames: ["turnstile-site-key"],
  });

  return Object.freeze({
    nodeEnv,
    appName,
    siteUrl,
    portalBasePath,
    loginPath,
    logoutRedirectPath,
    supportEmail,
    fromEmail,
    turnstileSiteKey,
    isProduction: nodeEnv === "production",
    isDevelopment: nodeEnv !== "production",
  });
}

function buildPublicEnv() {
  const base = buildBaseEnv();

  const supabaseUrl = stripTrailingSlash(
    readString("NEXT_PUBLIC_SUPABASE_URL", {
      aliases: ["VITE_SUPABASE_URL", "SUPABASE_URL"],
      metaNames: ["supabase-url"],
    })
  );

  const supabaseAnonKey = readString("NEXT_PUBLIC_SUPABASE_ANON_KEY", {
    aliases: [
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_ANON_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
    ],
    metaNames: ["supabase-anon-key", "supabase-publishable-key"],
  });

  return Object.freeze({
    ...base,
    supabaseUrl,
    supabaseAnonKey,
    supabasePublishableKey: supabaseAnonKey,
  });
}

function buildServerEnv() {
  const base = buildBaseEnv();

  const supabaseUrl = stripTrailingSlash(
    readString("SUPABASE_URL", {
      aliases: ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"],
      metaNames: ["supabase-url"],
    })
  );

  const supabaseAnonKey = readString("SUPABASE_ANON_KEY", {
    aliases: [
      "SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_ANON_KEY",
    ],
    metaNames: ["supabase-anon-key", "supabase-publishable-key"],
  });

  const supabaseServiceRoleKey = readString("SUPABASE_SERVICE_ROLE_KEY", {
    aliases: ["SUPABASE_SERVICE_KEY"],
  });

  const supabaseJwtSecret = readString("SUPABASE_JWT_SECRET", {
    aliases: ["JWT_SECRET", "SESSION_SECRET"],
  });

  const sessionCookieName = readString("SESSION_COOKIE_NAME", {
    fallback: DEFAULTS.SESSION_COOKIE_NAME,
  });

  const sessionTtlHours = readNumber("SESSION_TTL_HOURS", {
    fallback: DEFAULTS.SESSION_TTL_HOURS,
    min: 1,
    max: 24 * 365,
  });

  const sessionSecure = readBoolean("SESSION_SECURE", {
    aliases: ["COOKIE_SECURE"],
    fallback: base.isProduction,
  });

  const resendApiKey = readString("RESEND_API_KEY");
  const turnstileSecretKey = readString("TURNSTILE_SECRET_KEY", {
    aliases: ["CLOUDFLARE_TURNSTILE_SECRET_KEY"],
  });

  return Object.freeze({
    ...base,
    supabaseUrl,
    supabaseAnonKey,
    supabasePublishableKey: supabaseAnonKey,
    supabaseServiceRoleKey,
    supabaseJwtSecret,
    sessionCookieName,
    sessionTtlHours,
    sessionSecure,
    resendApiKey,
    turnstileSecretKey,
  });
}

export function getPublicEnv() {
  return buildPublicEnv();
}

export function getServerEnv() {
  return buildServerEnv();
}

export function getEnv() {
  return isBrowser ? getPublicEnv() : getServerEnv();
}

export function assertRequiredEnv(requiredKeys = [], options = {}) {
  const {
    serverOnly = true,
    label = "environment",
  } = options;

  const source = serverOnly ? getServerEnv() : getEnv();
  const missing = [];

  for (const key of requiredKeys) {
    const value = clean(source[key]);
    if (!value) missing.push(key);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required ${label} variables: ${missing.join(", ")}`
    );
  }

  return source;
}

export function getSiteUrl(path = "") {
  const env = getEnv();
  const base = stripTrailingSlash(env.siteUrl);

  if (!base) return clean(path);
  if (!path) return base;

  return `${base}${ensureLeadingSlash(path)}`;
}

export function getSessionConfig() {
  const env = isBrowser ? getPublicEnv() : getServerEnv();

  return {
    cookieName: clean(env.sessionCookieName) || DEFAULTS.SESSION_COOKIE_NAME,
    ttlHours:
      typeof env.sessionTtlHours === "number"
        ? env.sessionTtlHours
        : DEFAULTS.SESSION_TTL_HOURS,
    secure:
      typeof env.sessionSecure === "boolean"
        ? env.sessionSecure
        : env.isProduction,
  };
}

export function getSupabasePublicConfig() {
  const env = getPublicEnv();

  return {
    url: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
    publishableKey: env.supabasePublishableKey,
  };
}

export function getSupabaseServerConfig() {
  const env = getServerEnv();

  return {
    url: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
    publishableKey: env.supabasePublishableKey,
    serviceRoleKey: env.supabaseServiceRoleKey,
    jwtSecret: env.supabaseJwtSecret,
  };
}

export const env = getEnv();

export default env;