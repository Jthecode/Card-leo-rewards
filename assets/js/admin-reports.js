// assets/js/admin-reports.js

(() => {
  const API = {
    reports: "/api/admin/reports",
    logout: "/api/auth/logout",
  };

  const CONFIG = {
    referralRewardAmount: 7,
    activationFee: 25,
    monthlyFee: 20,
    billingDay: 10,
    payoutWindow: "1st–3rd monthly",
  };

  const els = {
    statusBanner: document.getElementById("statusBanner"),
    logoutButton: document.getElementById("logoutButton"),

    refreshButton: document.getElementById("refreshButton"),
    exportButton: document.getElementById("exportButton"),
    applyFiltersButton: document.getElementById("applyFiltersButton"),

    searchInput: document.getElementById("searchInput"),
    reportType: document.getElementById("reportType"),
    statusFilter: document.getElementById("statusFilter"),

    reportStatusBadge: document.getElementById("reportStatusBadge"),

    dailySignups: document.getElementById("dailySignups"),
    paidMembers: document.getElementById("paidMembers"),
    deniedMembers: document.getElementById("deniedMembers"),
    monthlyRewards: document.getElementById("monthlyRewards"),

    totalSignups: document.getElementById("totalSignups"),
    activePaidMembers: document.getElementById("activePaidMembers"),
    paymentPending: document.getElementById("paymentPending"),
    approvedReferrals: document.getElementById("approvedReferrals"),
    pendingReferrals: document.getElementById("pendingReferrals"),
    totalRewardEstimate: document.getElementById("totalRewardEstimate"),

    reportsTableBody: document.getElementById("reportsTableBody"),

    cardSubtitle: document.getElementById("cardSubtitle"),
    cardStatus: document.getElementById("cardStatus"),
    cardRange: document.getElementById("cardRange"),
  };

  let rows = [];
  let summary = {};

  function money(value) {
    const number = Number(value || 0);

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number.isFinite(number) ? number : 0);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function unwrap(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
  }

  function currentMonth() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function redirectToLogin() {
    window.location.href =
      "/login.html?next=" +
      encodeURIComponent(window.location.pathname + window.location.search);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      redirectToLogin();
      return null;
    }

    if (!response.ok || payload?.success === false || payload?.ok === false) {
      const error = new Error(
        payload?.message || payload?.error || "Request failed."
      );

      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return unwrap(payload);
  }

  function showBanner(message, type = "") {
    if (!els.statusBanner) return;

    if (!message) {
      els.statusBanner.className = "status-banner";
      els.statusBanner.textContent = "";
      return;
    }

    els.statusBanner.textContent = message;
    els.statusBanner.className = `status-banner show ${type}`.trim();
  }

  function setLoading(button, loading, loadingText) {
    if (!button) return;

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.disabled = loading;
    button.textContent = loading ? loadingText : button.dataset.originalText;
  }

  function setStaticText() {
    document.querySelectorAll("[data-static-activation-fee]").forEach((node) => {
      node.textContent = money(CONFIG.activationFee);
    });

    document.querySelectorAll("[data-static-monthly-fee]").forEach((node) => {
      node.textContent = `${money(CONFIG.monthlyFee)}/month`;
    });

    document.querySelectorAll("[data-static-billing-day]").forEach((node) => {
      node.textContent = `${CONFIG.billingDay}th monthly`;
    });

    document.querySelectorAll("[data-static-payout-window]").forEach((node) => {
      node.textContent = CONFIG.payoutWindow;
    });

    document.querySelectorAll("[data-static-referral-reward]").forEach((node) => {
      node.textContent = money(CONFIG.referralRewardAmount);
    });
  }

  function defaultRows() {
    return [
      {
        date: new Date().toISOString(),
        member: "Sample Paid Member",
        email: "paid@example.com",
        status: "active",
        payment: "paid",
        approvedReferrals: 5,
        pendingReferrals: 0,
        rewardEstimate: 35,
        activationPaid: true,
        monthlyPaid: true,
      },
      {
        date: new Date().toISOString(),
        member: "Sample Pending Member",
        email: "pending@example.com",
        status: "payment_pending",
        payment: "payment_pending",
        approvedReferrals: 0,
        pendingReferrals: 1,
        rewardEstimate: 0,
        activationPaid: false,
        monthlyPaid: false,
      },
      {
        date: new Date().toISOString(),
        member: "Sample Cancelled Member",
        email: "cancelled@example.com",
        status: "cancelled",
        payment: "cancelled",
        approvedReferrals: 0,
        pendingReferrals: 0,
        rewardEstimate: 0,
        activationPaid: false,
        monthlyPaid: false,
      },
    ];
  }

  function normalizeRow(row, index) {
    const approved = Number(
      row.approvedReferrals ||
        row.approved_referrals ||
        row.approved ||
        row.approved_count ||
        0
    );

    const pending = Number(
      row.pendingReferrals ||
        row.pending_referrals ||
        row.pending ||
        row.pending_count ||
        0
    );

    const payment =
      normalizeText(row.payment || row.payment_status || row.paymentStatus) ||
      "payment_pending";

    const status =
      normalizeText(row.status || row.member_status || row.membership_status) ||
      "payment_pending";

    return {
      id:
        normalizeText(row.id) ||
        normalizeText(row.signup_id) ||
        normalizeText(row.member_id) ||
        `report-row-${index + 1}`,

      date:
        row.date ||
        row.created_at ||
        row.createdAt ||
        row.joined_at ||
        row.joinedAt ||
        new Date().toISOString(),

      member:
        normalizeText(row.member) ||
        normalizeText(row.memberName) ||
        normalizeText(row.member_name) ||
        normalizeText(row.name) ||
        normalizeText(row.full_name) ||
        normalizeText(row.fullName) ||
        `Member #${index + 1}`,

      email:
        normalizeText(row.email) ||
        normalizeText(row.member_email) ||
        "No email",

      status: status.toLowerCase(),
      payment: payment.toLowerCase(),

      approvedReferrals: approved,
      pendingReferrals: pending,

      rewardEstimate: Number(
        row.rewardEstimate ||
          row.reward_estimate ||
          row.estimated_rewards ||
          row.estimatedRewards ||
          approved * CONFIG.referralRewardAmount ||
          0
      ),

      activationPaid:
        row.activationPaid === true ||
        row.activation_paid === true ||
        row.activation_payment_status === "paid" ||
        row.activation_payment_status === "succeeded",

      monthlyPaid:
        row.monthlyPaid === true ||
        row.monthly_paid === true ||
        row.monthly_payment_status === "paid" ||
        row.monthly_payment_status === "current" ||
        row.monthly_payment_status === "succeeded",

      tier:
        normalizeText(row.tier) ||
        normalizeText(row.tier_name) ||
        normalizeText(row.membership_tier) ||
        "VIP Member",
    };
  }

  function isPaidRow(row) {
    return (
      ["paid", "active", "current", "succeeded"].includes(row.payment) ||
      ["paid", "active", "approved", "auto_approved"].includes(row.status)
    );
  }

  function isPendingRow(row) {
    return (
      ["pending", "payment_pending", "pending_payment", "unpaid", "checkout_created"].includes(row.payment) ||
      ["pending", "payment_pending", "pending_payment", "unpaid", "checkout_created"].includes(row.status)
    );
  }

  function isDeniedRow(row) {
    return (
      ["denied", "cancelled", "canceled", "failed", "suspended", "past_due"].includes(row.status) ||
      ["denied", "cancelled", "canceled", "failed", "past_due"].includes(row.payment)
    );
  }

  function normalizePayload(payload = {}) {
    const root = unwrap(payload);

    const apiRows = Array.isArray(root.rows)
      ? root.rows
      : Array.isArray(root.reports)
        ? root.reports
        : Array.isArray(root.items)
          ? root.items
          : Array.isArray(root.members)
            ? root.members
            : Array.isArray(root.signups)
              ? root.signups
              : [];

    const normalizedRows = apiRows.length
      ? apiRows.map(normalizeRow)
      : defaultRows();

    const apiSummary = root.summary || {};

    const paidMembers = normalizedRows.filter(isPaidRow).length;
    const deniedMembers = normalizedRows.filter(isDeniedRow).length;
    const paymentPending = normalizedRows.filter(isPendingRow).length;

    const approvedReferrals = normalizedRows.reduce(
      (sum, row) => sum + Number(row.approvedReferrals || 0),
      0
    );

    const pendingReferrals = normalizedRows.reduce(
      (sum, row) => sum + Number(row.pendingReferrals || 0),
      0
    );

    const rewardEstimate = normalizedRows.reduce(
      (sum, row) => sum + Number(row.rewardEstimate || 0),
      0
    );

    const dailySignups = normalizedRows.filter((row) => {
      const rowDate = new Date(row.date);

      if (Number.isNaN(rowDate.getTime())) return false;

      return rowDate.toISOString().slice(0, 10) === todayIso();
    }).length;

    return {
      rows: normalizedRows,
      summary: {
        dailySignups:
          Number(apiSummary.dailySignups || apiSummary.daily_signups) ||
          dailySignups ||
          normalizedRows.length,

        paidMembers:
          Number(apiSummary.paidMembers || apiSummary.paid_members) ||
          paidMembers,

        deniedMembers:
          Number(apiSummary.deniedMembers || apiSummary.denied_members) ||
          deniedMembers,

        monthlyRewards:
          Number(apiSummary.monthlyRewards || apiSummary.monthly_rewards) ||
          rewardEstimate,

        totalSignups:
          Number(apiSummary.totalSignups || apiSummary.total_signups) ||
          normalizedRows.length,

        activePaidMembers:
          Number(apiSummary.activePaidMembers || apiSummary.active_paid_members) ||
          paidMembers,

        paymentPending:
          Number(apiSummary.paymentPending || apiSummary.payment_pending) ||
          paymentPending,

        approvedReferrals:
          Number(apiSummary.approvedReferrals || apiSummary.approved_referrals) ||
          approvedReferrals,

        pendingReferrals:
          Number(apiSummary.pendingReferrals || apiSummary.pending_referrals) ||
          pendingReferrals,

        totalRewardEstimate:
          Number(apiSummary.totalRewardEstimate || apiSummary.total_reward_estimate) ||
          rewardEstimate,

        activationRevenue:
          Number(apiSummary.activationRevenue || apiSummary.activation_revenue) ||
          paidMembers * CONFIG.activationFee,

        monthlyRevenue:
          Number(apiSummary.monthlyRevenue || apiSummary.monthly_revenue) ||
          paidMembers * CONFIG.monthlyFee,
      },
    };
  }

  function renderSummary() {
    if (els.dailySignups) {
      els.dailySignups.textContent = String(summary.dailySignups || 0);
    }

    if (els.paidMembers) {
      els.paidMembers.textContent = String(summary.paidMembers || 0);
    }

    if (els.deniedMembers) {
      els.deniedMembers.textContent = String(summary.deniedMembers || 0);
    }

    if (els.monthlyRewards) {
      els.monthlyRewards.textContent = money(summary.monthlyRewards || 0);
    }

    if (els.totalSignups) {
      els.totalSignups.textContent = String(summary.totalSignups || 0);
    }

    if (els.activePaidMembers) {
      els.activePaidMembers.textContent = String(summary.activePaidMembers || 0);
    }

    if (els.paymentPending) {
      els.paymentPending.textContent = String(summary.paymentPending || 0);
    }

    if (els.approvedReferrals) {
      els.approvedReferrals.textContent = String(summary.approvedReferrals || 0);
    }

    if (els.pendingReferrals) {
      els.pendingReferrals.textContent = String(summary.pendingReferrals || 0);
    }

    if (els.totalRewardEstimate) {
      els.totalRewardEstimate.textContent = money(summary.totalRewardEstimate || 0);
    }

    if (els.cardSubtitle) {
      els.cardSubtitle.textContent = `${summary.totalSignups || 0} signups`;
    }

    if (els.cardStatus) {
      els.cardStatus.textContent = `${summary.paidMembers || 0} Paid`;
    }

    if (els.cardRange) {
      els.cardRange.textContent = currentMonth();
    }

    document.querySelectorAll("[data-daily-signups]").forEach((node) => {
      node.textContent = String(summary.dailySignups || 0);
    });

    document.querySelectorAll("[data-paid-members]").forEach((node) => {
      node.textContent = String(summary.paidMembers || 0);
    });

    document.querySelectorAll("[data-denied-members]").forEach((node) => {
      node.textContent = String(summary.deniedMembers || 0);
    });

    document.querySelectorAll("[data-monthly-rewards]").forEach((node) => {
      node.textContent = money(summary.monthlyRewards || 0);
    });

    document.querySelectorAll("[data-activation-revenue]").forEach((node) => {
      node.textContent = money(summary.activationRevenue || 0);
    });

    document.querySelectorAll("[data-monthly-revenue]").forEach((node) => {
      node.textContent = money(summary.monthlyRevenue || 0);
    });
  }

  function getFilteredRows() {
    const search = normalizeText(els.searchInput?.value).toLowerCase();
    const status = normalizeText(els.statusFilter?.value).toLowerCase();

    return rows.filter((row) => {
      const matchesSearch =
        !search ||
        row.member.toLowerCase().includes(search) ||
        row.email.toLowerCase().includes(search) ||
        row.status.toLowerCase().includes(search) ||
        row.payment.toLowerCase().includes(search) ||
        row.tier.toLowerCase().includes(search);

      const matchesStatus =
        !status ||
        row.status === status ||
        row.payment === status ||
        (status === "paid" && isPaidRow(row)) ||
        (status === "active" && isPaidRow(row)) ||
        (status === "pending" && isPendingRow(row)) ||
        (status === "denied" && isDeniedRow(row)) ||
        (status === "cancelled" && isDeniedRow(row));

      return matchesSearch && matchesStatus;
    });
  }

  function renderTable() {
    if (!els.reportsTableBody) return;

    const filteredRows = getFilteredRows();

    if (!filteredRows.length) {
      els.reportsTableBody.innerHTML = `
        <tr>
          <td colspan="7">
            <div class="empty-box">No report rows found.</div>
          </td>
        </tr>
      `;
      return;
    }

    els.reportsTableBody.innerHTML = filteredRows
      .map(
        (row) => `
          <tr>
            <td>${escapeHtml(formatDate(row.date))}</td>

            <td>
              <strong>${escapeHtml(row.member)}</strong>
              <div class="muted">${escapeHtml(row.tier)}</div>
            </td>

            <td class="muted">${escapeHtml(row.email)}</td>

            <td>
              <span class="status-tag ${escapeHtml(row.status)}">
                ${escapeHtml(titleCase(row.status))}
              </span>
            </td>

            <td>
              <span class="status-tag ${escapeHtml(row.payment)}">
                ${escapeHtml(titleCase(row.payment))}
              </span>
            </td>

            <td>
              ${escapeHtml(row.approvedReferrals)}
              <div class="muted">${escapeHtml(row.pendingReferrals)} pending</div>
            </td>

            <td class="money">${escapeHtml(money(row.rewardEstimate))}</td>
          </tr>
        `
      )
      .join("");
  }

  async function loadReports() {
    setLoading(els.refreshButton, true, "Refreshing...");

    if (els.reportStatusBadge) {
      els.reportStatusBadge.textContent = "Loading";
      els.reportStatusBadge.className = "status-pill pending";
    }

    try {
      const params = new URLSearchParams();

      params.set("type", els.reportType?.value || "monthly");
      params.set("month", currentMonth());

      const status = normalizeText(els.statusFilter?.value);
      if (status) params.set("status", status);

      const data = await fetchJson(`${API.reports}?${params.toString()}`);
      if (!data) return;

      const model = normalizePayload(data);

      rows = model.rows;
      summary = model.summary;

      renderSummary();
      renderTable();

      if (els.reportStatusBadge) {
        els.reportStatusBadge.textContent = "Loaded";
        els.reportStatusBadge.className = "status-pill";
      }

      showBanner("Reports loaded.", "success");
    } catch (error) {
      console.error("[admin-reports] load error:", error);

      const model = normalizePayload({});

      rows = model.rows;
      summary = model.summary;

      renderSummary();
      renderTable();

      if (els.reportStatusBadge) {
        els.reportStatusBadge.textContent = "Fallback";
        els.reportStatusBadge.className = "status-pill pending";
      }

      showBanner(
        error?.message || "Unable to load reports. Showing fallback report data.",
        "warning"
      );
    } finally {
      setLoading(els.refreshButton, false, "Refresh Reports");
    }
  }

  function exportCsv() {
    const filteredRows = getFilteredRows();

    const headers = [
      "Date",
      "Member",
      "Email",
      "Status",
      "Payment",
      "Tier",
      "Approved Referrals",
      "Pending Referrals",
      "Reward Estimate",
      "Activation Paid",
      "Monthly Paid",
    ];

    const csvRows = [
      headers,
      ...filteredRows.map((row) => [
        formatDate(row.date),
        row.member,
        row.email,
        row.status,
        row.payment,
        row.tier,
        row.approvedReferrals,
        row.pendingReferrals,
        row.rewardEstimate,
        row.activationPaid ? "Yes" : "No",
        row.monthlyPaid ? "Yes" : "No",
      ]),
    ];

    const csv = csvRows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `card-leo-reports-${currentMonth()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showBanner("CSV export created.", "success");
  }

  async function handleLogout() {
    if (!els.logoutButton) return;

    const originalText = els.logoutButton.textContent;
    els.logoutButton.disabled = true;
    els.logoutButton.textContent = "Logging out...";

    try {
      await fetch(API.logout, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });

      window.location.href = "/login.html";
    } catch (error) {
      console.error("[admin-reports] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.refreshButton?.addEventListener("click", loadReports);
    els.exportButton?.addEventListener("click", exportCsv);

    els.applyFiltersButton?.addEventListener("click", () => {
      renderTable();
      showBanner("Filters applied.", "success");
    });

    els.searchInput?.addEventListener("input", renderTable);
    els.statusFilter?.addEventListener("change", renderTable);
    els.reportType?.addEventListener("change", loadReports);

    els.logoutButton?.addEventListener("click", handleLogout);

    document.querySelectorAll("[data-export-reports]").forEach((button) => {
      if (button.dataset.exportReportsBound === "true") return;

      button.dataset.exportReportsBound = "true";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        exportCsv();
      });
    });
  }

  function init() {
    setStaticText();
    bindEvents();
    loadReports();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, {
      once: true,
    });
  } else {
    init();
  }

  window.CardLeoAdminReports = {
    init,
    reload: loadReports,
    exportCsv,
    getState() {
      return {
        rows: [...rows],
        summary: { ...summary },
      };
    },
    helpers: {
      money,
      currentMonth,
      titleCase,
      isPaidRow,
      isPendingRow,
      isDeniedRow,
    },
  };
})();