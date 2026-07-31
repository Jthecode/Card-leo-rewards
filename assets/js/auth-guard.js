// assets/js/auth-guard.js
(function () {
  const DEFAULTS = {
    meEndpoint: "/api/auth/me",
    logoutEndpoint: "/api/auth/logout",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    paymentRequiredPage: "/signup.html?status=payment_required",
    redirectOnFail: true,
    requirePortalAccess: true,
    showLoader: true,
    autoBindLogout: true,
    debug: false,
    maxRetries: 2,
    retryDelayMs: 450,
  };

  const ACTIVE_STATUSES = new Set([
    "active",
    "approved",
    "invited",
    "paid",
    "current",
    "complete",
    "completed",
  ]);

  const PAID_PAYMENT_STATUSES = new Set([
    "paid",
    "active",
    "current",
    "succeeded",
    "complete",
    "completed",
  ]);

  const ACTIVE_MEMBERSHIP_STATUSES = new Set([
    "active",
    "activated",
    "paid",
    "approved",
    "current",
  ]);

  let currentAuthState = null;
  let isRunning = false;
  let hasRedirected = false;

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function logDebug(enabled, ...args) {
    if (enabled) {
      console.log("[CardLeoAuthGuard]", ...args);
    }
  }

  function getCurrentPath() {
    return `${window.location.pathname}${window.location.search || ""}${window.location.hash || ""}`;
  }

  function isLoginPage(config) {
    return window.location.pathname === new URL(config.loginPage, window.location.origin).pathname;
  }

  function buildRedirectUrl(target, nextPath) {
    try {
      const url = new URL(target, window.location.origin);

      if (nextPath) {
        url.searchParams.set("next", nextPath);
      }

      return url.toString();
    } catch {
      const separator = String(target).includes("?") ? "&" : "?";
      return nextPath
        ? `${target}${separator}next=${encodeURIComponent(nextPath)}`
        : target;
    }
  }

  function safeRedirect(targetUrl) {
    if (hasRedirected) return;

    hasRedirected = true;

    window.setTimeout(() => {
      window.location.replace(targetUrl);
    }, 50);
  }

  function redirectToLogin(config) {
    if (isLoginPage(config)) return;

    const url = buildRedirectUrl(config.loginPage, getCurrentPath());
    safeRedirect(url);
  }

  function redirectToUnauthorized(config) {
    const url = buildRedirectUrl(config.unauthorizedPage, getCurrentPath());
    safeRedirect(url);
  }

  function redirectToPaymentRequired(config, redirectTo) {
    const target = normalizeText(redirectTo) || config.paymentRequiredPage;
    const url = buildRedirectUrl(target, getCurrentPath());
    safeRedirect(url);
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
    if (loader) loader.remove();
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) {
      return {
        root: {},
        data: {},
        message: "",
        success: false,
      };
    }

    const data = isObject(payload.data) ? payload.data : payload;

    return {
      root: payload,
      data,
      message: normalizeText(payload.message || data.message),
      success:
        payload.success === true ||
        data.success === true ||
        payload.ok === true ||
        data.ok === true,
    };
  }

  function getUserMetadata(user) {
    return isObject(user?.user_metadata) ? user.user_metadata : {};
  }

  function getAppMetadata(user) {
    return isObject(user?.app_metadata) ? user.app_metadata : {};
  }

  function pickMember(payload) {
    const { data } = unwrapApiPayload(payload);

    if (isObject(data.member)) return data.member;
    if (isObject(data.profile)) return data.profile;

    return null;
  }

  function pickUser(payload) {
    const { data } = unwrapApiPayload(payload);
    return isObject(data.user) ? data.user : null;
  }

  function pickProfile(payload) {
    const { data } = unwrapApiPayload(payload);
    return isObject(data.profile) ? data.profile : null;
  }

  function getDisplayName({ member, profile, user }) {
    const metadata = getUserMetadata(user);

    const fullName =
      normalizeText(member?.fullName) ||
      normalizeText(member?.full_name) ||
      normalizeText(member?.name) ||
      normalizeText(profile?.fullName) ||
      normalizeText(profile?.full_name) ||
      normalizeText(profile?.name) ||
      normalizeText(metadata.full_name) ||
      normalizeText(metadata.name);

    if (fullName) return fullName;

    const firstName =
      normalizeText(member?.firstName || member?.first_name) ||
      normalizeText(profile?.firstName || profile?.first_name) ||
      normalizeText(metadata.first_name);

    const lastName =
      normalizeText(member?.lastName || member?.last_name) ||
      normalizeText(profile?.lastName || profile?.last_name) ||
      normalizeText(metadata.last_name);

    const joined = [firstName, lastName].filter(Boolean).join(" ");

    return (
      joined ||
      normalizeText(member?.email?.split("@")[0]) ||
      normalizeText(profile?.email?.split("@")[0]) ||
      normalizeText(user?.email?.split("@")[0]) ||
      "Card Leo Member"
    );
  }

  function getEmail({ member, profile, user, data }) {
    return normalizeEmail(
      data?.email ||
        data?.userEmail ||
        member?.email ||
        profile?.email ||
        user?.email
    );
  }

  function getMemberId({ member, profile, user, data }) {
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

  function getPortalUserId({ member, profile, user }) {
    const metadata = getUserMetadata(user);

    return normalizeText(
      member?.portalUserId ||
        member?.portal_user_id ||
        profile?.portalUserId ||
        profile?.portal_user_id ||
        user?.portalUserId ||
        user?.portal_user_id ||
        metadata.portalUserId ||
        metadata.portal_user_id
    );
  }

  function getRole({ member, profile, user, data }) {
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

  function getStatus({ member, profile, data }) {
    return normalizeText(
      data?.status ||
        member?.memberStatus ||
        member?.member_status ||
        member?.status ||
        profile?.memberStatus ||
        profile?.member_status ||
        profile?.status ||
        "active"
    ).toLowerCase();
  }

  function getPaymentStatus({ member, profile, data }) {
    return normalizeText(
      data?.payment_status ||
        data?.paymentStatus ||
        member?.payment_status ||
        member?.paymentStatus ||
        profile?.payment_status ||
        profile?.paymentStatus ||
        ""
    ).toLowerCase();
  }

  function getMembershipStatus({ member, profile, data }) {
    return normalizeText(
      data?.membership_status ||
        data?.membershipStatus ||
        member?.membership_status ||
        member?.membershipStatus ||
        profile?.membership_status ||
        profile?.membershipStatus ||
        ""
    ).toLowerCase();
  }

  function getTier({ member, profile }) {
    return normalizeText(
      member?.tier ||
        member?.accessLevel ||
        member?.access_level ||
        profile?.tier ||
        "core"
    ).toLowerCase();
  }

  function isPaymentRequired(data) {
    return (
      data?.requires_payment === true ||
      data?.requiresPayment === true ||
      data?.payment_required === true ||
      data?.paymentRequired === true
    );
  }

  function getPortalAccess({ member, profile, data, authenticated }) {
    if (typeof data?.portalAccess === "boolean") return data.portalAccess;
    if (typeof data?.portal_access === "boolean") return data.portal_access;
    if (typeof member?.portalAccess === "boolean") return member.portalAccess;
    if (typeof member?.portal_access === "boolean") return member.portal_access;

    const status = getStatus({ member, profile, data });
    const paymentStatus = getPaymentStatus({ member, profile, data });
    const membershipStatus = getMembershipStatus({ member, profile, data });

    if (
      ACTIVE_STATUSES.has(status) ||
      PAID_PAYMENT_STATUSES.has(paymentStatus) ||
      ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus)
    ) {
      return true;
    }

    if (
      ["pending", "reviewing", "disabled", "suspended", "denied", "closed"].includes(
        status
      )
    ) {
      return false;
    }

    return Boolean(authenticated);
  }

  function extractAuthState(payload, response) {
    const unwrapped = unwrapApiPayload(payload);
    const data = unwrapped.data;
    const member = pickMember(payload);
    const user = pickUser(payload);
    const profile = pickProfile(payload);

    const authenticated = data.authenticated === true;
    const status = getStatus({ member, profile, data });
    const paymentStatus = getPaymentStatus({ member, profile, data });
    const membershipStatus = getMembershipStatus({ member, profile, data });

    const normalizedMember = {
      ...(isObject(member) ? member : {}),
      id: getMemberId({ member, profile, user, data }),
      signupId: normalizeText(
        member?.signupId ||
          member?.signup_id ||
          getMemberId({ member, profile, user, data })
      ),
      portalUserId: getPortalUserId({ member, profile, user }),
      email: getEmail({ member, profile, user, data }),
      fullName: getDisplayName({ member, profile, user }),
      name: getDisplayName({ member, profile, user }),
      role: getRole({ member, profile, user, data }),
      status,
      memberStatus: status,
      payment_status: paymentStatus,
      paymentStatus,
      membership_status: membershipStatus,
      membershipStatus,
      tier: getTier({ member, profile }),
      portalAccess: getPortalAccess({ member, profile, data, authenticated }),
    };

    const redirectTo =
      normalizeText(data.redirectTo) ||
      normalizeText(payload?.redirectTo) ||
      normalizeText(member?.portalLoginUrl) ||
      normalizeText(member?.portal_login_url) ||
      "/portal/index.html";

    return {
      ok: response?.ok === true,
      httpStatus: response?.status || 0,
      success: unwrapped.success,
      authenticated,
      member: authenticated ? normalizedMember : null,
      user: authenticated ? user : null,
      profile: authenticated ? profile : null,
      session: isObject(data.session) ? data.session : null,
      portalAccess: authenticated
        ? getPortalAccess({
            member: normalizedMember,
            profile,
            data,
            authenticated,
          })
        : false,
      paymentRequired: isPaymentRequired(data),
      message: unwrapped.message,
      redirectTo,
      data,
      raw: payload,
    };
  }

  async function safeFetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        ...(options.headers || {}),
      },
      ...options,
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      response,
      data,
    };
  }

  async function getAuthState(config) {
    let lastResult = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const meResult = await safeFetchJson(config.meEndpoint, {
        method: "GET",
      });

      lastResult = meResult;

      logDebug(config.debug, "me endpoint result:", {
        attempt,
        meResult,
      });

      const state = extractAuthState(meResult.data, meResult.response);

      if (state.authenticated || state.paymentRequired) {
        return {
          source: "me",
          response: meResult.response,
          ...state,
        };
      }

      const shouldRetry =
        attempt < config.maxRetries &&
        (meResult.response.status === 0 ||
          meResult.response.status >= 500 ||
          state.message.toLowerCase().includes("no active session"));

      if (!shouldRetry) {
        return {
          source: "me",
          response: meResult.response,
          ...state,
        };
      }

      await sleep(config.retryDelayMs);
    }

    const fallbackState = extractAuthState(lastResult?.data, lastResult?.response);

    return {
      source: "me",
      response: lastResult?.response || null,
      ...fallbackState,
    };
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

  function applyMemberBindings(member) {
    if (!isObject(member)) return;

    const fullName =
      normalizeText(member.fullName || member.full_name || member.name) ||
      "Card Leo Member";

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      fullName.split(/\s+/)[0] ||
      "Member";

    const lastName = normalizeText(member.lastName || member.last_name);
    const email = normalizeText(member.email);
    const status = normalizeText(
      member.memberStatus || member.member_status || member.status || "active"
    );
    const tier = normalizeText(member.tier || "core");
    const role = normalizeText(member.role || "member");
    const accessLevel = normalizeText(
      member.accessLevel || member.access_level || tier || role
    );
    const memberId = normalizeText(member.id || member.signupId || member.signup_id);
    const portalUserId = normalizeText(member.portalUserId || member.portal_user_id);

    const bindings = [
      ["[data-member-name]", fullName],
      ["[data-member-full-name]", fullName],
      ["[data-member-first-name]", firstName],
      ["[data-member-last-name]", lastName],
      ["[data-member-email]", email],
      ["[data-member-status]", status],
      ["[data-member-tier]", tier],
      ["[data-member-role]", role],
      ["[data-member-access-level]", accessLevel],
      ["[data-member-accesslevel]", accessLevel],
      ["[data-member-id]", memberId],
      ["[data-member-signup-id]", memberId],
      ["[data-member-portal-user-id]", portalUserId],
      ["[data-session-name]", fullName],
      ["[data-session-email]", email],
      ["[data-session-user-id]", memberId],
      ["[data-session-role]", role],
      ["[data-session-status]", status],
    ];

    bindings.forEach(([selector, value]) => {
      setText(selector, value);
    });

    setValue("[data-profile-name-input]", fullName);
    setValue("[data-profile-email-input]", email);

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = email;
    document.body.dataset.memberStatus = status;
    document.body.dataset.memberTier = tier;
    document.body.dataset.memberRole = role;
    document.body.dataset.memberAccessLevel = accessLevel;
    document.body.dataset.memberId = memberId;
  }

  function setVisibilityForAuthState(authenticated) {
    document.querySelectorAll("[data-authenticated]").forEach((node) => {
      node.hidden = !authenticated;
    });

    document.querySelectorAll("[data-guest]").forEach((node) => {
      node.hidden = authenticated;
    });
  }

  async function logoutMember(config = DEFAULTS) {
    try {
      await fetch(config.logoutEndpoint || DEFAULTS.logoutEndpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      // Still redirect even if logout network request fails.
    }

    currentAuthState = null;
    redirectToLogin(config);
  }

  function bindLogoutButtons(config) {
    document
      .querySelectorAll("[data-logout], [data-member-logout]")
      .forEach((button) => {
        if (button.dataset.authGuardLogoutBound === "true") return;

        button.dataset.authGuardLogoutBound = "true";

        button.addEventListener("click", async (event) => {
          event.preventDefault();

          const originalText =
            "value" in button ? button.value : button.textContent;
          const canDisable = "disabled" in button;

          try {
            if ("value" in button) {
              button.value = "Signing out...";
            } else {
              button.textContent = "Signing out...";
            }

            if (canDisable) {
              button.disabled = true;
            }

            await logoutMember(config);
          } catch (error) {
            if ("value" in button) {
              button.value = originalText;
            } else {
              button.textContent = originalText;
            }

            if (canDisable) {
              button.disabled = false;
            }

            alert(error?.message || "Unable to sign out right now.");
          }
        });
      });
  }

  function dispatchReadyEvent(state) {
    const event = new CustomEvent("cardleo:auth-ready", {
      detail: {
        ok: true,
        member: state.member || null,
        user: state.user || null,
        profile: state.profile || null,
        session: state.session || null,
        source: state.source,
        portalAccess: state.portalAccess,
        authenticated: state.authenticated,
        redirectTo: state.redirectTo,
        raw: state.raw,
        data: state.data,
      },
    });

    window.dispatchEvent(event);
  }

  function dispatchFailureEvent(state) {
    const event = new CustomEvent("cardleo:auth-failed", {
      detail: state,
    });

    window.dispatchEvent(event);
  }

  async function run(options = {}) {
    if (isRunning) {
      return currentAuthState;
    }

    isRunning = true;
    hasRedirected = false;

    const config = {
      ...DEFAULTS,
      ...options,
    };

    const loader = config.showLoader ? createLoader() : null;

    document.body.dataset.authGuard = "checking";

    try {
      const state = await getAuthState(config);

      currentAuthState = state;

      logDebug(config.debug, "final auth state:", state);

      if (state.paymentRequired) {
        document.body.dataset.authGuard = "payment-required";
        setVisibilityForAuthState(false);

        dispatchFailureEvent({
          ok: false,
          status: state.httpStatus || 402,
          reason: "payment_required",
          ...state,
        });

        if (config.redirectOnFail) {
          redirectToPaymentRequired(config, state.redirectTo);
        }

        return {
          ok: false,
          status: state.httpStatus || 402,
          reason: "payment_required",
          ...state,
        };
      }

      if (!state.authenticated) {
        document.body.dataset.authGuard = "unauthenticated";
        setVisibilityForAuthState(false);

        dispatchFailureEvent({
          ok: false,
          status: state.httpStatus || 401,
          reason: "unauthenticated",
          ...state,
        });

        if (config.redirectOnFail) {
          redirectToLogin(config);
        }

        return {
          ok: false,
          status: state.httpStatus || 401,
          reason: "unauthenticated",
          ...state,
        };
      }

      if (config.requirePortalAccess && state.portalAccess === false) {
        document.body.dataset.authGuard = "unauthorized";
        setVisibilityForAuthState(false);

        dispatchFailureEvent({
          ok: false,
          status: state.httpStatus || 403,
          reason: "unauthorized",
          ...state,
        });

        if (config.redirectOnFail) {
          redirectToUnauthorized(config);
        }

        return {
          ok: false,
          status: state.httpStatus || 403,
          reason: "unauthorized",
          ...state,
        };
      }

      applyMemberBindings(state.member || {});
      setVisibilityForAuthState(true);

      document.body.dataset.authGuard = "ready";

      if (config.autoBindLogout) {
        bindLogoutButtons(config);
      }

      dispatchReadyEvent(state);

      return {
        ok: true,
        status: 200,
        reason: "authorized",
        ...state,
      };
    } catch (error) {
      document.body.dataset.authGuard = "error";

      logDebug(config.debug, "auth guard error:", error);

      const failedState = {
        ok: false,
        status: 500,
        reason: "error",
        error,
      };

      dispatchFailureEvent(failedState);

      if (config.redirectOnFail) {
        redirectToLogin(config);
      }

      return failedState;
    } finally {
      isRunning = false;

      if (loader) {
        removeLoader();
      }
    }
  }

  function getState() {
    return currentAuthState;
  }

  function autoInitFromBody() {
    const root = document.body || document.documentElement;

    if (!root) return;

    const shouldAutoRun =
      root.hasAttribute("data-require-auth") ||
      root.hasAttribute("data-auth-guard") ||
      root.dataset.cardleoAuthGuard === "auto";

    if (!shouldAutoRun) return;

    run({
      redirectOnFail: root.dataset.redirectOnFail !== "false",
      requirePortalAccess: root.dataset.requirePortalAccess !== "false",
      showLoader: root.dataset.showAuthLoader !== "false",
      debug: root.dataset.authDebug === "true",
    });
  }

  const CardLeoAuthGuard = {
    init: run,
    run,
    logout: logoutMember,
    bindLogoutButtons,
    getState,
    defaults: { ...DEFAULTS },
  };

  window.CardLeoAuthGuard = CardLeoAuthGuard;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInitFromBody);
  } else {
    autoInitFromBody();
  }
})();