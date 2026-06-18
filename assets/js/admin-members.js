// assets/js/admin-members.js

(() => {
  const API = {
    me: "/api/auth/me",
    members: "/api/admin/members",
    updateMember: "/api/admin/members/update",
    logout: "/api/auth/logout",
  };

  const CONFIG = {
    activationFee: 25,
    monthlyFee: 20,
    billingDay: 10,
    referralRewardAmount: 7,
    payoutWindow: "1st–3rd monthly",
  };

  const els = {
    statusBanner: document.getElementById("statusBanner"),
    logoutButton: document.getElementById("logoutButton"),

    refreshButton: document.getElementById("refreshButton"),
    exportButton: document.getElementById("exportButton"),
    applyFiltersButton: document.getElementById("applyFiltersButton"),

    searchInput: document.getElementById("searchInput"),
    statusFilter: document.getElementById("statusFilter"),
    tierFilter: document.getElementById("tierFilter"),

    membersStatusBadge: document.getElementById("membersStatusBadge"),

    totalMembers: document.getElementById("totalMembers"),
    paidMembers: document.getElementById("paidMembers"),
    pendingMembers: document.getElementById("pendingMembers"),
    deniedMembers: document.getElementById("deniedMembers"),

    membersTableBody: document.getElementById("membersTableBody"),

    cardSubtitle: document.getElementById("cardSubtitle"),
    cardStatus: document.getElementById("cardStatus"),
  };

  let members = [];
  let admin = null;

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

    if (response.status === 403) {
      window.location.href = "/unauthorized.html";
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

  function getFullName(member, index = 0) {
    const full =
      normalizeText(member.fullName) ||
      normalizeText(member.full_name) ||
      normalizeText(member.name);

    if (full) return full;

    const first = normalizeText(member.firstName || member.first_name);
    const last = normalizeText(member.lastName || member.last_name);

    return [first, last].filter(Boolean).join(" ") || `Member #${index + 1}`;
  }

  function getMemberStatus(member) {
    return normalizeText(
      member.membership_status ||
        member.membershipStatus ||
        member.memberStatus ||
        member.member_status ||
        member.status ||
        "payment_pending"
    ).toLowerCase();
  }

  function getPaymentStatus(member) {
    return normalizeText(
      member.payment_status ||
        member.paymentStatus ||
        "payment_pending"
    ).toLowerCase();
  }

  function getApprovalStatus(member) {
    return normalizeText(
      member.approval_status ||
        member.approvalStatus ||
        ""
    ).toLowerCase();
  }

  function getTier(member) {
    return normalizeText(
      member.tier_name ||
        member.tierName ||
        member.membership_tier ||
        member.membershipTier ||
        member.tier ||
        member.accessLevel ||
        member.access_level ||
        "VIP Member"
    );
  }

  function isPaidMember(member) {
    const status = getMemberStatus(member);
    const payment = getPaymentStatus(member);
    const approval = getApprovalStatus(member);

    return (
      ["active", "approved", "auto_approved", "paid"].includes(status) ||
      ["paid", "active", "current", "succeeded"].includes(payment) ||
      ["approved", "auto_approved", "paid"].includes(approval)
    );
  }

  function isPendingMember(member) {
    const status = getMemberStatus(member);
    const payment = getPaymentStatus(member);
    const approval = getApprovalStatus(member);

    return (
      ["pending", "payment_pending", "pending_payment", "unpaid", "checkout_created"].includes(status) ||
      ["pending", "payment_pending", "pending_payment", "unpaid", "checkout_created"].includes(payment) ||
      ["pending", "payment_pending", "pending_payment"].includes(approval)
    );
  }

  function isDeniedMember(member) {
    const status = getMemberStatus(member);
    const payment = getPaymentStatus(member);
    const approval = getApprovalStatus(member);

    return (
      ["denied", "declined", "cancelled", "canceled", "failed", "suspended", "past_due"].includes(status) ||
      ["denied", "declined", "cancelled", "canceled", "failed", "past_due"].includes(payment) ||
      ["denied", "declined", "cancelled", "canceled", "failed"].includes(approval)
    );
  }

  function normalizeMember(row, index) {
    const approvedReferrals = Number(
      row.approvedReferrals ||
        row.approved_referrals ||
        row.approved ||
        row.approved_count ||
        0
    );

    const totalReferrals = Number(
      row.totalReferrals ||
        row.total_referrals ||
        row.referrals ||
        approvedReferrals ||
        0
    );

    const earned = Number(
      row.earned ||
        row.totalEarned ||
        row.total_earned ||
        row.earned_amount ||
        approvedReferrals * CONFIG.referralRewardAmount ||
        0
    );

    return {
      id:
        normalizeText(row.id) ||
        normalizeText(row.signup_id) ||
        normalizeText(row.member_id) ||
        `member-${index + 1}`,

      name: getFullName(row, index),

      email:
        normalizeText(row.email) ||
        normalizeText(row.member_email) ||
        "No email",

      phone:
        normalizeText(row.phone) ||
        normalizeText(row.phone_number) ||
        "—",

      city: normalizeText(row.city),
      state: normalizeText(row.state),

      status: getMemberStatus(row),
      payment: getPaymentStatus(row),
      approval: getApprovalStatus(row) || (isPaidMember(row) ? "auto_approved" : "payment_pending"),

      tier: getTier(row),

      referralName:
        normalizeText(row.referralName) ||
        normalizeText(row.referral_name) ||
        normalizeText(row.sponsor) ||
        "—",

      referralCode:
        normalizeText(row.referralCode) ||
        normalizeText(row.referral_code) ||
        normalizeText(row.code) ||
        "",

      approvedReferrals,
      totalReferrals,
      earned,

      activationPaid:
        row.activationPaid === true ||
        row.activation_paid === true ||
        row.activation_payment_status === "paid" ||
        row.activation_payment_status === "succeeded" ||
        isPaidMember(row),

      monthlyPaid:
        row.monthlyPaid === true ||
        row.monthly_paid === true ||
        row.monthly_payment_status === "paid" ||
        row.monthly_payment_status === "current" ||
        row.monthly_payment_status === "succeeded" ||
        isPaidMember(row),

      stripeCustomerId:
        normalizeText(row.stripeCustomerId) ||
        normalizeText(row.stripe_customer_id) ||
        "",

      stripeSubscriptionId:
        normalizeText(row.stripeSubscriptionId) ||
        normalizeText(row.stripe_subscription_id) ||
        "",

      joinedAt:
        row.joinedAt ||
        row.joined_at ||
        row.createdAt ||
        row.created_at ||
        "",

      updatedAt:
        row.updatedAt ||
        row.updated_at ||
        "",

      raw: row,
    };
  }

  function normalizePayload(payload = {}) {
    const root = unwrap(payload);

    admin = root.admin || root.user || admin;

    const rows = Array.isArray(root.members)
      ? root.members
      : Array.isArray(root.signups)
        ? root.signups
        : Array.isArray(root.rows)
          ? root.rows
          : Array.isArray(root.items)
            ? root.items
            : [];

    return rows.map(normalizeMember);
  }

  function renderStats() {
    const total = members.length;
    const paid = members.filter(isPaidMember).length;
    const pending = members.filter(isPendingMember).length;
    const denied = members.filter(isDeniedMember).length;

    if (els.totalMembers) els.totalMembers.textContent = String(total);
    if (els.paidMembers) els.paidMembers.textContent = String(paid);
    if (els.pendingMembers) els.pendingMembers.textContent = String(pending);
    if (els.deniedMembers) els.deniedMembers.textContent = String(denied);

    if (els.cardSubtitle) {
      els.cardSubtitle.textContent = `${total} member records`;
    }

    if (els.cardStatus) {
      els.cardStatus.textContent = `${paid} Paid`;
    }

    document.querySelectorAll("[data-total-members]").forEach((node) => {
      node.textContent = String(total);
    });

    document.querySelectorAll("[data-paid-members]").forEach((node) => {
      node.textContent = String(paid);
    });

    document.querySelectorAll("[data-pending-members]").forEach((node) => {
      node.textContent = String(pending);
    });

    document.querySelectorAll("[data-denied-members]").forEach((node) => {
      node.textContent = String(denied);
    });
  }

  function getFilteredMembers() {
    const search = normalizeText(els.searchInput?.value).toLowerCase();
    const status = normalizeText(els.statusFilter?.value).toLowerCase();
    const tier = normalizeText(els.tierFilter?.value).toLowerCase();

    return members.filter((member) => {
      const matchesSearch =
        !search ||
        member.name.toLowerCase().includes(search) ||
        member.email.toLowerCase().includes(search) ||
        member.phone.toLowerCase().includes(search) ||
        member.referralName.toLowerCase().includes(search) ||
        member.referralCode.toLowerCase().includes(search);

      const matchesStatus =
        !status ||
        member.status === status ||
        member.payment === status ||
        member.approval === status ||
        (status === "paid" && isPaidMember(member)) ||
        (status === "active" && isPaidMember(member)) ||
        (status === "payment_pending" && isPendingMember(member)) ||
        (status === "pending" && isPendingMember(member)) ||
        (status === "denied" && isDeniedMember(member)) ||
        (status === "cancelled" && isDeniedMember(member));

      const matchesTier =
        !tier || member.tier.toLowerCase().includes(tier);

      return matchesSearch && matchesStatus && matchesTier;
    });
  }

  function renderTable() {
    if (!els.membersTableBody) return;

    const rows = getFilteredMembers();

    if (!rows.length) {
      els.membersTableBody.innerHTML = `
        <tr>
          <td colspan="9">
            <div class="empty-box">No members found.</div>
          </td>
        </tr>
      `;
      return;
    }

    els.membersTableBody.innerHTML = rows
      .map((member) => {
        const paid = isPaidMember(member);

        return `
          <tr>
            <td>
              <div class="member-cell">
                <span class="avatar">${escapeHtml(member.name.charAt(0))}</span>
                <span>
                  <strong>${escapeHtml(member.name)}</strong>
                  <div class="muted">Ref: ${escapeHtml(member.referralName)}</div>
                </span>
              </div>
            </td>

            <td class="muted">${escapeHtml(member.email)}</td>
            <td class="muted">${escapeHtml(member.phone)}</td>

            <td>
              <span class="status-tag ${escapeHtml(member.status)}">
                ${escapeHtml(titleCase(member.status))}
              </span>
            </td>

            <td>
              <span class="status-tag ${escapeHtml(member.payment)}">
                ${escapeHtml(titleCase(member.payment))}
              </span>
            </td>

            <td>${escapeHtml(member.tier)}</td>

            <td>
              ${escapeHtml(member.approvedReferrals)} approved / ${escapeHtml(member.totalReferrals)} total
            </td>

            <td class="money">${escapeHtml(money(member.earned))}</td>

            <td>
              <div class="row-actions">
                ${
                  paid
                    ? `<button class="mini-btn" type="button" disabled>Paid</button>`
                    : `<button class="mini-btn approve" type="button" data-mark-paid="${escapeHtml(member.id)}">Mark Paid</button>`
                }

                <button class="mini-btn" type="button" data-view="${escapeHtml(member.id)}">
                  View
                </button>

                <button class="mini-btn danger" type="button" data-suspend="${escapeHtml(member.id)}">
                  Suspend
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadAdminSession() {
    try {
      const data = await fetchJson(API.me);
      if (!data) return;

      admin = data.admin || data.user || data.member || null;
    } catch (error) {
      if (error?.status === 401) {
        redirectToLogin();
        return;
      }

      console.warn("[admin-members] admin session check skipped:", error);
    }
  }

  async function loadMembers() {
    setLoading(els.refreshButton, true, "Refreshing...");

    if (els.membersStatusBadge) {
      els.membersStatusBadge.textContent = "Loading";
      els.membersStatusBadge.className = "status-pill pending";
    }

    try {
      const params = new URLSearchParams();

      const status = normalizeText(els.statusFilter?.value);
      const tier = normalizeText(els.tierFilter?.value);
      const search = normalizeText(els.searchInput?.value);

      if (status) params.set("status", status);
      if (tier) params.set("tier", tier);
      if (search) params.set("search", search);

      const url = params.toString()
        ? `${API.members}?${params.toString()}`
        : API.members;

      const data = await fetchJson(url);
      if (!data) return;

      members = normalizePayload(data);

      renderStats();
      renderTable();

      if (els.membersStatusBadge) {
        els.membersStatusBadge.textContent = "Loaded";
        els.membersStatusBadge.className = "status-pill";
      }

      showBanner("Members loaded.", "success");
    } catch (error) {
      console.error("[admin-members] load error:", error);

      members = [];

      renderStats();
      renderTable();

      if (els.membersStatusBadge) {
        els.membersStatusBadge.textContent = "Error";
        els.membersStatusBadge.className = "status-pill error";
      }

      showBanner(error?.message || "Unable to load members.", "error");
    } finally {
      setLoading(els.refreshButton, false, "Refresh Members");
    }
  }

  async function updateMemberStatus(memberId, payload) {
    try {
      await fetchJson(API.updateMember, {
        method: "POST",
        body: JSON.stringify({
          id: memberId,
          ...payload,
        }),
      });

      members = members.map((member) => {
        if (member.id !== memberId) return member;

        return {
          ...member,
          status: payload.membership_status || payload.status || member.status,
          payment: payload.payment_status || member.payment,
          approval: payload.approval_status || member.approval,
          activationPaid: payload.payment_status === "paid" || member.activationPaid,
          monthlyPaid: payload.payment_status === "paid" || member.monthlyPaid,
        };
      });

      renderStats();
      renderTable();

      showBanner("Member updated.", "success");
    } catch (error) {
      console.error("[admin-members] update error:", error);

      showBanner(error?.message || "Unable to update member.", "error");
    }
  }

  function viewMember(memberId) {
    const member = members.find((item) => item.id === memberId);

    if (!member) {
      showBanner("Member not found.", "error");
      return;
    }

    window.alert(
      [
        `Member: ${member.name}`,
        `Email: ${member.email}`,
        `Phone: ${member.phone}`,
        `Status: ${titleCase(member.status)}`,
        `Payment: ${titleCase(member.payment)}`,
        `Approval: ${titleCase(member.approval)}`,
        `Tier: ${member.tier}`,
        `Activation Fee: ${member.activationPaid ? "Paid" : "Not Paid"}`,
        `Monthly Membership: ${member.monthlyPaid ? "Paid/Current" : "Not Paid"}`,
        `Approved Referrals: ${member.approvedReferrals}`,
        `Total Referrals: ${member.totalReferrals}`,
        `Earned: ${money(member.earned)}`,
        `Stripe Customer: ${member.stripeCustomerId || "—"}`,
        `Stripe Subscription: ${member.stripeSubscriptionId || "—"}`,
      ].join("\n")
    );
  }

  function exportCsv() {
    const rows = getFilteredMembers();

    const headers = [
      "ID",
      "Name",
      "Email",
      "Phone",
      "Status",
      "Payment",
      "Approval",
      "Tier",
      "Referral Name",
      "Referral Code",
      "Approved Referrals",
      "Total Referrals",
      "Earned",
      "Activation Paid",
      "Monthly Paid",
      "Stripe Customer",
      "Stripe Subscription",
    ];

    const csvRows = [
      headers,
      ...rows.map((member) => [
        member.id,
        member.name,
        member.email,
        member.phone,
        member.status,
        member.payment,
        member.approval,
        member.tier,
        member.referralName,
        member.referralCode,
        member.approvedReferrals,
        member.totalReferrals,
        member.earned,
        member.activationPaid ? "Yes" : "No",
        member.monthlyPaid ? "Yes" : "No",
        member.stripeCustomerId,
        member.stripeSubscriptionId,
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
    link.download = "card-leo-members.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showBanner("Members CSV exported.", "success");
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
      console.error("[admin-members] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.refreshButton?.addEventListener("click", loadMembers);
    els.exportButton?.addEventListener("click", exportCsv);

    els.applyFiltersButton?.addEventListener("click", () => {
      renderTable();
      showBanner("Filters applied.", "success");
    });

    els.searchInput?.addEventListener("input", renderTable);
    els.statusFilter?.addEventListener("change", renderTable);
    els.tierFilter?.addEventListener("change", renderTable);

    els.logoutButton?.addEventListener("click", handleLogout);

    els.membersTableBody?.addEventListener("click", (event) => {
      const markPaidButton = event.target.closest("[data-mark-paid]");
      const viewButton = event.target.closest("[data-view]");
      const suspendButton = event.target.closest("[data-suspend]");

      if (markPaidButton) {
        updateMemberStatus(markPaidButton.getAttribute("data-mark-paid"), {
          membership_status: "active",
          payment_status: "paid",
          approval_status: "auto_approved",
          activation_fee_amount: CONFIG.activationFee,
          monthly_fee_amount: CONFIG.monthlyFee,
          billing_day: CONFIG.billingDay,
        });
        return;
      }

      if (viewButton) {
        viewMember(viewButton.getAttribute("data-view"));
        return;
      }

      if (suspendButton) {
        const confirmed = window.confirm("Suspend this member?");
        if (!confirmed) return;

        updateMemberStatus(suspendButton.getAttribute("data-suspend"), {
          membership_status: "suspended",
          payment_status: "suspended",
          approval_status: "suspended",
        });
      }
    });

    document.querySelectorAll("[data-export-members]").forEach((button) => {
      if (button.dataset.exportMembersBound === "true") return;

      button.dataset.exportMembersBound = "true";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        exportCsv();
      });
    });
  }

  async function init() {
    setStaticText();
    bindEvents();
    await loadAdminSession();
    await loadMembers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, {
      once: true,
    });
  } else {
    init();
  }

  window.CardLeoAdminMembers = {
    init,
    reload: loadMembers,
    updateMemberStatus,
    exportCsv,
    getState() {
      return {
        admin,
        members: [...members],
      };
    },
    helpers: {
      money,
      titleCase,
      isPaidMember,
      isPendingMember,
      isDeniedMember,
    },
  };
})();