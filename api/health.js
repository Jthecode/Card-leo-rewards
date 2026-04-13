// api/health.js

import { getServerEnv } from "../lib/env.js";
import {
  ok,
  serverError,
  methodNotAllowed,
  setNoStore,
  setJsonHeaders,
} from "../lib/responses.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("api:health");

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function getRuntime() {
  if (typeof process !== "undefined" && process.release?.name) {
    return process.release.name;
  }
  return "unknown";
}

function getNodeVersion() {
  if (typeof process !== "undefined" && process.version) {
    return process.version;
  }
  return "unknown";
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function buildEnvChecks(env) {
  return {
    siteUrlConfigured: Boolean(clean(env.siteUrl)),
    supportEmailConfigured: Boolean(clean(env.supportEmail)),
    fromEmailConfigured: Boolean(clean(env.fromEmail)),
    supabaseUrlConfigured: Boolean(clean(env.supabaseUrl)),
    supabasePublishableConfigured: Boolean(
      clean(env.supabaseAnonKey || env.supabasePublishableKey)
    ),
    supabaseServiceRoleConfigured: Boolean(clean(env.supabaseServiceRoleKey)),
    sessionCookieConfigured: Boolean(clean(env.sessionCookieName)),
  };
}

async function checkSupabaseReachability(env) {
  const supabaseUrl = clean(env.supabaseUrl);
  const publishableKey = clean(env.supabaseAnonKey || env.supabasePublishableKey);

  if (!supabaseUrl || !publishableKey) {
    return {
      ok: false,
      status: "missing_config",
      latencyMs: null,
      message: "Supabase URL or publishable key is missing.",
    };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      method: "GET",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        status: "unreachable",
        latencyMs,
        httpStatus: response.status,
        message: `Supabase responded with status ${response.status}.`,
      };
    }

    return {
      ok: true,
      status: "ok",
      latencyMs,
      httpStatus: response.status,
      message: "Supabase is reachable.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      latencyMs: Date.now() - startedAt,
      message: error?.message || "Failed to reach Supabase.",
    };
  }
}

function buildSummary({ envChecks, supabaseCheck }) {
  const requiredOk =
    envChecks.siteUrlConfigured &&
    envChecks.supportEmailConfigured &&
    envChecks.fromEmailConfigured &&
    envChecks.supabaseUrlConfigured &&
    envChecks.supabasePublishableConfigured &&
    envChecks.supabaseServiceRoleConfigured &&
    envChecks.sessionCookieConfigured;

  if (!requiredOk) {
    return {
      healthy: false,
      status: "degraded",
      message: "One or more required environment values are missing.",
    };
  }

  if (!supabaseCheck.ok) {
    return {
      healthy: false,
      status: "degraded",
      message: "Application config loaded, but Supabase is not reachable.",
    };
  }

  return {
    healthy: true,
    status: "ok",
    message: "Card Leo Rewards API is healthy.",
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  setJsonHeaders(res);

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"]);
  }

  try {
    const env = getServerEnv();
    const envChecks = buildEnvChecks(env);
    const supabaseCheck = await checkSupabaseReachability(env);
    const summary = buildSummary({ envChecks, supabaseCheck });

    const diagnostics = {
      app: clean(env.appName) || "Card Leo Rewards",
      timestamp: nowIso(),
      environment: clean(env.nodeEnv) || "development",
      runtime: getRuntime(),
      nodeVersion: getNodeVersion(),
      uptimeSeconds:
        typeof process !== "undefined" && typeof process.uptime === "function"
          ? Math.round(process.uptime())
          : null,
      checks: {
        env: envChecks,
        supabase: supabaseCheck,
      },
    };

    if (!summary.healthy) {
      logger.warn("Health check returned degraded status.", {
        status: summary.status,
        checks: diagnostics.checks,
      });

      return res.status(503).json({
        success: false,
        message: summary.message,
        data: {
          status: summary.status,
          ...diagnostics,
        },
      });
    }

    logger.info("Health check passed.", {
      status: summary.status,
      supabaseLatencyMs: supabaseCheck.latencyMs,
    });

    return ok(
      res,
      {
        status: summary.status,
        ...diagnostics,
      },
      summary.message
    );
  } catch (error) {
    logger.error("Health check failed unexpectedly.", {
      error: {
        name: error?.name || "Error",
        message: error?.message || "Unknown error",
      },
    });

    return serverError(
      res,
      "Health check failed unexpectedly.",
      isTruthy(process?.env?.NODE_ENV !== "production")
        ? {
            error: error?.message || "Unknown error",
          }
        : null
    );
  }
}