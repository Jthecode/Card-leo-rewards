// assets/js/admin-payouts.js

(() => {
  const API = {
    payouts: "/api/payouts/list",
    generateMonthly: "/api/payouts/generate-monthly",
    markPaid: "/api/payouts/mark-paid",
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

    generateBatchButton: document.getElementById("generateBatchButton"),
    refreshButton: document.getElementById("refreshButton"),
    applyFiltersButton: document.getElementById("applyFiltersButton"),

    searchInput: document.getElementById("searchInput"),
    statusFilter: document.getElementById("statusFilter"),
    monthFilter: document.getElementById("monthFilter"),

    queueStatusBadge: document.getElementById("queueStatusBadge"),

    pendingPayouts: document.getElementById("pendingPayouts"),
    pendingAmount: document.getElementById("pendingAmount"),
    paidThisMonth: document.getElementById("paidThisMonth"),
    approvedReferrals: document.getElementById("approvedReferrals"),

    payoutsTableBody: document.getElementById("payoutsTableBody"),

    batchId: document.getElementById("batchId"),
    batchMonth: document.getElementById("batchMonth"),
    batchStatus: document.getElementById("batchStatus"),
    batchMembers: document.getElementById("batchMembers"),
    batchAmount: document.getElementById("batchAmount"),

    cardSubtitle: document.getElementById("cardSubtitle"),
    cardStatus: document.getElementById("cardStatus"),
  };

  let payouts = [];
  let currentSummary = null;
  let latestBatch = null;

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

  function normalizePayout(row, index) {
    const approved = Number(
      row.approvedReferrals ||
        row.approved_referrals ||
        row.approved ||
        row.referral_count ||
        0
    );

    const amount = Number(
      row.amount ||
        row.payout_amount ||
        row.reward_amount ||
        row.total_amount ||
        approved * CONFIG.referralRewardAmount ||
        0
    );

    const name =
      normalizeText(row.memberName) ||
      normalizeText(row.member_name) ||
      normalizeText(row.name) ||
      normalizeText(row.full_name) ||
      normalizeText(row.fullName) ||
      `Member #${index + 1}`;

    const email =
      normalizeText(row.email) ||
      normalizeText(row.member_email) ||
      "No email";

    const status = normalizeText(row.status, "pending").toLowerCase();

    return {
      id:
        normalizeText(row.id) ||
        normalizeText(row.payout_id) ||
        normalizeText(row.payoutId) ||
        `payout-${index + 1}`,
      memberId:
        normalizeText(row.member_id) ||
        normalizeText(row.memberId) ||
        normalizeText(row.signup_id) ||
        "",
      name,
      email,
      approved,
      amount,
      status,
      month:
        normalizeText(row.month) ||
        normalizeText(row.payout_month) ||
        currentMonth(),
      createdAt:
        row.created_at ||
        row.createdAt ||
        row.generated_at ||
        row.generatedAt ||
        "",
      paidAt:
        row.paid_at ||
        row.paidAt ||
        "",
      raw: row,
    };
  }

  function normalizePayload(payload = {}) {
    const root = unwrap(payload);

    const rows = Array.isArray(root.payouts)
      ? root.payouts
      : Array.isArray(root.rows)
        ? root.rows
        : Array.isArray(root.items)
          ? root.items
          : [];

    const normalized = rows.map(normalizePayout);

    const summary = root.summary || {};

    const pendingRows = normalized.filter((row) =>
      ["pending", "approved", "processing"].includes(row.status)
    );

    const paidRows = normalized.filter((row) => row.status === "paid");

    const pendingAmount = pendingRows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    const paidThisMonth = paidRows
      .filter((row) => row.month === currentMonth())
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const approvedReferrals = normalized.reduce(
      (sum, row) => sum + Number(row.approved || 0),
      0
    );

    return {
      payouts: normalized,
      summary: {
        pendingPayouts:
          Number(summary.pendingPayouts || summary.pending_payouts) ||
          pendingRows.length,
        pendingAmount:
          Number(summary.pendingAmount || summary.pending_amount) ||
          pendingAmount,
        paidThisMonth:
          Number(summary.paidThisMonth || summary.paid_this_month) ||
          paidThisMonth,
        approvedReferrals:
          Number(summary.approvedReferrals || summary.approved_referrals) ||
          approvedReferrals,
      },
      batch: root.batch || root.latestBatch || root.latest_batch || null,
    };
  }

  function renderSummary(summary) {
    currentSummary = summary;

    if (els.pendingPayouts) {
      els.pendingPayouts.textContent = String(summary.pendingPayouts || 0);
    }

    if (els.pendingAmount) {
      els.pendingAmount.textContent = money(summary.pendingAmount || 0);
    }

    if (els.paidThisMonth) {
      els.paidThisMonth.textContent = money(summary.paidThisMonth || 0);
    }

    if (els.approvedReferrals) {
      els.approvedReferrals.textContent = String(summary.approvedReferrals || 0);
    }

    if (els.cardSubtitle) {
      els.cardSubtitle.textContent = `${money(summary.pendingAmount || 0)} pending`;
    }

    if (els.cardStatus) {
      els.cardStatus.textContent = `${summary.pendingPayouts || 0} Pending`;
    }

    document.querySelectorAll("[data-pending-payouts]").forEach((node) => {
      node.textContent = String(summary.pendingPayouts || 0);
    });

    document.querySelectorAll("[data-pending-amount]").forEach((node) => {
      node.textContent = money(summary.pendingAmount || 0);
    });

    document.querySelectorAll("[data-paid-this-month]").forEach((node) => {
      node.textContent = money(summary.paidThisMonth || 0);
    });

    document.querySelectorAll("[data-approved-referrals]").forEach((node) => {
      node.textContent = String(summary.approvedReferrals || 0);
    });
  }

  function renderBatch(batch) {
    latestBatch = batch;

    if (!batch) {
      if (els.batchId) els.batchId.textContent = "—";
      if (els.batchMonth) els.batchMonth.textContent = currentMonth();
      if (els.batchStatus) els.batchStatus.textContent = "Not generated";
      if (els.batchMembers) els.batchMembers.textContent = "0";
      if (els.batchAmount) els.batchAmount.textContent = "$0";
      return;
    }

    if (els.batchId) {
      els.batchId.textContent = normalizeText(batch.id || batch.batch_id, "—");
    }

    if (els.batchMonth) {
      els.batchMonth.textContent = normalizeText(
        batch.month || batch.payout_month,
        currentMonth()
      );
    }

    if (els.batchStatus) {
      els.batchStatus.textContent = titleCase(batch.status || "generated");
    }

    if (els.batchMembers) {
      els.batchMembers.textContent = String(
        batch.totalMembers || batch.total_members || batch.members || 0
      );
    }

    if (els.batchAmount) {
      els.batchAmount.textContent = money(
        batch.totalAmount || batch.total_amount || batch.amount || 0
      );
    }
  }

  function getFilteredPayouts() {
    const search = normalizeText(els.searchInput?.value).toLowerCase();
    const status = normalizeText(els.statusFilter?.value).toLowerCase();
    const monthFilter = normalizeText(els.monthFilter?.value).toLowerCase();

    return payouts.filter((row) => {
      const matchesSearch =
        !search ||
        row.name.toLowerCase().includes(search) ||
        row.email.toLowerCase().includes(search) ||
        row.id.toLowerCase().includes(search);

      const matchesStatus = !status || row.status === status;

      const matchesMonth =
        !monthFilter ||
        monthFilter === "all" ||
        row.month === currentMonth();

      return matchesSearch && matchesStatus && matchesMonth;
    });
  }

  function renderTable() {
    if (!els.payoutsTableBody) return;

    const rows = getFilteredPayouts();

    if (!rows.length) {
      els.payoutsTableBody.innerHTML = `
        <tr>
          <td colspan="7">
            <div class="empty-box">No payouts found.</div>
          </td>
        </tr>
      `;
      return;
    }

    els.payoutsTableBody.innerHTML = rows
      .map((row) => {
        const canMarkPaid = ["pending", "approved", "processing"].includes(
          row.status
        );

        return `
          <tr>
            <td>
              <div class="member-cell">
                <span class="avatar">${escapeHtml(row.name.charAt(0))}</span>
                <span>
                  <strong>${escapeHtml(row.name)}</strong>
                  <div class="muted">ID: ${escapeHtml(row.id)}</div>
                </span>
              </div>
            </td>

            <td class="muted">${escapeHtml(row.email)}</td>

            <td>${escapeHtml(row.approved)}</td>

            <td class="money">${escapeHtml(money(row.amount))}</td>

            <td>
              <span class="status-tag ${escapeHtml(row.status)}">
                ${escapeHtml(titleCase(row.status))}
              </span>
            </td>

            <td>${escapeHtml(row.month)}</td>

            <td>
              <div class="row-actions">
                ${
                  canMarkPaid
                    ? `<button class="mini-btn pay" type="button" data-mark-paid="${escapeHtml(row.id)}">Mark Paid</button>`
                    : `<button class="mini-btn" type="button" disabled>Paid</button>`
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadPayouts() {
    setLoading(els.refreshButton, true, "Refreshing...");

    if (els.queueStatusBadge) {
      els.queueStatusBadge.textContent = "Loading";
      els.queueStatusBadge.className = "status-pill pending";
    }

    try {
      const params = new URLSearchParams();

      const status = normalizeText(els.statusFilter?.value);
      const month = normalizeText(els.monthFilter?.value);

      if (status) params.set("status", status);
      if (month && month !== "all") params.set("month", currentMonth());

      const url = params.toString()
        ? `${API.payouts}?${params.toString()}`
        : API.payouts;

      const data = await fetchJson(url);
      if (!data) return;

      const model = normalizePayload(data);

      payouts = model.payouts;

      renderSummary(model.summary);
      renderBatch(model.batch);
      renderTable();

      if (els.queueStatusBadge) {
        els.queueStatusBadge.textContent = "Loaded";
        els.queueStatusBadge.className = "status-pill";
      }

      showBanner("Payout queue loaded.", "success");
    } catch (error) {
      console.error("[admin-payouts] load error:", error);

      payouts = [];

      renderSummary({
        pendingPayouts: 0,
        pendingAmount: 0,
        paidThisMonth: 0,
        approvedReferrals: 0,
      });

      renderBatch(null);
      renderTable();

      if (els.queueStatusBadge) {
        els.queueStatusBadge.textContent = "Error";
        els.queueStatusBadge.className = "status-pill error";
      }

      showBanner(error?.message || "Unable to load payouts.", "error");
    } finally {
      setLoading(els.refreshButton, false, "Refresh Payouts");
    }
  }

  async function generateMonthlyBatch() {
    setLoading(els.generateBatchButton, true, "Generating...");

    try {
      const data = await fetchJson(API.generateMonthly, {
        method: "POST",
        body: JSON.stringify({
          month: currentMonth(),
          referral_reward_amount: CONFIG.referralRewardAmount,
          payout_window: CONFIG.payoutWindow,
          activation_fee_amount: CONFIG.activationFee,
          monthly_fee_amount: CONFIG.monthlyFee,
          billing_day: CONFIG.billingDay,
        }),
      });

      showBanner(
        data?.message || "Monthly payout batch generated successfully.",
        "success"
      );

      await loadPayouts();
    } catch (error) {
      console.error("[admin-payouts] generate error:", error);

      showBanner(
        error?.message || "Unable to generate monthly payout batch.",
        "error"
      );
    } finally {
      setLoading(els.generateBatchButton, false, "Generate Monthly Batch");
    }
  }

  async function markPaid(payoutId) {
    if (!payoutId) return;

    const confirmed = window.confirm(
      "Mark this payout as paid? Only do this after the payment has been sent."
    );

    if (!confirmed) return;

    try {
      await fetchJson(API.markPaid, {
        method: "POST",
        body: JSON.stringify({
          payout_id: payoutId,
          status: "paid",
          paid_at: new Date().toISOString(),
        }),
      });

      showBanner("Payout marked as paid.", "success");
      await loadPayouts();
    } catch (error) {
      console.error("[admin-payouts] mark paid error:", error);

      showBanner(error?.message || "Unable to mark payout as paid.", "error");
    }
  }

  function exportCsv() {
    const rows = getFilteredPayouts();

    const headers = [
      "Payout ID",
      "Member",
      "Email",
      "Approved Referrals",
      "Amount",
      "Status",
      "Month",
      "Paid At",
    ];

    const csvRows = [
      headers,
      ...rows.map((row) => [
        row.id,
        row.name,
        row.email,
        row.approved,
        row.amount,
        row.status,
        row.month,
        row.paidAt || "",
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
    link.download = `card-leo-payouts-${currentMonth()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showBanner("Payout CSV exported.", "success");
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
      console.error("[admin-payouts] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.refreshButton?.addEventListener("click", loadPayouts);
    els.generateBatchButton?.addEventListener("click", generateMonthlyBatch);

    els.applyFiltersButton?.addEventListener("click", () => {
      renderTable();
      showBanner("Filters applied.", "success");
    });

    els.searchInput?.addEventListener("input", renderTable);
    els.statusFilter?.addEventListener("change", renderTable);
    els.monthFilter?.addEventListener("change", renderTable);

    els.logoutButton?.addEventListener("click", handleLogout);

    els.payoutsTableBody?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mark-paid]");
      if (!button) return;

      markPaid(button.getAttribute("data-mark-paid"));
    });

    document.querySelectorAll("[data-export-payouts]").forEach((button) => {
      if (button.dataset.exportPayoutsBound === "true") return;

      button.dataset.exportPayoutsBound = "true";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        exportCsv();
      });
    });
  }

  function init() {
    setStaticText();
    bindEvents();
    loadPayouts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.CardLeoAdminPayouts = {
    init,
    reload: loadPayouts,
    generateMonthlyBatch,
    markPaid,
    exportCsv,
    getState() {
      return {
        payouts: [...payouts],
        summary: currentSummary,
        latestBatch,
      };
    },
    helpers: {
      money,
      currentMonth,
      titleCase,
    },
  };
})();