// assets/js/admin-support.js

(() => {
  const state = {
    admin: null,
    filters: {
      status: "all",
      priority: "all",
      category: "all",
      assigned: "all",
      sort: "updated",
      search: "",
      limit: 20,
      page: 1,
    },
    options: {
      statuses: [],
      priorities: [],
      categories: [],
      assignedOptions: [],
      sorts: [],
    },
    pagination: null,
    summary: null,
    tickets: [],
    selectedTicketId: null,
  };

  const SORT_LABELS = {
    newest: "Newest",
    oldest: "Oldest",
    updated: "Recently Updated",
    priority: "Priority",
    status: "Status",
  };

  const ASSIGNED_LABELS = {
    all: "All Tickets",
    assigned: "Assigned",
    unassigned: "Unassigned",
    mine: "Assigned To Me",
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
    params.set("priority", state.filters.priority);
    params.set("category", state.filters.category);
    params.set("assigned", state.filters.assigned);
    params.set("sort", state.filters.sort);
    params.set("search", state.filters.search);
    params.set("limit", String(state.filters.limit));
    params.set("page", String(state.filters.page));
    return params.toString();
  }

  function getStatusClass(status) {
    const normalized = String(status || "").toLowerCase();
    return `status-${normalized}`;
  }

  function getPriorityClass(priority) {
    const normalized = String(priority || "").toLowerCase();
    return `priority-${normalized}`;
  }

  function renderHeader() {
    if (!state.admin) return;

    setText("adminName", state.admin.fullName || state.admin.email || "Admin");
    setText(
      "adminAccess",
      state.admin.isSuperAdmin ? "Super Admin" : "Support Admin"
    );
    setText("lastRefresh", formatDate(new Date().toISOString()));
  }

  function renderFilters() {
    const statusFilter = $("statusFilter");
    const priorityFilter = $("priorityFilter");
    const categoryFilter = $("categoryFilter");
    const assignedFilter = $("assignedFilter");
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

    if (priorityFilter && !priorityFilter.dataset.ready) {
      priorityFilter.innerHTML = (state.options.priorities || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              value === "all" ? "All Priorities" : titleCase(value)
            )}</option>`
        )
        .join("");
      priorityFilter.dataset.ready = "true";
    }

    if (categoryFilter && !categoryFilter.dataset.ready) {
      categoryFilter.innerHTML = (state.options.categories || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              value === "all" ? "All Categories" : titleCase(value)
            )}</option>`
        )
        .join("");
      categoryFilter.dataset.ready = "true";
    }

    if (assignedFilter && !assignedFilter.dataset.ready) {
      assignedFilter.innerHTML = (state.options.assignedOptions || [])
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}">${escapeHtml(
              ASSIGNED_LABELS[value] || titleCase(value)
            )}</option>`
        )
        .join("");
      assignedFilter.dataset.ready = "true";
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
    if (priorityFilter) priorityFilter.value = state.filters.priority;
    if (categoryFilter) categoryFilter.value = state.filters.category;
    if (assignedFilter) assignedFilter.value = state.filters.assigned;
    if (sortFilter) sortFilter.value = state.filters.sort;
    if ($("limitFilter")) $("limitFilter").value = String(state.filters.limit);
    if ($("searchInput")) $("searchInput").value = state.filters.search;
    if ($("pageIndicator")) $("pageIndicator").value = String(state.filters.page);
  }

  function renderSummary() {
    const summary = state.summary || {};

    setText("valueTotal", formatCount(summary.total || 0));
    setText("valueOpen", formatCount(summary.open || 0));
    setText("valueProgress", formatCount(summary.inProgress || 0));
    setText("valueWaiting", formatCount(summary.waitingOnMember || 0));
    setText("valueUrgent", formatCount(summary.urgent || 0));
    setText(
      "valueResolved",
      formatCount((summary.resolved || 0) + (summary.closed || 0))
    );

    [
      "cardTotal",
      "cardOpen",
      "cardProgress",
      "cardWaiting",
      "cardUrgent",
      "cardResolved",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.classList.remove("loading");
    });
  }

  function renderTable() {
    const body = $("ticketsTableBody");
    if (!body) return;

    if (!state.tickets.length) {
      body.innerHTML = `
        <tr>
          <td colspan="8" class="muted">No tickets matched your filters.</td>
        </tr>
      `;
      return;
    }

    body.innerHTML = state.tickets
      .map((item) => {
        const isActive = item.id === state.selectedTicketId;

        return `
          <tr data-ticket-id="${escapeHtml(item.id)}" class="${isActive ? "active" : ""}">
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.subject || item.ticketNumber || "Ticket")}</div>
                <div class="meta-line">${escapeHtml(item.ticketNumber || "No ticket number")}</div>
                <div class="meta-line">${escapeHtml(item.sourceLabel || "Portal")}</div>
              </div>
            </td>
            <td>
              <span class="status-tag ${getStatusClass(item.status)}">
                ${escapeHtml(item.statusLabel || titleCase(item.status))}
              </span>
            </td>
            <td>
              <span class="priority-tag ${getPriorityClass(item.priority)}">
                ${escapeHtml(item.priorityLabel || titleCase(item.priority))}
              </span>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.categoryLabel || titleCase(item.category))}</div>
                <div class="meta-line">${escapeHtml(item.sourceLabel || "Portal")}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.member?.fullName || item.contactMessage?.name || "Unknown")}</div>
                <div class="meta-line">${escapeHtml(item.member?.email || item.contactMessage?.email || "No email")}</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(item.assignee?.fullName || "Unassigned")}</div>
                <div class="meta-line">
                  <span class="assign-tag ${item.flags?.isAssigned ? "assigned" : "unassigned"}">
                    ${item.flags?.isAssigned ? "Assigned" : "Unassigned"}
                  </span>
                </div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${formatCount(item.counts?.messageCount || 0)}</div>
                <div class="meta-line">${formatCount(item.counts?.internalNoteCount || 0)} internal notes</div>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <div class="name-title">${escapeHtml(formatDate(item.lastMessageAt || item.updatedAt || item.createdAt))}</div>
                <div class="meta-line">${escapeHtml(formatDate(item.firstResponseAt))}</div>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function getSelectedTicket() {
    return state.tickets.find((item) => item.id === state.selectedTicketId) || null;
  }

  function renderDetail() {
    const container = $("detailBody");
    if (!container) return;

    const item = getSelectedTicket();

    if (!item) {
      container.innerHTML = `
        <div class="detail-empty">
          Select a ticket from the table to view full detail.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="detail-block">
        <h4>Ticket Overview</h4>
        <div class="kv">
          <div class="k">Ticket</div>
          <div class="v">${escapeHtml(item.ticketNumber || "—")}</div>

          <div class="k">Subject</div>
          <div class="v">${escapeHtml(item.subject || "—")}</div>

          <div class="k">Status</div>
          <div class="v">
            <span class="status-tag ${getStatusClass(item.status)}">
              ${escapeHtml(item.statusLabel || titleCase(item.status))}
            </span>
          </div>

          <div class="k">Priority</div>
          <div class="v">
            <span class="priority-tag ${getPriorityClass(item.priority)}">
              ${escapeHtml(item.priorityLabel || titleCase(item.priority))}
            </span>
          </div>

          <div class="k">Category</div>
          <div class="v">${escapeHtml(item.categoryLabel || titleCase(item.category))}</div>

          <div class="k">Source</div>
          <div class="v">${escapeHtml(item.sourceLabel || "Portal")}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Member + Contact Context</h4>
        <div class="kv">
          <div class="k">Member</div>
          <div class="v">${escapeHtml(item.member?.fullName || "—")}</div>

          <div class="k">Member Email</div>
          <div class="v">${escapeHtml(item.member?.email || item.contactMessage?.email || "—")}</div>

          <div class="k">Member Tier</div>
          <div class="v">${escapeHtml(item.member?.tier ? titleCase(item.member.tier) : "—")}</div>

          <div class="k">Member Status</div>
          <div class="v">${escapeHtml(item.member?.memberStatus ? titleCase(item.member.memberStatus) : "—")}</div>

          <div class="k">Contact Name</div>
          <div class="v">${escapeHtml(item.contactMessage?.name || "—")}</div>

          <div class="k">Contact Topic</div>
          <div class="v">${escapeHtml(item.contactMessage?.topic ? titleCase(item.contactMessage.topic) : "—")}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Assignment + Timing</h4>
        <div class="kv">
          <div class="k">Assignee</div>
          <div class="v">${escapeHtml(item.assignee?.fullName || "Unassigned")}</div>

          <div class="k">First Response</div>
          <div class="v">${escapeHtml(formatDate(item.firstResponseAt))}</div>

          <div class="k">Last Message</div>
          <div class="v">${escapeHtml(formatDate(item.lastMessageAt))}</div>

          <div class="k">Resolved At</div>
          <div class="v">${escapeHtml(formatDate(item.resolvedAt))}</div>

          <div class="k">Closed At</div>
          <div class="v">${escapeHtml(formatDate(item.closedAt))}</div>

          <div class="k">Created</div>
          <div class="v">${escapeHtml(formatDate(item.createdAt))}</div>

          <div class="k">Updated</div>
          <div class="v">${escapeHtml(formatDate(item.updatedAt))}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Queue Metrics</h4>
        <div class="kv">
          <div class="k">Messages</div>
          <div class="v">${formatCount(item.counts?.messageCount || 0)}</div>

          <div class="k">Internal Notes</div>
          <div class="v">${formatCount(item.counts?.internalNoteCount || 0)}</div>

          <div class="k">Assigned</div>
          <div class="v">${item.flags?.isAssigned ? "Yes" : "No"}</div>

          <div class="k">Has Member</div>
          <div class="v">${item.flags?.hasMember ? "Yes" : "No"}</div>

          <div class="k">Has Contact Record</div>
          <div class="v">${item.flags?.hasContactMessage ? "Yes" : "No"}</div>

          <div class="k">Has Internal Notes</div>
          <div class="v">${item.flags?.hasInternalNotes ? "Yes" : "No"}</div>
        </div>
      </div>

      <div class="detail-block">
        <h4>Latest Message Preview</h4>
        ${
          item.latestMessage
            ? `
              <div class="message-preview">
                <strong>${escapeHtml(titleCase(item.latestMessage.senderType || "message"))}</strong>
                <div class="meta-line" style="margin-bottom: 10px;">
                  ${escapeHtml(item.latestMessage.senderName || item.latestMessage.senderEmail || "Unknown sender")} •
                  ${escapeHtml(formatDate(item.latestMessage.createdAt))}
                </div>
                <div>${escapeHtml(item.latestMessage.body || "No message body.")}</div>
              </div>
            `
            : `<div class="detail-empty">No message preview is available for this ticket.</div>`
        }
      </div>

      <div class="detail-block">
        <h4>Operational Flags</h4>
        <div class="flag-row">
          <span class="flag">${item.flags?.isAssigned ? "Assigned" : "Unassigned"}</span>
          <span class="flag">${item.flags?.isResolved ? "Resolved" : "Not Resolved"}</span>
          <span class="flag">${item.flags?.isClosed ? "Closed" : "Open Workflow"}</span>
          <span class="flag">${item.flags?.hasMember ? "Member Linked" : "No Member Linked"}</span>
          <span class="flag">${item.flags?.hasContactMessage ? "Contact Message Linked" : "No Contact Record"}</span>
          <span class="flag">${item.flags?.hasInternalNotes ? "Internal Notes Present" : "No Internal Notes"}</span>
        </div>
      </div>
    `;
  }

  function renderMeta() {
    const pagination = state.pagination || {};

    setText(
      "tableMeta",
      `${formatCount(pagination.total || 0)} tickets • page ${formatCount(
        pagination.page || 1
      )} of ${formatCount(pagination.totalPages || 1)}`
    );

    setText(
      "paginationMeta",
      pagination.total
        ? `Showing ${formatCount(pagination.from)}–${formatCount(
            pagination.to
          )} of ${formatCount(pagination.total)} tickets`
        : "No tickets to show"
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

  async function loadTickets() {
    try {
      const me = await api("/api/auth/me");
      state.admin = me?.data?.user || null;
    } catch (error) {
      if (error?.status === 401) {
        const next = encodeURIComponent("/admin/support.html");
        window.location.href = `/login.html?next=${next}`;
        return;
      }
      throw error;
    }

    const result = await api(`/api/admin/support?${buildQuery()}`);

    state.options.statuses = result?.data?.filters?.statuses || [];
    state.options.priorities = result?.data?.filters?.priorities || [];
    state.options.categories = result?.data?.filters?.categories || [];
    state.options.assignedOptions = result?.data?.filters?.assignedOptions || [];
    state.options.sorts = result?.data?.filters?.sorts || [];
    state.summary = result?.data?.summary || null;
    state.pagination = result?.data?.pagination || null;
    state.tickets = result?.data?.tickets || [];
    state.admin = result?.data?.admin || state.admin;

    if (!state.selectedTicketId && state.tickets.length) {
      state.selectedTicketId = state.tickets[0].id;
    }

    if (
      state.selectedTicketId &&
      !state.tickets.some((item) => item.id === state.selectedTicketId)
    ) {
      state.selectedTicketId = state.tickets.length ? state.tickets[0].id : null;
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
      priority: "all",
      category: "all",
      assigned: "all",
      sort: "updated",
      search: "",
      limit: 20,
      page: 1,
    };

    renderFilters();
    loadTickets();
  }

  function bindEvents() {
    $("refreshBtn")?.addEventListener("click", loadTickets);
    $("logoutBtn")?.addEventListener("click", handleLogout);

    $("applyFiltersBtn")?.addEventListener("click", () => {
      state.filters.search = $("searchInput")?.value.trim() || "";
      state.filters.status = $("statusFilter")?.value || "all";
      state.filters.priority = $("priorityFilter")?.value || "all";
      state.filters.category = $("categoryFilter")?.value || "all";
      state.filters.assigned = $("assignedFilter")?.value || "all";
      state.filters.sort = $("sortFilter")?.value || "updated";
      state.filters.limit = Number($("limitFilter")?.value || 20);
      state.filters.page = 1;
      loadTickets();
    });

    $("clearFiltersBtn")?.addEventListener("click", clearFilters);

    $("prevPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasPreviousPage) return;
      state.filters.page = Math.max(1, Number(state.filters.page || 1) - 1);
      loadTickets();
    });

    $("nextPageBtn")?.addEventListener("click", () => {
      if (!state.pagination?.hasNextPage) return;
      state.filters.page = Number(state.filters.page || 1) + 1;
      loadTickets();
    });

    $("ticketsTableBody")?.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-ticket-id]");
      if (!row) return;

      state.selectedTicketId = row.getAttribute("data-ticket-id");
      renderTable();
      renderDetail();
    });
  }

  async function init() {
    bindEvents();

    try {
      await loadTickets();
    } catch (error) {
      if (error?.status === 403) {
        window.location.href = "/unauthorized.html";
        return;
      }

      const table = $("ticketsTableBody");
      if (table) {
        table.innerHTML = `
          <tr>
            <td colspan="8" class="muted">${escapeHtml(
              error?.message || "Unable to load support tickets."
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