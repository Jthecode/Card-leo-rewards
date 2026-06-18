// assets/js/portal-leaderboard.js

(() => {
  const API = {
    me: "/api/auth/me",
    leaderboard: "/api/leaderboard/monthly",
    referrals: "/api/referrals/me",
    portalTower: "/api/portal/referral-tower",
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
    logoutButton: document.getElementById("logoutButton"),
    copyReferralButton: document.getElementById("copyReferralButton"),
    towerStatus: document.getElementById("towerStatus"),

    cardMemberName: document.getElementById("cardMemberName"),
    cardMemberTier: document.getElementById("cardMemberTier"),
    cardMemberStatus: document.getElementById("cardMemberStatus"),
    cardRewardSnapshot: document.getElementById("cardRewardSnapshot"),

    towerFloors: document.getElementById("towerFloors"),

    totalReferrals: document.getElementById("totalReferrals"),
    approvedReferrals: document.getElementById("approvedReferrals"),
    pendingReferrals: document.getElementById("pendingReferrals"),
    totalEarned: document.getElementById("totalEarned"),

    leaderboardTable: document.getElementById("leaderboardTable"),
    recentReferralsTable: document.getElementById("recentReferralsTable"),
  };

  const ACTIVE_STATUSES = new Set([
    "active",
    "approved",
    "auto_approved",
    "paid",
    "current",
    "succeeded",
  ]);

  const PENDING_STATUSES = new Set([
    "pending",
    "payment_pending",
    "pending_payment",
    "checkout_created",
    "unpaid",
    "processing",
  ]);

  const BAD_STATUSES = new Set([
    "denied",
    "declined",
    "cancelled",
    "canceled",
    "failed",
    "suspended",
    "past_due",
  ]);

  const state = {
    member: null,
    referralLink: "",
    leaderboard: [],
    referrals: [],
    summary: null,
    raw: null,
    loading: false,
  };

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

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "—";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function unwrap(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
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

  function redirectToLogin() {
    window.location.href =
      "/login.html?next=" +
      encodeURIComponent(window.location.pathname + window.location.search);
  }

  function getFullName(member) {
    const full =
      normalizeText(member?.fullName) ||
      normalizeText(member?.full_name) ||
      normalizeText(member?.name);

    if (full) return full;

    const first = normalizeText(member?.firstName || member?.first_name);
    const last = normalizeText(member?.lastName || member?.last_name);

    return [first, last].filter(Boolean).join(" ") || "Card Leo Member";
  }

  function getTier(member) {
    return normalizeText(
      member?.tier_name ||
        member?.tierName ||
        member?.membership_tier ||
        member?.membershipTier ||
        member?.tier ||
        member?.accessLevel ||
        member?.access_level ||
        "VIP Member"
    );
  }

  function getStatus(member) {
    return normalizeText(
      member?.membership_status ||
        member?.membershipStatus ||
        member?.memberStatus ||
        member?.member_status ||
        member?.status ||
        "payment_pending"
    ).toLowerCase();
  }

  function getPaymentStatus(member) {
    return normalizeText(
      member?.payment_status || member?.paymentStatus || ""
    ).toLowerCase();
  }

  function getApprovalStatus(member) {
    return normalizeText(
      member?.approval_status || member?.approvalStatus || ""
    ).toLowerCase();
  }

  function isPaidActive(member) {
    const status = getStatus(member);
    const paymentStatus = getPaymentStatus(member);
    const approvalStatus = getApprovalStatus(member);

    return (
      ACTIVE_STATUSES.has(status) ||
      ACTIVE_STATUSES.has(paymentStatus) ||
      ACTIVE_STATUSES.has(approvalStatus)
    );
  }

  function isPendingPayment(member) {
    const status = getStatus(member);
    const paymentStatus = getPaymentStatus(member);
    const approvalStatus = getApprovalStatus(member);

    return (
      PENDING_STATUSES.has(status) ||
      PENDING_STATUSES.has(paymentStatus) ||
      PENDING_STATUSES.has(approvalStatus)
    );
  }

  function isBadStatus(member) {
    const status = getStatus(member);
    const paymentStatus = getPaymentStatus(member);
    const approvalStatus = getApprovalStatus(member);

    return (
      BAD_STATUSES.has(status) ||
      BAD_STATUSES.has(paymentStatus) ||
      BAD_STATUSES.has(approvalStatus)
    );
  }

  function getMemberStatusLabel(member) {
    if (isPaidActive(member)) return "Referral Active";
    if (isBadStatus(member)) return titleCase(getStatus(member));
    if (isPendingPayment(member)) return "Payment Required";
    return titleCase(getStatus(member));
  }

  function getReferralLink(member) {
    const existing =
      normalizeText(member?.referral_link) ||
      normalizeText(member?.referralLink) ||
      normalizeText(member?.portal_referral_link);

    if (existing) return existing;

    const code =
      normalizeText(member?.referral_code) ||
      normalizeText(member?.referralCode) ||
      normalizeText(member?.username) ||
      normalizeText(member?.email).split("@")[0] ||
      "member";

    return `https://cardleorewards.com/signup?ref=${encodeURIComponent(code)}`;
  }

  function showTowerStatus(message, type = "") {
    if (!els.towerStatus) return;

    if (!message) {
      els.towerStatus.hidden = true;
      els.towerStatus.className = "status-box";
      els.towerStatus.textContent = "";
      return;
    }

    els.towerStatus.hidden = false;
    els.towerStatus.className = "status-box";

    if (type === "success") {
      els.towerStatus.classList.add("success");
    }

    if (type === "error") {
      els.towerStatus.classList.add("error");
    }

    if (type === "warning") {
      els.towerStatus.classList.add("warning");
    }

    els.towerStatus.textContent = message;
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

  function renderMember(member) {
    state.member = member || {};
    state.referralLink = getReferralLink(state.member);

    const fullName = getFullName(state.member);
    const tier = getTier(state.member);
    const paid = isPaidActive(state.member);
    const statusLabel = getMemberStatusLabel(state.member);

    if (els.cardMemberName) {
      els.cardMemberName.textContent = fullName;
    }

    if (els.cardMemberTier) {
      els.cardMemberTier.textContent = tier;
    }

    if (els.cardMemberStatus) {
      els.cardMemberStatus.textContent = statusLabel;
    }

    document.querySelectorAll("[data-member-name]").forEach((node) => {
      node.textContent = fullName;
    });

    document.querySelectorAll("[data-member-first-name]").forEach((node) => {
      node.textContent =
        normalizeText(state.member.firstName || state.member.first_name) ||
        fullName.split(/\s+/)[0] ||
        "Member";
    });

    document.querySelectorAll("[data-member-tier]").forEach((node) => {
      node.textContent = titleCase(tier);
    });

    document.querySelectorAll("[data-member-status]").forEach((node) => {
      node.textContent = statusLabel;
    });

    document.querySelectorAll("[data-referral-link]").forEach((node) => {
      if ("value" in node) {
        node.value = state.referralLink;
      } else {
        node.textContent = state.referralLink;
      }
    });

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberTier = tier;
    document.body.dataset.memberStatus = getStatus(state.member);
    document.body.dataset.memberPaymentStatus = getPaymentStatus(state.member);
    document.body.dataset.portalAccess = paid ? "enabled" : "payment_required";

    document.querySelectorAll("[data-paid-only]").forEach((node) => {
      node.hidden = !paid;
    });

    document.querySelectorAll("[data-payment-required-only]").forEach((node) => {
      node.hidden = paid;
    });

    if (!paid) {
      showTowerStatus(
        "Complete your membership payment to unlock full referral rewards and leaderboard access.",
        "warning"
      );
    }
  }

  function normalizeSummary(payload = {}) {
    const summary = payload.summary || payload.stats || {};

    const approvedReferrals = Number(
      summary.approvedReferrals ||
        summary.approved_referrals ||
        payload.approvedReferrals ||
        payload.approved_referrals ||
        0
    );

    const pendingReferrals = Number(
      summary.pendingReferrals ||
        summary.pending_referrals ||
        payload.pendingReferrals ||
        payload.pending_referrals ||
        0
    );

    const totalReferrals = Number(
      summary.totalReferrals ||
        summary.total_referrals ||
        payload.totalReferrals ||
        payload.total_referrals ||
        approvedReferrals + pendingReferrals ||
        0
    );

    const totalEarned = Number(
      summary.totalEarned ||
        summary.total_earned ||
        summary.earnedAmount ||
        summary.earned_amount ||
        payload.totalEarned ||
        payload.total_earned ||
        approvedReferrals * CONFIG.referralRewardAmount ||
        0
    );

    return {
      totalReferrals,
      approvedReferrals,
      pendingReferrals,
      totalEarned,
    };
  }

  function renderStats(summary) {
    state.summary = summary;

    if (els.totalReferrals) {
      els.totalReferrals.textContent = String(summary.totalReferrals);
    }

    if (els.approvedReferrals) {
      els.approvedReferrals.textContent = String(summary.approvedReferrals);
    }

    if (els.pendingReferrals) {
      els.pendingReferrals.textContent = String(summary.pendingReferrals);
    }

    if (els.totalEarned) {
      els.totalEarned.textContent = money(summary.totalEarned);
    }

    if (els.cardRewardSnapshot) {
      els.cardRewardSnapshot.textContent = `${money(summary.totalEarned)} Earned`;
    }

    document.querySelectorAll("[data-total-referrals]").forEach((node) => {
      node.textContent = String(summary.totalReferrals);
    });

    document.querySelectorAll("[data-approved-referrals]").forEach((node) => {
      node.textContent = String(summary.approvedReferrals);
    });

    document.querySelectorAll("[data-pending-referrals]").forEach((node) => {
      node.textContent = String(summary.pendingReferrals);
    });

    document.querySelectorAll("[data-total-earned]").forEach((node) => {
      node.textContent = money(summary.totalEarned);
    });
  }

  function normalizeLeaderboard(payload = {}) {
    const rows =
      payload.leaderboard ||
      payload.rows ||
      payload.members ||
      payload.topEarners ||
      payload.top_earners ||
      [];

    return Array.isArray(rows) ? rows : [];
  }

  function normalizeReferrals(payload = {}) {
    const rows =
      payload.referrals ||
      payload.recentReferrals ||
      payload.recent_referrals ||
      payload.rows ||
      [];

    return Array.isArray(rows) ? rows : [];
  }

  function renderLeaderboard(rows = []) {
    if (!els.leaderboardTable) return;

    state.leaderboard = rows;

    const safeRows = rows.slice(0, 8);

    const header = `
      <div class="table-row header">
        <span>Rank</span>
        <span>Member</span>
        <span>Approved</span>
        <span>Earnings</span>
      </div>
    `;

    if (!safeRows.length) {
      els.leaderboardTable.innerHTML =
        header + `<div class="empty-box">No leaderboard activity yet.</div>`;
      return;
    }

    els.leaderboardTable.innerHTML =
      header +
      safeRows
        .map((row, index) => {
          const rank = row.rank || index + 1;

          const name =
            row.referralName ||
            row.name ||
            row.memberName ||
            row.member_name ||
            `Member #${rank}`;

          const approved =
            row.approvedReferrals ||
            row.approved_referrals ||
            row.approved ||
            0;

          const earned =
            row.earnedAmount ||
            row.earned_amount ||
            row.totalEarned ||
            row.total_earned ||
            Number(approved) * CONFIG.referralRewardAmount;

          return `
            <div class="table-row">
              <span><span class="rank-medal">${escapeHtml(rank)}</span></span>

              <span class="member-cell">
                <span class="avatar">${escapeHtml(String(name).charAt(0))}</span>
                <span class="member-name">${escapeHtml(name)}</span>
              </span>

              <span>${escapeHtml(approved)}</span>
              <span class="green-money">${escapeHtml(money(earned))}</span>
            </div>
          `;
        })
        .join("");
  }

  function renderRecentReferrals(rows = []) {
    if (!els.recentReferralsTable) return;

    state.referrals = rows;

    const safeRows = rows.slice(0, 8);

    const header = `
      <div class="table-row header">
        <span>Name</span>
        <span>Status</span>
        <span>Joined</span>
        <span>Earnings</span>
      </div>
    `;

    if (!safeRows.length) {
      els.recentReferralsTable.innerHTML =
        header + `<div class="empty-box">No recent referrals yet.</div>`;
      return;
    }

    els.recentReferralsTable.innerHTML =
      header +
      safeRows
        .map((referral) => {
          const name =
            referral.name ||
            referral.full_name ||
            referral.fullName ||
            "New Member";

          const statusRaw = normalizeText(
            referral.statusLabel || referral.status,
            "Pending"
          );

          const approved = statusRaw.toLowerCase().includes("approved");
          const status = approved ? "approved" : "pending";

          const amount = Number(
            referral.amount ||
              referral.reward_amount ||
              referral.earned ||
              (approved ? CONFIG.referralRewardAmount : 0)
          );

          return `
            <div class="table-row">
              <span class="member-cell">
                <span class="avatar">${escapeHtml(String(name).charAt(0))}</span>
                <span class="member-name">${escapeHtml(name)}</span>
              </span>

              <span>
                <span class="status-tag ${status}">
                  ${escapeHtml(titleCase(statusRaw))}
                </span>
              </span>

              <span>${escapeHtml(
                formatDate(
                  referral.created_at ||
                    referral.createdAt ||
                    referral.joined_at ||
                    referral.joinedAt
                )
              )}</span>

              <span class="${approved ? "green-money" : ""}">
                ${approved ? "+ " + escapeHtml(money(amount)) : "Pending"}
              </span>
            </div>
          `;
        })
        .join("");
  }

  function floorClass(floor) {
    const status = normalizeText(floor.status || floor.state).toLowerCase();

    if (status === "earned" || status === "approved") return "tower-floor earned";
    if (status === "pending") return "tower-floor pending";
    return "tower-floor locked";
  }

  function renderFloors(payload = {}) {
    if (!els.towerFloors) return;

    const floors = Array.isArray(payload?.tower?.floors)
      ? payload.tower.floors
      : Array.isArray(payload?.floors)
        ? payload.floors
        : [];

    if (!floors.length) {
      renderDefaultFloors(payload.summary || {});
      return;
    }

    const sorted = [...floors].sort((a, b) => Number(b.floor) - Number(a.floor));

    els.towerFloors.innerHTML = sorted
      .map((floor) => {
        const amount = Number(floor.amount || 0);

        const label =
          normalizeText(floor.label) ||
          normalizeText(floor.name) ||
          (floor.status === "pending" ? "Pending Referral" : "Open Floor");

        const moneyText =
          amount > 0
            ? `+${money(amount)}`
            : titleCase(floor.status || floor.state || "Locked");

        return `
          <div class="${floorClass(floor)}">
            <span class="floor-number">${escapeHtml(floor.floor || "")}</span>
            <span class="floor-name">${escapeHtml(label)}</span>
            <span class="floor-money">${escapeHtml(moneyText)}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderDefaultFloors(summary = {}) {
    if (!els.towerFloors) return;

    const approved = Number(
      summary.approvedReferrals || summary.approved_referrals || 0
    );

    const pending = Number(
      summary.pendingReferrals || summary.pending_referrals || 0
    );

    const floors = [];

    for (let floor = 12; floor >= 1; floor -= 1) {
      let status = "locked";
      let label = "Open Floor";
      let amount = 0;

      if (floor <= approved) {
        status = "approved";
        label = "Approved Referral";
        amount = CONFIG.referralRewardAmount;
      } else if (floor <= approved + pending) {
        status = "pending";
        label = "Pending Referral";
      }

      floors.push({
        floor,
        status,
        label,
        amount,
      });
    }

    els.towerFloors.innerHTML = floors
      .map((floor) => {
        const moneyText =
          floor.amount > 0
            ? `+${money(floor.amount)}`
            : titleCase(floor.status || "Locked");

        return `
          <div class="${floorClass(floor)}">
            <span class="floor-number">${escapeHtml(floor.floor)}</span>
            <span class="floor-name">${escapeHtml(floor.label)}</span>
            <span class="floor-money">${escapeHtml(moneyText)}</span>
          </div>
        `;
      })
      .join("");
  }

  function mergePayloads(...payloads) {
    return payloads.reduce((acc, payload) => {
      if (!payload || !isObject(payload)) return acc;

      return {
        ...acc,
        ...payload,
        summary: {
          ...(acc.summary || {}),
          ...(payload.summary || payload.stats || {}),
        },
        leaderboard:
          payload.leaderboard ||
          payload.topEarners ||
          payload.top_earners ||
          acc.leaderboard ||
          [],
        referrals:
          payload.referrals ||
          payload.recentReferrals ||
          payload.recent_referrals ||
          acc.referrals ||
          [],
        tower: payload.tower || acc.tower || null,
        floors: payload.floors || acc.floors || [],
      };
    }, {});
  }

  async function loadSession() {
    const data = await fetchJson(API.me);

    if (!data) return null;

    if (data.authenticated === false) {
      redirectToLogin();
      return null;
    }

    const member = data.member || data.profile || data.user || null;

    if (!member) {
      redirectToLogin();
      return null;
    }

    renderMember(member);
    return member;
  }

  async function loadLeaderboard() {
    if (state.loading) return;

    state.loading = true;
    showTowerStatus("Loading referral tower...");

    try {
      await loadSession();

      const results = await Promise.allSettled([
        fetchJson(API.leaderboard),
        fetchJson(API.referrals),
        fetchJson(API.portalTower),
      ]);

      const payloads = results
        .filter((result) => result.status === "fulfilled" && result.value)
        .map((result) => result.value);

      const merged = mergePayloads(...payloads);
      const summary = normalizeSummary(merged);

      state.raw = merged;

      renderStats(summary);
      renderFloors({
        ...merged,
        summary,
      });
      renderLeaderboard(normalizeLeaderboard(merged));
      renderRecentReferrals(normalizeReferrals(merged));

      if (isPaidActive(state.member)) {
        showTowerStatus("Referral tower updated.", "success");
      } else {
        showTowerStatus(
          "Payment required. Complete membership activation to unlock full leaderboard rewards.",
          "warning"
        );
      }
    } catch (error) {
      console.error("[portal-leaderboard] load error:", error);

      renderStats({
        totalReferrals: 0,
        approvedReferrals: 0,
        pendingReferrals: 0,
        totalEarned: 0,
      });

      renderFloors({
        summary: {
          approvedReferrals: 0,
          pendingReferrals: 0,
        },
      });

      renderLeaderboard([]);
      renderRecentReferrals([]);

      showTowerStatus(
        error?.message || "Unable to load referral tower right now.",
        "error"
      );
    } finally {
      state.loading = false;
    }
  }

  async function copyReferralLink() {
    if (!state.referralLink && state.member) {
      state.referralLink = getReferralLink(state.member);
    }

    if (!state.referralLink) {
      showTowerStatus("Referral link is not available yet.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(state.referralLink);
      showTowerStatus("Referral link copied.", "success");
    } catch {
      const temp = document.createElement("input");
      temp.value = state.referralLink;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();

      showTowerStatus("Referral link copied.", "success");
    }
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
      console.error("[portal-leaderboard] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.copyReferralButton?.addEventListener("click", copyReferralLink);
    els.logoutButton?.addEventListener("click", handleLogout);

    document.querySelectorAll("[data-copy-referral]").forEach((button) => {
      if (button.dataset.leaderboardCopyBound === "true") return;

      button.dataset.leaderboardCopyBound = "true";
      button.addEventListener("click", copyReferralLink);
    });

    document.querySelectorAll("[data-leaderboard-refresh]").forEach((button) => {
      if (button.dataset.leaderboardRefreshBound === "true") return;

      button.dataset.leaderboardRefreshBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const originalText = button.textContent;

        try {
          button.disabled = true;
          button.textContent = "Refreshing...";
          await loadLeaderboard();
        } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      });
    });

    window.addEventListener("cardleo:auth-ready", (event) => {
      const member = event?.detail?.member;

      if (member && !state.member) {
        renderMember(member);
      }
    });

    window.addEventListener("cardleo:auth-failed", () => {
      redirectToLogin();
    });
  }

  function init() {
    setStaticText();
    bindEvents();
    loadLeaderboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.CardLeoPortalLeaderboard = {
    init,
    reload: loadLeaderboard,
    copyReferralLink,
    getState() {
      return { ...state };
    },
    helpers: {
      isPaidActive,
      isPendingPayment,
      isBadStatus,
      money,
    },
  };
})();