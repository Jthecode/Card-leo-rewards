// assets/js/portal-benefits.js

(() => {
  const state = {
    loading: false,
    initialized: false,
    profile: null,
    summary: null,
    onboarding: null,
    rewardAccount: null,
    featureFlags: null,
    benefits: [],
    groups: [],
    filters: {
      category: "all",
      status: "all",
      search: "",
    },
  };

  const selectors = {
    loading: '[data-benefits-loading]',
    error: '[data-benefits-error]',
    errorMessage: '[data-benefits-error-message]',
    empty: '[data-benefits-empty]',
    featured: '[data-benefits-featured]',
    groups: '[data-benefits-groups]',
    refresh: '[data-benefits-refresh]',
    search: '[data-benefits-search]',
    filterCategory: '[data-benefits-filter-category]',
    filterStatus: '[data-benefits-filter-status]',
    statsBenefits: '[data-benefits-total]',
    statsUnlocked: '[data-benefits-unlocked]',
    statsLocked: '[data-benefits-locked]',
    memberName: '[data-benefits-member-name]',
    memberEmail: '[data-benefits-member-email]',
    memberTier: '[data-benefits-member-tier]',
    memberStatus: '[data-benefits-member-status]',
    nextTier: '[data-benefits-next-tier]',
    pointsAvailable: '[data-benefits-points-available]',
    pointsPending: '[data-benefits-points-pending]',
    onboardingPercent: '[data-benefits-onboarding-percent]',
    filterSummary: '[data-benefits-filter-summary]',
    lastUpdated: '[data-benefits-last-updated]',
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
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
    return Number.isFinite(num) ? num.toLocaleString() : "0";
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

  function normalizeString(value) {
    return String(value || "").trim().toLowerCase();
  }

  function setText(selector, value) {
    const el = $(selector);
    if (el) el.textContent = value ?? "";
  }

  function show(selector, visible) {
    $all(selector).forEach((el) => {
      el.hidden = !visible;
      el.style.display = visible ? "" : "none";
    });
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    show(selectors.loading, isLoading);

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

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: "GET",
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
      const error = new Error(body?.message || `Request failed with status ${response.status}`);
      error.status = response.status;
      error.payload = body;
      throw error;
    }

    return body;
  }

  async function ensureAuthenticated() {
    try {
      await fetchJson("/api/auth/me");
      return true;
    } catch (error) {
      if (error?.status === 401) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login.html?next=${next}`;
        return false;
      }
      throw error;
    }
  }

  function populateFilterOptions() {
    const categorySelect = $(selectors.filterCategory);
    const statusSelect = $(selectors.filterStatus);

    const categories = Array.from(
      new Set((state.benefits || []).map((item) => normalizeString(item.category)).filter(Boolean))
    ).sort();

    if (categorySelect && !categorySelect.dataset.populated) {
      const existingValue = categorySelect.value || "all";
      categorySelect.innerHTML = [
        `<option value="all">All Categories</option>`,
        ...categories.map(
          (category) =>
            `<option value="${escapeHtml(category)}">${escapeHtml(titleCase(category))}</option>`
        ),
      ].join("");
      categorySelect.value = categories.includes(existingValue) || existingValue === "all" ? existingValue : "all";
      categorySelect.dataset.populated = "true";
    }

    if (statusSelect && !statusSelect.dataset.populated) {
      const existingValue = statusSelect.value || "all";
      statusSelect.innerHTML = `
        <option value="all">All Statuses</option>
        <option value="unlocked">Unlocked</option>
        <option value="locked">Locked</option>
        <option value="featured">Featured</option>
      `;
      statusSelect.value = ["all", "unlocked", "locked", "featured"].includes(existingValue)
        ? existingValue
        : "all";
      statusSelect.dataset.populated = "true";
    }
  }

  function applyFilters(benefits) {
    const category = normalizeString(state.filters.category || "all");
    const status = normalizeString(state.filters.status || "all");
    const search = normalizeString(state.filters.search || "");

    return (benefits || []).filter((benefit) => {
      if (category !== "all" && normalizeString(benefit.category) !== category) {
        return false;
      }

      if (status === "unlocked" && !benefit.unlocked) {
        return false;
      }

      if (status === "locked" && !benefit.locked) {
        return false;
      }

      if (status === "featured" && !benefit.featured) {
        return false;
      }

      if (search) {
        const haystack = [
          benefit.title,
          benefit.description,
          benefit.category,
          benefit.badge,
          benefit.requiredTier,
          benefit.lockedReason,
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
    const filtered = applyFilters(state.benefits);

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

  function renderSummary() {
    const summary = state.summary || {};
    const rewardAccount = state.rewardAccount || {};
    const onboarding = state.onboarding || {};

    setText(selectors.memberName, summary.memberName || "Member");
    setText(selectors.memberEmail, summary.email || "—");
    setText(selectors.memberTier, summary.tierLabel || "Core");
    setText(selectors.memberStatus, titleCase(summary.memberStatus || "pending"));
    setText(selectors.nextTier, summary.nextTierLabel || "Top Tier");
    setText(selectors.pointsAvailable, formatNumber(rewardAccount.points_available));
    setText(selectors.pointsPending, formatNumber(rewardAccount.points_pending));
    setText(selectors.onboardingPercent, formatPercent(onboarding.onboarding_percent));
    setText(selectors.statsBenefits, formatNumber(summary?.totals?.benefits || 0));
    setText(selectors.statsUnlocked, formatNumber(summary?.totals?.unlocked || 0));
    setText(selectors.statsLocked, formatNumber(summary?.totals?.locked || 0));
    setText(selectors.lastUpdated, formatDate(new Date().toISOString()));
  }

  function getToneClass(benefit) {
    if (benefit.locked) return "is-locked";
    if (benefit.featured) return "is-featured";
    return "is-unlocked";
  }

  function renderBenefitCard(benefit) {
    const toneClass = getToneClass(benefit);
    const badge = benefit.badge ? `<span class="benefit-badge">${escapeHtml(benefit.badge)}</span>` : "";
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
      `${formatNumber(filteredItems.length)} shown • ${formatNumber(unlocked)} unlocked • ${formatNumber(
        locked
      )} locked`
    );
  }

  function renderAll() {
    renderSummary();

    const groups = buildFilteredGroups();
    renderFeatured(groups);
    renderGroups(groups);
    renderFilterSummary(groups);
  }

  async function loadBenefits() {
    setLoading(true);
    setError("");
    setEmpty(false);

    try {
      const authOkay = await ensureAuthenticated();
      if (!authOkay) return;

      const response = await fetchJson("/api/portal/benefits");
      const data = response?.data || {};

      state.summary = data.summary || null;
      state.onboarding = data.onboarding || null;
      state.rewardAccount = data.rewardAccount || null;
      state.featureFlags = data.featureFlags || null;
      state.benefits = Array.isArray(data.benefits) ? data.benefits : [];
      state.groups = Array.isArray(data.groups) ? data.groups : [];

      populateFilterOptions();
      renderAll();
    } catch (error) {
      console.error("[portal-benefits] load error:", error);
      setError(error?.message || "Unable to load benefits right now.");
    } finally {
      setLoading(false);
    }
  }

  function bindControls() {
    const searchInput = $(selectors.search);
    const categorySelect = $(selectors.filterCategory);
    const statusSelect = $(selectors.filterStatus);

    $all(selectors.refresh).forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        loadBenefits();
      });
    });

    if (searchInput) {
      let timeoutId = null;

      searchInput.addEventListener("input", (event) => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => {
          state.filters.search = event.target.value || "";
          renderAll();
        }, 180);
      });
    }

    if (categorySelect) {
      categorySelect.addEventListener("change", (event) => {
        state.filters.category = event.target.value || "all";
        renderAll();
      });
    }

    if (statusSelect) {
      statusSelect.addEventListener("change", (event) => {
        state.filters.status = event.target.value || "all";
        renderAll();
      });
    }
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
    await loadBenefits();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();