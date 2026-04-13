// assets/js/admin-members.js

(() => {
  const state = {
    admin: null,
    filters: {
      status: "all",
      tier: "all",
      role: "all",
      sort: "newest",
      search: "",
      limit: 20,
      page: 1,
    },
    options: {
      statuses: [],
      tiers: [],
      roles: [],
      sorts: [],
    },
    pagination: null,
    summary: null,
    members: [],
    selectedMemberId: null,
  };

  const SORT_LABELS = {
    newest: "Newest",
    oldest: "Oldest",
    name: "Name",
    status: "Status",
    tier: "Tier",
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

  function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString() : "0";
  }

  function formatPoints(value) {
    return `${formatCount(value)} pts`;
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

  function buildQuery() {
    const params = new URLSearchParams();
    params.set("status", state.filters.status);
    params.set("tier", state.filters.tier);
    params.set("role", state.filters.role);
    params.set("sort", state.filters.sort);
    params.set("search", state.filters.search);
    params.set("limit", String(state.filters.limit));
    params.set("page", String(state.filters.page));
    return params.toString();
  }

  function getStatusClass(status) {
    const normalized = String(status || "").toLowerCase();

    if (normalized === "active") return "status-active";
    if (normalized === "pending") return "status-pending";
    if (normalized === "closed") return "status-closed";
    if (normalized === "paused" || normalized === "suspended") {
      return "status-paused";
    }

    return "status-pending";
  }

  function getTierClass(tier) {
    const normalized = String(tier || "").toLowerCase();

    if (normalized === "vip") return "tier-vip";
    if (normalized === "gold") return "tier-gold";
    if (normalized === "platinum") return "tier-platinum";

    return "";
  }

  function renderHeader() {
    if (!state.admin) return;

    setText("adminName", state.admin.fullName || state.admin.email || "Admin");
    setText(
      "adminAccess",
      state.admin.isSuperAdmin ? "Super Admin" : "Members Admin"
    );
    setText("lastRefresh", formatDate(new Date().toISOString()));
  }

  function renderFilters() {
    const statusFilter = $("statusFilter");
    const tierFilter = $("tierFilter");
    const roleFilter = $("roleFilter");
    const sortFilter = $("sortFilter");

    if (statusFilter && !statusFilter.dataset.ready) {
      statusFilter.innerHTML = (state.options.statuses || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              value === "all" ? "All Statuses" : titleCase(value)
            )}</option>`
        )
        .join("");
      statusFilter.dataset.ready = "true";
    }

    if (tierFilter && !tierFilter.dataset.ready) {
      tierFilter.innerHTML = (state.options.tiers || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              value === "all" ? "All Tiers" : titleCase(value)
            )}</option>`
        )
        .join("");
      tierFilter.dataset.ready = "true";
    }

    if (roleFilter && !roleFilter.dataset.ready) {
      roleFilter.innerHTML = (state.options.roles || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              value === "all" ? "All Roles" : titleCase(value)
            )}</option>`
        )
        .join("");
      roleFilter.dataset.ready = "true";
    }

    if (sortFilter && !sortFilter.dataset.ready) {
      sortFilter.innerHTML = (state.options.sorts || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              SORT_LABELS[value] || titleCase(value)
            )}</option>`
        )
        .join("");
      sortFilter.dataset.ready = "true";
    }

    if (statusFilter) statusFilter.value = state.filters.status;
    if (tierFilter) tierFilter.value = state.filters.tier;
    if (roleFilter) roleFilter.value = state.filters.role;
    if (sortFilter) sortFilter.value = state.filters.sort;
    if ($("limitFilter")) $("limitFilter").value = String(state.filters.limit);
    if ($("searchInput")) $("searchInput").value = state.filters.search;
    if ($("pageIndicator")) $("pageIndicator").value = String(state.filters.page);
  }

  function renderSummary() {
    const summary = state.summary || {};
    const vipCount = (state.members || []).filter(
      (member) => String(member.tier || "").toLowerCase() === "vip"
    ).length;

    setText("valueTotal", formatCount(summary.total || 0));
    setText("valueActive", formatCount(summary.activeMembers || 0));
    setText("valuePending", formatCount(summary.statusCounts?.pending || 0));
    setText("valueVip", formatCount(vipCount));
    setText("valueAdmins", formatCount(summary.adminOperators || 0));
    setText("valueSupport", formatCount(summary.supportOperators || 0));

    [
      "cardTotal",
      "cardActive",
      "cardPending",
      "cardVip",
      "cardAdmins",
      "cardSupport",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.classList.remove("loading");
    });
  }

  function renderTable() {
    const body = $("membersTableBody");
    if (!body) return;

    if (!state.members.length) {
      body.innerHTML = `
        <tr>
          <td colspan="8" class="muted">No members matched your filters.</td>
        </tr>
      `;
      return;
    }

    body.innerHTML = state.members
      .map((item) => {
        const isActive = item.id === state.selectedMemberId;
        const onboardingPercent = Number(item.metrics?.onboardingPercent || 0);
        const pointsAvailable = Number(item.metrics?.pointsAvailable || 0);
        const openSupport = Number(item.metrics?.openSupportTickets || 0);

        return `
          <tr data-member-id="${escapeHtml(item.id)}" class="${isActive ? "active" : ""}">
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.fullName || item.email || "Member")}</div>
                <div class="meta-line">${escapeHtml(item.email || "No email")}</div>
                <div class="meta-line">${escapeHtml(item.phone || "No phone")}</div>
              </div>
            </td>
            <td>
              <span class="status-tag ${getStatusClass(item.memberStatus)}">
                ${escapeHtml(item.memberStatusLabel || titleCase(item.memberStatus))}
              </span>
            </td>
            <td>
              <span class="tier-tag ${getTierClass(item.tier)}">
                ${escapeHtml(item.tierLabel || titleCase(item.tier))}
              </span>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.roleLabel || titleCase(item.role))}</div>
                <div class="meta-line">${item.flags?.isAdminOperator ? "Operator access" : "Standard access"}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${formatCount(onboardingPercent)}%</div>
                <div class="meta-line">${
                  item.onboarding?.onboardingStatus
                    ? escapeHtml(titleCase(item.onboarding.onboardingStatus))
                    : "No onboarding data"
                }</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(formatPoints(pointsAvailable))}</div>
                <div class="meta-line">${escapeHtml(
                  formatPoints(item.metrics?.pointsPending || 0)
                )} pending</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${formatCount(openSupport)}</div>
                <div class="meta-line">${openSupport ? "Open tickets" : "No open tickets"}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(formatDate(item.updatedAt))}</div>
                <div class="meta-line">${escapeHtml(formatDate(item.lastLoginAt))}</div>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function getSelectedMember() {
    return state.members.find((item) => item.id === state.selectedMemberId) || null;
  }

  function renderDetail() {
    const container = $("detailBody");
    if (!container) return;

    const item = getSelectedMember();

    if (!item) {
      container.innerHTML = `
        <div class="detail-empty">
          Select a member from the table to view full detail.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="detail-block">
        <h4>Profile Overview</h4>
        <div class="kv">
          <div class="k">Name</div>
          <div class="v">${escapeHtml(item.fullName || "—")}</div>

          <div class="k">Email</div>
          <div class="v">${escapeHtml(item.email || "—")}</div>

          <div class="k">Phone</div>
          <div class="v">${escapeHtml(item.phone || "—")}</div>

          <div class="k">Status</div>
          <div class="v">
            <span class="status-tag ${getStatusClass(item.memberStatus)}">
              ${escapeHtml(item.memberStatusLabel || titleCase(item.memberStatus))}
            </span>
          </div>

          <div class="k">Tier</div>
          <div class="v">
            <span class="tier-tag ${getTierClass(item.tier)}">
              ${escapeHtml(item.tierLabel || titleCase(item.tier))}
            </span>
          </div>

          <div class="k">Role</div>
          <div class="v">${escapeHtml(item.roleLabel || titleCase(item.role))}</div>

          <div class="k">Referral Code</div>
          <div class="v">${escapeHtml(item.referralCode || "—")}</div>

          <div class="k">Portal Login</div>
          <div class="v">${
            item.portalLoginUrl
              ? `<a href="${escapeHtml(item.portalLoginUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.portalLoginUrl)}</a>`
              : "—"
          }</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Onboarding</h4>
        <div class="kv">
          <div class="k">Progress</div>
          <div class="v">${formatCount(item.metrics?.onboardingPercent || 0)}%</div>

          <div class="k">Status</div>
          <div class="v">${escapeHtml(
            titleCase(item.onboarding?.onboardingStatus || "not_started")
          )}</div>

          <div class="k">Terms Accepted</div>
          <div class="v">${item.onboarding?.acceptedTerms ? "Yes" : "No"}</div>

          <div class="k">Privacy Accepted</div>
          <div class="v">${item.onboarding?.acceptedPrivacy ? "Yes" : "No"}</div>

          <div class="k">Profile Completed</div>
          <div class="v">${item.onboarding?.profileCompleted ? "Yes" : "No"}</div>

          <div class="k">Email Verified</div>
          <div class="v">${item.flags?.hasVerifiedEmail ? "Yes" : "No"}</div>

          <div class="k">Rewards Activated</div>
          <div class="v">${item.onboarding?.rewardsActivated ? "Yes" : "No"}</div>

          <div class="k">First Login Completed</div>
          <div class="v">${item.onboarding?.firstLoginCompleted ? "Yes" : "No"}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Rewards Snapshot</h4>
        <div class="kv">
          <div class="k">Account Status</div>
          <div class="v">${escapeHtml(
            titleCase(item.rewardAccount?.accountStatus || "active")
          )}</div>

          <div class="k">Available</div>
          <div class="v">${escapeHtml(
            formatPoints(item.rewardAccount?.pointsAvailable || 0)
          )}</div>

          <div class="k">Pending</div>
          <div class="v">${escapeHtml(
            formatPoints(item.rewardAccount?.pointsPending || 0)
          )}</div>

          <div class="k">Lifetime Earned</div>
          <div class="v">${escapeHtml(
            formatPoints(item.rewardAccount?.pointsLifetimeEarned || 0)
          )}</div>

          <div class="k">Lifetime Redeemed</div>
          <div class="v">${escapeHtml(
            formatPoints(item.rewardAccount?.pointsLifetimeRedeemed || 0)
          )}</div>

          <div class="k">Lifetime Expired</div>
          <div class="v">${escapeHtml(
            formatPoints(item.rewardAccount?.pointsLifetimeExpired || 0)
          )}</div>

          <div class="k">Last Earned</div>
          <div class="v">${escapeHtml(formatDate(item.rewardAccount?.lastEarnedAt))}</div>

          <div class="k">Last Redeemed</div>
          <div class="v">${escapeHtml(formatDate(item.rewardAccount?.lastRedeemedAt))}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Operational Flags</h4>
        <div class="flag-row">
          <span class="flag">${item.flags?.hasVerifiedEmail ? "Verified Email" : "Email Not Verified"}</span>
          <span class="flag">${item.flags?.hasVerifiedPhone ? "Verified Phone" : "Phone Not Verified"}</span>
          <span class="flag">${item.flags?.hasCompletedOnboarding ? "Onboarding Complete" : "Onboarding Incomplete"}</span>
          <span class="flag">${item.flags?.hasCompletedProfile ? "Profile Complete" : "Profile Incomplete"}</span>
          <span class="flag">${item.flags?.hasRewardsActivated ? "Rewards Active" : "Rewards Pending"}</span>
          <span class="flag">${item.flags?.hasPortalLoginUrl ? "Portal Ready" : "Portal Link Missing"}</span>
          <span class="flag">${item.flags?.isAdminOperator ? "Operator Profile" : "Member Profile"}</span>
          <span class="flag">${item.flags?.hasOpenSupportTickets ? "Open Support Ticket" : "No Open Support Tickets"}</span>
        </div>
      </div>

      <div class="detail-block">
        <h4>Linked Records</h4>
        <div class="kv">
          <div class="k">Signup Source</div>
          <div class="v">${escapeHtml(item.signup?.sourceLabel || "—")}</div>

          <div class="k">Signup Status</div>
          <div class="v">${escapeHtml(item.signup?.statusLabel || "—")}</div>

          <div class="k">Signup Page</div>
          <div class="v">${escapeHtml(item.signup?.signupPage || "—")}</div>

          <div class="k">Open Support Tickets</div>
          <div class="v">${formatCount(item.metrics?.openSupportTickets || 0)}</div>

          <div class="k">Internal Note Count</div>
          <div class="v">${formatCount(item.metrics?.noteCount || 0)}</div>

          <div class="k">Last Login</div>
          <div class="v">${escapeHtml(formatDate(item.lastLoginAt))}</div>

          <div class="k">Created</div>
          <div class="v">${escapeHtml(formatDate(item.createdAt))}</div>

          <div class="k">Updated</div>
          <div class="v">${escapeHtml(formatDate(item.updatedAt))}</div>
        </div>
      </div>
    `;
  }

  function renderMeta() {
    const pagination = state.pagination || {};

    setText(
      "tableMeta",
      `${formatCount(pagination.total || 0)} members • page ${formatCount(
        pagination.page || 1
      )} of ${formatCount(pagination.totalPages || 1)}`
    );

    setText(
      "paginationMeta",
      pagination.total
        ? `Showing ${formatCount(pagination.from)}–${formatCount(
            pagination.to
          )} of ${formatCount(pagination.total)} members`
        : "No members to show"
    );

    if ($("pageIndicator")) {
      $("pageIndicator").value = String(
        pagination.page || state.filters.page || 1
      );
    }

    if ($("prevPageBtn")) $("prevPageBtn").disabled = !pagination.hasPreviousPage;
    if ($("nextPageBtn")) $("nextPageBtn").disabled = !pagination.hasNextPage;
  }

  function renderAll() {
    renderHeader();
    renderFilters();
    renderSummary();
    renderTable();
    renderDetail();
    renderMeta();
  }

  async function loadMembers() {
    try {
      const me = await api("/api/auth/me");
      state.admin = me?.data?.user || null;
    } catch (error) {
      if (error?.status === 401) {
        const next = encodeURIComponent("/admin/members.html");
        window.location.href = `/login.html?next=${next}`;
        return;
      }
      throw error;
    }

    const result = await api(`/api/admin/members?${buildQuery()}`);

    state.options.statuses = result?.data?.filters?.statuses || [];
    state.options.tiers = result?.data?.filters?.tiers || [];
    state.options.roles = result?.data?.filters?.roles || [];
    state.options.sorts = result?.data?.filters?.sorts || [];
    state.summary = result?.data?.summary || null;
    state.pagination = result?.data?.pagination || null;
    state.members = result?.data?.members || [];
    state.admin = result?.data?.admin || state.admin;

    if (!state.selectedMemberId && state.members.length) {
      state.selectedMemberId = state.members[0].id;
    }

    if (
      state.selectedMemberId &&
      !state.members.some((item) => item.id === state.selectedMemberId)
    ) {
      state.selectedMemberId = state.members.length ? state.members[0].id : null;
    }

    renderAll();
  }

  async function handleLogout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // no-op
    } finally {
      window.location.href = "/login.html";
    }
  }

  function clearFilters() {
    state.filters = {
      status: "all",
      tier: "all",
      role: "all",
      sort: "newest",
      search: "",
      limit: 20,
      page: 1,
    };

    renderFilters();
    loadMembers();
  }

  function bindEvents() {
    $("refreshBtn")?.addEventListener("click", loadMembers);
    $("logoutBtn")?.addEventListener("click", handleLogout);

    $("applyFiltersBtn")?.addEventListener("click", () => {
      state.filters.search = $("searchInput")?.value.trim() || "";
      state.filters.status = $("statusFilter")?.value || "all";
      state.filters.tier = $("tierFilter")?.value || "all";
      state.filters.role = $("roleFilter")?.value || "all";
      state.filters.sort = $("sortFilter")?.value || "newest";
      state.filters.limit = Number($("limitFilter")?.value || 20);
      state.filters.page = 1;
      loadMembers();
    });

    $("clearFiltersBtn")?.addEventListener("click", clearFilters);

    $("prevPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasPreviousPage) return;
      state.filters.page = Math.max(1, Number(state.filters.page || 1) - 1);
      loadMembers();
    });

    $("nextPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasNextPage) return;
      state.filters.page = Number(state.filters.page || 1) + 1;
      loadMembers();
    });

    $("membersTableBody")?.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-member-id]");
      if (!row) return;

      state.selectedMemberId = row.getAttribute("data-member-id");
      renderTable();
      renderDetail();
    });
  }

  async function init() {
    bindEvents();

    try {
      await loadMembers();
    } catch (error) {
      if (error?.status === 403) {
        window.location.href = "/unauthorized.html";
        return;
      }

      const table = $("membersTableBody");
      if (table) {
        table.innerHTML = `
          <tr>
            <td colspan="8" class="muted">${escapeHtml(
              error?.message || "Unable to load members."
            )}</td>
          </tr>
        `;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();