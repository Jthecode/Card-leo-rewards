// assets/js/portal-profile.js
(function () {
  const CONFIG = {
    meEndpoint: "/api/auth/me",
    profileEndpoint: "/api/portal/profile",
    updateProfileEndpoint: "/api/portal/update-profile",
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
    support: null,
    raw: null,
    initialFormValues: null,
    isSaving: false,
    isLoading: false,
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

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "—";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
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

    return {
      response,
      payload,
      data: unwrapApiPayload(payload),
      message: normalizeText(payload?.message || unwrapApiPayload(payload)?.message),
    };
  }

  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.loginPage}?next=${encodeURIComponent(next)}`;
  }

  function redirectToUnauthorized() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.unauthorizedPage}?next=${encodeURIComponent(next)}`;
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

  function setHidden(selector, hidden) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.hidden = Boolean(hidden);
    });
  }

  function getStatusNode(form = null) {
    return (
      form?.querySelector("[data-profile-status]") ||
      document.querySelector("[data-profile-status]") ||
      document.querySelector("[data-profile-page-status]") ||
      document.querySelector("#profile-status") ||
      document.querySelector("#profile-page-status")
    );
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

  function setFormDisabled(form, disabled) {
    if (!form) return;

    Array.from(form.elements || []).forEach((node) => {
      if (node.dataset.keepEnabled === "true") return;
      node.disabled = Boolean(disabled);
    });
  }

  function splitFullName(fullName = "") {
    const clean = normalizeText(fullName);

    if (!clean) {
      return {
        firstName: "",
        lastName: "",
      };
    }

    const parts = clean.split(/\s+/).filter(Boolean);

    if (parts.length === 1) {
      return {
        firstName: parts[0],
        lastName: "",
      };
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
    };
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

  function getFirstName(member = {}, profile = {}) {
    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      normalizeText(profile.firstName || profile.first_name);

    if (firstName) return firstName;

    return getFullName(member, profile).split(/\s+/)[0] || "Member";
  }

  function getLastName(member = {}, profile = {}) {
    return (
      normalizeText(member.lastName || member.last_name) ||
      normalizeText(profile.lastName || profile.last_name)
    );
  }

  function getMemberEmail(member = {}, profile = {}) {
    return normalizeEmail(member.email || profile.email);
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

  function getPortalAccess(member = {}) {
    if (typeof member.portalAccess === "boolean") return member.portalAccess;
    if (typeof member.portal_access === "boolean") return member.portal_access;

    return ACTIVE_STATUSES.has(getMemberStatus(member));
  }

  function getJoinedAt(member = {}) {
    return (
      member.joinedAt ||
      member.joined_at ||
      member.createdAt ||
      member.created_at ||
      null
    );
  }

  function getLocationText(values = {}) {
    const city = normalizeText(values.city);
    const st = normalizeText(values.state);

    if (city && st) return `${city}, ${st}`;
    if (city) return city;
    if (st) return st;

    return "Not provided";
  }

  function normalizeMember(member = {}, profile = {}) {
    const safeMember = isObject(member) ? member : {};
    const safeProfile = isObject(profile) ? profile : {};

    const firstName = getFirstName(safeMember, safeProfile);
    const lastName = getLastName(safeMember, safeProfile);
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
      firstName,
      first_name: firstName,
      lastName,
      last_name: lastName,
      fullName,
      full_name: fullName,
      name: fullName,
      email: getMemberEmail(safeMember, safeProfile),
      phone: safeMember.phone || safeProfile.phone || "",
      city: safeMember.city || safeProfile.city || "",
      state: safeMember.state || safeProfile.state || "",
      interest: safeMember.interest || safeProfile.interest || "",
      goals: safeMember.goals || safeProfile.goals || "",
      referralName:
        safeMember.referralName ||
        safeMember.referral_name ||
        safeProfile.referralName ||
        safeProfile.referral_name ||
        "",
      referral_name:
        safeMember.referralName ||
        safeMember.referral_name ||
        safeProfile.referralName ||
        safeProfile.referral_name ||
        "",
      status,
      memberStatus: status,
      member_status: status,
      tier,
      tierLabel: titleCase(tier),
      portalAccess: getPortalAccess({
        ...safeMember,
        status,
      }),
      accessLevel: safeMember.accessLevel || safeMember.access_level || tier || "member",
      joinedAt: getJoinedAt(safeMember),
      createdAt: safeMember.createdAt || safeMember.created_at || null,
      updatedAt: safeMember.updatedAt || safeMember.updated_at || null,
    };
  }

  function buildProfileFromMember(member = {}) {
    return {
      id: member.id || member.signupId || "",
      email: member.email || "",
      firstName: member.firstName || member.first_name || "",
      first_name: member.firstName || member.first_name || "",
      lastName: member.lastName || member.last_name || "",
      last_name: member.lastName || member.last_name || "",
      fullName: member.fullName || member.full_name || member.name || "",
      full_name: member.fullName || member.full_name || member.name || "",
      phone: member.phone || "",
      city: member.city || "",
      state: member.state || "",
      referralName: member.referralName || member.referral_name || "",
      referral_name: member.referralName || member.referral_name || "",
      interest: member.interest || "",
      goals: member.goals || "",
      status: member.status || "",
      tier: member.tier || "core",
    };
  }

  function inferProfilePayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);

    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackProfile = isObject(fallback.profile) ? fallback.profile : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const rawMember =
      (isObject(data.member) && data.member) ||
      (isObject(data.profile) && data.profile) ||
      fallbackMember ||
      {};

    const rawProfile =
      (isObject(data.profile) && data.profile) ||
      (isObject(data.member) && buildProfileFromMember(data.member)) ||
      fallbackProfile ||
      {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...rawMember,
      },
      {
        ...fallbackProfile,
        ...rawProfile,
      }
    );

    const profile = {
      ...buildProfileFromMember(member),
      ...fallbackProfile,
      ...rawProfile,
    };

    const support =
      (isObject(data.support) && data.support) ||
      (isObject(data.settings?.support) && data.settings.support) ||
      (isObject(data.member?.support) && data.member.support) ||
      fallbackSupport ||
      {};

    return {
      member,
      profile,
      support,
      raw: data,
    };
  }

  function applyMember(member = {}) {
    state.member = normalizeMember(member, state.profile || {});

    const fullName = state.member.fullName;
    const firstName = state.member.firstName || "Member";
    const status = state.member.memberStatus || state.member.status || "active";
    const statusLabel = titleCase(status);
    const accessLevel = state.member.accessLevel || state.member.tier || "member";

    setText("[data-member-name]", fullName);
    setText("[data-member-full-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-last-name]", state.member.lastName || "");
    setText("[data-member-email]", state.member.email || "");
    setText("[data-member-status]", statusLabel);
    setText("[data-member-tier]", titleCase(state.member.tier || "core"));
    setText("[data-member-access-level]", titleCase(accessLevel));
    setText("[data-member-accesslevel]", titleCase(accessLevel));
    setText("[data-member-id]", state.member.id || state.member.signupId || "");
    setText("[data-member-joined-at]", formatDate(state.member.joinedAt));

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = state.member.email || "";
    document.body.dataset.memberStatus = status;
    document.body.dataset.memberAccessLevel = accessLevel;
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

  function buildProfileValues(profile = {}, member = {}) {
    const mergedMember = normalizeMember(member, profile);
    const fullName = getFullName(mergedMember, profile);

    return {
      firstName:
        profile.firstName ??
        profile.first_name ??
        mergedMember.firstName ??
        "",
      lastName:
        profile.lastName ??
        profile.last_name ??
        mergedMember.lastName ??
        "",
      fullName:
        profile.fullName ??
        profile.full_name ??
        fullName ??
        "",
      email: profile.email ?? mergedMember.email ?? "",
      phone: profile.phone ?? mergedMember.phone ?? "",
      city: profile.city ?? mergedMember.city ?? "",
      state: profile.state ?? mergedMember.state ?? "",
      referralName:
        profile.referralName ??
        profile.referral_name ??
        mergedMember.referralName ??
        "",
      interest: profile.interest ?? mergedMember.interest ?? "",
      goals: profile.goals ?? mergedMember.goals ?? "",
    };
  }

  function applyProfile(profile = {}, member = {}) {
    state.profile = isObject(profile) ? profile : {};

    const values = buildProfileValues(state.profile, member || state.member || {});
    state.initialFormValues = { ...values };

    setValue('[name="firstName"], [data-profile-field="firstName"]', values.firstName);
    setValue('[name="first_name"], [data-profile-field="first_name"]', values.firstName);

    setValue('[name="lastName"], [data-profile-field="lastName"]', values.lastName);
    setValue('[name="last_name"], [data-profile-field="last_name"]', values.lastName);

    setValue('[name="fullName"], [data-profile-field="fullName"]', values.fullName);
    setValue('[name="full_name"], [data-profile-field="full_name"]', values.fullName);

    setValue('[name="email"], [data-profile-field="email"]', values.email);
    setValue('[name="phone"], [data-profile-field="phone"]', values.phone);
    setValue('[name="city"], [data-profile-field="city"]', values.city);
    setValue('[name="state"], [data-profile-field="state"]', values.state);

    setValue(
      '[name="referralName"], [data-profile-field="referralName"]',
      values.referralName
    );
    setValue(
      '[name="referral_name"], [data-profile-field="referral_name"]',
      values.referralName
    );

    setValue('[name="interest"], [data-profile-field="interest"]', values.interest);
    setValue('[name="goals"], [data-profile-field="goals"]', values.goals);

    setText("[data-profile-name]", values.fullName || "Card Leo Member");
    setText("[data-profile-email]", values.email || "Not provided");
    setText("[data-profile-phone]", values.phone || "Not provided");
    setText("[data-profile-location]", getLocationText(values));
    setText("[data-profile-city]", values.city || "Not provided");
    setText("[data-profile-state]", values.state || "Not provided");
    setText("[data-profile-referral-name]", values.referralName || "Not provided");
    setText("[data-profile-interest]", values.interest || "Not provided");
    setText("[data-profile-goals]", values.goals || "Not provided");
  }

  function renderPayload(payload, fallback = {}) {
    const parsed = inferProfilePayload(payload, fallback);

    state.raw = parsed.raw;
    applyMember(parsed.member);
    applySupport(parsed.support);
    applyProfile(parsed.profile, parsed.member);

    setHidden("[data-profile-loading]", true);
    setHidden("[data-profile-ready]", false);

    return parsed;
  }

  function getProfileForm() {
    return (
      document.querySelector("[data-profile-form]") ||
      document.querySelector("#portal-profile-form") ||
      document.querySelector("#profile-form") ||
      null
    );
  }

  function findField(form, name) {
    if (!form) return null;

    return (
      form.querySelector(`[name="${name}"]`) ||
      form.querySelector(`[data-profile-field="${name}"]`)
    );
  }

  function readField(form, ...names) {
    for (const name of names) {
      const field = findField(form, name);

      if (field) {
        return normalizeText(field.value || "");
      }
    }

    return "";
  }

  function collectProfileFromForm(form) {
    let firstName = readField(form, "firstName", "first_name");
    let lastName = readField(form, "lastName", "last_name");
    const fullName = readField(form, "fullName", "full_name", "name");

    if ((!firstName || !lastName) && fullName) {
      const parts = splitFullName(fullName);
      firstName = firstName || parts.firstName;
      lastName = lastName || parts.lastName;
    }

    const finalFullName = fullName || [firstName, lastName].filter(Boolean).join(" ");

    return {
      firstName,
      lastName,
      fullName: finalFullName,
      email: readField(form, "email"),
      phone: readField(form, "phone"),
      city: readField(form, "city"),
      state: readField(form, "state"),
      referralName: readField(form, "referralName", "referral_name"),
      interest: readField(form, "interest"),
      goals: readField(form, "goals"),
    };
  }

  function restoreInitialFormValues(form) {
    if (!form || !state.initialFormValues) return;

    const values = state.initialFormValues;

    const mappings = [
      ["firstName", values.firstName],
      ["first_name", values.firstName],
      ["lastName", values.lastName],
      ["last_name", values.lastName],
      ["fullName", values.fullName],
      ["full_name", values.fullName],
      ["email", values.email],
      ["phone", values.phone],
      ["city", values.city],
      ["state", values.state],
      ["referralName", values.referralName],
      ["referral_name", values.referralName],
      ["interest", values.interest],
      ["goals", values.goals],
    ];

    mappings.forEach(([name, value]) => {
      const field = findField(form, name);
      if (field) field.value = value ?? "";
    });
  }

  function validateProfilePayload(payload) {
    const errors = {};

    if (!payload.firstName) {
      errors.firstName = "First name is required.";
    }

    if (!payload.lastName) {
      errors.lastName = "Last name is required.";
    }

    if (!payload.email) {
      errors.email = "Email is required.";
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (payload.email && !emailPattern.test(payload.email)) {
      errors.email = "Please enter a valid email address.";
    }

    if (payload.phone && payload.phone.replace(/\D/g, "").length < 10) {
      errors.phone = "Please enter a valid phone number.";
    }

    if (payload.city.length > 80) {
      errors.city = "City must be 80 characters or fewer.";
    }

    if (payload.state.length > 80) {
      errors.state = "State must be 80 characters or fewer.";
    }

    if (payload.referralName.length > 120) {
      errors.referralName = "Referral name must be 120 characters or fewer.";
    }

    if (payload.goals.length > 1500) {
      errors.goals = "Goals must be 1500 characters or fewer.";
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      message: Object.values(errors)[0] || "",
    };
  }

  function getErrorMessage(result, fallback = "Something went wrong.") {
    const data = result?.data || {};
    const payload = result?.payload || {};

    const directMessage =
      normalizeText(payload.message) ||
      normalizeText(data.message) ||
      normalizeText(payload.error) ||
      normalizeText(data.error);

    if (directMessage) return directMessage;

    const errors = data.errors || payload.errors || data.details || payload.details;

    if (isObject(errors)) {
      const first = Object.values(errors).find(Boolean);
      if (first) return normalizeText(first, fallback);
    }

    return fallback;
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
      throw new Error("Your session is active, but your member profile was not returned.");
    }

    return renderPayload(result.payload);
  }

  async function loadProfileEnhancement(fallbackPayload) {
    try {
      const result = await fetchJson(CONFIG.profileEndpoint, {
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

      return renderPayload(result.payload, fallbackPayload || {});
    } catch (error) {
      console.warn("Profile enhancement skipped:", error);
      return fallbackPayload || null;
    }
  }

  async function loadProfile() {
    if (state.isLoading) return false;

    state.isLoading = true;

    const pageStatus = getStatusNode();
    clearStatus(pageStatus);
    setHidden("[data-profile-loading]", false);

    try {
      const sessionPayload = await loadSessionFirst();

      if (!sessionPayload) return false;

      await loadProfileEnhancement(sessionPayload);

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
      setHidden("[data-profile-loading]", true);
    }
  }

  async function saveProfile(form) {
    if (state.isSaving || !form) return;

    const statusNode = getStatusNode(form);
    clearStatus(statusNode);

    const payload = collectProfileFromForm(form);
    const validation = validateProfilePayload(payload);

    if (!validation.valid) {
      setStatus(statusNode, "error", validation.message);
      return;
    }

    state.isSaving = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-profile-submit]");

    const originalSubmitText = submitButton?.textContent || "Save Profile";

    setFormDisabled(form, true);

    if (submitButton) {
      submitButton.textContent = "Saving...";
      submitButton.disabled = true;
    }

    try {
      const result = await fetchJson(CONFIG.updateProfileEndpoint, {
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
        throw new Error(
          getErrorMessage(result, "Unable to update your profile.")
        );
      }

      const parsed = renderPayload(result.payload, {
        member: state.member || {},
        profile: state.profile || {},
        support: state.support || {},
      });

      const event = new CustomEvent("cardleo:profile-updated", {
        detail: {
          member: parsed.member,
          profile: parsed.profile,
          support: parsed.support,
          payload: result.payload,
        },
      });

      window.dispatchEvent(event);

      setStatus(
        statusNode,
        "success",
        normalizeText(result.payload?.message) ||
          normalizeText(result.data?.message) ||
          "Profile updated successfully."
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not save your profile right now."
      );
    } finally {
      state.isSaving = false;
      setFormDisabled(form, false);

      const emailField =
        findField(form, "email") ||
        form.querySelector('[type="email"]');

      if (emailField) {
        emailField.readOnly = true;
      }

      if (submitButton) {
        submitButton.textContent = originalSubmitText;
        submitButton.disabled = false;
      }
    }
  }

  function bindProfileForm() {
    const form = getProfileForm();

    if (!form || form.dataset.profileBound === "true") return;

    form.dataset.profileBound = "true";

    const emailField =
      findField(form, "email") ||
      form.querySelector('[type="email"]');

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
      clearStatus(getStatusNode(form));
    });
  }

  function bindLogoutButtons() {
    if (window.CardLeoAuthGuard?.bindLogoutButtons) {
      window.CardLeoAuthGuard.bindLogoutButtons(CONFIG.authGuardOptions);
      return;
    }

    document.querySelectorAll("[data-logout], [data-member-logout]").forEach((button) => {
      if (button.dataset.profileLogoutBound === "true") return;

      button.dataset.profileLogoutBound = "true";

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

  async function init() {
    const pageStatus = getStatusNode();

    try {
      bindProfileForm();
      bindLogoutButtons();

      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      await loadProfile();
    } catch (error) {
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal profile page."
      );
    }
  }

  window.addEventListener("cardleo:auth-ready", (event) => {
    const detail = event?.detail || {};

    if (detail.member && !state.authReady) {
      state.authReady = true;

      renderPayload({
        success: true,
        data: {
          authenticated: true,
          member: detail.member,
          profile: detail.profile || null,
          user: detail.user || null,
          session: detail.session || null,
          support: detail.support || null,
        },
      });
    }
  });

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
    getState: function () {
      return { ...state };
    },
  };
})();