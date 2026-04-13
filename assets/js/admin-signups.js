// assets/js/admin-signups.js

(() => {
  const state = {
    admin: null,
    filters: {
      status: "all",
      sort: "newest",
      search: "",
      limit: 20,
      page: 1,
    },
    options: {
      statuses: [],
      sorts: [],
    },
    pagination: null,
    summary: null,
    signups: [],
    selectedSignupId: null,
    approveTargetId: null,
    loading: false,
  };

  const SORT_LABELS = {
    newest: "Newest",
    oldest: "Oldest",
    name: "Name",
    status: "Status",
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
    params.set("sort", state.filters.sort);
    params.set("search", state.filters.search);
    params.set("limit", String(state.filters.limit));
    params.set("page", String(state.filters.page));
    return params.toString();
  }

  function getStatusClass(status) {
    const normalized = String(status || "").toLowerCase();

    if (normalized === "rejected") return "status-rejected";
    if (["approved", "invited", "active"].includes(normalized)) {
      return "status-approved";
    }
    if (["new", "reviewing"].includes(normalized)) {
      return "status-new";
    }

    return "status-new";
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
    const sortFilter = $("sortFilter");
    const limitFilter = $("limitFilter");
    const searchInput = $("searchInput");
    const pageIndicator = $("pageIndicator");

    if (statusFilter && !statusFilter.dataset.ready) {
      statusFilter.innerHTML = (state.options.statuses || [])
        .map(
          (status) =>
            `<option value="${escapeHtml(status)}">${escapeHtml(
              status === "all" ? "All Statuses" : titleCase(status)
            )}</option>`
        )
        .join("");
      statusFilter.dataset.ready = "true";
    }

    if (sortFilter && !sortFilter.dataset.ready) {
      sortFilter.innerHTML = (state.options.sorts || [])
        .map(
          (sort) =>
            `<option value="${escapeHtml(sort)}">${escapeHtml(
              SORT_LABELS[sort] || titleCase(sort)
            )}</option>`
        )
        .join("");
      sortFilter.dataset.ready = "true";
    }

    if (statusFilter) statusFilter.value = state.filters.status;
    if (sortFilter) sortFilter.value = state.filters.sort;
    if (limitFilter) limitFilter.value = String(state.filters.limit);
    if (searchInput) searchInput.value = state.filters.search;
    if (pageIndicator) pageIndicator.value = String(state.filters.page);
  }

  function renderSummary() {
    const summary = state.summary || {};
    const statusCounts = summary.statusCounts || {};

    const pending =
      Number(statusCounts.new || 0) + Number(statusCounts.reviewing || 0);

    setText("valuePending", formatCount(pending));
    setText("valueApproved", formatCount(summary.approved || 0));
    setText("valueInvited", formatCount(summary.invited || 0));
    setText("valueActive", formatCount(summary.active || 0));
    setText("valueRejected", formatCount(summary.rejected || 0));
    setText("valueTotal", formatCount(summary.total || 0));

    [
      "cardPending",
      "cardApproved",
      "cardInvited",
      "cardActive",
      "cardRejected",
      "cardTotal",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.classList.remove("loading");
    });
  }

  function renderTable() {
    const body = $("signupsTableBody");
    if (!body) return;

    if (!state.signups.length) {
      body.innerHTML = `
        <tr>
          <td colspan="6" class="muted">No signups matched your filters.</td>
        </tr>
      `;
      return;
    }

    body.innerHTML = state.signups
      .map((item) => {
        const isActive = item.id === state.selectedSignupId;

        return `
          <tr data-signup-id="${escapeHtml(item.id)}" class="${isActive ? "active" : ""}">
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.fullName || item.email || "Signup")}</div>
                <div class="meta-line">${escapeHtml(item.email || "No email")}</div>
                <div class="meta-line">${escapeHtml(item.phone || "No phone")}</div>
              </div>
            </td>
            <td>
              <span class="status-tag ${getStatusClass(item.status)}">
                ${escapeHtml(item.statusLabel || titleCase(item.status))}
              </span>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.sourceLabel || "Website")}</div>
                <div class="meta-line">${escapeHtml(item.signupPage || "No page")}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.interest || "General Interest")}</div>
                <div class="meta-line">${escapeHtml(item.referralName || "No referral name")}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${item.hasPortalUser ? "Linked" : "Not linked"}</div>
                <div class="meta-line">${escapeHtml(item.portalUserId || "No portal user")}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(formatDate(item.createdAt))}</div>
                <div class="meta-line">${escapeHtml(formatDate(item.updatedAt))}</div>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function getSelectedSignup() {
    return state.signups.find((item) => item.id === state.selectedSignupId) || null;
  }

  function renderDetail() {
    const container = $("detailBody");
    if (!container) return;

    const item = getSelectedSignup();

    if (!item) {
      container.innerHTML = `
        <div class="detail-empty">
          Select a signup from the table to view full details.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="detail-block">
        <h4>Lead Overview</h4>
        <div class="kv">
          <div class="k">Name</div>
          <div class="v">${escapeHtml(item.fullName || "—")}</div>

          <div class="k">Email</div>
          <div class="v">${escapeHtml(item.email || "—")}</div>

          <div class="k">Phone</div>
          <div class="v">${escapeHtml(item.phone || "—")}</div>

          <div class="k">Status</div>
          <div class="v">
            <span class="status-tag ${getStatusClass(item.status)}">
              ${escapeHtml(item.statusLabel || titleCase(item.status))}
            </span>
          </div>

          <div class="k">Source</div>
          <div class="v">${escapeHtml(item.sourceLabel || "—")}</div>

          <div class="k">Signup Page</div>
          <div class="v">${escapeHtml(item.signupPage || "—")}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Location + Context</h4>
        <div class="kv">
          <div class="k">City</div>
          <div class="v">${escapeHtml(item.city || "—")}</div>

          <div class="k">State</div>
          <div class="v">${escapeHtml(item.state || "—")}</div>

          <div class="k">Referral Name</div>
          <div class="v">${escapeHtml(item.referralName || "—")}</div>

          <div class="k">Interest</div>
          <div class="v">${escapeHtml(item.interest || "—")}</div>

          <div class="k">Agreed</div>
          <div class="v">${item.agreed ? "Yes" : "No"}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Goals</h4>
        <div class="kv">
          <div class="k">Submitted Goals</div>
          <div class="v">${escapeHtml(item.goals || "No goals were provided.")}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Portal Linkage</h4>
        <div class="kv">
          <div class="k">Portal User</div>
          <div class="v">${escapeHtml(item.portalUserId || "Not linked yet")}</div>

          <div class="k">Login URL</div>
          <div class="v">${
            item.portalLoginUrl
              ? `<a href="${escapeHtml(item.portalLoginUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.portalLoginUrl)}</a>`
              : "—"
          }</div>

          <div class="k">Notes</div>
          <div class="v">${escapeHtml(item.notes || "No signup notes yet.")}</div>

          <div class="k">Admin Notes</div>
          <div class="v">${formatCount(item.noteCount || 0)}</div>
        </div>
      </div>

      <div class="detail-block actions">
        <h4>Actions</h4>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" id="approveSignupBtn">
            Approve Signup
          </button>
          <button class="btn btn-secondary" type="button" id="copyEmailBtn">
            Copy Email
          </button>
          ${
            item.portalLoginUrl
              ? `<a class="btn" href="${escapeHtml(item.portalLoginUrl)}" target="_blank" rel="noreferrer">Open Login</a>`
              : ""
          }
        </div>
      </div>
    `;

    const approveBtn = $("approveSignupBtn");
    if (approveBtn) {
      approveBtn.addEventListener("click", openApproveDrawer);
    }

    const copyBtn = $("copyEmailBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.email || "");
          copyBtn.textContent = "Copied";
          setTimeout(() => {
            copyBtn.textContent = "Copy Email";
          }, 1200);
        } catch {
          // no-op
        }
      });
    }
  }

  function renderMeta() {
    const pagination = state.pagination || {};

    setText(
      "tableMeta",
      `${formatCount(pagination.total || 0)} signups • page ${formatCount(
        pagination.page || 1
      )} of ${formatCount(pagination.totalPages || 1)}`
    );

    setText(
      "paginationMeta",
      pagination.total
        ? `Showing ${formatCount(pagination.from)}–${formatCount(
            pagination.to
          )} of ${formatCount(pagination.total)} signups`
        : "No signups to show"
    );

    if ($("pageIndicator")) {
      $("pageIndicator").value = String(
        pagination.page || state.filters.page || 1
      );
    }

    if ($("prevPageBtn")) {
      $("prevPageBtn").disabled = !pagination.hasPreviousPage;
    }

    if ($("nextPageBtn")) {
      $("nextPageBtn").disabled = !pagination.hasNextPage;
    }
  }

  function renderAll() {
    renderHeader();
    renderFilters();
    renderSummary();
    renderTable();
    renderDetail();
    renderMeta();
  }

  async function loadSignups() {
    state.loading = true;

    try {
      const me = await api("/api/auth/me");
      state.admin = me?.data?.user || null;
    } catch (error) {
      if (error?.status === 401) {
        const next = encodeURIComponent("/admin/signups.html");
        window.location.href = `/login.html?next=${next}`;
        return;
      }
      throw error;
    }

    const result = await api(`/api/admin/signups?${buildQuery()}`);

    state.options.statuses = result?.data?.filters?.statuses || [];
    state.options.sorts = result?.data?.filters?.sorts || [];
    state.summary = result?.data?.summary || null;
    state.pagination = result?.data?.pagination || null;
    state.signups = result?.data?.signups || [];
    state.admin = result?.data?.admin || state.admin;

    if (!state.selectedSignupId && state.signups.length) {
      state.selectedSignupId = state.signups[0].id;
    }

    if (
      state.selectedSignupId &&
      !state.signups.some((item) => item.id === state.selectedSignupId)
    ) {
      state.selectedSignupId = state.signups.length ? state.signups[0].id : null;
    }

    renderAll();
  }

  function openApproveDrawer() {
    const selected = getSelectedSignup();
    if (!selected) return;

    state.approveTargetId = selected.id;

    const drawer = $("approveDrawer");
    const meta = $("approveDrawerMeta");
    const approvalNote = $("approvalNote");
    const adminNote = $("adminNote");
    const redirectTo = $("redirectTo");
    const approvalStatus = $("approvalStatus");
    const sendInviteCheckbox = $("sendInviteCheckbox");
    const awardWelcomeBonusCheckbox = $("awardWelcomeBonusCheckbox");

    if (meta) {
      meta.textContent = `Approving ${selected.fullName || selected.email || "this signup"}.`;
    }

    if (approvalNote) approvalNote.value = "";
    if (adminNote) adminNote.value = "";
    if (redirectTo) redirectTo.value = "";
    if (approvalStatus) approvalStatus.value = "invited";
    if (sendInviteCheckbox) sendInviteCheckbox.checked = true;
    if (awardWelcomeBonusCheckbox) awardWelcomeBonusCheckbox.checked = true;

    if (drawer) {
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }
  }

  function closeApproveDrawer() {
    state.approveTargetId = null;
    const drawer = $("approveDrawer");
    if (drawer) {
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
    }
  }

  async function submitApproval() {
    if (!state.approveTargetId) return;

    const confirmBtn = $("confirmApproveBtn");
    const originalText = confirmBtn ? confirmBtn.textContent : "Confirm Approval";

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Approving...";
    }

    try {
      const payload = {
        signupId: state.approveTargetId,
        status: $("approvalStatus")?.value || "invited",
        approvalNote: $("approvalNote")?.value || "",
        adminNote: $("adminNote")?.value || "",
        redirectTo: $("redirectTo")?.value || "",
        sendInvite: Boolean($("sendInviteCheckbox")?.checked),
        awardWelcomeBonus: Boolean($("awardWelcomeBonusCheckbox")?.checked),
      };

      const result = await api("/api/admin/approve-signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      closeApproveDrawer();
      await loadSignups();
      alert(result?.message || "Signup approved successfully.");
    } catch (error) {
      alert(error?.message || "Unable to approve signup.");
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
      }
    }
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

  function bindEvents() {
    $("refreshBtn")?.addEventListener("click", loadSignups);

    $("logoutBtn")?.addEventListener("click", handleLogout);

    $("applyFiltersBtn")?.addEventListener("click", () => {
      state.filters.search = $("searchInput")?.value.trim() || "";
      state.filters.status = $("statusFilter")?.value || "all";
      state.filters.sort = $("sortFilter")?.value || "newest";
      state.filters.limit = Number($("limitFilter")?.value || 20);
      state.filters.page = 1;
      loadSignups();
    });

    $("prevPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasPreviousPage) return;
      state.filters.page = Math.max(1, Number(state.filters.page || 1) - 1);
      loadSignups();
    });

    $("nextPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasNextPage) return;
      state.filters.page = Number(state.filters.page || 1) + 1;
      loadSignups();
    });

    $("signupsTableBody")?.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-signup-id]");
      if (!row) return;

      state.selectedSignupId = row.getAttribute("data-signup-id");
      renderTable();
      renderDetail();
    });

    $("closeDrawerBtn")?.addEventListener("click", closeApproveDrawer);
    $("cancelApproveBtn")?.addEventListener("click", closeApproveDrawer);
    $("confirmApproveBtn")?.addEventListener("click", submitApproval);

    $("approveDrawer")?.addEventListener("click", (event) => {
      if (event.target === $("approveDrawer")) {
        closeApproveDrawer();
      }
    });

    $("approvalStatus")?.addEventListener("change", (event) => {
      const value = event.target.value;
      const sendInviteCheckbox = $("sendInviteCheckbox");
      if (!sendInviteCheckbox) return;

      if (value === "approved") {
        sendInviteCheckbox.checked = false;
      } else if (value === "invited") {
        sendInviteCheckbox.checked = true;
      }
    });
  }

  async function init() {
    bindEvents();

    try {
      await loadSignups();
    } catch (error) {
      if (error?.status === 403) {
        window.location.href = "/unauthorized.html";
        return;
      }

      const table = $("signupsTableBody");
      if (table) {
        table.innerHTML = `
          <tr>
            <td colspan="6" class="muted">${escapeHtml(
              error?.message || "Unable to load signups."
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