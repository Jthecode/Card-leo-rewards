// assets/js/portal-benefits.js
(() => {
  const CONFIG = {
    meEndpoint: "/api/auth/me",
    benefitsEndpoint: "/api/portal/benefits",
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
    loading: false,
    initialized: false,
    authReady: false,
    member: null,
    profile: null,
    summary: null,
    onboarding: null,
    rewardAccount: null,
    featureFlags: null,
    support: null,
    benefits: [],
    groups: [],
    raw: null,
    filters: {
      category: "all",
      status: "all",
      search: "",
    },
  };

  const selectors = {
    loading: "[data-benefits-loading]",
    ready: "[data-benefits-ready]",
    error: "[data-benefits-error]",
    errorMessage: "[data-benefits-error-message]",
    empty: "[data-benefits-empty]",
    featured: "[data-benefits-featured]",
    groups: "[data-benefits-groups]",
    refresh: "[data-benefits-refresh]",
    search: "[data-benefits-search]",
    filterCategory: "[data-benefits-filter-category]",
    filterStatus: "[data-benefits-filter-status]",
    statsBenefits: "[data-benefits-total]",
    statsUnlocked: "[data-benefits-unlocked]",
    statsLocked: "[data-benefits-locked]",
    memberName: "[data-benefits-member-name]",
    memberEmail: "[data-benefits-member-email]",
    memberTier: "[data-benefits-member-tier]",
    memberStatus: "[data-benefits-member-status]",
    nextTier: "[data-benefits-next-tier]",
    pointsAvailable: "[data-benefits-points-available]",
    pointsPending: "[data-benefits-points-pending]",
    onboardingPercent: "[data-benefits-onboarding-percent]",
    filterSummary: "[data-benefits-filter-summary]",
    lastUpdated: "[data-benefits-last-updated]",
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeString(value) {
    return String(value || "").trim().toLowerCase();
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

  function formatNumber(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString("en-US") : "0";
  }

  function money(value) {
    const num = Number(value || 0);

    if (!Number.isFinite(num)) {
      return "$0.00";
    }

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num);
  }

  function formatPercent(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0%";
    return `${Math.max(0, Math.min(100, Math.round(num)))}%`;
  }

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: "GET",
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

  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.loginPage}?next=${encodeURIComponent(next)}`;
  }

  function redirectToUnauthorized() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.unauthorizedPage}?next=${encodeURIComponent(next)}`;
  }

  function setText(selector, value) {
    $all(selector).forEach((el) => {
      el.textContent = value ?? "";
    });
  }

  function setHidden(selector, hidden) {
    $all(selector).forEach((el) => {
      el.hidden = Boolean(hidden);
      el.style.display = hidden ? "none" : "";
    });
  }

  function show(selector, visible) {
    setHidden(selector, !visible);
  }

  function setLoading(isLoading) {
    state.loading = isLoading;

    show(selectors.loading, isLoading);
    show(selectors.ready, !isLoading);

    $all(selectors.refresh).forEach((button) => {
      if ("disabled" in button) {
        button.disabled = isLoading;
      }
    });
  }

  function setError(message = "") {
    const hasError = Boolean(message);

    show(selectors.error, hasError);
    setText(selectors.errorMessage, message || "");
  }

  function setEmpty(isEmpty) {
    show(selectors.empty, isEmpty);
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
      nextTier: safeMember.nextTier || safeMember.next_tier || "",
      nextTierLabel: safeMember.nextTierLabel || safeMember.next_tier_label || "",
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

  function buildFallbackBenefits(member = {}) {
    const portalAccess = getPortalAccess(member);
    const status = getMemberStatus(member);
    const tier = normalizeText(member.tier || "core").toLowerCase();

    return [
      {
        code: "member_portal",
        title: "Member Portal Access",
        description:
          "Access your Card Leo Rewards dashboard, account details, benefits, support tools, and premium member experience.",
        category: "core",
        requiredTier: "core",
        badge: portalAccess ? "Active" : "Pending",
        featured: true,
        sortOrder: 10,
        unlocked: portalAccess,
        locked: !portalAccess,
        lockedReason: portalAccess
          ? null
          : "Your member portal access is pending activation or approval.",
      },
      {
        code: "profile_management",
        title: "Profile Management",
        description:
          "Review and update your member contact details, location, referral information, and account profile.",
        category: "account",
        requiredTier: "core",
        badge: "Included",
        featured: true,
        sortOrder: 20,
        unlocked: true,
        locked: false,
        lockedReason: null,
      },
      {
        code: "rewards_overview",
        title: "Rewards Overview",
        description:
          "View your available reward activity, company-building status, and member reward tracking as your account grows.",
        category: "rewards",
        requiredTier: "core",
        badge: portalAccess ? "Ready" : "Pending",
        featured: true,
        sortOrder: 30,
        unlocked: portalAccess,
        locked: !portalAccess,
        lockedReason: portalAccess
          ? null
          : "Rewards access activates when your account becomes active.",
      },
      {
        code: "member_support",
        title: "Member Support",
        description:
          "Submit support requests and get help with profile questions, benefits, rewards, and member access.",
        category: "support",
        requiredTier: "core",
        badge: "Included",
        featured: true,
        sortOrder: 40,
        unlocked: true,
        locked: false,
        lockedReason: null,
      },
      {
        code: "premium_offers",
        title: "Premium Member Offers",
        description:
          "Enhanced promotions, premium member perks, and select Card Leo Rewards opportunities will appear here as they become available.",
        category: "offers",
        requiredTier: "silver",
        badge: "Coming Soon",
        featured: false,
        sortOrder: 50,
        unlocked: ["silver", "gold", "platinum", "vip"].includes(tier),
        locked: !["silver", "gold", "platinum", "vip"].includes(tier),
        lockedReason: "Available starting at Silver tier.",
      },
      {
        code: "account_status",
        title: "Account Status",
        description:
          status === "active"
            ? "Your account is active and connected to the member experience."
            : "Your account status is being reviewed. More benefits unlock as your account becomes active.",
        category: "account",
        requiredTier: "core",
        badge: titleCase(status || "Active"),
        featured: true,
        sortOrder: 5,
        unlocked: status === "active" || status === "approved" || status === "invited",
        locked: !(status === "active" || status === "approved" || status === "invited"),
        lockedReason:
          status === "active" || status === "approved" || status === "invited"
            ? null
            : "Account activation is required for the full member experience.",
      },
    ];
  }

  function buildFallbackSummary(member = {}, benefits = []) {
    const unlocked = benefits.filter((item) => item.unlocked).length;
    const locked = benefits.filter((item) => item.locked).length;

    return {
      profileId: member.id || member.signupId || null,
      memberName: member.fullName || member.name || "Card Leo Member",
      email: member.email || "",
      tier: member.tier || "core",
      tierLabel: titleCase(member.tier || "core"),
      nextTier: "",
      nextTierLabel: "Top Tier",
      memberStatus: member.memberStatus || member.status || "active",
      totals: {
        benefits: benefits.length,
        unlocked,
        locked,
      },
    };
  }

  function inferBenefitsPayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);

    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackProfile = isObject(fallback.profile) ? fallback.profile : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...(isObject(data.member) ? data.member : {}),
        ...(isObject(data.summary)
          ? {
              fullName: data.summary.memberName,
              email: data.summary.email,
              tier: data.summary.tier,
              tierLabel: data.summary.tierLabel,
              nextTier: data.summary.nextTier,
              nextTierLabel: data.summary.nextTierLabel,
              status: data.summary.memberStatus,
            }
          : {}),
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

    const support =
      (isObject(data.support) && data.support) ||
      fallbackSupport ||
      {};

    const fallbackBenefits = Array.isArray(fallback.benefits)
      ? fallback.benefits
      : buildFallbackBenefits(member);

    const benefits = Array.isArray(data.benefits) && data.benefits.length
      ? data.benefits
      : fallbackBenefits;

    const summary = isObject(data.summary) && data.summary
      ? data.summary
      : buildFallbackSummary(member, benefits);

    const onboarding = isObject(data.onboarding)
      ? data.onboarding
      : isObject(fallback.onboarding)
        ? fallback.onboarding
        : {
            onboarding_percent: member.portalAccess ? 100 : 50,
            profile_completed: Boolean(member.email && member.fullName),
            email_verified: Boolean(member.emailVerified || member.email_verified),
            rewards_activated: member.portalAccess,
          };

    const rewardAccount = isObject(data.rewardAccount)
      ? data.rewardAccount
      : isObject(data.reward_account)
        ? data.reward_account
        : isObject(fallback.rewardAccount)
          ? fallback.rewardAccount
          : {};

    const featureFlags = isObject(data.featureFlags)
      ? data.featureFlags
      : isObject(data.feature_flags)
        ? data.feature_flags
        : isObject(fallback.featureFlags)
          ? fallback.featureFlags
          : {
              benefits_enabled: true,
              rewards_enabled: true,
              referrals_enabled: true,
              support_enabled: true,
            };

    return {
      member,
      profile,
      support,
      summary,
      onboarding,
      rewardAccount,
      featureFlags,
      benefits,
      groups: Array.isArray(data.groups) ? data.groups : [],
      raw: data,
    };
  }

  function applyMemberBindings(member = {}) {
    state.member = normalizeMember(member, state.profile || {});

    setText("[data-member-name]", state.member.fullName);
    setText("[data-member-full-name]", state.member.fullName);
    setText("[data-member-first-name]", state.member.firstName);
    setText("[data-member-email]", state.member.email);
    setText("[data-member-status]", titleCase(state.member.memberStatus || state.member.status));
    setText("[data-member-tier]", titleCase(state.member.tier || "core"));
    setText("[data-member-access-level]", titleCase(state.member.accessLevel || state.member.tier || "member"));

    document.body.dataset.memberName = state.member.fullName || "";
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

    $all("[data-support-email-link]").forEach((node) => {
      node.textContent = email;
      node.href = `mailto:${email}`;
    });
  }

  function getRewardNumber(...values) {
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }

    return 0;
  }

  function renderSummary() {
    const summary = state.summary || {};
    const rewardAccount = state.rewardAccount || {};
    const onboarding = state.onboarding || {};
    const member = state.member || {};

    const totalBenefits =
      summary?.totals?.benefits ??
      state.benefits.length;

    const totalUnlocked =
      summary?.totals?.unlocked ??
      state.benefits.filter((item) => item.unlocked).length;

    const totalLocked =
      summary?.totals?.locked ??
      state.benefits.filter((item) => item.locked).length;

    const pointsAvailable = getRewardNumber(
      rewardAccount.points_available,
      rewardAccount.available_points,
      rewardAccount.totalRewardsEarned,
      rewardAccount.total_rewards_earned,
      rewardAccount.total_direct_referral_earned,
      rewardAccount.total_override_earned
    );

    const pointsPending = getRewardNumber(
      rewardAccount.points_pending,
      rewardAccount.pending_points,
      rewardAccount.companyBuildingPending,
      rewardAccount.company_building_pending
    );

    setText(selectors.memberName, summary.memberName || member.fullName || "Member");
    setText(selectors.memberEmail, summary.email || member.email || "—");
    setText(selectors.memberTier, summary.tierLabel || member.tierLabel || titleCase(member.tier || "core"));
    setText(selectors.memberStatus, titleCase(summary.memberStatus || member.memberStatus || "active"));
    setText(selectors.nextTier, summary.nextTierLabel || member.nextTierLabel || "Top Tier");

    setText(selectors.pointsAvailable, pointsAvailable ? money(pointsAvailable) : "0");
    setText(selectors.pointsPending, pointsPending ? money(pointsPending) : "0");

    setText(selectors.onboardingPercent, formatPercent(onboarding.onboarding_percent || onboarding.onboardingPercent));
    setText(selectors.statsBenefits, formatNumber(totalBenefits));
    setText(selectors.statsUnlocked, formatNumber(totalUnlocked));
    setText(selectors.statsLocked, formatNumber(totalLocked));
    setText(selectors.lastUpdated, formatDate(new Date().toISOString()));
  }

  function populateFilterOptions() {
    const categorySelect = $(selectors.filterCategory);
    const statusSelect = $(selectors.filterStatus);

    const categories = Array.from(
      new Set(
        (state.benefits || [])
          .map((item) => normalizeString(item.category))
          .filter(Boolean)
      )
    ).sort();

    if (categorySelect) {
      const existingValue = categorySelect.value || state.filters.category || "all";

      categorySelect.innerHTML = [
        `<option value="all">All Categories</option>`,
        ...categories.map(
          (category) =>
            `<option value="${escapeHtml(category)}">${escapeHtml(titleCase(category))}</option>`
        ),
      ].join("");

      categorySelect.value =
        categories.includes(existingValue) || existingValue === "all"
          ? existingValue
          : "all";

      state.filters.category = categorySelect.value;
    }

    if (statusSelect) {
      const existingValue = statusSelect.value || state.filters.status || "all";

      statusSelect.innerHTML = `
        <option value="all">All Statuses</option>
        <option value="unlocked">Unlocked</option>
        <option value="locked">Locked</option>
        <option value="featured">Featured</option>
      `;

      statusSelect.value = ["all", "unlocked", "locked", "featured"].includes(existingValue)
        ? existingValue
        : "all";

      state.filters.status = statusSelect.value;
    }
  }

  function normalizeBenefit(benefit = {}, index = 0) {
    const unlocked = benefit.unlocked === true || benefit.locked === false;
    const locked = benefit.locked === true || !unlocked;

    return {
      code: normalizeText(benefit.code || benefit.id || `benefit-${index + 1}`),
      title: normalizeText(benefit.title || benefit.name, `Benefit ${index + 1}`),
      description: normalizeText(
        benefit.description || benefit.body || benefit.summary,
        "Premium Card Leo Rewards member benefit."
      ),
      category: normalizeString(benefit.category || "other") || "other",
      requiredTier: normalizeText(benefit.requiredTier || benefit.required_tier || benefit.tier || "core"),
      badge: normalizeText(benefit.badge || benefit.label || ""),
      featured: benefit.featured === true,
      sortOrder: Number(benefit.sortOrder || benefit.sort_order || index + 1),
      unlocked,
      locked,
      lockedReason: normalizeText(
        benefit.lockedReason ||
          benefit.locked_reason ||
          (locked ? "Locked until you meet the requirements." : "")
      ),
      meta: isObject(benefit.meta) ? benefit.meta : {},
    };
  }

  function applyFilters(benefits) {
    const category = normalizeString(state.filters.category || "all");
    const status = normalizeString(state.filters.status || "all");
    const search = normalizeString(state.filters.search || "");

    return (benefits || []).filter((benefit) => {
      const item = normalizeBenefit(benefit);

      if (category !== "all" && normalizeString(item.category) !== category) {
        return false;
      }

      if (status === "unlocked" && !item.unlocked) {
        return false;
      }

      if (status === "locked" && !item.locked) {
        return false;
      }

      if (status === "featured" && !item.featured) {
        return false;
      }

      if (search) {
        const haystack = [
          item.title,
          item.description,
          item.category,
          item.badge,
          item.requiredTier,
          item.lockedReason,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(search)) {
          return false;
        }
      }

      return true;
    });
  }

  function buildFilteredGroups() {
    const filtered = applyFilters(state.benefits).map(normalizeBenefit);

    const groupsMap = filtered.reduce((acc, benefit) => {
      const key = normalizeString(benefit.category || "other") || "other";

      if (!acc[key]) {
        acc[key] = {
          category: key,
          title: titleCase(key),
          items: [],
        };
      }

      acc[key].items.push(benefit);
      return acc;
    }, {});

    return Object.values(groupsMap)
      .map((group) => ({
        ...group,
        count: group.items.length,
        unlockedCount: group.items.filter((item) => item.unlocked).length,
        items: group.items.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0)),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function getToneClass(benefit) {
    if (benefit.locked) return "is-locked";
    if (benefit.featured) return "is-featured";
    return "is-unlocked";
  }

  function renderBenefitCard(rawBenefit) {
    const benefit = normalizeBenefit(rawBenefit);
    const toneClass = getToneClass(benefit);

    const badge = benefit.badge
      ? `<span class="benefit-badge">${escapeHtml(benefit.badge)}</span>`
      : "";

    const lockText = benefit.locked
      ? `<p class="benefit-meta benefit-locked-reason">${escapeHtml(
          benefit.lockedReason || "Locked until you meet the requirements."
        )}</p>`
      : `<p class="benefit-meta benefit-unlocked-state">Unlocked</p>`;

    const tierMeta = benefit.requiredTier
      ? `<span class="benefit-chip">Tier: ${escapeHtml(titleCase(benefit.requiredTier))}</span>`
      : "";

    const categoryMeta = benefit.category
      ? `<span class="benefit-chip">Category: ${escapeHtml(titleCase(benefit.category))}</span>`
      : "";

    return `
      <article class="benefit-card ${toneClass}" data-benefit-code="${escapeHtml(benefit.code || "")}">
        <div class="benefit-card-top">
          <div class="benefit-card-heading">
            <h3 class="benefit-title">${escapeHtml(benefit.title || "Benefit")}</h3>
            ${badge}
          </div>

          <span class="benefit-state ${benefit.locked ? "is-locked" : "is-live"}">
            ${benefit.locked ? "Locked" : "Active"}
          </span>
        </div>

        <p class="benefit-description">${escapeHtml(benefit.description || "")}</p>

        <div class="benefit-chips">
          ${categoryMeta}
          ${tierMeta}
          ${benefit.featured ? `<span class="benefit-chip">Featured</span>` : ""}
        </div>

        ${lockText}
      </article>
    `;
  }

  function renderFeatured(groups) {
    const container = $(selectors.featured);
    if (!container) return;

    const featured = groups
      .flatMap((group) => group.items)
      .filter((item) => item.featured)
      .slice(0, 6);

    if (!featured.length) {
      container.innerHTML = "";
      container.hidden = true;
      return;
    }

    container.hidden = false;
    container.innerHTML = featured.map(renderBenefitCard).join("");
  }

  function renderGroups(groups) {
    const container = $(selectors.groups);
    if (!container) return;

    if (!groups.length) {
      container.innerHTML = "";
      setEmpty(true);
      return;
    }

    setEmpty(false);

    container.innerHTML = groups
      .map(
        (group) => `
          <section class="benefit-group" data-benefit-group="${escapeHtml(group.category)}">
            <div class="benefit-group-header">
              <div>
                <h2 class="benefit-group-title">${escapeHtml(group.title)}</h2>
                <p class="benefit-group-meta">
                  ${formatNumber(group.unlockedCount)} unlocked • ${formatNumber(group.count)} total
                </p>
              </div>
            </div>

            <div class="benefit-group-grid">
              ${group.items.map(renderBenefitCard).join("")}
            </div>
          </section>
        `
      )
      .join("");
  }

  function renderFilterSummary(groups) {
    const filteredItems = groups.flatMap((group) => group.items);
    const unlocked = filteredItems.filter((item) => item.unlocked).length;
    const locked = filteredItems.filter((item) => item.locked).length;

    setText(
      selectors.filterSummary,
      `${formatNumber(filteredItems.length)} shown • ${formatNumber(unlocked)} unlocked • ${formatNumber(locked)} locked`
    );
  }

  function renderAll() {
    renderSummary();

    const groups = buildFilteredGroups();

    renderFeatured(groups);
    renderGroups(groups);
    renderFilterSummary(groups);
  }

  function renderPayload(payload, fallback = {}) {
    const parsed = inferBenefitsPayload(payload, fallback);

    state.raw = parsed.raw;
    state.member = parsed.member;
    state.profile = parsed.profile;
    state.support = parsed.support;
    state.summary = parsed.summary;
    state.onboarding = parsed.onboarding;
    state.rewardAccount = parsed.rewardAccount;
    state.featureFlags = parsed.featureFlags;
    state.benefits = parsed.benefits;
    state.groups = parsed.groups;

    applyMemberBindings(parsed.member);
    applySupport(parsed.support);
    populateFilterOptions();
    renderAll();

    setHidden(selectors.loading, true);
    setHidden(selectors.ready, false);

    return parsed;
  }

  async function loadSessionFirst() {
    const result = await fetchJson(CONFIG.meEndpoint, {
      method: "GET",
    });

    if (!result.response.ok) {
      throw new Error(result.message || "Unable to verify your session.");
    }

    if (result.data.authenticated !== true) {
      redirectToLogin();
      return null;
    }

    if (!isObject(result.data.member) && !isObject(result.data.profile)) {
      throw new Error("Your session is active, but your member details were not returned.");
    }

    const member = normalizeMember(
      result.data.member || result.data.profile || {},
      result.data.profile || {}
    );

    const benefits = buildFallbackBenefits(member);

    return renderPayload({
      success: true,
      data: {
        member,
        profile: result.data.profile || null,
        support: result.data.support || null,
        summary: buildFallbackSummary(member, benefits),
        onboarding: {
          onboarding_percent: member.portalAccess ? 100 : 50,
          profile_completed: Boolean(member.email && member.fullName),
          email_verified: Boolean(member.emailVerified || member.email_verified),
          rewards_activated: member.portalAccess,
        },
        rewardAccount: {},
        featureFlags: {
          benefits_enabled: true,
          rewards_enabled: true,
          referrals_enabled: true,
          support_enabled: true,
        },
        benefits,
        groups: [],
      },
    });
  }

  async function loadBenefitsEnhancement(fallbackPayload) {
    try {
      const result = await fetchJson(CONFIG.benefitsEndpoint, {
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
      console.warn("[portal-benefits] enhancement skipped:", error);
      return fallbackPayload || null;
    }
  }

  async function loadBenefits() {
    if (state.loading) return false;

    setLoading(true);
    setError("");
    setEmpty(false);

    try {
      const sessionPayload = await loadSessionFirst();

      if (!sessionPayload) return false;

      await loadBenefitsEnhancement(sessionPayload);

      return true;
    } catch (error) {
      console.error("[portal-benefits] load error:", error);
      setError(error?.message || "Unable to load benefits right now.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function bindControls() {
    const searchInput = $(selectors.search);
    const categorySelect = $(selectors.filterCategory);
    const statusSelect = $(selectors.filterStatus);

    $all(selectors.refresh).forEach((button) => {
      if (button.dataset.benefitsRefreshBound === "true") return;

      button.dataset.benefitsRefreshBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const originalText = "value" in button ? button.value : button.textContent;

        try {
          if ("disabled" in button) button.disabled = true;

          if ("value" in button) {
            button.value = "Refreshing...";
          } else {
            button.textContent = "Refreshing...";
          }

          await loadBenefits();
        } finally {
          if ("disabled" in button) button.disabled = false;

          if ("value" in button) {
            button.value = originalText;
          } else {
            button.textContent = originalText;
          }
        }
      });
    });

    if (searchInput && searchInput.dataset.benefitsSearchBound !== "true") {
      searchInput.dataset.benefitsSearchBound = "true";
      let timeoutId = null;

      searchInput.addEventListener("input", (event) => {
        window.clearTimeout(timeoutId);

        timeoutId = window.setTimeout(() => {
          state.filters.search = event.target.value || "";
          renderAll();
        }, 180);
      });
    }

    if (categorySelect && categorySelect.dataset.benefitsCategoryBound !== "true") {
      categorySelect.dataset.benefitsCategoryBound = "true";

      categorySelect.addEventListener("change", (event) => {
        state.filters.category = event.target.value || "all";
        renderAll();
      });
    }

    if (statusSelect && statusSelect.dataset.benefitsStatusBound !== "true") {
      statusSelect.dataset.benefitsStatusBound = "true";

      statusSelect.addEventListener("change", (event) => {
        state.filters.status = event.target.value || "all";
        renderAll();
      });
    }
  }

  function bindLogoutButtons() {
    if (window.CardLeoAuthGuard?.bindLogoutButtons) {
      window.CardLeoAuthGuard.bindLogoutButtons(CONFIG.authGuardOptions);
      return;
    }

    $all("[data-logout], [data-member-logout]").forEach((button) => {
      if (button.dataset.benefitsLogoutBound === "true") return;

      button.dataset.benefitsLogoutBound = "true";

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

  function injectStyles() {
    if (document.getElementById("portal-benefits-styles")) return;

    const style = document.createElement("style");
    style.id = "portal-benefits-styles";
    style.textContent = `
      .benefit-group {
        margin-top: 2rem;
      }

      .benefit-group-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
      }

      .benefit-group-title {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 700;
      }

      .benefit-group-meta {
        margin: 0.35rem 0 0;
        opacity: 0.75;
        font-size: 0.92rem;
      }

      .benefit-group-grid,
      [data-benefits-featured] {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 1rem;
      }

      .benefit-card {
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 18px;
        padding: 1rem;
        background: rgba(255,255,255,0.03);
        backdrop-filter: blur(10px);
        transition: 0.2s ease;
      }

      .benefit-card:hover {
        border-color: rgba(255,255,255,0.14);
        transform: translateY(-1px);
      }

      .benefit-card.is-featured {
        border-color: rgba(255, 215, 0, 0.28);
      }

      .benefit-card.is-locked {
        opacity: 0.9;
      }

      .benefit-card-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }

      .benefit-card-heading {
        min-width: 0;
      }

      .benefit-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1.35;
      }

      .benefit-badge,
      .benefit-chip,
      .benefit-state {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-size: 0.76rem;
        line-height: 1;
        white-space: nowrap;
      }

      .benefit-badge {
        margin-top: 0.5rem;
        padding: 0.4rem 0.65rem;
        background: rgba(255,255,255,0.08);
      }

      .benefit-state {
        padding: 0.45rem 0.7rem;
        border: 1px solid rgba(255,255,255,0.1);
      }

      .benefit-state.is-live {
        background: rgba(80, 200, 120, 0.12);
      }

      .benefit-state.is-locked {
        background: rgba(255, 170, 0, 0.12);
      }

      .benefit-description {
        margin: 0 0 0.9rem;
        line-height: 1.6;
        opacity: 0.92;
      }

      .benefit-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      .benefit-chip {
        padding: 0.45rem 0.65rem;
        background: rgba(255,255,255,0.06);
      }

      .benefit-meta {
        margin: 0.9rem 0 0;
        font-size: 0.9rem;
        opacity: 0.78;
      }
    `;

    document.head.appendChild(style);
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;

    injectStyles();
    bindControls();
    bindLogoutButtons();

    try {
      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      await loadBenefits();
    } catch (error) {
      console.error("[portal-benefits] init error:", error);
      setError(error?.message || "Unable to load benefits page.");
    }
  }

  window.addEventListener("cardleo:auth-ready", (event) => {
    const detail = event?.detail || {};

    if (detail.member && !state.authReady) {
      state.authReady = true;

      const member = normalizeMember(detail.member, detail.profile || {});
      const benefits = buildFallbackBenefits(member);

      renderPayload({
        success: true,
        data: {
          member,
          profile: detail.profile || null,
          support: detail.support || null,
          summary: buildFallbackSummary(member, benefits),
          onboarding: {
            onboarding_percent: member.portalAccess ? 100 : 50,
            profile_completed: Boolean(member.email && member.fullName),
            email_verified: Boolean(member.emailVerified || member.email_verified),
            rewards_activated: member.portalAccess,
          },
          rewardAccount: {},
          featureFlags: {
            benefits_enabled: true,
            rewards_enabled: true,
            referrals_enabled: true,
            support_enabled: true,
          },
          benefits,
          groups: [],
        },
      });
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.CardLeoPortalBenefits = {
    init,
    reload: loadBenefits,
    render: renderPayload,
    getState: function () {
      return { ...state };
    },
  };
})();