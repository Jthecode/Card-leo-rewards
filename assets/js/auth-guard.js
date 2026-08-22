// assets/js/auth-guard.js

(function () {
  "use strict";

  /* ==========================================================================
     CARD LEO REWARDS
     GLOBAL MEMBER AUTH GUARD

     VERSION
     -------
     2026-08-22-portal-session-fix

     PURPOSE
     -------
     - Uses /api/auth/me as the single source of truth.
     - Protects Card Leo member portal pages.
     - Prevents false login redirect loops.
     - Keeps temporary API/database failures from logging members out.
     - Separates:
         authentication
         payment readiness
         portal access
         temporary service errors
     - Normalizes member data for all portal pages.
     - Provides global logout behavior.
     - Dispatches Card Leo authentication events.
  ========================================================================== */

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

  /* ==========================================================================
     STATUS RULES
  ========================================================================== */

  const ACTIVE_STATUSES = new Set([
    "active",
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
    "auto_approved",
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
    "approved",
    "paid",
    "current",
    "complete",
    "completed",
    "succeeded",
    "auto_approved",
  ]);

  const PAYMENT_REQUIRED_STATUSES = new Set([
    "",
    "unpaid",
    "payment_pending",
    "pending_payment",
    "requires_payment",
    "incomplete",
    "past_due",
    "failed",
    "payment_failed",
  ]);

  const BLOCKED_STATUSES = new Set([
    "disabled",
    "suspended",
    "paused",
    "denied",
    "closed",
    "cancelled",
    "canceled",
  ]);

  /* ==========================================================================
     INTERNAL STATE
  ========================================================================== */

  let currentAuthState = null;
  let isRunning = false;
  let hasRedirected = false;

  /* ==========================================================================
     BASIC HELPERS
  ========================================================================== */

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeStatus(value) {
    return normalizeText(value).toLowerCase();
  }

  function isObject(value) {
    return (
      Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function logDebug(enabled, ...args) {
    if (!enabled) return;

    console.log(
      "[CardLeoAuthGuard]",
      ...args
    );
  }

  /* ==========================================================================
     PATH / REDIRECT HELPERS
  ========================================================================== */

  function getCurrentPath() {
    return (
      `${window.location.pathname}` +
      `${window.location.search || ""}` +
      `${window.location.hash || ""}`
    );
  }

  function isLoginPage(config) {
    try {
      const loginUrl = new URL(
        config.loginPage,
        window.location.origin
      );

      return (
        window.location.pathname ===
        loginUrl.pathname
      );
    } catch {
      return (
        window.location.pathname ===
        "/login.html"
      );
    }
  }

  function buildRedirectUrl(
    target,
    nextPath
  ) {
    try {
      const url = new URL(
        target,
        window.location.origin
      );

      if (nextPath) {
        url.searchParams.set(
          "next",
          nextPath
        );
      }

      return url.toString();
    } catch {
      const separator =
        String(target).includes("?")
          ? "&"
          : "?";

      return nextPath
        ? `${target}${separator}next=${encodeURIComponent(
            nextPath
          )}`
        : target;
    }
  }

  function safeRedirect(targetUrl) {
    if (hasRedirected) {
      return;
    }

    hasRedirected = true;

    window.setTimeout(() => {
      window.location.replace(
        targetUrl
      );
    }, 50);
  }

  function redirectToLogin(config) {
    if (isLoginPage(config)) {
      return;
    }

    const currentPath =
      getCurrentPath();

    const url =
      buildRedirectUrl(
        config.loginPage,
        currentPath
      );

    safeRedirect(url);
  }

  function redirectToUnauthorized(
    config
  ) {
    const url =
      buildRedirectUrl(
        config.unauthorizedPage,
        getCurrentPath()
      );

    safeRedirect(url);
  }

  function redirectToPaymentRequired(
    config,
    redirectTo
  ) {
    const target =
      normalizeText(redirectTo) ||
      config.paymentRequiredPage;

    const url =
      buildRedirectUrl(
        target,
        getCurrentPath()
      );

    safeRedirect(url);
  }

  /* ==========================================================================
     LOADER
  ========================================================================== */

  function ensureAuthStyles() {
    if (
      document.getElementById(
        "cardleo-auth-guard-style"
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        "style"
      );

    style.id =
      "cardleo-auth-guard-style";

    style.textContent = `
      @keyframes cardleoAuthSpin {
        from {
          transform: rotate(0deg);
        }

        to {
          transform: rotate(360deg);
        }
      }

      [data-cardleo-auth-loader] {
        box-sizing: border-box;
      }

      [data-cardleo-auth-loader] * {
        box-sizing: border-box;
      }

      [data-cardleo-auth-service-error] {
        box-sizing: border-box;
      }

      [data-cardleo-auth-service-error] * {
        box-sizing: border-box;
      }
    `;

    document.head.appendChild(
      style
    );
  }

  function createLoader() {
    const existing =
      document.querySelector(
        "[data-cardleo-auth-loader]"
      );

    if (existing) {
      return existing;
    }

    ensureAuthStyles();

    const loader =
      document.createElement(
        "div"
      );

    loader.setAttribute(
      "data-cardleo-auth-loader",
      "true"
    );

    loader.setAttribute(
      "aria-live",
      "polite"
    );

    Object.assign(
      loader.style,
      {
        position: "fixed",
        inset: "0",
        zIndex: "999999",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",

        padding: "20px",

        background:
          "radial-gradient(circle at top, rgba(21,35,21,.94), rgba(7,11,8,.98))",

        backdropFilter:
          "blur(10px)",
      }
    );

    const card =
      document.createElement(
        "div"
      );

    Object.assign(
      card.style,
      {
        width:
          "min(92vw, 460px)",

        padding:
          "28px 24px",

        borderRadius:
          "22px",

        border:
          "1px solid rgba(205,167,82,.22)",

        background:
          "linear-gradient(180deg, rgba(20,25,20,.96), rgba(11,15,11,.98))",

        boxShadow:
          "0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(205,167,82,.08) inset",

        textAlign:
          "center",

        color:
          "#f4ead3",

        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }
    );

    const badge =
      document.createElement(
        "div"
      );

    badge.textContent =
      "CARD LEO REWARDS";

    Object.assign(
      badge.style,
      {
        display:
          "inline-flex",

        alignItems:
          "center",

        justifyContent:
          "center",

        padding:
          "8px 12px",

        marginBottom:
          "16px",

        borderRadius:
          "999px",

        fontSize:
          "11px",

        fontWeight:
          "700",

        letterSpacing:
          ".18em",

        textTransform:
          "uppercase",

        color:
          "#d8b05e",

        background:
          "rgba(216,176,94,.08)",

        border:
          "1px solid rgba(216,176,94,.18)",
      }
    );

    const spinner =
      document.createElement(
        "div"
      );

    Object.assign(
      spinner.style,
      {
        width:
          "54px",

        height:
          "54px",

        margin:
          "0 auto 16px",

        borderRadius:
          "50%",

        border:
          "3px solid rgba(255,255,255,.12)",

        borderTopColor:
          "#d8b05e",

        animation:
          "cardleoAuthSpin .9s linear infinite",
      }
    );

    const title =
      document.createElement(
        "h2"
      );

    title.textContent =
      "Checking your member access";

    Object.assign(
      title.style,
      {
        margin:
          "0 0 10px",

        fontSize:
          "1.25rem",

        fontWeight:
          "700",

        lineHeight:
          "1.2",

        color:
          "#f8f3e8",
      }
    );

    const text =
      document.createElement(
        "p"
      );

    text.textContent =
      "Verifying your Card Leo Rewards session and portal permissions.";

    Object.assign(
      text.style,
      {
        margin:
          "0",

        fontSize:
          ".95rem",

        lineHeight:
          "1.6",

        color:
          "rgba(244,234,211,.78)",
      }
    );

    card.appendChild(
      badge
    );

    card.appendChild(
      spinner
    );

    card.appendChild(
      title
    );

    card.appendChild(
      text
    );

    loader.appendChild(
      card
    );

    document.body.appendChild(
      loader
    );

    return loader;
  }

  function removeLoader() {
    const loader =
      document.querySelector(
        "[data-cardleo-auth-loader]"
      );

    if (loader) {
      loader.remove();
    }
  }

  /* ==========================================================================
     SERVICE ERROR NOTICE

     IMPORTANT
     ---------
     Temporary server/database/network failures must NOT send an otherwise
     valid member to login.

     This is one of the primary protections against the My Card login loop.
  ========================================================================== */

  function removeServiceErrorNotice() {
    const existing =
      document.querySelector(
        "[data-cardleo-auth-service-error]"
      );

    if (existing) {
      existing.remove();
    }
  }

  function showServiceErrorNotice(
    config,
    state = {}
  ) {
    removeServiceErrorNotice();
    ensureAuthStyles();

    const overlay =
      document.createElement(
        "div"
      );

    overlay.setAttribute(
      "data-cardleo-auth-service-error",
      "true"
    );

    Object.assign(
      overlay.style,
      {
        position:
          "fixed",

        inset:
          "0",

        zIndex:
          "999998",

        display:
          "flex",

        alignItems:
          "center",

        justifyContent:
          "center",

        padding:
          "20px",

        background:
          "rgba(5,8,6,.94)",

        backdropFilter:
          "blur(12px)",

        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }
    );

    const card =
      document.createElement(
        "div"
      );

    Object.assign(
      card.style,
      {
        width:
          "min(92vw, 500px)",

        padding:
          "30px 26px",

        borderRadius:
          "24px",

        border:
          "1px solid rgba(216,176,94,.22)",

        background:
          "linear-gradient(180deg, rgba(22,28,22,.98), rgba(10,14,11,.98))",

        boxShadow:
          "0 30px 90px rgba(0,0,0,.55)",

        color:
          "#f8f3e8",

        textAlign:
          "center",
      }
    );

    const badge =
      document.createElement(
        "div"
      );

    badge.textContent =
      "CARD LEO REWARDS";

    Object.assign(
      badge.style,
      {
        display:
          "inline-block",

        marginBottom:
          "16px",

        padding:
          "7px 11px",

        borderRadius:
          "999px",

        color:
          "#d8b05e",

        border:
          "1px solid rgba(216,176,94,.2)",

        background:
          "rgba(216,176,94,.08)",

        fontSize:
          "11px",

        fontWeight:
          "800",

        letterSpacing:
          ".16em",
      }
    );

    const title =
      document.createElement(
        "h2"
      );

    title.textContent =
      "We couldn't verify your session";

    Object.assign(
      title.style,
      {
        margin:
          "0 0 10px",

        fontSize:
          "1.35rem",

        lineHeight:
          "1.25",
      }
    );

    const message =
      document.createElement(
        "p"
      );

    message.textContent =
      "Your session was not cleared. Card Leo is temporarily unable to verify your account. Please try again.";

    Object.assign(
      message.style,
      {
        margin:
          "0 0 22px",

        color:
          "rgba(248,243,232,.74)",

        fontSize:
          ".95rem",

        lineHeight:
          "1.6",
      }
    );

    const button =
      document.createElement(
        "button"
      );

    button.type =
      "button";

    button.textContent =
      "Try Again";

    Object.assign(
      button.style,
      {
        width:
          "100%",

        border:
          "0",

        borderRadius:
          "14px",

        padding:
          "14px 18px",

        cursor:
          "pointer",

        background:
          "#d8b05e",

        color:
          "#11150f",

        fontSize:
          "15px",

        fontWeight:
          "800",
      }
    );

    button.addEventListener(
      "click",
      async () => {
        button.disabled =
          true;

        button.textContent =
          "Checking...";

        removeServiceErrorNotice();

        const result =
          await run({
            ...config,
            showLoader:
              true,
          });

        if (
          !result?.ok &&
          (
            result?.reason ===
              "service_unavailable" ||
            result?.reason ===
              "error"
          )
        ) {
          button.disabled =
            false;

          button.textContent =
            "Try Again";
        }
      }
    );

    if (
      config.debug &&
      state?.error
    ) {
      const debug =
        document.createElement(
          "pre"
        );

      debug.textContent =
        normalizeText(
          state.error?.message ||
          state.message ||
          "Unknown authentication service error."
        );

      Object.assign(
        debug.style,
        {
          margin:
            "18px 0 0",

          padding:
            "12px",

          borderRadius:
            "12px",

          textAlign:
            "left",

          overflowX:
            "auto",

          whiteSpace:
            "pre-wrap",

          background:
            "rgba(0,0,0,.25)",

          color:
            "rgba(248,243,232,.65)",

          fontSize:
            "12px",
        }
      );

      card.appendChild(
        debug
      );
    }

    card.appendChild(
      badge
    );

    card.appendChild(
      title
    );

    card.appendChild(
      message
    );

    card.appendChild(
      button
    );

    overlay.appendChild(
      card
    );

    document.body.appendChild(
      overlay
    );
  }

  /* ==========================================================================
     API PAYLOAD NORMALIZATION
  ========================================================================== */

  function unwrapApiPayload(
    payload
  ) {
    if (!isObject(payload)) {
      return {
        root: {},
        data: {},
        message: "",
        success: false,
      };
    }

    const data =
      isObject(payload.data)
        ? payload.data
        : payload;

    return {
      root:
        payload,

      data,

      message:
        normalizeText(
          payload.message ||
          data.message
        ),

      success:
        payload.success === true ||
        data.success === true ||
        payload.ok === true ||
        data.ok === true,
    };
  }

  function getUserMetadata(
    user
  ) {
    return isObject(
      user?.user_metadata
    )
      ? user.user_metadata
      : {};
  }

  function getAppMetadata(
    user
  ) {
    return isObject(
      user?.app_metadata
    )
      ? user.app_metadata
      : {};
  }

  function pickMember(
    payload
  ) {
    const { data } =
      unwrapApiPayload(
        payload
      );

    if (
      isObject(
        data.member
      )
    ) {
      return data.member;
    }

    if (
      isObject(
        data.profile
      )
    ) {
      return data.profile;
    }

    return null;
  }

  function pickUser(
    payload
  ) {
    const { data } =
      unwrapApiPayload(
        payload
      );

    return isObject(
      data.user
    )
      ? data.user
      : null;
  }

  function pickProfile(
    payload
  ) {
    const { data } =
      unwrapApiPayload(
        payload
      );

    return isObject(
      data.profile
    )
      ? data.profile
      : null;
  }

  /* ==========================================================================
     MEMBER FIELD NORMALIZATION
  ========================================================================== */

  function getDisplayName({
    member,
    profile,
    user,
  }) {
    const metadata =
      getUserMetadata(
        user
      );

    const fullName =
      normalizeText(
        member?.fullName
      ) ||
      normalizeText(
        member?.full_name
      ) ||
      normalizeText(
        member?.name
      ) ||
      normalizeText(
        profile?.fullName
      ) ||
      normalizeText(
        profile?.full_name
      ) ||
      normalizeText(
        profile?.name
      ) ||
      normalizeText(
        metadata.full_name
      ) ||
      normalizeText(
        metadata.name
      );

    if (fullName) {
      return fullName;
    }

    const firstName =
      normalizeText(
        member?.firstName ||
        member?.first_name
      ) ||
      normalizeText(
        profile?.firstName ||
        profile?.first_name
      ) ||
      normalizeText(
        metadata.first_name
      );

    const lastName =
      normalizeText(
        member?.lastName ||
        member?.last_name
      ) ||
      normalizeText(
        profile?.lastName ||
        profile?.last_name
      ) ||
      normalizeText(
        metadata.last_name
      );

    const joined =
      [
        firstName,
        lastName,
      ]
        .filter(Boolean)
        .join(" ");

    return (
      joined ||
      normalizeText(
        member?.email
          ?.split("@")[0]
      ) ||
      normalizeText(
        profile?.email
          ?.split("@")[0]
      ) ||
      normalizeText(
        user?.email
          ?.split("@")[0]
      ) ||
      "Card Leo Member"
    );
  }

  function getEmail({
    member,
    profile,
    user,
    data,
  }) {
    return normalizeEmail(
      data?.email ||
      data?.userEmail ||
      member?.email ||
      profile?.email ||
      user?.email
    );
  }

  function getMemberId({
    member,
    profile,
    user,
    data,
  }) {
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

  function getPortalUserId({
    member,
    profile,
    user,
  }) {
    const metadata =
      getUserMetadata(
        user
      );

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

  function getRole({
    member,
    profile,
    user,
    data,
  }) {
    const metadata =
      getUserMetadata(
        user
      );

    const appMetadata =
      getAppMetadata(
        user
      );

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

  function getStatus({
    member,
    profile,
    data,
  }) {
    return normalizeStatus(
      data?.status ||
      member?.memberStatus ||
      member?.member_status ||
      member?.status ||
      profile?.memberStatus ||
      profile?.member_status ||
      profile?.status ||
      ""
    );
  }

  function getPaymentStatus({
    member,
    profile,
    data,
  }) {
    return normalizeStatus(
      data?.payment_status ||
      data?.paymentStatus ||
      member?.payment_status ||
      member?.paymentStatus ||
      profile?.payment_status ||
      profile?.paymentStatus ||
      ""
    );
  }

  function getMembershipStatus({
    member,
    profile,
    data,
  }) {
    return normalizeStatus(
      data?.membership_status ||
      data?.membershipStatus ||
      member?.membership_status ||
      member?.membershipStatus ||
      profile?.membership_status ||
      profile?.membershipStatus ||
      ""
    );
  }

  function getTier({
    member,
    profile,
  }) {
    return normalizeText(
      member?.tier ||
      member?.accessLevel ||
      member?.access_level ||
      profile?.tier ||
      "core"
    ).toLowerCase();
  }

  /* ==========================================================================
     PAYMENT / ACCESS LOGIC
  ========================================================================== */

  function isPaymentRequired(
    data,
    {
      paymentStatus = "",
      membershipStatus = "",
    } = {}
  ) {
    if (
      data?.requires_payment ===
        true ||
      data?.requiresPayment ===
        true ||
      data?.payment_required ===
        true ||
      data?.paymentRequired ===
        true
    ) {
      return true;
    }

    /*
     * Explicit paid states always win.
     */

    if (
      PAID_PAYMENT_STATUSES.has(
        paymentStatus
      ) ||
      ACTIVE_MEMBERSHIP_STATUSES.has(
        membershipStatus
      )
    ) {
      return false;
    }

    /*
     * Do not infer payment-required solely from an empty value.
     * /api/auth/me is the source of truth.
     */

    return false;
  }

  function getPortalAccess({
    member,
    profile,
    data,
    authenticated,
  }) {
    /*
     * Explicit server values have priority.
     */

    if (
      typeof data?.portalAccess ===
      "boolean"
    ) {
      return data.portalAccess;
    }

    if (
      typeof data?.portal_access ===
      "boolean"
    ) {
      return data.portal_access;
    }

    if (
      typeof member?.portalAccess ===
      "boolean"
    ) {
      return member.portalAccess;
    }

    if (
      typeof member?.portal_access ===
      "boolean"
    ) {
      return member.portal_access;
    }

    const status =
      getStatus({
        member,
        profile,
        data,
      });

    const paymentStatus =
      getPaymentStatus({
        member,
        profile,
        data,
      });

    const membershipStatus =
      getMembershipStatus({
        member,
        profile,
        data,
      });

    if (
      BLOCKED_STATUSES.has(
        status
      ) ||
      BLOCKED_STATUSES.has(
        membershipStatus
      )
    ) {
      return false;
    }

    if (
      ACTIVE_STATUSES.has(
        status
      ) ||
      PAID_PAYMENT_STATUSES.has(
        paymentStatus
      ) ||
      ACTIVE_MEMBERSHIP_STATUSES.has(
        membershipStatus
      )
    ) {
      return true;
    }

    /*
     * Compatibility fallback.
     *
     * Authentication alone does not override an explicit denial.
     */

    return Boolean(
      authenticated
    );
  }

  /* ==========================================================================
     EXTRACT AUTH STATE
  ========================================================================== */

  function extractAuthState(
    payload,
    response
  ) {
    const unwrapped =
      unwrapApiPayload(
        payload
      );

    const data =
      unwrapped.data;

    const member =
      pickMember(
        payload
      );

    const user =
      pickUser(
        payload
      );

    const profile =
      pickProfile(
        payload
      );

    const authenticated =
      data.authenticated ===
        true;

    const status =
      getStatus({
        member,
        profile,
        data,
      });

    const paymentStatus =
      getPaymentStatus({
        member,
        profile,
        data,
      });

    const membershipStatus =
      getMembershipStatus({
        member,
        profile,
        data,
      });

    const normalizedMember = {
      ...(isObject(member)
        ? member
        : {}),

      id:
        getMemberId({
          member,
          profile,
          user,
          data,
        }),

      signupId:
        normalizeText(
          member?.signupId ||
          member?.signup_id ||
          getMemberId({
            member,
            profile,
            user,
            data,
          })
        ),

      portalUserId:
        getPortalUserId({
          member,
          profile,
          user,
        }),

      email:
        getEmail({
          member,
          profile,
          user,
          data,
        }),

      fullName:
        getDisplayName({
          member,
          profile,
          user,
        }),

      name:
        getDisplayName({
          member,
          profile,
          user,
        }),

      role:
        getRole({
          member,
          profile,
          user,
          data,
        }),

      status,

      memberStatus:
        status,

      payment_status:
        paymentStatus,

      paymentStatus,

      membership_status:
        membershipStatus,

      membershipStatus,

      tier:
        getTier({
          member,
          profile,
        }),
    };

    normalizedMember.portalAccess =
      getPortalAccess({
        member:
          normalizedMember,

        profile,

        data,

        authenticated,
      });

    const redirectTo =
      normalizeText(
        data.redirectTo
      ) ||
      normalizeText(
        payload?.redirectTo
      ) ||
      normalizeText(
        member?.portalLoginUrl
      ) ||
      normalizeText(
        member?.portal_login_url
      ) ||
      "/portal/index.html";

    const paymentRequired =
      isPaymentRequired(
        data,
        {
          paymentStatus,
          membershipStatus,
        }
      );

    return {
      ok:
        response?.ok ===
        true,

      httpStatus:
        response?.status ||
        0,

      success:
        unwrapped.success,

      authenticated,

      member:
        authenticated
          ? normalizedMember
          : null,

      user:
        authenticated
          ? user
          : null,

      profile:
        authenticated
          ? profile
          : null,

      session:
        isObject(
          data.session
        )
          ? data.session
          : null,

      portalAccess:
        authenticated
          ? normalizedMember
              .portalAccess
          : false,

      paymentRequired,

      message:
        unwrapped.message,

      redirectTo,

      data,

      raw:
        payload,
    };
  }

  /* ==========================================================================
     NETWORK
  ========================================================================== */

  async function safeFetchJson(
    url,
    options = {}
  ) {
    try {
      const response =
        await fetch(
          url,
          {
            credentials:
              "include",

            cache:
              "no-store",

            ...options,

            headers: {
              Accept:
                "application/json",

              "Cache-Control":
                "no-cache",

              ...(options.headers ||
                {}),
            },
          }
        );

      let data =
        null;

      try {
        data =
          await response.json();
      } catch {
        data =
          null;
      }

      return {
        response,
        data,
        networkError:
          null,
      };
    } catch (error) {
      /*
       * Network failure is NOT authentication failure.
       */

      return {
        response: {
          ok: false,
          status: 0,
        },

        data: {
          success: false,

          message:
            "Unable to reach the Card Leo authentication service.",
        },

        networkError:
          error,
      };
    }
  }

  /* ==========================================================================
     AUTH REQUEST

     IMPORTANT
     ---------
     Only a real auth response can establish that a member is logged out.

     Network errors and 5xx responses are retried and then treated as service
     failures rather than authentication failures.
  ========================================================================== */

  async function getAuthState(
    config
  ) {
    let lastResult =
      null;

    for (
      let attempt = 0;
      attempt <=
        config.maxRetries;
      attempt += 1
    ) {
      const meResult =
        await safeFetchJson(
          config.meEndpoint,
          {
            method:
              "GET",
          }
        );

      lastResult =
        meResult;

      logDebug(
        config.debug,
        "me endpoint result:",
        {
          attempt,
          status:
            meResult
              ?.response
              ?.status,

          networkError:
            meResult
              ?.networkError ||
            null,

          data:
            meResult.data,
        }
      );

      const state =
        extractAuthState(
          meResult.data,
          meResult.response
        );

      state.networkError =
        meResult.networkError ||
        null;

      /*
       * Authenticated member.
       */

      if (
        state.authenticated
      ) {
        return {
          source:
            "me",

          response:
            meResult.response,

          ...state,
        };
      }

      /*
       * Explicit payment-required response.
       */

      if (
        state.paymentRequired
      ) {
        return {
          source:
            "me",

          response:
            meResult.response,

          ...state,
        };
      }

      const status =
        Number(
          meResult
            ?.response
            ?.status ||
          0
        );

      const temporaryFailure =
        status === 0 ||
        status >= 500 ||
        Boolean(
          meResult.networkError
        );

      /*
       * Explicit 401 / 403 is authoritative.
       *
       * Do not keep retrying a real authentication denial.
       */

      if (
        status === 401 ||
        status === 403
      ) {
        return {
          source:
            "me",

          response:
            meResult.response,

          ...state,
        };
      }

      if (
        !temporaryFailure
      ) {
        return {
          source:
            "me",

          response:
            meResult.response,

          ...state,
        };
      }

      const canRetry =
        attempt <
        config.maxRetries;

      if (!canRetry) {
        return {
          source:
            "me",

          response:
            meResult.response,

          ...state,
        };
      }

      await sleep(
        config.retryDelayMs *
          (attempt + 1)
      );
    }

    const fallbackState =
      extractAuthState(
        lastResult?.data,
        lastResult?.response
      );

    fallbackState.networkError =
      lastResult
        ?.networkError ||
      null;

    return {
      source:
        "me",

      response:
        lastResult?.response ||
        null,

      ...fallbackState,
    };
  }

  /* ==========================================================================
     DOM BINDINGS
  ========================================================================== */

  function setText(
    selector,
    value
  ) {
    if (!selector) {
      return;
    }

    document
      .querySelectorAll(
        selector
      )
      .forEach(
        (node) => {
          node.textContent =
            value;
        }
      );
  }

  function setValue(
    selector,
    value
  ) {
    if (!selector) {
      return;
    }

    document
      .querySelectorAll(
        selector
      )
      .forEach(
        (node) => {
          if (
            "value" in node
          ) {
            node.value =
              value;
          } else {
            node.textContent =
              value;
          }
        }
      );
  }

  function applyMemberBindings(
    member
  ) {
    if (
      !isObject(member)
    ) {
      return;
    }

    const fullName =
      normalizeText(
        member.fullName ||
        member.full_name ||
        member.name
      ) ||
      "Card Leo Member";

    const firstName =
      normalizeText(
        member.firstName ||
        member.first_name
      ) ||
      fullName
        .split(/\s+/)[0] ||
      "Member";

    const lastName =
      normalizeText(
        member.lastName ||
        member.last_name
      );

    const email =
      normalizeText(
        member.email
      );

    const status =
      normalizeText(
        member.memberStatus ||
        member.member_status ||
        member.status ||
        "active"
      );

    const tier =
      normalizeText(
        member.tier ||
        "core"
      );

    const role =
      normalizeText(
        member.role ||
        "member"
      );

    const accessLevel =
      normalizeText(
        member.accessLevel ||
        member.access_level ||
        tier ||
        role
      );

    const memberId =
      normalizeText(
        member.id ||
        member.signupId ||
        member.signup_id
      );

    const portalUserId =
      normalizeText(
        member.portalUserId ||
        member.portal_user_id
      );

    const bindings = [
      [
        "[data-member-name]",
        fullName,
      ],

      [
        "[data-member-full-name]",
        fullName,
      ],

      [
        "[data-member-first-name]",
        firstName,
      ],

      [
        "[data-member-last-name]",
        lastName,
      ],

      [
        "[data-member-email]",
        email,
      ],

      [
        "[data-member-status]",
        status,
      ],

      [
        "[data-member-tier]",
        tier,
      ],

      [
        "[data-member-role]",
        role,
      ],

      [
        "[data-member-access-level]",
        accessLevel,
      ],

      [
        "[data-member-accesslevel]",
        accessLevel,
      ],

      [
        "[data-member-id]",
        memberId,
      ],

      [
        "[data-member-signup-id]",
        memberId,
      ],

      [
        "[data-member-portal-user-id]",
        portalUserId,
      ],

      [
        "[data-session-name]",
        fullName,
      ],

      [
        "[data-session-email]",
        email,
      ],

      [
        "[data-session-user-id]",
        memberId,
      ],

      [
        "[data-session-role]",
        role,
      ],

      [
        "[data-session-status]",
        status,
      ],
    ];

    bindings.forEach(
      ([
        selector,
        value,
      ]) => {
        setText(
          selector,
          value
        );
      }
    );

    setValue(
      "[data-profile-name-input]",
      fullName
    );

    setValue(
      "[data-profile-email-input]",
      email
    );

    if (
      document.body
    ) {
      document.body
        .dataset
        .memberName =
        fullName;

      document.body
        .dataset
        .memberEmail =
        email;

      document.body
        .dataset
        .memberStatus =
        status;

      document.body
        .dataset
        .memberTier =
        tier;

      document.body
        .dataset
        .memberRole =
        role;

      document.body
        .dataset
        .memberAccessLevel =
        accessLevel;

      document.body
        .dataset
        .memberId =
        memberId;

      document.body
        .dataset
        .memberPortalUserId =
        portalUserId;
    }
  }

  function setVisibilityForAuthState(
    authenticated
  ) {
    document
      .querySelectorAll(
        "[data-authenticated]"
      )
      .forEach(
        (node) => {
          node.hidden =
            !authenticated;
        }
      );

    document
      .querySelectorAll(
        "[data-guest]"
      )
      .forEach(
        (node) => {
          node.hidden =
            authenticated;
        }
      );
  }

  /* ==========================================================================
     LOGOUT
  ========================================================================== */

  async function logoutMember(
    config = DEFAULTS
  ) {
    try {
      await fetch(
        config.logoutEndpoint ||
          DEFAULTS.logoutEndpoint,
        {
          method:
            "POST",

          credentials:
            "include",

          cache:
            "no-store",

          headers: {
            Accept:
              "application/json",

            "Cache-Control":
              "no-cache",
          },
        }
      );
    } catch {
      /*
       * Continue to login even if logout endpoint is temporarily unreachable.
       */
    }

    currentAuthState =
      null;

    hasRedirected =
      false;

    removeServiceErrorNotice();

    /*
     * Intentional logout does NOT need next=/portal/... .
     *
     * This prevents a logout/login redirect loop.
     */

    const loginUrl =
      new URL(
        config.loginPage,
        window.location.origin
      );

    safeRedirect(
      loginUrl.toString()
    );
  }

  function bindLogoutButtons(
    config
  ) {
    document
      .querySelectorAll(
        "[data-logout], [data-member-logout]"
      )
      .forEach(
        (button) => {
          if (
            button.dataset
              .authGuardLogoutBound ===
            "true"
          ) {
            return;
          }

          button.dataset
            .authGuardLogoutBound =
            "true";

          button.addEventListener(
            "click",
            async (
              event
            ) => {
              event.preventDefault();

              const originalText =
                "value" in button
                  ? button.value
                  : button.textContent;

              const canDisable =
                "disabled" in button;

              try {
                if (
                  "value" in
                  button
                ) {
                  button.value =
                    "Signing out...";
                } else {
                  button.textContent =
                    "Signing out...";
                }

                if (
                  canDisable
                ) {
                  button.disabled =
                    true;
                }

                await logoutMember(
                  config
                );
              } catch (
                error
              ) {
                if (
                  "value" in
                  button
                ) {
                  button.value =
                    originalText;
                } else {
                  button.textContent =
                    originalText;
                }

                if (
                  canDisable
                ) {
                  button.disabled =
                    false;
                }

                alert(
                  error?.message ||
                  "Unable to sign out right now."
                );
              }
            }
          );
        }
      );
  }

  /* ==========================================================================
     EVENTS
  ========================================================================== */

  function dispatchReadyEvent(
    state
  ) {
    const event =
      new CustomEvent(
        "cardleo:auth-ready",
        {
          detail: {
            ok:
              true,

            member:
              state.member ||
              null,

            user:
              state.user ||
              null,

            profile:
              state.profile ||
              null,

            session:
              state.session ||
              null,

            source:
              state.source,

            portalAccess:
              state.portalAccess,

            authenticated:
              state.authenticated,

            redirectTo:
              state.redirectTo,

            raw:
              state.raw,

            data:
              state.data,
          },
        }
      );

    window.dispatchEvent(
      event
    );
  }

  function dispatchFailureEvent(
    state
  ) {
    const event =
      new CustomEvent(
        "cardleo:auth-failed",
        {
          detail:
            state,
        }
      );

    window.dispatchEvent(
      event
    );
  }

  /* ==========================================================================
     MAIN AUTH GUARD
  ========================================================================== */

  async function run(
    options = {}
  ) {
    /*
     * If another guard request is already running, wait briefly for it
     * instead of starting competing /api/auth/me calls.
     */

    if (isRunning) {
      for (
        let index = 0;
        index < 40;
        index += 1
      ) {
        await sleep(50);

        if (!isRunning) {
          return (
            currentAuthState ||
            {
              ok: false,
              status: 503,
              reason:
                "auth_check_unavailable",
            }
          );
        }
      }

      return (
        currentAuthState ||
        {
          ok: false,
          status: 503,
          reason:
            "auth_check_timeout",
        }
      );
    }

    isRunning =
      true;

    hasRedirected =
      false;

    const config = {
      ...DEFAULTS,
      ...options,
    };

    const loader =
      config.showLoader
        ? createLoader()
        : null;

    if (
      document.body
    ) {
      document.body
        .dataset
        .authGuard =
        "checking";
    }

    try {
      const state =
        await getAuthState(
          config
        );

      currentAuthState =
        state;

      logDebug(
        config.debug,
        "final auth state:",
        state
      );

      const temporaryFailure =
        state.httpStatus ===
          0 ||
        state.httpStatus >=
          500 ||
        Boolean(
          state.networkError
        );

      /*
       * ================================================================
       * TEMPORARY FAILURE
       *
       * Do NOT redirect to login.
       * Do NOT treat the member as logged out.
       * Do NOT destroy session state.
       * ================================================================
       */

      if (
        temporaryFailure
      ) {
        if (
          document.body
        ) {
          document.body
            .dataset
            .authGuard =
            "service-error";
        }

        setVisibilityForAuthState(
          false
        );

        const failedState = {
          ok:
            false,

          status:
            state.httpStatus ||
            503,

          reason:
            "service_unavailable",

          ...state,
        };

        currentAuthState =
          failedState;

        dispatchFailureEvent(
          failedState
        );

        showServiceErrorNotice(
          config,
          failedState
        );

        return failedState;
      }

      removeServiceErrorNotice();

      /*
       * ================================================================
       * PAYMENT REQUIRED
       * ================================================================
       */

      if (
        state.paymentRequired
      ) {
        if (
          document.body
        ) {
          document.body
            .dataset
            .authGuard =
            "payment-required";
        }

        setVisibilityForAuthState(
          false
        );

        const failedState = {
          ok:
            false,

          status:
            state.httpStatus ||
            402,

          reason:
            "payment_required",

          ...state,
        };

        currentAuthState =
          failedState;

        dispatchFailureEvent(
          failedState
        );

        if (
          config.redirectOnFail
        ) {
          redirectToPaymentRequired(
            config,
            state.redirectTo
          );
        }

        return failedState;
      }

      /*
       * ================================================================
       * REAL UNAUTHENTICATED SESSION
       *
       * Only an actual non-temporary auth response gets here.
       * ================================================================
       */

      if (
        !state.authenticated
      ) {
        if (
          document.body
        ) {
          document.body
            .dataset
            .authGuard =
            "unauthenticated";
        }

        setVisibilityForAuthState(
          false
        );

        const failedState = {
          ok:
            false,

          status:
            state.httpStatus ||
            401,

          reason:
            "unauthenticated",

          ...state,
        };

        currentAuthState =
          failedState;

        dispatchFailureEvent(
          failedState
        );

        if (
          config.redirectOnFail
        ) {
          redirectToLogin(
            config
          );
        }

        return failedState;
      }

      /*
       * ================================================================
       * AUTHENTICATED BUT PORTAL ACCESS DENIED
       * ================================================================
       */

      if (
        config.requirePortalAccess &&
        state.portalAccess ===
          false
      ) {
        if (
          document.body
        ) {
          document.body
            .dataset
            .authGuard =
            "unauthorized";
        }

        setVisibilityForAuthState(
          false
        );

        const failedState = {
          ok:
            false,

          status:
            state.httpStatus ||
            403,

          reason:
            "unauthorized",

          ...state,
        };

        currentAuthState =
          failedState;

        dispatchFailureEvent(
          failedState
        );

        if (
          config.redirectOnFail
        ) {
          redirectToUnauthorized(
            config
          );
        }

        return failedState;
      }

      /*
       * ================================================================
       * AUTHORIZED
       * ================================================================
       */

      applyMemberBindings(
        state.member ||
        {}
      );

      setVisibilityForAuthState(
        true
      );

      if (
        document.body
      ) {
        document.body
          .dataset
          .authGuard =
          "ready";
      }

      if (
        config.autoBindLogout
      ) {
        bindLogoutButtons(
          config
        );
      }

      const authorizedState = {
        ok:
          true,

        status:
          200,

        reason:
          "authorized",

        ...state,
      };

      currentAuthState =
        authorizedState;

      dispatchReadyEvent(
        authorizedState
      );

      return authorizedState;
    } catch (error) {
      /*
       * ================================================================
       * UNEXPECTED CLIENT ERROR
       *
       * Critical rule:
       * DO NOT redirect to login here.
       *
       * An exception in the guard is not proof the session is invalid.
       * ================================================================
       */

      if (
        document.body
      ) {
        document.body
          .dataset
          .authGuard =
          "error";
      }

      logDebug(
        config.debug,
        "auth guard error:",
        error
      );

      const failedState = {
        ok:
          false,

        status:
          500,

        reason:
          "error",

        error,
      };

      currentAuthState =
        failedState;

      dispatchFailureEvent(
        failedState
      );

      setVisibilityForAuthState(
        false
      );

      showServiceErrorNotice(
        config,
        failedState
      );

      return failedState;
    } finally {
      isRunning =
        false;

      if (loader) {
        removeLoader();
      }
    }
  }

  /* ==========================================================================
     PUBLIC STATE
  ========================================================================== */

  function getState() {
    return currentAuthState;
  }

  function isAuthenticated() {
    return (
      currentAuthState
        ?.authenticated ===
      true
    );
  }

  function hasPortalAccess() {
    return (
      currentAuthState
        ?.authenticated ===
        true &&
      currentAuthState
        ?.portalAccess !==
        false
    );
  }

  function getMember() {
    return (
      currentAuthState
        ?.member ||
      null
    );
  }

  /* ==========================================================================
     AUTO INITIALIZATION
  ========================================================================== */

  function autoInitFromBody() {
    const root =
      document.body ||
      document.documentElement;

    if (!root) {
      return;
    }

    const shouldAutoRun =
      root.hasAttribute(
        "data-require-auth"
      ) ||
      root.hasAttribute(
        "data-auth-guard"
      ) ||
      root.dataset
        .cardleoAuthGuard ===
        "auto";

    if (!shouldAutoRun) {
      return;
    }

    run({
      redirectOnFail:
        root.dataset
          .redirectOnFail !==
        "false",

      requirePortalAccess:
        root.dataset
          .requirePortalAccess !==
        "false",

      showLoader:
        root.dataset
          .showAuthLoader !==
        "false",

      debug:
        root.dataset
          .authDebug ===
        "true",
    });
  }

  /* ==========================================================================
     PUBLIC API
  ========================================================================== */

  const CardLeoAuthGuard = {
    init:
      run,

    run,

    logout:
      logoutMember,

    bindLogoutButtons,

    getState,

    getMember,

    isAuthenticated,

    hasPortalAccess,

    defaults: {
      ...DEFAULTS,
    },

    version:
      "2026-08-22-portal-session-fix",
  };

  window.CardLeoAuthGuard =
    CardLeoAuthGuard;

  /* ==========================================================================
     START
  ========================================================================== */

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      autoInitFromBody
    );
  } else {
    autoInitFromBody();
  }
})();