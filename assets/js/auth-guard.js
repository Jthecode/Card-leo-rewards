// assets/js/auth-guard.js

(function () {
  const DEFAULTS = {
    meEndpoint: "/api/auth/me",
    logoutEndpoint: "/api/auth/logout",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    fallbackPortalOverviewEndpoint: "/api/portal/overview",
    redirectOnFail: true,
    requirePortalAccess: true,
    showLoader: true,
    debug: false,
  };

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function logDebug(enabled, ...args) {
    if (enabled) {
      console.log("[CardLeoAuthGuard]", ...args);
    }
  }

  function buildRedirectUrl(target, nextPath) {
    try {
      const url = new URL(target, window.location.origin);
      if (nextPath) {
        url.searchParams.set("next", nextPath);
      }
      return url.toString();
    } catch {
      return target;
    }
  }

  function createLoader() {
    const existing = document.querySelector("[data-cardleo-auth-loader]");
    if (existing) return existing;

    const loader = document.createElement("div");
    loader.setAttribute("data-cardleo-auth-loader", "true");
    loader.setAttribute("aria-live", "polite");
    loader.style.position = "fixed";
    loader.style.inset = "0";
    loader.style.zIndex = "9999";
    loader.style.display = "flex";
    loader.style.alignItems = "center";
    loader.style.justifyContent = "center";
    loader.style.background =
      "radial-gradient(circle at top, rgba(21, 35, 21, 0.92), rgba(7, 11, 8, 0.96))";
    loader.style.backdropFilter = "blur(10px)";

    const card = document.createElement("div");
    card.style.width = "min(92vw, 460px)";
    card.style.padding = "28px 24px";
    card.style.borderRadius = "22px";
    card.style.border = "1px solid rgba(205, 167, 82, 0.22)";
    card.style.background =
      "linear-gradient(180deg, rgba(20, 25, 20, 0.94), rgba(11, 15, 11, 0.96))";
    card.style.boxShadow =
      "0 30px 80px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(205, 167, 82, 0.08) inset";
    card.style.textAlign = "center";
    card.style.color = "#f4ead3";
    card.style.fontFamily =
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const badge = document.createElement("div");
    badge.textContent = "CARD LEO REWARDS";
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.justifyContent = "center";
    badge.style.padding = "8px 12px";
    badge.style.marginBottom = "16px";
    badge.style.borderRadius = "999px";
    badge.style.fontSize = "11px";
    badge.style.fontWeight = "700";
    badge.style.letterSpacing = "0.18em";
    badge.style.textTransform = "uppercase";
    badge.style.color = "#d8b05e";
    badge.style.background = "rgba(216, 176, 94, 0.08)";
    badge.style.border = "1px solid rgba(216, 176, 94, 0.18)";

    const spinner = document.createElement("div");
    spinner.style.width = "54px";
    spinner.style.height = "54px";
    spinner.style.margin = "0 auto 16px";
    spinner.style.borderRadius = "50%";
    spinner.style.border = "3px solid rgba(255,255,255,0.12)";
    spinner.style.borderTopColor = "#d8b05e";
    spinner.style.animation = "cardleoAuthSpin 0.9s linear infinite";

    const title = document.createElement("h2");
    title.textContent = "Checking your member access";
    title.style.margin = "0 0 10px";
    title.style.fontSize = "1.25rem";
    title.style.fontWeight = "700";
    title.style.lineHeight = "1.2";
    title.style.color = "#f8f3e8";

    const text = document.createElement("p");
    text.textContent =
      "Verifying your Card Leo Rewards session and portal permissions.";
    text.style.margin = "0";
    text.style.fontSize = "0.95rem";
    text.style.lineHeight = "1.6";
    text.style.color = "rgba(244, 234, 211, 0.78)";

    card.appendChild(badge);
    card.appendChild(spinner);
    card.appendChild(title);
    card.appendChild(text);
    loader.appendChild(card);
    document.body.appendChild(loader);

    if (!document.getElementById("cardleo-auth-guard-style")) {
      const style = document.createElement("style");
      style.id = "cardleo-auth-guard-style";
      style.textContent = `
        @keyframes cardleoAuthSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    return loader;
  }

  function removeLoader() {
    const loader = document.querySelector("[data-cardleo-auth-loader]");
    if (loader) {
      loader.remove();
    }
  }

  function inferMemberPayload(payload) {
    if (!isObject(payload)) return null;

    if (isObject(payload.member)) return payload.member;
    if (isObject(payload.user)) return payload.user;
    if (isObject(payload.profile)) return payload.profile;
    if (isObject(payload.data?.member)) return payload.data.member;
    if (isObject(payload.data?.user)) return payload.data.user;
    if (isObject(payload.data?.profile)) return payload.data.profile;
    if (isObject(payload.data)) return payload.data;

    return null;
  }

  function extractPortalAccess(payload) {
    const member = inferMemberPayload(payload);
    const portalAccess =
      member?.portalAccess ??
      member?.portal_access ??
      payload?.portalAccess ??
      payload?.portal_access ??
      payload?.data?.portalAccess ??
      payload?.data?.portal_access;

    if (typeof portalAccess === "boolean") return portalAccess;
    return null;
  }

  function extractAuthenticatedFlag(payload, member) {
    const authenticated =
      payload?.authenticated ??
      payload?.success ??
      payload?.loggedIn ??
      payload?.isAuthenticated ??
      payload?.data?.authenticated ??
      payload?.data?.loggedIn ??
      null;

    if (typeof authenticated === "boolean") {
      return authenticated;
    }

    return !!(
      member?.email ||
      member?.id ||
      payload?.session ||
      payload?.data?.session
    );
  }

  function extractAuthState(payload) {
    const member = inferMemberPayload(payload);

    return {
      authenticated: extractAuthenticatedFlag(payload, member),
      member,
      portalAccess: extractPortalAccess(payload),
    };
  }

  async function safeFetchJson(url, options) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
      ...options,
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { response, data };
  }

  async function getAuthState(config) {
    const meResult = await safeFetchJson(config.meEndpoint, { method: "GET" });
    logDebug(config.debug, "me endpoint result:", meResult);

    if (meResult.response.ok) {
      const state = extractAuthState(meResult.data);
      return {
        ok: true,
        source: "me",
        response: meResult.response,
        data: meResult.data,
        ...state,
      };
    }

    if (
      config.requirePortalAccess &&
      [401, 403, 404].includes(meResult.response.status)
    ) {
      const portalResult = await safeFetchJson(config.fallbackPortalOverviewEndpoint, {
        method: "GET",
      });

      logDebug(config.debug, "portal overview fallback result:", portalResult);

      if (portalResult.response.ok) {
        const state = extractAuthState(portalResult.data);
        return {
          ok: true,
          source: "portal-overview",
          response: portalResult.response,
          data: portalResult.data,
          authenticated: true,
          member: state.member,
          portalAccess:
            typeof state.portalAccess === "boolean" ? state.portalAccess : true,
        };
      }

      return {
        ok: false,
        source: "portal-overview",
        response: portalResult.response,
        data: portalResult.data,
        authenticated: false,
        member: null,
        portalAccess: false,
      };
    }

    return {
      ok: false,
      source: "me",
      response: meResult.response,
      data: meResult.data,
      authenticated: false,
      member: null,
      portalAccess: false,
    };
  }

  function applyMemberBindings(member) {
    if (!isObject(member)) return;

    const fullName =
      normalizeText(member.name) ||
      normalizeText(member.fullName || member.full_name) ||
      [
        normalizeText(member.firstName || member.first_name),
        normalizeText(member.lastName || member.last_name),
      ]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      "Card Leo Member";

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      fullName.split(" ")[0] ||
      "Member";

    const email = normalizeText(member.email || "");
    const status = normalizeText(
      member.status || member.memberStatus || member.member_status || "member"
    );
    const accessLevel = normalizeText(
      member.accessLevel ||
        member.access_level ||
        member.tier ||
        member.role ||
        "member"
    );

    const bindings = {
      name: fullName,
      firstName,
      email,
      status,
      accessLevel,
    };

    Object.entries(bindings).forEach(([key, value]) => {
      document.querySelectorAll(`[data-member-${key}]`).forEach((node) => {
        node.textContent = value;
      });
    });

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = email;
    document.body.dataset.memberStatus = status;
    document.body.dataset.memberAccessLevel = accessLevel;
  }

  function redirectToLogin(config) {
    const next = window.location.pathname + window.location.search + window.location.hash;
    const url = buildRedirectUrl(config.loginPage, next);
    window.location.href = url;
  }

  function redirectToUnauthorized(config) {
    const next = window.location.pathname + window.location.search + window.location.hash;
    const url = buildRedirectUrl(config.unauthorizedPage, next);
    window.location.href = url;
  }

  async function logout(config) {
    try {
      await fetch(config.logoutEndpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });
    } catch {
      // swallow logout network errors and still redirect
    }

    redirectToLogin(config);
  }

  async function run(options = {}) {
    const config = { ...DEFAULTS, ...options };
    const loader = config.showLoader ? createLoader() : null;

    document.body.dataset.authGuard = "checking";

    try {
      const state = await getAuthState(config);

      logDebug(config.debug, "final auth state:", state);

      if (!state.ok || !state.authenticated) {
        document.body.dataset.authGuard = "unauthenticated";

        if (config.redirectOnFail) {
          redirectToLogin(config);
          return {
            ok: false,
            status: state.response?.status || 401,
            reason: "unauthenticated",
            ...state,
          };
        }

        return {
          ok: false,
          status: state.response?.status || 401,
          reason: "unauthenticated",
          ...state,
        };
      }

      if (config.requirePortalAccess && state.portalAccess === false) {
        document.body.dataset.authGuard = "unauthorized";

        if (config.redirectOnFail) {
          redirectToUnauthorized(config);
          return {
            ok: false,
            status: state.response?.status || 403,
            reason: "unauthorized",
            ...state,
          };
        }

        return {
          ok: false,
          status: state.response?.status || 403,
          reason: "unauthorized",
          ...state,
        };
      }

      applyMemberBindings(state.member || {});
      document.body.dataset.authGuard = "ready";

      const event = new CustomEvent("cardleo:auth-ready", {
        detail: {
          member: state.member || null,
          source: state.source,
          portalAccess: state.portalAccess,
          authenticated: state.authenticated,
        },
      });

      window.dispatchEvent(event);

      return {
        ok: true,
        status: 200,
        reason: "authorized",
        ...state,
      };
    } catch (error) {
      document.body.dataset.authGuard = "error";
      logDebug(config.debug, "auth guard error:", error);

      if (config.redirectOnFail) {
        redirectToLogin(config);
      }

      return {
        ok: false,
        status: 500,
        reason: "error",
        error,
      };
    } finally {
      if (loader) {
        removeLoader();
      }
    }
  }

  const CardLeoAuthGuard = {
    init: run,
    run,
    logout,
    defaults: { ...DEFAULTS },
  };

  window.CardLeoAuthGuard = CardLeoAuthGuard;
})();