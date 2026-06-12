// assets/js/portal-benefits.js

(() => {
  const state = {
    loading: false,
    summary: null,
    featureFlags: {},
    onboarding: {},
    rewardAccount: {},
    benefits: [],
    groups: [],
    activeCategory: "all",
  };

  function $(id) {
    return document.getElementById(id);
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
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function formatMoney(value) {
    const num = Number(value || 0);

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(num) ? num : 0);
  }

  function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString() : "0";
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function getFirstValue(source, keys = [], fallback = null) {
    if (!source || typeof source !== "object") return fallback;

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] != null) {
        return source[key];
      }
    }

    return fallback;
  }

  function toBoolean(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    }
    return fallback;
  }

  function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function isPlainObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : { success: false, message: "Unexpected server response." };

    if (!response.ok || body?.success === false) {
      const error = new Error(body?.message || "Request failed.");
      error.status = response.status;
      error.payload = body;
      throw error;
    }

    return body;
  }

  function normalizeBenefit(raw = {}) {
    const unlocked = toBoolean(
      getFirstValue(raw, ["unlocked", "isUnlocked"], null),
      !toBoolean(getFirstValue(raw, ["locked", "isLocked"], false), false)
    );

    const locked = toBoolean(
      getFirstValue(raw, ["locked", "isLocked"], null),
      !unlocked
    );

    const featured = toBoolean(
      getFirstValue(raw, ["featured", "isFeatured"], false),
      false
    );

    return {
      id: getFirstValue(raw, ["id"], ""),
      title: getFirstValue(raw, ["title", "name"], "Benefit"),
      description: getFirstValue(
        raw,
        ["description", "summary", "copy"],
        "No description available."
      ),
      category: String(getFirstValue(raw, ["category", "group"], "other") || "other")
        .trim()
        .toLowerCase(),
      badge: getFirstValue(raw, ["badge", "label"], ""),
      requiredTier: getFirstValue(
        raw,
        ["requiredTier", "required_tier", "tier"],
        "core"
      ),
      unlocked,
      locked,
      featured,
      lockedReason: getFirstValue(
        raw,
        ["lockedReason", "locked_reason", "reason"],
        ""
      ),
      meta: isPlainObject(raw.meta)
        ? raw.meta
        : isPlainObject(raw.metadata)
        ? raw.metadata
        : null,
    };
  }

  function buildGroupsFromBenefits(benefits) {
    const grouped = new Map();

    benefits.forEach((benefit) => {
      const key = benefit.category || "other";

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }

      grouped.get(key).push(benefit);
    });

    return Array.from(grouped.entries()).map(([category, items]) => ({
      category,
      title: titleCase(category),
      count: items.length,
      unlockedCount: items.filter((item) => item.unlocked).length,
      items,
    }));
  }

  function normalizeGroup(raw = {}) {
    const items = Array.isArray(raw.items) ? raw.items.map(normalizeBenefit) : [];
    const category = String(
      getFirstValue(raw, ["category", "key"], items[0]?.category || "other") || "other"
    )
      .trim()
      .toLowerCase();

    return {
      category,
      title: getFirstValue(raw, ["title"], titleCase(category)),
      count: toNumber(getFirstValue(raw, ["count"], items.length), items.length),
      unlockedCount: toNumber(
        getFirstValue(
          raw,
          ["unlockedCount", "unlocked_count"],
          items.filter((item) => item.unlocked).length
        ),
        items.filter((item) => item.unlocked).length
      ),
      items,
    };
  }

  function normalizeSummary(raw = {}, benefits = []) {
    const computedTotals = {
      benefits: benefits.length,
      unlocked: benefits.filter((item) => item.unlocked).length,
      locked: benefits.filter((item) => !item.unlocked).length,
    };

    const totals = isPlainObject(raw.totals) ? raw.totals : {};

    return {
      memberName: getFirstValue(
        raw,
        ["memberName", "member_name", "fullName", "full_name"],
        document.body.dataset.memberName || "Card Leo Member"
      ),
      tier: getFirstValue(raw, ["tier"], "core"),
      tierLabel: getFirstValue(raw, ["tierLabel", "tier_label"], titleCase(getFirstValue(raw, ["tier"], "core"))),
      memberStatus: getFirstValue(raw, ["memberStatus", "member_status"], "active"),
      nextTierLabel: getFirstValue(raw, ["nextTierLabel", "next_tier_label"], "Current Highest Tier"),
      totals: {
        benefits: toNumber(getFirstValue(totals, ["benefits"], computedTotals.benefits), computedTotals.benefits),
        unlocked: toNumber(getFirstValue(totals, ["unlocked"], computedTotals.unlocked), computedTotals.unlocked),
        locked: toNumber(getFirstValue(totals, ["locked"], computedTotals.locked), computedTotals.locked),
      },
    };
  }

  function normalizeFeatureFlags(raw = {}) {
    return {
      rewardsEnabled: toBoolean(
        getFirstValue(raw, ["rewardsEnabled", "rewards_enabled"], true),
        true
      ),
      referralsEnabled: toBoolean(
        getFirstValue(raw, ["referralsEnabled", "referrals_enabled"], true),
        true
      ),
      supportEnabled: toBoolean(
        getFirstValue(raw, ["supportEnabled", "support_enabled"], true),
        true
      ),
      benefitsEnabled: toBoolean(
        getFirstValue(raw, ["benefitsEnabled", "benefits_enabled"], true),
        true
      ),
    };
  }

  function normalizeOnboarding(raw = {}) {
    return {
      onboardingPercent: toNumber(
        getFirstValue(raw, ["onboardingPercent", "onboarding_percent"], 0),
        0
      ),
      profileCompleted: toBoolean(
        getFirstValue(raw, ["profileCompleted", "profile_completed"], false),
        false
      ),
      emailVerified: toBoolean(
        getFirstValue(raw, ["emailVerified", "email_verified"], false),
        false
      ),
      rewardsActivated: toBoolean(
        getFirstValue(raw, ["rewardsActivated", "rewards_activated"], false),
        false
      ),
    };
  }

  function normalizeRewardAccount(raw = {}) {
    return {
      totalRewardsEarned: toNumber(
        getFirstValue(raw, ["totalRewardsEarned", "total_rewards_earned"], 0),
        0
      ),
      totalRewardsPaid: toNumber(
        getFirstValue(raw, ["totalRewardsPaid", "total_rewards_paid"], 0),
        0
      ),
      companyBuildingReleased: toNumber(
        getFirstValue(raw, ["companyBuildingReleased", "company_building_released"], 0),
        0
      ),
      companyBuildingPending: toNumber(
        getFirstValue(raw, ["companyBuildingPending", "company_building_pending"], 0),
        0
      ),
    };
  }

  function getToneClass(benefit) {
    if (benefit.featured && benefit.unlocked) return "benefit-featured";
    if (benefit.locked || !benefit.unlocked) return "benefit-locked";
    return "benefit-unlocked";
  }

  function getBadgeClass(benefit) {
    if (benefit.locked || !benefit.unlocked) return "badge-muted";
    if (benefit.featured) return "badge-gold";
    return "badge-soft";
  }

  function normalizeGroups() {
    if (Array.isArray(state.groups) && state.groups.length) {
      return state.groups;
    }

    return buildGroupsFromBenefits(state.benefits);
  }

  function ensureActiveCategoryIsValid() {
    const validCategories = ["all", ...normalizeGroups().map((group) => group.category)];

    if (!validCategories.includes(state.activeCategory)) {
      state.activeCategory = "all";
    }
  }

  function getVisibleGroups() {
    const groups = normalizeGroups();

    if (!state.activeCategory || state.activeCategory === "all") {
      return groups;
    }

    return groups.filter((group) => group.category === state.activeCategory);
  }

  function renderHeader() {
    const summary = state.summary || {};
    const totals = summary.totals || {};

    setText("memberName", summary.memberName || "Card Leo Member");
    setText("memberTier", summary.tierLabel || titleCase(summary.tier || "core"));
    setText("memberStatus", titleCase(summary.memberStatus || "active"));
    setText("nextTier", summary.nextTierLabel || "Current Highest Tier");

    setText("benefitsTotal", formatCount(totals.benefits || 0));
    setText("benefitsUnlocked", formatCount(totals.unlocked || 0));
    setText("benefitsLocked", formatCount(totals.locked || 0));
  }

  function renderMetrics() {
    const rewardAccount = state.rewardAccount || {};
    const onboarding = state.onboarding || {};

    setText("metricOnboarding", `${formatCount(onboarding.onboardingPercent || 0)}%`);
    setText("metricEarned", formatMoney(rewardAccount.totalRewardsEarned || 0));
    setText("metricReleased", formatMoney(rewardAccount.companyBuildingReleased || 0));
    setText("metricPending", formatMoney(rewardAccount.companyBuildingPending || 0));
  }

  function renderFeatureFlags() {
    const container = $("featureFlags");
    if (!container) return;

    const flags = state.featureFlags || {};
    const items = [
      { label: "Rewards", enabled: flags.rewardsEnabled !== false },
      { label: "Referrals", enabled: flags.referralsEnabled !== false },
      { label: "Support", enabled: flags.supportEnabled !== false },
      { label: "Benefits", enabled: flags.benefitsEnabled !== false },
    ];

    container.innerHTML = items
      .map(
        (item) => `
          <span class="flag ${item.enabled ? "enabled" : "disabled"}">
            ${escapeHtml(item.label)} · ${item.enabled ? "On" : "Off"}
          </span>
        `
      )
      .join("");
  }

  function renderCategoryTabs() {
    const container = $("benefitCategoryTabs");
    if (!container) return;

    const groups = normalizeGroups();
    const tabs = [
      {
        key: "all",
        label: "All Benefits",
        count: state.benefits.length,
      },
      ...groups.map((group) => ({
        key: group.category,
        label: group.title,
        count: group.count,
      })),
    ];

    container.innerHTML = tabs
      .map(
        (tab) => `
          <button
            type="button"
            class="filter-chip ${state.activeCategory === tab.key ? "active" : ""}"
            data-benefit-category="${escapeHtml(tab.key)}"
            aria-pressed="${state.activeCategory === tab.key ? "true" : "false"}"
          >
            ${escapeHtml(tab.label)} <span>${formatCount(tab.count)}</span>
          </button>
        `
      )
      .join("");
  }

  function renderBenefits() {
    const container = $("benefitsGrid");
    if (!container) return;

    const groups = getVisibleGroups();

    if (!groups.length) {
      container.innerHTML = `
        <div class="detail-empty">
          No benefits matched this category.
        </div>
      `;
      return;
    }

    container.innerHTML = groups
      .map(
        (group) => `
          <section class="benefit-group">
            <div class="benefit-group-header">
              <div>
                <h3>${escapeHtml(group.title)}</h3>
                <p>
                  ${formatCount(group.unlockedCount)} unlocked of
                  ${formatCount(group.count)} total
                </p>
              </div>
            </div>

            <div class="benefit-card-grid">
              ${group.items
                .map(
                  (benefit) => `
                    <article class="benefit-card ${getToneClass(benefit)}">
                      <div class="benefit-card-top">
                        <span class="benefit-badge ${getBadgeClass(benefit)}">
                          ${escapeHtml(
                            benefit.badge || (benefit.unlocked ? "Unlocked" : "Locked")
                          )}
                        </span>
                        <span class="benefit-state ${benefit.unlocked ? "unlocked" : "locked"}">
                          ${benefit.unlocked ? "Unlocked" : "Locked"}
                        </span>
                      </div>

                      <h4>${escapeHtml(benefit.title || "Benefit")}</h4>
                      <p>${escapeHtml(benefit.description || "No description available.")}</p>

                      <div class="benefit-meta">
                        <span>Category: ${escapeHtml(titleCase(benefit.category || "general"))}</span>
                        <span>Required Tier: ${escapeHtml(titleCase(benefit.requiredTier || "core"))}</span>
                      </div>

                      ${
                        benefit.lockedReason
                          ? `<div class="benefit-note">${escapeHtml(benefit.lockedReason)}</div>`
                          : ""
                      }

                      ${
                        benefit.meta
                          ? `
                            <details class="benefit-details">
                              <summary>More detail</summary>
                              <pre>${escapeHtml(JSON.stringify(benefit.meta, null, 2))}</pre>
                            </details>
                          `
                          : ""
                      }
                    </article>
                  `
                )
                .join("")}
            </div>
          </section>
        `
      )
      .join("");
  }

  function renderTimeline() {
    const container = $("benefitsTimeline");
    if (!container) return;

    const onboarding = state.onboarding || {};
    const rewardAccount = state.rewardAccount || {};

    const steps = [
      {
        title: "Profile Setup",
        status: onboarding.profileCompleted ? "complete" : "pending",
        description:
          "Complete your core profile details to improve eligibility and personalization.",
      },
      {
        title: "Email Verification",
        status: onboarding.emailVerified ? "complete" : "pending",
        description:
          "Verify your email to secure your account and complete onboarding.",
      },
      {
        title: "Rewards Activation",
        status: onboarding.rewardsActivated ? "complete" : "pending",
        description:
          "Activate the rewards profile so earnings and member incentives can track properly.",
      },
      {
        title: "Company Building Release",
        status: rewardAccount.companyBuildingReleased > 0 ? "complete" : "pending",
        description:
          "Complete paid membership cycles to release company-building earnings.",
      },
    ];

    container.innerHTML = steps
      .map(
        (step) => `
          <div class="timeline-step ${step.status}">
            <div class="timeline-dot"></div>
            <div class="timeline-copy">
              <h4>${escapeHtml(step.title)}</h4>
              <p>${escapeHtml(step.description)}</p>
            </div>
          </div>
        `
      )
      .join("");
  }

  function renderAccountPanel() {
    const summary = state.summary || {};
    const onboarding = state.onboarding || {};
    const rewardAccount = state.rewardAccount || {};

    setText("accountTier", summary.tierLabel || titleCase(summary.tier || "core"));
    setText("accountOnboarding", `${formatCount(onboarding.onboardingPercent || 0)}%`);
    setText("accountCompanyPending", formatMoney(rewardAccount.companyBuildingPending || 0));
    setText("accountCompanyReleased", formatMoney(rewardAccount.companyBuildingReleased || 0));
    setText("accountTotalEarned", formatMoney(rewardAccount.totalRewardsEarned || 0));
    setText("accountTotalPaid", formatMoney(rewardAccount.totalRewardsPaid || 0));
  }

  function showInlineError(message) {
    const container = $("benefitsGrid");
    if (!container) return;

    container.innerHTML = `
      <div class="detail-empty">
        ${escapeHtml(message || "Unable to load benefits.")}
      </div>
    `;
  }

  function bindCategoryEvents() {
    const container = $("benefitCategoryTabs");
    if (!container || container.dataset.bound === "true") return;

    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-benefit-category]");
      if (!button) return;

      state.activeCategory =
        button.getAttribute("data-benefit-category") || "all";

      renderCategoryTabs();
      renderBenefits();
    });

    container.dataset.bound = "true";
  }

  function renderAll() {
    ensureActiveCategoryIsValid();
    renderHeader();
    renderMetrics();
    renderFeatureFlags();
    renderCategoryTabs();
    renderBenefits();
    renderTimeline();
    renderAccountPanel();
    setText("lastRefresh", formatDate(new Date().toISOString()));
  }

  async function loadBenefits() {
    state.loading = true;

    const result = await api("/api/portal/benefits");
    const data = result?.data || {};

    const benefits = Array.isArray(data.benefits)
      ? data.benefits.map(normalizeBenefit)
      : [];

    const groups = Array.isArray(data.groups)
      ? data.groups.map(normalizeGroup)
      : buildGroupsFromBenefits(benefits);

    state.benefits = benefits;
    state.groups = groups;
    state.summary = normalizeSummary(data.summary || {}, benefits);
    state.featureFlags = normalizeFeatureFlags(data.featureFlags || {});
    state.onboarding = normalizeOnboarding(data.onboarding || {});
    state.rewardAccount = normalizeRewardAccount(data.rewardAccount || {});

    ensureActiveCategoryIsValid();
    renderAll();
  }

  async function handleRefresh() {
    const button = $("refreshBenefitsBtn");
    const originalText = button ? button.textContent : "";

    try {
      if (button) {
        button.disabled = true;
        button.textContent = "Refreshing...";
      }

      await loadBenefits();
    } catch (error) {
      showInlineError(error?.message || "Unable to refresh benefits.");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText || "Refresh";
      }
    }
  }

  async function handleLogout() {
    try {
      await api("/api/auth/logout", {
        method: "POST",
      });
    } catch {
      // no-op
    } finally {
      window.location.href = "/login.html";
    }
  }

  function bindEvents() {
    bindCategoryEvents();
    $("refreshBenefitsBtn")?.addEventListener("click", handleRefresh);
    $("logoutBtn")?.addEventListener("click", handleLogout);
  }

  async function init() {
    bindEvents();

    try {
      await loadBenefits();
    } catch (error) {
      if (error?.status === 401) {
        const next = encodeURIComponent("/portal/benefits.html");
        window.location.href = `/login.html?next=${next}`;
        return;
      }

      if (error?.status === 403) {
        window.location.href = "/unauthorized.html";
        return;
      }

      showInlineError(error?.message || "Unable to load benefits.");
    } finally {
      state.loading = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();