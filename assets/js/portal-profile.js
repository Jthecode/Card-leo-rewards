// assets/js/portal-profile.js

(function () {
  const CONFIG = {
    profileEndpoint: "/api/portal/profile",
    updateProfileEndpoint: "/api/portal/update-profile",
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
    profile: null,
    support: null,
    initialFormValues: null,
    isSaving: false,
    isLoading: false,
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

  function fetchJson(url, options = {}) {
    return fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...options,
    }).then(async (response) => {
      let data = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      return { response, data };
    });
  }

  function inferProfilePayload(payload) {
    const data = isObject(payload?.data) ? payload.data : payload;
    const member = isObject(data?.member) ? data.member : {};
    const profile = isObject(data?.profile) ? data.profile : {};
    const support = isObject(data?.support) ? data.support : {};

    return { member, profile, support };
  }

  function applyMember(member = {}) {
    state.member = member;

    const fullName =
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
      fullName.split(" ")[0] ||
      "Member";

    setText("[data-member-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", member.email || "");
    setText("[data-member-status]", member.status || "member");
    setText(
      "[data-member-access-level]",
      member.accessLevel || member.access_level || "member"
    );
    setText(
      "[data-member-joined-at]",
      member.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : "—"
    );

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = normalizeText(member.email || "");
    document.body.dataset.memberStatus = normalizeText(member.status || "");
  }

  function applySupport(support = {}) {
    state.support = support;

    setText("[data-support-email]", support.email || "support@cardleorewards.com");
    setText("[data-support-phone]", support.phone || "");
    setText("[data-support-hours]", support.hours || "Mon–Fri, 9:00 AM–6:00 PM");
  }

  function buildProfileValues(profile = {}, member = {}) {
    return {
      firstName:
        profile.firstName ??
        profile.first_name ??
        member.firstName ??
        member.first_name ??
        "",
      lastName:
        profile.lastName ??
        profile.last_name ??
        member.lastName ??
        member.last_name ??
        "",
      email: profile.email ?? member.email ?? "",
      phone: profile.phone ?? "",
      city: profile.city ?? "",
      state: profile.state ?? "",
      referralName: profile.referralName ?? profile.referral_name ?? "",
      interest: profile.interest ?? "",
      goals: profile.goals ?? "",
    };
  }

  function applyProfile(profile = {}, member = {}) {
    state.profile = profile;

    const values = buildProfileValues(profile, member);
    state.initialFormValues = { ...values };

    setValue('[name="firstName"], [data-profile-field="firstName"]', values.firstName);
    setValue('[name="lastName"], [data-profile-field="lastName"]', values.lastName);
    setValue('[name="email"], [data-profile-field="email"]', values.email);
    setValue('[name="phone"], [data-profile-field="phone"]', values.phone);
    setValue('[name="city"], [data-profile-field="city"]', values.city);
    setValue('[name="state"], [data-profile-field="state"]', values.state);
    setValue(
      '[name="referralName"], [data-profile-field="referralName"]',
      values.referralName
    );
    setValue('[name="interest"], [data-profile-field="interest"]', values.interest);
    setValue('[name="goals"], [data-profile-field="goals"]', values.goals);

    setText("[data-profile-email]", values.email);
    setText("[data-profile-phone]", values.phone || "Not provided");
    setText(
      "[data-profile-location]",
      [values.city, values.state].filter(Boolean).join(", ") || "Not provided"
    );
    setText(
      "[data-profile-referral-name]",
      values.referralName || "Not provided"
    );
    setText("[data-profile-interest]", values.interest || "Not provided");
    setText("[data-profile-goals]", values.goals || "Not provided");
  }

  function getProfileForm() {
    return (
      document.querySelector("[data-profile-form]") ||
      document.querySelector("#portal-profile-form") ||
      document.querySelector("#profile-form") ||
      null
    );
  }

  function readField(form, name) {
    const field =
      form.querySelector(`[name="${name}"]`) ||
      form.querySelector(`[data-profile-field="${name}"]`);

    return normalizeText(field?.value || "");
  }

  function collectProfileFromForm(form) {
    return {
      firstName: readField(form, "firstName"),
      lastName: readField(form, "lastName"),
      email: readField(form, "email"),
      phone: readField(form, "phone"),
      city: readField(form, "city"),
      state: readField(form, "state"),
      referralName: readField(form, "referralName"),
      interest: readField(form, "interest"),
      goals: readField(form, "goals"),
    };
  }

  function restoreInitialFormValues(form) {
    if (!state.initialFormValues) return;

    const values = state.initialFormValues;

    const mappings = [
      ["firstName", values.firstName],
      ["lastName", values.lastName],
      ["email", values.email],
      ["phone", values.phone],
      ["city", values.city],
      ["state", values.state],
      ["referralName", values.referralName],
      ["interest", values.interest],
      ["goals", values.goals],
    ];

    mappings.forEach(([name, value]) => {
      const field =
        form.querySelector(`[name="${name}"]`) ||
        form.querySelector(`[data-profile-field="${name}"]`);

      if (field) field.value = value ?? "";
    });
  }

  function validateProfilePayload(payload) {
    if (!payload.firstName) {
      return "First name is required.";
    }

    if (!payload.lastName) {
      return "Last name is required.";
    }

    if (!payload.email) {
      return "Email is required.";
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(payload.email)) {
      return "Please enter a valid email address.";
    }

    return null;
  }

  async function loadProfile() {
    state.isLoading = true;

    const pageStatus =
      document.querySelector("[data-profile-page-status]") ||
      document.querySelector("#profile-page-status") ||
      document.querySelector("[data-profile-status]");

    clearStatus(pageStatus);

    try {
      const result = await fetchJson(CONFIG.profileEndpoint, {
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
          normalizeText(result.data?.message) || "Unable to load your profile."
        );
      }

      const payload = inferProfilePayload(result.data);
      applyMember(payload.member);
      applySupport(payload.support);
      applyProfile(payload.profile, payload.member);

      return true;
    } catch (error) {
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal profile."
      );
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function saveProfile(form) {
    if (state.isSaving) return;

    const statusNode =
      form.querySelector("[data-profile-status]") ||
      document.querySelector("[data-profile-status]") ||
      document.querySelector("#profile-status");

    clearStatus(statusNode);

    const payload = collectProfileFromForm(form);
    const validationError = validateProfilePayload(payload);

    if (validationError) {
      setStatus(statusNode, "error", validationError);
      return;
    }

    state.isSaving = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-profile-submit]");

    const resetButton =
      form.querySelector('[type="reset"]') ||
      form.querySelector("[data-profile-reset]");

    setDisabled(
      [
        '[data-profile-form] button',
        '[data-profile-form] input',
        '[data-profile-form] textarea',
        '[data-profile-form] select',
      ],
      true
    );

    if (submitButton) {
      submitButton.dataset.originalText =
        submitButton.dataset.originalText || submitButton.textContent;
      submitButton.textContent = "Saving...";
    }

    try {
      const result = await fetchJson(CONFIG.updateProfileEndpoint, {
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
          normalizeText(result.data?.message) || "Unable to update your profile."
        );
      }

      const parsed = inferProfilePayload(result.data);
      applyMember(parsed.member);
      applySupport(parsed.support);
      applyProfile(parsed.profile, parsed.member);

      setStatus(
        statusNode,
        "success",
        normalizeText(result.data?.message) || "Profile updated successfully."
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not save your profile right now."
      );
    } finally {
      state.isSaving = false;

      setDisabled(
        [
          '[data-profile-form] button',
          '[data-profile-form] input',
          '[data-profile-form] textarea',
          '[data-profile-form] select',
        ],
        false
      );

      const emailField =
        form.querySelector('[name="email"]') ||
        form.querySelector('[data-profile-field="email"]');
      if (emailField) {
        emailField.readOnly = true;
      }

      if (submitButton) {
        submitButton.textContent =
          submitButton.dataset.originalText || "Save Profile";
      }

      if (resetButton) {
        resetButton.disabled = false;
      }
    }
  }

  function bindProfileForm() {
    const form = getProfileForm();
    if (!form) return;

    const emailField =
      form.querySelector('[name="email"]') ||
      form.querySelector('[data-profile-field="email"]');

    if (emailField) {
      emailField.readOnly = true;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveProfile(form);
    });

    form.addEventListener("reset", (event) => {
      event.preventDefault();
      restoreInitialFormValues(form);

      const statusNode =
        form.querySelector("[data-profile-status]") ||
        document.querySelector("[data-profile-status]") ||
        document.querySelector("#profile-status");

      clearStatus(statusNode);
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

  async function init() {
    try {
      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      bindProfileForm();
      bindLogoutButtons();

      await loadProfile();
    } catch (error) {
      const pageStatus =
        document.querySelector("[data-profile-page-status]") ||
        document.querySelector("#profile-page-status") ||
        document.querySelector("[data-profile-status]");

      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal profile page."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalProfile = {
    init,
    reload: loadProfile,
    saveProfile,
    resetForm: function () {
      const form = getProfileForm();
      if (form) restoreInitialFormValues(form);
    },
  };
})();