// assets/js/portal-dashboard.js

(() => {
  const API = {
    me: "/api/auth/me",
    overview: "/api/portal/overview",
    referralTower: "/api/portal/referral-tower",
    billingPortal: "/api/billing/portal",
    logout: "/api/auth/logout",
  };

  const els = {
    memberName: document.getElementById("memberName"),
    memberTierBadge: document.getElementById("memberTierBadge"),
    referralLink: document.getElementById("referralLink"),
    copyReferralButton: document.getElementById("copyReferralButton"),
    billingPortalButton: document.getElementById("billingPortalButton"),

    currentBalance: document.getElementById("currentBalance"),
    totalReferrals: document.getElementById("totalReferrals"),
    approvedReferrals: document.getElementById("approvedReferrals"),
    pendingReferrals: document.getElementById("pendingReferrals"),
    totalEarned: document.getElementById("totalEarned"),

    towerFloors: document.getElementById("towerFloors"),
    towerStatus: document.getElementById("towerStatus"),

    leaderboardTable: document.getElementById("leaderboardTable"),
    recentReferralsTable: document.getElementById("recentReferralsTable"),

    logoutButton: document.getElementById("logoutButton"),
  };

  const state = {
    member: null,
    overview: null,
    referralPayload: null,
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

  function getFirstName(member) {
    return (
      normalizeText(member?.firstName || member?.first_name) ||
      getFullName(member).split(/\s+/)[0] ||
      "Member"
    );
  }

  function getTier(member) {
    return normalizeText(
      member?.tier_name ||
        member?.tierName ||
        member?.membership_tier ||
        member?.membershipTier ||
        member?.tier ||
        "VIP Member"
    );
  }

  function getStatus(member) {
    return normalizeText(
      member?.membership_status ||
        member?.membershipStatus ||
        member?.status ||
        member?.member_status ||
        "active"
    ).toLowerCase();
  }

  function getPaymentStatus(member) {
    return normalizeText(
      member?.payment_status || member?.paymentStatus || "paid"
    ).toLowerCase();
  }

  function isPaidActive(member) {
    const status = getStatus(member);
    const paymentStatus = getPaymentStatus(member);

    return (
      ["active", "approved", "auto_approved", "paid"].includes(status) ||
      ["paid", "active", "current", "succeeded"].includes(paymentStatus)
    );
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

  function setTowerStatus(message, type = "info") {
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

    els.towerStatus.textContent = message;
  }

  function renderMember(member) {
    state.member = member;

    if (!member) {
      redirectToLogin();
      return;
    }

    const firstName = getFirstName(member);
    const tier = getTier(member);
    const paid = isPaidActive(member);

    if (els.memberName) {
      els.memberName.textContent = firstName;
    }

    if (els.memberTierBadge) {
      els.memberTierBadge.textContent = paid ? `♛ ${tier}` : "Payment Required";
    }

    if (els.referralLink) {
      els.referralLink.value = getReferralLink(member);
    }

    if (!paid) {
      setTowerStatus(
        "Membership payment is required before full portal access, rewards, referrals, and benefits are unlocked.",
        "error"
      );
    }
  }

  function renderStats(summary = {}) {
    const total = Number(
      summary.totalReferrals ||
        summary.total_referrals ||
        summary.referrals_total ||
        0
    );

    const approved = Number(
      summary.approvedReferrals ||
        summary.approved_referrals ||
        summary.referrals_approved ||
        0
    );

    const pending = Number(
      summary.pendingReferrals ||
        summary.pending_referrals ||
        summary.referrals_pending ||
        0
    );

    const earned = Number(
      summary.earnedAmount ||
        summary.earned_amount ||
        summary.totalEarned ||
        summary.total_earned ||
        approved * 7 ||
        0
    );

    const balance = Number(
      summary.currentBalance ||
        summary.current_balance ||
        summary.balance ||
        earned ||
        0
    );

    if (els.totalReferrals) {
      els.totalReferrals.textContent = String(total);
    }

    if (els.approvedReferrals) {
      els.approvedReferrals.textContent = String(approved);
    }

    if (els.pendingReferrals) {
      els.pendingReferrals.textContent = String(pending);
    }

    if (els.totalEarned) {
      els.totalEarned.textContent = money(earned);
    }

    if (els.currentBalance) {
      els.currentBalance.textContent = money(balance);
    }
  }

  function floorClass(floor) {
    const status = normalizeText(floor.status || floor.state).toLowerCase();

    if (status === "earned" || status === "approved") {
      return "tower-floor earned";
    }

    if (status === "pending") {
      return "tower-floor pending";
    }

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
      renderDefaultFloors(payload?.summary || {});
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
        amount = 7;
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

  function getRows(payload, keys) {
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) {
        return payload[key];
      }
    }

    return [];
  }

  function renderLeaderboard(rows = []) {
    if (!els.leaderboardTable) return;

    const safeRows = Array.isArray(rows) ? rows.slice(0, 5) : [];

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
            Number(approved) * 7;

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

    const safeRows = Array.isArray(rows) ? rows.slice(0, 5) : [];

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

          const status = statusRaw.toLowerCase().includes("approved")
            ? "approved"
            : "pending";

          const amount = Number(referral.amount || referral.reward_amount || 0);
          const approved = status === "approved";

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
                ${approved ? "+ " + escapeHtml(money(amount || 7)) : "Pending"}
              </span>
            </div>
          `;
        })
        .join("");
  }

  function renderReferralPayload(payload = {}) {
    state.referralPayload = payload;

    const summary = payload.summary || {};

    renderStats(summary);
    renderFloors(payload);
    renderLeaderboard(
      getRows(payload, ["leaderboard", "topEarners", "top_earners", "rows"])
    );
    renderRecentReferrals(
      getRows(payload, ["referrals", "recentReferrals", "recent_referrals"])
    );

    const referralLink =
      normalizeText(payload?.member?.referralLink) ||
      normalizeText(payload?.member?.referral_link);

    if (referralLink && els.referralLink) {
      els.referralLink.value = referralLink;
    }

    setTowerStatus("Referral tower updated.", "success");
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

  async function loadOverview() {
    try {
      const data = await fetchJson(API.overview);

      if (!data) return null;

      state.overview = data;

      const member = data.member || data.profile || data.user || null;

      if (member) {
        renderMember({
          ...(state.member || {}),
          ...member,
        });
      }

      if (data.summary || data.stats) {
        renderStats(data.summary || data.stats);
      }

      return data;
    } catch (error) {
      console.warn("[portal-dashboard] overview unavailable:", error);
      return null;
    }
  }

  async function loadReferralTower() {
    setTowerStatus("Loading referral tower...");

    try {
      const payload = await fetchJson(API.referralTower);

      if (!payload) return null;

      renderReferralPayload(payload);
      return payload;
    } catch (error) {
      console.error("[portal-dashboard] referral tower error:", error);

      renderStats({
        totalReferrals: 0,
        approvedReferrals: 0,
        pendingReferrals: 0,
        earnedAmount: 0,
      });

      renderFloors({
        summary: {
          approvedReferrals: 0,
          pendingReferrals: 0,
        },
      });

      renderLeaderboard([]);
      renderRecentReferrals([]);

      setTowerStatus(
        error?.message || "Unable to load referral tower right now.",
        "error"
      );

      return null;
    }
  }

  async function copyReferralLink() {
    const link = normalizeText(els.referralLink?.value);

    if (!link) {
      setTowerStatus("Referral link is not available yet.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(link);
      setTowerStatus("Referral link copied.", "success");
    } catch {
      const temp = document.createElement("input");
      temp.value = link;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();

      setTowerStatus("Referral link copied.", "success");
    }
  }

  async function openBillingPortal() {
    try {
      const data = await fetchJson(API.billingPortal, {
        method: "POST",
        body: JSON.stringify({
          return_url: window.location.href,
        }),
      });

      const url =
        data?.url ||
        data?.billing_portal_url ||
        data?.billingPortalUrl ||
        data?.redirectTo;

      if (!url) {
        window.location.href = "/portal/billing.html";
        return;
      }

      window.location.href = url;
    } catch (error) {
      console.warn("[portal-dashboard] billing portal unavailable:", error);
      window.location.href = "/portal/billing.html";
    }
  }

  async function logout() {
    if (!els.logoutButton) return;

    const oldText = els.logoutButton.textContent;

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
      console.error("[portal-dashboard] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = oldText;

      alert("We could not log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.copyReferralButton?.addEventListener("click", copyReferralLink);
    els.billingPortalButton?.addEventListener("click", openBillingPortal);
    els.logoutButton?.addEventListener("click", logout);

    window.addEventListener("cardleo:auth-ready", (event) => {
      const member = event?.detail?.member;

      if (member) {
        renderMember(member);
      }
    });

    window.addEventListener("cardleo:auth-failed", redirectToLogin);
  }

  async function init() {
    bindEvents();

    try {
      await loadSession();
      await Promise.allSettled([loadOverview(), loadReferralTower()]);
    } catch (error) {
      console.error("[portal-dashboard] init error:", error);
      redirectToLogin();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();