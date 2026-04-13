// assets/js/portal-settings.js

(function () {
  const CONFIG = {
    settingsEndpoint: "/api/portal/settings",
    sessionsEndpoint: "/api/portal/sessions",
    changePasswordEndpoint: "/api/portal/change-password",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      fallbackPortalOverviewEndpoint: "/api/portal/overview",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      debug: false,
    },
  };

  const state = {
    member: null,
    settings: null,
    sessions: [],
    support: null,
    isSavingSettings: false,
    isSavingPassword: false,
    isLoadingSessions: false,
  };

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setValue(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.value = value ?? "";
    });
  }

  function setChecked(selector, checked) {
    document.querySelectorAll(selector).forEach((node) => {
      node.checked = !!checked;
    });
  }

  function setDisabled(selectors, disabled) {
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        node.disabled = !!disabled;
      });
    });
  }

  function setStatus(target, type, message) {
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

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
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function inferSettingsPayload(payload) {
    const data = isObject(payload?.data) ? payload.data : payload;
    const member = isObject(data?.member) ? data.member : {};
    const settings = isObject(data?.settings) ? data.settings : {};
    const support = isObject(data?.support) ? data.support : {};

    return { member, settings, support };
  }

  function inferSessionsPayload(payload) {
    const data = isObject(payload?.data) ? payload.data : payload;
    const sessionsWrap = isObject(data?.sessions) ? data.sessions : {};
    const support = isObject(data?.support) ? data.support : {};
    const member = isObject(data?.member) ? data.member : {};

    return {
      member,
      support,
      sessions:
        Array.isArray(sessionsWrap.sessions) ? sessionsWrap.sessions : [],
      totalSessions:
        Number.isFinite(sessionsWrap.totalSessions) ? sessionsWrap.totalSessions : 0,
      currentSessionId: normalizeText(sessionsWrap.currentSessionId || ""),
      persisted: sessionsWrap.persisted !== false,
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
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

  function applyMember(member = {}) {
    state.member = member;

    const name =
      normalizeText(member.name) ||
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
      name.split(" ")[0] ||
      "Member";

    setText("[data-member-name]", name);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", member.email || "");
    setText("[data-member-status]", member.status || "member");
    setText(
      "[data-member-access-level]",
      member.accessLevel || member.access_level || "member"
    );

    document.body.dataset.memberName = name;
    document.body.dataset.memberEmail = normalizeText(member.email || "");
  }

  function applySupport(support = {}) {
    state.support = support;

    setText("[data-support-email]", support.email || "support@cardleorewards.com");
    setText("[data-support-phone]", support.phone || "");
    setText("[data-support-hours]", support.hours || "Mon–Fri, 9:00 AM–6:00 PM");
  }

  function applySettings(settings = {}) {
    state.settings = settings;

    const preferences = isObject(settings.preferences) ? settings.preferences : {};
    const security = isObject(settings.security) ? settings.security : {};

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

    const themeSelect =
      document.querySelector('[name="theme"]') ||
      document.querySelector('[data-setting="theme"]');

    if (themeSelect) {
      themeSelect.value = normalizeText(preferences.theme || "dark") || "dark";
    }

    setText(
      "[data-password-last-changed]",
      security.passwordLastChangedAt
        ? new Date(security.passwordLastChangedAt).toLocaleString()
        : "Not available"
    );
    setText(
      "[data-email-verified]",
      security.emailVerified ? "Verified" : "Not verified"
    );
    setText(
      "[data-two-factor-enabled]",
      security.twoFactorEnabled ? "Enabled" : "Not enabled"
    );
  }

  function getSettingsForm() {
    return document.querySelector("[data-settings-form]") ||
      document.querySelector("#portal-settings-form") ||
      document.querySelector("#settings-form") ||
      null;
  }

  function getPasswordForm() {
    return document.querySelector("[data-password-form]") ||
      document.querySelector("#change-password-form") ||
      document.querySelector("#password-form") ||
      null;
  }

  function collectSettingsFromForm(form) {
    const readCheckbox = (name) => {
      const field =
        form.querySelector(`[name="${name}"]`) ||
        form.querySelector(`[data-setting="${name}"]`);
      return !!field?.checked;
    };

    const themeField =
      form.querySelector('[name="theme"]') ||
      form.querySelector('[data-setting="theme"]');

    return {
      preferences: {
        emailNotifications: readCheckbox("emailNotifications"),
        smsNotifications: readCheckbox("smsNotifications"),
        productUpdates: readCheckbox("productUpdates"),
        marketingEmails: readCheckbox("marketingEmails"),
        rewardAlerts: readCheckbox("rewardAlerts"),
        securityAlerts: readCheckbox("securityAlerts"),
        theme: normalizeText(themeField?.value || "dark").toLowerCase() || "dark",
      },
      security: {
        twoFactorEnabled: !!(
          form.querySelector('[name="twoFactorEnabled"]') ||
          form.querySelector('[data-setting="twoFactorEnabled"]')
        )?.checked,
      },
    };
  }

  function collectPasswordFromForm(form) {
    const currentPassword =
      form.querySelector('[name="currentPassword"]')?.value || "";
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
      signOutOtherSessions: signOutOtherSessionsField
        ? !!signOutOtherSessionsField.checked
        : true,
    };
  }

  function renderSessions(sessions) {
    const containers = document.querySelectorAll(
      "[data-sessions-list], #portal-sessions-list, #sessions-list"
    );

    if (!containers.length) return;

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!Array.isArray(sessions) || !sessions.length) {
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

      sessions.forEach((session) => {
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
            ${escapeHtml(session.browser || "Unknown Browser")} • ${escapeHtml(
          session.os || "Unknown OS"
        )} • ${escapeHtml(session.deviceType || "device")}
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
            session.lastActiveAt
              ? new Date(session.lastActiveAt).toLocaleString()
              : "Unavailable"
          )}</div>
          <div><strong style="color:#f4ead3;">Created:</strong> ${escapeHtml(
            session.createdAt
              ? new Date(session.createdAt).toLocaleString()
              : "Unavailable"
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

    setText(
      "[data-total-sessions]",
      String(Array.isArray(sessions) ? sessions.length : 0)
    );
  }

  function styleActionButton(button, tone = "primary") {
    button.style.border = "0";
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
      button.style.background =
        "linear-gradient(135deg, rgba(216,176,94,0.95), rgba(162,124,48,0.96))";
      button.style.color = "#140f07";
      button.style.boxShadow = "0 14px 30px rgba(216,176,94,0.18)";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadSettings() {
    const result = await fetchJson(CONFIG.settingsEndpoint, {
      method: "GET",
    });

    if (result.response.status === 401) {
      window.location.href = CONFIG.loginPage;
      return false;
    }

    if (result.response.status === 403) {
      window.location.href = CONFIG.unauthorizedPage;
      return false;
    }

    if (!result.response.ok) {
      throw new Error(
        normalizeText(result.data?.message) || "Unable to load portal settings."
      );
    }

    const payload = inferSettingsPayload(result.data);
    applyMember(payload.member);
    applySupport(payload.support);
    applySettings(payload.settings);

    return true;
  }

  async function loadSessions() {
    state.isLoadingSessions = true;

    const statusNode =
      document.querySelector("[data-sessions-status]") ||
      document.querySelector("#sessions-status");

    clearStatus(statusNode);

    try {
      const result = await fetchJson(CONFIG.sessionsEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return false;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return false;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to load sessions."
        );
      }

      const payload = inferSessionsPayload(result.data);
      if (payload.member && !state.member) applyMember(payload.member);
      if (payload.support && !state.support) applySupport(payload.support);

      state.sessions = payload.sessions;
      renderSessions(payload.sessions);

      if (payload.persisted === false) {
        setStatus(
          statusNode,
          "info",
          "Sessions loaded, but the portal_sessions database column is not yet persisting changes."
        );
      }

      return true;
    } catch (error) {
      renderSessions([]);
      setStatus(
        statusNode,
        "error",
        error?.message || "Unable to load your active sessions."
      );
      return false;
    } finally {
      state.isLoadingSessions = false;
    }
  }

  async function saveSettings(form) {
    if (state.isSavingSettings) return;

    const statusNode =
      form.querySelector("[data-settings-status]") ||
      document.querySelector("[data-settings-status]") ||
      document.querySelector("#settings-status");

    clearStatus(statusNode);
    state.isSavingSettings = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-settings-submit]");

    const resetButton =
      form.querySelector('[type="reset"]') ||
      form.querySelector("[data-settings-reset]");

    setDisabled(
      ['[data-settings-form] button', '[data-settings-form] input', '[data-settings-form] select'],
      true
    );

    if (submitButton) {
      submitButton.dataset.originalText =
        submitButton.dataset.originalText || submitButton.textContent;
      submitButton.textContent = "Saving...";
    }

    try {
      const payload = collectSettingsFromForm(form);

      const result = await fetchJson(CONFIG.settingsEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to save settings."
        );
      }

      const parsed = inferSettingsPayload(result.data);
      applyMember(parsed.member);
      applySupport(parsed.support);
      applySettings(parsed.settings);

      setStatus(
        statusNode,
        result.data?.persisted === false ? "info" : "success",
        normalizeText(result.data?.message) || "Settings updated successfully."
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not update your portal settings."
      );
    } finally {
      state.isSavingSettings = false;

      setDisabled(
        ['[data-settings-form] button', '[data-settings-form] input', '[data-settings-form] select'],
        false
      );

      if (submitButton) {
        submitButton.textContent =
          submitButton.dataset.originalText || "Save Settings";
      }

      if (resetButton) {
        resetButton.disabled = false;
      }
    }
  }

  async function changePassword(form) {
    if (state.isSavingPassword) return;

    const statusNode =
      form.querySelector("[data-password-status]") ||
      document.querySelector("[data-password-status]") ||
      document.querySelector("#password-status");

    clearStatus(statusNode);
    state.isSavingPassword = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-password-submit]");

    if (submitButton) {
      submitButton.dataset.originalText =
        submitButton.dataset.originalText || submitButton.textContent;
      submitButton.textContent = "Updating...";
      submitButton.disabled = true;
    }

    try {
      const payload = collectPasswordFromForm(form);

      const result = await fetchJson(CONFIG.changePasswordEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to change password."
        );
      }

      form.reset();

      if (result.data?.data?.member) {
        applyMember(result.data.data.member);
      }

      setText(
        "[data-password-last-changed]",
        result.data?.data?.security?.passwordLastChangedAt
          ? new Date(
              result.data.data.security.passwordLastChangedAt
            ).toLocaleString()
          : "Just now"
      );

      setStatus(
        statusNode,
        "success",
        normalizeText(result.data?.message) || "Password changed successfully."
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
        submitButton.textContent =
          submitButton.dataset.originalText || "Update Password";
        submitButton.disabled = false;
      }
    }
  }

  async function handleSessionAction(action, sessionId = "") {
    const statusNode =
      document.querySelector("[data-sessions-status]") ||
      document.querySelector("#sessions-status");

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
        window.location.href = CONFIG.loginPage;
        return;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to update sessions."
        );
      }

      const payload = inferSessionsPayload(result.data);
      state.sessions = payload.sessions;
      renderSessions(payload.sessions);

      setStatus(
        statusNode,
        result.data?.persisted === false ? "info" : "success",
        normalizeText(result.data?.message) || "Sessions updated successfully."
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
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings(form);
    });

    form.addEventListener("reset", (event) => {
      event.preventDefault();
      if (state.settings) {
        applySettings(state.settings);
      }
      const statusNode =
        form.querySelector("[data-settings-status]") ||
        document.querySelector("[data-settings-status]") ||
        document.querySelector("#settings-status");
      clearStatus(statusNode);
    });
  }

  function bindPasswordForm() {
    const form = getPasswordForm();
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await changePassword(form);
    });
  }

  function bindSessionButtons() {
    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-session-action]");
      if (!target) return;

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

  function bindLogoutButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-logout]");
      if (!trigger) return;

      event.preventDefault();

      if (window.CardLeoAuthGuard?.logout) {
        await window.CardLeoAuthGuard.logout(CONFIG.authGuardOptions);
      } else {
        window.location.href = CONFIG.loginPage;
      }
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
      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      bindSettingsForm();
      bindPasswordForm();
      bindSessionButtons();
      bindLogoutButtons();
      styleStaticButtons();

      await loadSettings();
      await loadSessions();
    } catch (error) {
      const globalStatus =
        document.querySelector("[data-settings-page-status]") ||
        document.querySelector("#settings-page-status") ||
        document.querySelector("[data-settings-status]");

      setStatus(
        globalStatus,
        "error",
        error?.message || "We could not load your portal settings page."
      );
    }
  }

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
  };
})();