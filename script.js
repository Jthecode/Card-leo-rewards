// assets/js/portal-benefits.js

(() => {
  const state = {
    loading: false,
    summary: null,
    featureFlags: null,
    onboarding: null,
    rewardAccount: null,
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

  function getToneClass(benefit) {
    if (benefit?.featured && benefit?.unlocked) return "benefit-featured";
    if (benefit?.locked) return "benefit-locked";
    return "benefit-unlocked";
  }

  function getBadgeClass(benefit) {
    if (benefit?.locked) return "badge-muted";
    if (benefit?.featured) return "badge-gold";
    return "badge-soft";
  }

  function normalizeGroups() {
    if (Array.isArray(state.groups) && state.groups.length) {
      return state.groups;
    }

    const grouped = {};
    (state.benefits || []).forEach((benefit) => {
      const key = benefit.category || "other";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(benefit);
    });

    return Object.entries(grouped).map(([category, items]) => ({
      category,
      title: titleCase(category),
      count: items.length,
      unlockedCount: items.filter((item) => item.unlocked).length,
      items,
    }));
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

    setText(
      "memberName",
      summary.memberName || document.body.dataset.memberName || "Card Leo Member"
    );
    setText("memberTier", summary.tierLabel || titleCase(summary.tier || "core"));
    setText(
      "memberStatus",
      titleCase(summary.memberStatus || "active")
    );
    setText(
      "nextTier",
      summary.nextTierLabel || "Current Highest Tier"
    );

    setText("benefitsTotal", formatCount(totals.benefits || state.benefits.length || 0));
    setText("benefitsUnlocked", formatCount(totals.unlocked || 0));
    setText("benefitsLocked", formatCount(totals.locked || 0));
  }

  function renderMetrics() {
    const rewardAccount = state.rewardAccount || {};
    const onboarding = state.onboarding || {};

    setText(
      "metricOnboarding",
      `${formatCount(onboarding.onboarding_percent || onboarding.onboardingPercent || 0)}%`
    );
    setText(
      "metricEarned",
      formatMoney(
        rewardAccount.total_rewards_earned ||
          rewardAccount.totalRewardsEarned ||
          0
      )
    );
    setText(
      "metricReleased",
      formatMoney(
        rewardAccount.company_building_released ||
          rewardAccount.companyBuildingReleased ||
          0
      )
    );
    setText(
      "metricPending",
      formatMoney(
        rewardAccount.company_building_pending ||
          rewardAccount.companyBuildingPending ||
          0
      )
    );
  }

  function renderFeatureFlags() {
    const container = $("featureFlags");
    if (!container) return;

    const flags = state.featureFlags || {};
    const items = [
      {
        label: "Rewards",
        enabled: flags.rewards_enabled !== false,
      },
      {
        label: "Referrals",
        enabled: flags.referrals_enabled !== false,
      },
      {
        label: "Support",
        enabled: flags.support_enabled !== false,
      },
      {
        label: "Benefits",
        enabled: flags.benefits_enabled !== false,
      },
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
                          ${escapeHtml(benefit.badge || (benefit.unlocked ? "Unlocked" : "Locked"))}
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
        status: onboarding.profile_completed || onboarding.profileCompleted ? "complete" : "pending",
        description: "Complete your core profile details to improve eligibility and personalization.",
      },
      {
        title: "Email Verification",
        status: onboarding.email_verified || onboarding.emailVerified ? "complete" : "pending",
        description: "Verify your email to secure your account and complete onboarding.",
      },
      {
        title: "Rewards Activation",
        status: onboarding.rewards_activated || onboarding.rewardsActivated ? "complete" : "pending",
        description: "Activate the rewards profile so earnings and member incentives can track properly.",
      },
      {
        title: "Company Building Release",
        status:
          Number(
            rewardAccount.company_building_released ||
              rewardAccount.companyBuildingReleased ||
              0
          ) > 0
            ? "complete"
            : "pending",
        description: "Complete paid membership cycles to release company-building earnings.",
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
    setText(
      "accountOnboarding",
      `${formatCount(onboarding.onboarding_percent || onboarding.onboardingPercent || 0)}%`
    );
    setText(
      "accountCompanyPending",
      formatMoney(
        rewardAccount.company_building_pending ||
          rewardAccount.companyBuildingPending ||
          0
      )
    );
    setText(
      "accountCompanyReleased",
      formatMoney(
        rewardAccount.company_building_released ||
          rewardAccount.companyBuildingReleased ||
          0
      )
    );
    setText(
      "accountTotalEarned",
      formatMoney(
        rewardAccount.total_rewards_earned ||
          rewardAccount.totalRewardsEarned ||
          0
      )
    );
    setText(
      "accountTotalPaid",
      formatMoney(
        rewardAccount.total_rewards_paid ||
          rewardAccount.totalRewardsPaid ||
          0
      )
    );
  }

  function bindCategoryEvents() {
    const container = $("benefitCategoryTabs");
    if (!container) return;

    container.querySelectorAll("[data-benefit-category]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeCategory = button.getAttribute("data-benefit-category") || "all";
        renderCategoryTabs();
        renderBenefits();
      });
    });
  }

  function renderAll() {
    renderHeader();
    renderMetrics();
    renderFeatureFlags();
    renderCategoryTabs();
    renderBenefits();
    renderTimeline();
    renderAccountPanel();
    bindCategoryEvents();
    setText("lastRefresh", formatDate(new Date().toISOString()));
  }

  async function loadBenefits() {
    state.loading = true;

    const result = await api("/api/portal/benefits");
    const data = result?.data || {};

    state.summary = data.summary || null;
    state.featureFlags = data.featureFlags || {};
    state.onboarding = data.onboarding || {};
    state.rewardAccount = data.rewardAccount || {};
    state.benefits = Array.isArray(data.benefits) ? data.benefits : [];
    state.groups = Array.isArray(data.groups) ? data.groups : [];

    if (!state.activeCategory) {
      state.activeCategory = "all";
    }

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
      alert(error?.message || "Unable to refresh benefits.");
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

      const container = $("benefitsGrid");
      if (container) {
        container.innerHTML = `
          <div class="detail-empty">
            ${escapeHtml(error?.message || "Unable to load benefits.")}
          </div>
        `;
      }
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