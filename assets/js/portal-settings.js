// assets/js/portal-settings.js
(function () {
  const CONFIG = {
    meEndpoint: "/api/auth/me",
    settingsEndpoint: "/api/portal/settings",
    sessionsEndpoint: "/api/portal/sessions",
    changePasswordEndpoint: "/api/portal/change-password",
    logoutEndpoint: "/api/auth/logout",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      autoBindLogout: true,
      debug: false,
    },
  };

  const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

  const state = {
    member: null,
    profile: null,
    settings: null,
    sessions: [],
    support: null,
    raw: null,
    isSavingSettings: false,
    isSavingPassword: false,
    isLoadingSettings: false,
    isLoadingSessions: false,
    authReady: false,
  };

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function titleCase(value) {
    return String(value || "")
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function formatDateTime(value) {
    if (!value) return "Not available";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "Not available";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.loginPage}?next=${encodeURIComponent(next)}`;
  }

  function redirectToUnauthorized() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.unauthorizedPage}?next=${encodeURIComponent(next)}`;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));
    const data = unwrapApiPayload(payload);

    return {
      response,
      payload,
      data,
      message: normalizeText(payload?.message || data?.message),
    };
  }

  function setText(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setValue(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      if ("value" in node) {
        node.value = value ?? "";
      } else {
        node.textContent = normalizeText(value);
      }
    });
  }

  function setChecked(selector, checked) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      if ("checked" in node) {
        node.checked = Boolean(checked);
      }
    });
  }

  function setHidden(selector, hidden) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.hidden = Boolean(hidden);
    });
  }

  function setFormDisabled(form, disabled) {
    if (!form) return;

    Array.from(form.elements || []).forEach((node) => {
      if (node.dataset.keepEnabled === "true") return;
      node.disabled = Boolean(disabled);
    });
  }

  function getStatusNode(...selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }

    return null;
  }

  function setStatus(target, type, message) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = false;
    el.textContent = normalizeText(message);
    el.dataset.state = type || "info";

    el.style.display = "block";
    el.style.padding = "14px 16px";
    el.style.borderRadius = "16px";
    el.style.marginTop = "12px";
    el.style.fontSize = "0.95rem";
    el.style.lineHeight = "1.5";
    el.style.border = "1px solid rgba(255,255,255,0.08)";

    if (type === "success") {
      el.style.background = "rgba(34, 197, 94, 0.10)";
      el.style.color = "#d9ffe8";
      el.style.borderColor = "rgba(34, 197, 94, 0.28)";
    } else if (type === "error") {
      el.style.background = "rgba(239, 68, 68, 0.10)";
      el.style.color = "#ffe2e2";
      el.style.borderColor = "rgba(239, 68, 68, 0.28)";
    } else {
      el.style.background = "rgba(216, 176, 94, 0.10)";
      el.style.color = "#f4ead3";
      el.style.borderColor = "rgba(216, 176, 94, 0.25)";
    }
  }

  function clearStatus(target) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function getFullName(member = {}, profile = {}) {
    const fullName =
      normalizeText(member.fullName) ||
      normalizeText(member.full_name) ||
      normalizeText(member.name) ||
      normalizeText(profile.fullName) ||
      normalizeText(profile.full_name) ||
      normalizeText(profile.name);

    if (fullName) return fullName;

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      normalizeText(profile.firstName || profile.first_name);

    const lastName =
      normalizeText(member.lastName || member.last_name) ||
      normalizeText(profile.lastName || profile.last_name);

    return [firstName, lastName].filter(Boolean).join(" ") || "Card Leo Member";
  }

  function getMemberStatus(member = {}, profile = {}) {
    return normalizeText(
      member.memberStatus ||
        member.member_status ||
        member.status ||
        profile.memberStatus ||
        profile.member_status ||
        profile.status ||
        "active"
    ).toLowerCase();
  }

  function getPortalAccess(member = {}, profile = {}) {
    if (typeof member.portalAccess === "boolean") return member.portalAccess;
    if (typeof member.portal_access === "boolean") return member.portal_access;

    return ACTIVE_STATUSES.has(getMemberStatus(member, profile));
  }

  function normalizeMember(member = {}, profile = {}) {
    const safeMember = isObject(member) ? member : {};
    const safeProfile = isObject(profile) ? profile : {};
    const fullName = getFullName(safeMember, safeProfile);
    const status = getMemberStatus(safeMember, safeProfile);
    const tier = normalizeText(
      safeMember.tier ||
        safeMember.accessLevel ||
        safeMember.access_level ||
        safeProfile.tier ||
        "core"
    ).toLowerCase();

    return {
      ...safeMember,
      id:
        safeMember.id ||
        safeMember.signupId ||
        safeMember.signup_id ||
        safeProfile.id ||
        "",
      signupId:
        safeMember.signupId ||
        safeMember.signup_id ||
        safeMember.id ||
        safeProfile.signupId ||
        safeProfile.signup_id ||
        safeProfile.id ||
        "",
      portalUserId: safeMember.portalUserId || safeMember.portal_user_id || "",
      firstName:
        safeMember.firstName ||
        safeMember.first_name ||
        safeProfile.firstName ||
        safeProfile.first_name ||
        fullName.split(/\s+/)[0] ||
        "Member",
      lastName:
        safeMember.lastName ||
        safeMember.last_name ||
        safeProfile.lastName ||
        safeProfile.last_name ||
        "",
      fullName,
      full_name: fullName,
      name: fullName,
      email: normalizeEmail(safeMember.email || safeProfile.email),
      phone: safeMember.phone || safeProfile.phone || "",
      city: safeMember.city || safeProfile.city || "",
      state: safeMember.state || safeProfile.state || "",
      status,
      memberStatus: status,
      member_status: status,
      tier,
      tierLabel: titleCase(tier),
      portalAccess: getPortalAccess({ ...safeMember, status }, safeProfile),
      accessLevel: safeMember.accessLevel || safeMember.access_level || tier || "member",
      joinedAt:
        safeMember.joinedAt ||
        safeMember.joined_at ||
        safeMember.createdAt ||
        safeMember.created_at ||
        null,
    };
  }

  function buildDefaultSettings(member = {}) {
    return {
      preferences: {
        emailNotifications: true,
        smsNotifications: false,
        productUpdates: true,
        marketingEmails: true,
        rewardAlerts: true,
        securityAlerts: true,
        theme: "dark",
      },
      security: {
        emailVerified: Boolean(member.email),
        twoFactorEnabled: false,
        passwordLastChangedAt: null,
        changePasswordEndpoint: CONFIG.changePasswordEndpoint,
        sessionsEndpoint: CONFIG.sessionsEndpoint,
      },
    };
  }

  function buildFallbackSession(member = {}) {
    const ua = navigator.userAgent || "";
    const isMobile = /mobile|iphone|android/i.test(ua);

    return {
      id: "current-browser-session",
      current: true,
      label: "Current Browser Session",
      browser: detectBrowser(ua),
      os: detectOs(ua),
      deviceType: isMobile ? "mobile" : "desktop",
      ipAddressMasked: "Current network",
      userAgent: ua,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      expiresAt: null,
      memberEmail: member.email || "",
    };
  }

  function detectBrowser(userAgent = "") {
    const ua = String(userAgent).toLowerCase();

    if (ua.includes("edg/")) return "Microsoft Edge";
    if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
    if (ua.includes("chrome/") && !ua.includes("edg/")) return "Chrome";
    if (ua.includes("firefox/")) return "Firefox";
    if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";

    return "Browser";
  }

  function detectOs(userAgent = "") {
    const ua = String(userAgent).toLowerCase();

    if (ua.includes("windows nt")) return "Windows";
    if (ua.includes("mac os x")) return "macOS";
    if (ua.includes("android")) return "Android";
    if (ua.includes("iphone") || ua.includes("ipad")) return "iOS";
    if (ua.includes("linux")) return "Linux";

    return "Device";
  }

  function inferSettingsPayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);

    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackProfile = isObject(fallback.profile) ? fallback.profile : {};
    const fallbackSettings = isObject(fallback.settings) ? fallback.settings : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...(isObject(data.member) ? data.member : {}),
      },
      {
        ...fallbackProfile,
        ...(isObject(data.profile) ? data.profile : {}),
      }
    );

    const profile =
      (isObject(data.profile) && data.profile) ||
      fallbackProfile ||
      {};

    const settings =
      (isObject(data.settings) && data.settings) ||
      fallbackSettings ||
      buildDefaultSettings(member);

    const support =
      (isObject(data.support) && data.support) ||
      fallbackSupport ||
      {};

    return {
      member,
      profile,
      settings,
      support,
      raw: data,
      persisted: data.persisted,
    };
  }

  function inferSessionsPayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);
    const sessionsWrap = isObject(data.sessions) ? data.sessions : {};
    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...(isObject(data.member) ? data.member : {}),
      },
      {}
    );

    const support =
      (isObject(data.support) && data.support) ||
      fallbackSupport ||
      {};

    const sessions = Array.isArray(sessionsWrap.sessions)
      ? sessionsWrap.sessions
      : Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(fallback.sessions)
          ? fallback.sessions
          : [buildFallbackSession(member)];

    return {
      member,
      support,
      sessions,
      totalSessions:
        Number(sessionsWrap.totalSessions || data.totalSessions || sessions.length) || 0,
      currentSessionId: normalizeText(
        sessionsWrap.currentSessionId ||
          data.currentSessionId ||
          sessions.find((item) => item.current)?.id ||
          ""
      ),
      persisted: sessionsWrap.persisted !== false && data.persisted !== false,
    };
  }

  function applyMember(member = {}) {
    state.member = normalizeMember(member, state.profile || {});

    const name = state.member.fullName || "Card Leo Member";
    const firstName = state.member.firstName || name.split(/\s+/)[0] || "Member";
    const statusLabel = titleCase(state.member.memberStatus || state.member.status || "active");
    const accessLevel = state.member.accessLevel || state.member.tier || "member";

    setText("[data-member-name]", name);
    setText("[data-member-full-name]", name);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", state.member.email || "");
    setText("[data-member-status]", statusLabel);
    setText("[data-member-tier]", titleCase(state.member.tier || "core"));
    setText("[data-member-access-level]", titleCase(accessLevel));
    setText("[data-member-accesslevel]", titleCase(accessLevel));

    document.body.dataset.memberName = name;
    document.body.dataset.memberEmail = state.member.email || "";
    document.body.dataset.memberStatus = state.member.memberStatus || "";
    document.body.dataset.memberTier = state.member.tier || "";
    document.body.dataset.memberId = state.member.id || state.member.signupId || "";
  }

  function applySupport(support = {}) {
    state.support = isObject(support) ? support : {};

    const email = normalizeText(state.support.email, "support@cardleorewards.com");
    const phone = normalizeText(state.support.phone, "Not listed");
    const hours = normalizeText(state.support.hours, "Mon–Fri, 9:00 AM–6:00 PM");

    setText("[data-support-email]", email);
    setText("[data-support-phone]", phone);
    setText("[data-support-hours]", hours);

    document.querySelectorAll("[data-support-email-link]").forEach((node) => {
      node.textContent = email;
      node.href = `mailto:${email}`;
    });
  }

  function applySettings(settings = {}) {
    const defaults = buildDefaultSettings(state.member || {});
    const safeSettings = isObject(settings) ? settings : defaults;

    const preferences = {
      ...defaults.preferences,
      ...(isObject(safeSettings.preferences) ? safeSettings.preferences : {}),
    };

    const security = {
      ...defaults.security,
      ...(isObject(safeSettings.security) ? safeSettings.security : {}),
    };

    state.settings = {
      preferences,
      security,
    };

    setChecked(
      '[name="emailNotifications"], [data-setting="emailNotifications"]',
      preferences.emailNotifications
    );
    setChecked(
      '[name="smsNotifications"], [data-setting="smsNotifications"]',
      preferences.smsNotifications
    );
    setChecked(
      '[name="productUpdates"], [data-setting="productUpdates"]',
      preferences.productUpdates
    );
    setChecked(
      '[name="marketingEmails"], [data-setting="marketingEmails"]',
      preferences.marketingEmails
    );
    setChecked(
      '[name="rewardAlerts"], [data-setting="rewardAlerts"]',
      preferences.rewardAlerts
    );
    setChecked(
      '[name="securityAlerts"], [data-setting="securityAlerts"]',
      preferences.securityAlerts
    );
    setChecked(
      '[name="twoFactorEnabled"], [data-setting="twoFactorEnabled"]',
      security.twoFactorEnabled
    );

    const themeSelect =
      document.querySelector('[name="theme"]') ||
      document.querySelector('[data-setting="theme"]');

    if (themeSelect) {
      themeSelect.value = normalizeText(preferences.theme, "dark").toLowerCase();
    }

    setText("[data-password-last-changed]", formatDateTime(security.passwordLastChangedAt));
    setText("[data-email-verified]", security.emailVerified ? "Verified" : "Not verified");
    setText("[data-two-factor-enabled]", security.twoFactorEnabled ? "Enabled" : "Not enabled");
  }

  function renderSettingsPayload(payload, fallback = {}) {
    const parsed = inferSettingsPayload(payload, fallback);

    state.raw = parsed.raw;
    state.profile = parsed.profile;
    applyMember(parsed.member);
    applySupport(parsed.support);
    applySettings(parsed.settings);

    setHidden("[data-settings-loading]", true);
    setHidden("[data-settings-ready]", false);

    return parsed;
  }

  function renderSessionsPayload(payload, fallback = {}) {
    const parsed = inferSessionsPayload(payload, fallback);

    if (parsed.member && !state.member) applyMember(parsed.member);
    if (parsed.support && !state.support) applySupport(parsed.support);

    state.sessions = parsed.sessions;
    renderSessions(parsed.sessions);

    return parsed;
  }

  function getSettingsForm() {
    return (
      document.querySelector("[data-settings-form]") ||
      document.querySelector("#portal-settings-form") ||
      document.querySelector("#settings-form") ||
      null
    );
  }

  function getPasswordForm() {
    return (
      document.querySelector("[data-password-form]") ||
      document.querySelector("#change-password-form") ||
      document.querySelector("#password-form") ||
      null
    );
  }

  function readCheckbox(form, name, fallback = false) {
    const field =
      form.querySelector(`[name="${name}"]`) ||
      form.querySelector(`[data-setting="${name}"]`);

    return field ? Boolean(field.checked) : fallback;
  }

  function collectSettingsFromForm(form) {
    const themeField =
      form.querySelector('[name="theme"]') ||
      form.querySelector('[data-setting="theme"]');

    const currentPrefs = state.settings?.preferences || {};
    const currentSecurity = state.settings?.security || {};

    return {
      preferences: {
        emailNotifications: readCheckbox(
          form,
          "emailNotifications",
          currentPrefs.emailNotifications ?? true
        ),
        smsNotifications: readCheckbox(
          form,
          "smsNotifications",
          currentPrefs.smsNotifications ?? false
        ),
        productUpdates: readCheckbox(
          form,
          "productUpdates",
          currentPrefs.productUpdates ?? true
        ),
        marketingEmails: readCheckbox(
          form,
          "marketingEmails",
          currentPrefs.marketingEmails ?? true
        ),
        rewardAlerts: readCheckbox(
          form,
          "rewardAlerts",
          currentPrefs.rewardAlerts ?? true
        ),
        securityAlerts: readCheckbox(
          form,
          "securityAlerts",
          currentPrefs.securityAlerts ?? true
        ),
        theme: normalizeText(themeField?.value || currentPrefs.theme || "dark").toLowerCase(),
      },
      security: {
        twoFactorEnabled: readCheckbox(
          form,
          "twoFactorEnabled",
          currentSecurity.twoFactorEnabled ?? false
        ),
      },
    };
  }

  function collectPasswordFromForm(form) {
    const currentPassword = form.querySelector('[name="currentPassword"]')?.value || "";
    const newPassword = form.querySelector('[name="newPassword"]')?.value || "";
    const confirmNewPassword =
      form.querySelector('[name="confirmNewPassword"]')?.value ||
      form.querySelector('[name="confirmPassword"]')?.value ||
      "";

    const signOutOtherSessionsField =
      form.querySelector('[name="signOutOtherSessions"]') ||
      form.querySelector('[data-password-setting="signOutOtherSessions"]');

    return {
      currentPassword,
      newPassword,
      confirmNewPassword,
      confirmPassword: confirmNewPassword,
      signOutOtherSessions: signOutOtherSessionsField
        ? Boolean(signOutOtherSessionsField.checked)
        : true,
    };
  }

  function validatePasswordPayload(payload) {
    if (!payload.currentPassword) {
      return "Current password is required.";
    }

    if (!payload.newPassword) {
      return "New password is required.";
    }

    if (!payload.confirmNewPassword) {
      return "Please confirm your new password.";
    }

    if (payload.newPassword !== payload.confirmNewPassword) {
      return "New password and confirmation do not match.";
    }

    if (payload.currentPassword === payload.newPassword) {
      return "Your new password must be different from your current password.";
    }

    if (payload.newPassword.length < 8) {
      return "Your new password must be at least 8 characters long.";
    }

    if (!/[A-Z]/.test(payload.newPassword)) {
      return "Your new password must include at least one uppercase letter.";
    }

    if (!/[a-z]/.test(payload.newPassword)) {
      return "Your new password must include at least one lowercase letter.";
    }

    if (!/[0-9]/.test(payload.newPassword)) {
      return "Your new password must include at least one number.";
    }

    if (!/[^A-Za-z0-9]/.test(payload.newPassword)) {
      return "Your new password must include at least one special character.";
    }

    return "";
  }

  function getErrorMessage(result, fallback = "Something went wrong.") {
    const data = result?.data || {};
    const payload = result?.payload || {};

    const direct =
      normalizeText(payload.message) ||
      normalizeText(data.message) ||
      normalizeText(payload.error) ||
      normalizeText(data.error);

    if (direct) return direct;

    const errors = data.errors || payload.errors || data.details || payload.details;

    if (isObject(errors)) {
      const first = Object.values(errors).find(Boolean);
      if (first) return normalizeText(first, fallback);
    }

    return fallback;
  }

  function styleActionButton(button, tone = "primary") {
    button.style.borderRadius = "14px";
    button.style.padding = "11px 14px";
    button.style.fontWeight = "700";
    button.style.cursor = "pointer";
    button.style.transition = "transform 0.18s ease, opacity 0.18s ease";

    if (tone === "danger") {
      button.style.background = "rgba(239,68,68,0.16)";
      button.style.color = "#ffe2e2";
      button.style.border = "1px solid rgba(239,68,68,0.28)";
    } else if (tone === "secondary") {
      button.style.background = "rgba(255,255,255,0.05)";
      button.style.color = "#f4ead3";
      button.style.border = "1px solid rgba(255,255,255,0.1)";
    } else {
      button.style.border = "0";
      button.style.background =
        "linear-gradient(135deg, rgba(216,176,94,0.95), rgba(162,124,48,0.96))";
      button.style.color = "#140f07";
      button.style.boxShadow = "0 14px 30px rgba(216,176,94,0.18)";
    }
  }

  function renderSessions(sessions) {
    const containers = document.querySelectorAll(
      "[data-sessions-list], #portal-sessions-list, #sessions-list"
    );

    if (!containers.length) return;

    const list = Array.isArray(sessions) ? sessions : [];

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!list.length) {
        const empty = document.createElement("div");
        empty.textContent = "No active sessions were found for this account.";
        empty.style.padding = "16px";
        empty.style.borderRadius = "18px";
        empty.style.background = "rgba(255,255,255,0.03)";
        empty.style.border = "1px solid rgba(255,255,255,0.08)";
        empty.style.color = "rgba(244, 234, 211, 0.75)";
        container.appendChild(empty);
        return;
      }

      list.forEach((session) => {
        const item = document.createElement("article");
        item.style.padding = "18px";
        item.style.borderRadius = "18px";
        item.style.background =
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))";
        item.style.border = "1px solid rgba(255,255,255,0.08)";
        item.style.display = "grid";
        item.style.gap = "12px";

        const top = document.createElement("div");
        top.style.display = "flex";
        top.style.alignItems = "center";
        top.style.justifyContent = "space-between";
        top.style.gap = "12px";
        top.style.flexWrap = "wrap";

        const title = document.createElement("div");
        title.innerHTML = `
          <strong style="display:block;color:#f8f3e8;font-size:1rem;">
            ${escapeHtml(session.label || "Session")}
          </strong>
          <span style="display:block;color:rgba(244,234,211,0.7);font-size:0.92rem;margin-top:4px;">
            ${escapeHtml(session.browser || "Browser")} • ${escapeHtml(session.os || "Device")} • ${escapeHtml(session.deviceType || "device")}
          </span>
        `;

        const badge = document.createElement("span");
        badge.textContent = session.current ? "Current Session" : "Active";
        badge.style.display = "inline-flex";
        badge.style.alignItems = "center";
        badge.style.justifyContent = "center";
        badge.style.padding = "8px 12px";
        badge.style.borderRadius = "999px";
        badge.style.fontSize = "0.78rem";
        badge.style.fontWeight = "700";
        badge.style.letterSpacing = "0.04em";
        badge.style.background = session.current
          ? "rgba(34,197,94,0.12)"
          : "rgba(216,176,94,0.12)";
        badge.style.color = session.current ? "#d8ffe6" : "#f4ead3";
        badge.style.border = session.current
          ? "1px solid rgba(34,197,94,0.24)"
          : "1px solid rgba(216,176,94,0.24)";

        top.appendChild(title);
        top.appendChild(badge);

        const meta = document.createElement("div");
        meta.style.display = "grid";
        meta.style.gap = "6px";
        meta.style.color = "rgba(244,234,211,0.76)";
        meta.style.fontSize = "0.92rem";
        meta.innerHTML = `
          <div><strong style="color:#f4ead3;">IP:</strong> ${escapeHtml(
            session.ipAddressMasked || session.ipAddress || "Unavailable"
          )}</div>
          <div><strong style="color:#f4ead3;">Last active:</strong> ${escapeHtml(
            formatDateTime(session.lastActiveAt || session.last_active_at)
          )}</div>
          <div><strong style="color:#f4ead3;">Created:</strong> ${escapeHtml(
            formatDateTime(session.createdAt || session.created_at)
          )}</div>
        `;

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.flexWrap = "wrap";
        actions.style.gap = "10px";

        if (!session.current) {
          const revokeButton = document.createElement("button");
          revokeButton.type = "button";
          revokeButton.textContent = "Sign Out Session";
          revokeButton.dataset.sessionAction = "revoke";
          revokeButton.dataset.sessionId = session.id || "";
          styleActionButton(revokeButton, "secondary");
          actions.appendChild(revokeButton);
        } else {
          const currentText = document.createElement("div");
          currentText.textContent = "This is the session you’re currently using.";
          currentText.style.color = "rgba(244,234,211,0.72)";
          currentText.style.fontSize = "0.9rem";
          actions.appendChild(currentText);
        }

        item.appendChild(top);
        item.appendChild(meta);
        item.appendChild(actions);
        container.appendChild(item);
      });
    });

    setText("[data-total-sessions]", String(list.length));
  }

  async function loadSessionFirst() {
    const result = await fetchJson(CONFIG.meEndpoint, {
      method: "GET",
    });

    if (!result.response.ok) {
      throw new Error(getErrorMessage(result, "Unable to verify your session."));
    }

    if (result.data.authenticated !== true) {
      redirectToLogin();
      return null;
    }

    if (!isObject(result.data.member) && !isObject(result.data.profile)) {
      throw new Error("Your session is active, but your member details were not returned.");
    }

    const member = normalizeMember(result.data.member || result.data.profile || {}, result.data.profile || {});
    const settings = buildDefaultSettings(member);

    const parsed = renderSettingsPayload({
      success: true,
      data: {
        member,
        profile: result.data.profile || null,
        settings,
        support: result.data.support || null,
      },
    });

    renderSessionsPayload({
      success: true,
      data: {
        member,
        support: result.data.support || null,
        sessions: {
          persisted: false,
          totalSessions: 1,
          currentSessionId: "current-browser-session",
          sessions: [buildFallbackSession(member)],
        },
      },
    });

    return parsed;
  }

  async function loadSettingsEnhancement(fallbackPayload) {
    try {
      const result = await fetchJson(CONFIG.settingsEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return null;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return null;
      }

      if (!result.response.ok) {
        return fallbackPayload || null;
      }

      return renderSettingsPayload(result.payload, fallbackPayload || {});
    } catch (error) {
      console.warn("[portal-settings] settings enhancement skipped:", error);
      return fallbackPayload || null;
    }
  }

  async function loadSessionsEnhancement(fallbackPayload) {
    state.isLoadingSessions = true;

    const statusNode = getStatusNode("[data-sessions-status]", "#sessions-status");
    clearStatus(statusNode);

    try {
      const result = await fetchJson(CONFIG.sessionsEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return null;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return null;
      }

      if (!result.response.ok) {
        return fallbackPayload || null;
      }

      const parsed = renderSessionsPayload(result.payload, fallbackPayload || {});

      if (parsed.persisted === false) {
        setStatus(
          statusNode,
          "info",
          "Sessions loaded, but the portal_sessions database column is not yet persisting changes."
        );
      }

      return parsed;
    } catch (error) {
      console.warn("[portal-settings] sessions enhancement skipped:", error);
      return fallbackPayload || null;
    } finally {
      state.isLoadingSessions = false;
    }
  }

  async function loadSettings() {
    if (state.isLoadingSettings) return false;

    state.isLoadingSettings = true;

    const statusNode = getStatusNode(
      "[data-settings-page-status]",
      "#settings-page-status",
      "[data-settings-status]",
      "#settings-status"
    );

    clearStatus(statusNode);
    setHidden("[data-settings-loading]", false);

    try {
      const sessionPayload = await loadSessionFirst();

      if (!sessionPayload) return false;

      await loadSettingsEnhancement(sessionPayload);

      return true;
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not load your portal settings page."
      );

      return false;
    } finally {
      state.isLoadingSettings = false;
      setHidden("[data-settings-loading]", true);
    }
  }

  async function loadSessions() {
    const fallback = {
      member: state.member || {},
      support: state.support || {},
      sessions: state.sessions?.length ? state.sessions : [buildFallbackSession(state.member || {})],
    };

    await loadSessionsEnhancement(fallback);
  }

  async function saveSettings(form) {
    if (state.isSavingSettings || !form) return;

    const statusNode =
      form.querySelector("[data-settings-status]") ||
      getStatusNode("[data-settings-status]", "#settings-status");

    clearStatus(statusNode);
    state.isSavingSettings = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-settings-submit]");

    const originalSubmitText = submitButton?.textContent || "Save Settings";

    setFormDisabled(form, true);

    if (submitButton) {
      submitButton.textContent = "Saving...";
      submitButton.disabled = true;
    }

    try {
      const payload = collectSettingsFromForm(form);

      const result = await fetchJson(CONFIG.settingsEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return;
      }

      if (!result.response.ok) {
        throw new Error(getErrorMessage(result, "Unable to save settings."));
      }

      const parsed = renderSettingsPayload(result.payload, {
        member: state.member || {},
        profile: state.profile || {},
        settings: state.settings || {},
        support: state.support || {},
      });

      const persisted = result.data.persisted !== false && parsed.persisted !== false;

      setStatus(
        statusNode,
        persisted ? "success" : "info",
        result.message ||
          (persisted
            ? "Settings updated successfully."
            : "Settings validated successfully. Add portal_settings to public.signups to persist updates.")
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not update your portal settings."
      );
    } finally {
      state.isSavingSettings = false;
      setFormDisabled(form, false);

      if (submitButton) {
        submitButton.textContent = originalSubmitText;
        submitButton.disabled = false;
      }
    }
  }

  async function changePassword(form) {
    if (state.isSavingPassword || !form) return;

    const statusNode =
      form.querySelector("[data-password-status]") ||
      getStatusNode("[data-password-status]", "#password-status");

    clearStatus(statusNode);

    const payload = collectPasswordFromForm(form);
    const validationError = validatePasswordPayload(payload);

    if (validationError) {
      setStatus(statusNode, "error", validationError);
      return;
    }

    state.isSavingPassword = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-password-submit]");

    const originalSubmitText = submitButton?.textContent || "Update Password";

    if (submitButton) {
      submitButton.textContent = "Updating...";
      submitButton.disabled = true;
    }

    try {
      const result = await fetchJson(CONFIG.changePasswordEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return;
      }

      if (!result.response.ok) {
        throw new Error(getErrorMessage(result, "Unable to change password."));
      }

      form.reset();

      const responseData = unwrapApiPayload(result.payload);

      if (responseData.member) {
        applyMember(responseData.member);
      }

      const changedAt =
        responseData?.security?.passwordLastChangedAt ||
        responseData?.settings?.security?.passwordLastChangedAt ||
        new Date().toISOString();

      setText("[data-password-last-changed]", formatDateTime(changedAt));

      setStatus(
        statusNode,
        "success",
        result.message || "Password changed successfully."
      );

      await loadSessions();
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not change your password."
      );
    } finally {
      state.isSavingPassword = false;

      if (submitButton) {
        submitButton.textContent = originalSubmitText;
        submitButton.disabled = false;
      }
    }
  }

  async function handleSessionAction(action, sessionId = "") {
    const statusNode = getStatusNode("[data-sessions-status]", "#sessions-status");
    clearStatus(statusNode);

    try {
      const result = await fetchJson(CONFIG.sessionsEndpoint, {
        method: "POST",
        body: JSON.stringify({
          action,
          sessionId,
        }),
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return;
      }

      if (!result.response.ok) {
        throw new Error(getErrorMessage(result, "Unable to update sessions."));
      }

      const parsed = renderSessionsPayload(result.payload, {
        member: state.member || {},
        support: state.support || {},
        sessions: state.sessions || [],
      });

      const persisted = result.data.persisted !== false && parsed.persisted !== false;

      setStatus(
        statusNode,
        persisted ? "success" : "info",
        result.message ||
          (persisted
            ? "Sessions updated successfully."
            : "Sessions updated for this request. Add portal_sessions to public.signups to persist updates.")
      );

      if (result.data?.signedOut) {
        window.location.href = CONFIG.loginPage;
      }
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not update your sessions."
      );
    }
  }

  function bindSettingsForm() {
    const form = getSettingsForm();

    if (!form || form.dataset.settingsBound === "true") return;

    form.dataset.settingsBound = "true";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings(form);
    });

    form.addEventListener("reset", (event) => {
      event.preventDefault();

      if (state.settings) {
        applySettings(state.settings);
      }

      clearStatus(
        form.querySelector("[data-settings-status]") ||
          getStatusNode("[data-settings-status]", "#settings-status")
      );
    });
  }

  function bindPasswordForm() {
    const form = getPasswordForm();

    if (!form || form.dataset.passwordBound === "true") return;

    form.dataset.passwordBound = "true";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await changePassword(form);
    });
  }

  function bindSessionButtons() {
    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-session-action]");
      if (!target) return;

      event.preventDefault();

      const actionName = normalizeText(target.dataset.sessionAction).toLowerCase();
      const sessionId = normalizeText(target.dataset.sessionId);

      if (actionName === "revoke") {
        await handleSessionAction("revoke_session", sessionId);
        return;
      }

      if (actionName === "signout-others") {
        await handleSessionAction("sign_out_others");
        return;
      }

      if (actionName === "signout-current") {
        await handleSessionAction("sign_out_current");
        return;
      }

      if (actionName === "clear-all") {
        await handleSessionAction("clear_all");
      }
    });
  }

  function bindRefreshButtons() {
    document.querySelectorAll("[data-settings-refresh]").forEach((button) => {
      if (button.dataset.settingsRefreshBound === "true") return;

      button.dataset.settingsRefreshBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await loadSettings();
        await loadSessions();
      });
    });

    document.querySelectorAll("[data-sessions-refresh]").forEach((button) => {
      if (button.dataset.sessionsRefreshBound === "true") return;

      button.dataset.sessionsRefreshBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await loadSessions();
      });
    });
  }

  function bindLogoutButtons() {
    if (window.CardLeoAuthGuard?.bindLogoutButtons) {
      window.CardLeoAuthGuard.bindLogoutButtons(CONFIG.authGuardOptions);
      return;
    }

    document.querySelectorAll("[data-logout], [data-member-logout]").forEach((button) => {
      if (button.dataset.settingsLogoutBound === "true") return;

      button.dataset.settingsLogoutBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        try {
          await fetch(CONFIG.logoutEndpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json",
            },
          });
        } catch {
          // Still redirect.
        }

        window.location.href = CONFIG.loginPage;
      });
    });
  }

  function styleStaticButtons() {
    document
      .querySelectorAll(
        '[data-session-action="signout-others"], [data-session-action="signout-current"], [data-session-action="clear-all"], [data-settings-submit], [data-password-submit]'
      )
      .forEach((button) => {
        const tone =
          button.dataset.sessionAction === "clear-all" ||
          button.dataset.sessionAction === "signout-current"
            ? "danger"
            : "primary";

        styleActionButton(button, tone);
      });
  }

  async function init() {
    try {
      bindSettingsForm();
      bindPasswordForm();
      bindSessionButtons();
      bindRefreshButtons();
      bindLogoutButtons();
      styleStaticButtons();

      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      await loadSettings();
      await loadSessions();
    } catch (error) {
      const globalStatus = getStatusNode(
        "[data-settings-page-status]",
        "#settings-page-status",
        "[data-settings-status]",
        "#settings-status"
      );

      setStatus(
        globalStatus,
        "error",
        error?.message || "We could not load your portal settings page."
      );
    }
  }

  window.addEventListener("cardleo:auth-ready", (event) => {
    const detail = event?.detail || {};

    if (detail.member && !state.authReady) {
      state.authReady = true;

      const member = normalizeMember(detail.member, detail.profile || {});
      const settings = buildDefaultSettings(member);

      renderSettingsPayload({
        success: true,
        data: {
          member,
          profile: detail.profile || null,
          settings,
          support: detail.support || null,
        },
      });

      renderSessionsPayload({
        success: true,
        data: {
          member,
          support: detail.support || null,
          sessions: {
            persisted: false,
            totalSessions: 1,
            currentSessionId: "current-browser-session",
            sessions: [buildFallbackSession(member)],
          },
        },
      });
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalSettings = {
    init,
    reloadSettings: loadSettings,
    reloadSessions: loadSessions,
    saveSettings,
    changePassword,
    signOutCurrent: () => handleSessionAction("sign_out_current"),
    signOutOthers: () => handleSessionAction("sign_out_others"),
    clearAllSessions: () => handleSessionAction("clear_all"),
    getState: function () {
      return { ...state };
    },
  };
})();