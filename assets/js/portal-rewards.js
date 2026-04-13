// assets/js/portal-rewards.js

(function () {
  const CONFIG = {
    rewardsEndpoint: "/api/portal/rewards",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      fallbackPortalOverviewEndpoint: "/api/portal/overview",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      debug: false,
    },
  };

  const state = {
    member: null,
    rewards: [],
    summary: null,
    support: null,
    isLoading: false,
  };

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setHtml(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.innerHTML = String(value ?? "");
    });
  }

  function setStatus(target, type, message) {
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = false;
    el.textContent = normalizeText(message);
    el.dataset.state = type || "info";

    el.style.display = "block";
    el.style.padding = "14px 16px";
    el.style.borderRadius = "16px";
    el.style.marginTop = "12px";
    el.style.fontSize = "0.95rem";
    el.style.lineHeight = "1.5";
    el.style.border = "1px solid rgba(255,255,255,0.08)";

    if (type === "success") {
      el.style.background = "rgba(34, 197, 94, 0.10)";
      el.style.color = "#d9ffe8";
      el.style.borderColor = "rgba(34, 197, 94, 0.28)";
    } else if (type === "error") {
      el.style.background = "rgba(239, 68, 68, 0.10)";
      el.style.color = "#ffe2e2";
      el.style.borderColor = "rgba(239, 68, 68, 0.28)";
    } else {
      el.style.background = "rgba(216, 176, 94, 0.10)";
      el.style.color = "#f4ead3";
      el.style.borderColor = "rgba(216, 176, 94, 0.25)";
    }
  }

  function clearStatus(target) {
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "—";

    try {
      return new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "—";
    }
  }

  function formatDateTime(value) {
    if (!value) return "—";

    try {
      return new Date(value).toLocaleString();
    } catch {
      return "—";
    }
  }

  function formatNumber(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return "0";
    return new Intl.NumberFormat().format(num);
  }

  function formatPoints(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return "0";
    return `${new Intl.NumberFormat().format(num)} pts`;
  }

  function normalizeStatusTone(status) {
    const value = normalizeText(status).toLowerCase();

    if (["active", "available", "earned", "approved", "unlocked"].includes(value)) {
      return "success";
    }

    if (["pending", "processing", "in review", "scheduled"].includes(value)) {
      return "warning";
    }

    if (["expired", "inactive", "redeemed", "used", "ended"].includes(value)) {
      return "muted";
    }

    return "primary";
  }

  function badgeStyles(tone) {
    if (tone === "success") {
      return {
        background: "rgba(34,197,94,0.12)",
        color: "#d8ffe6",
        border: "1px solid rgba(34,197,94,0.25)",
      };
    }

    if (tone === "warning") {
      return {
        background: "rgba(216,176,94,0.12)",
        color: "#f4ead3",
        border: "1px solid rgba(216,176,94,0.24)",
      };
    }

    if (tone === "muted") {
      return {
        background: "rgba(148,163,184,0.10)",
        color: "#d8dee8",
        border: "1px solid rgba(148,163,184,0.18)",
      };
    }

    return {
      background: "rgba(255,255,255,0.06)",
      color: "#f8f3e8",
      border: "1px solid rgba(255,255,255,0.10)",
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...options,
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { response, data };
  }

  function inferRewardsPayload(payload) {
    const data = isObject(payload?.data) ? payload.data : payload;
    const member = isObject(data?.member) ? data.member : {};
    const support = isObject(data?.support) ? data.support : {};
    const summary = isObject(data?.summary) ? data.summary : {};
    const rewards = Array.isArray(data?.rewards) ? data.rewards : [];

    return { member, support, summary, rewards };
  }

  function applyMember(member = {}) {
    state.member = member;

    const fullName =
      normalizeText(member.name) ||
      [
        normalizeText(member.firstName || member.first_name),
        normalizeText(member.lastName || member.last_name),
      ]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      "Card Leo Member";

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      fullName.split(" ")[0] ||
      "Member";

    setText("[data-member-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", member.email || "");
    setText("[data-member-status]", member.status || "member");
    setText(
      "[data-member-access-level]",
      member.accessLevel || member.access_level || "member"
    );
    setText(
      "[data-member-joined-at]",
      member.joinedAt ? formatDate(member.joinedAt) : "—"
    );

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = normalizeText(member.email || "");
    document.body.dataset.memberStatus = normalizeText(member.status || "");
  }

  function applySupport(support = {}) {
    state.support = support;

    setText("[data-support-email]", support.email || "support@cardleorewards.com");
    setText("[data-support-phone]", support.phone || "");
    setText("[data-support-hours]", support.hours || "Mon–Fri, 9:00 AM–6:00 PM");
  }

  function applySummary(summary = {}, rewards = []) {
    state.summary = summary;

    const totalRewards =
      Number.isFinite(Number(summary.totalRewards))
        ? Number(summary.totalRewards)
        : rewards.length;

    const activeRewards =
      Number.isFinite(Number(summary.activeRewards))
        ? Number(summary.activeRewards)
        : rewards.filter((reward) =>
            ["active", "available", "earned", "unlocked"].includes(
              normalizeText(reward.status).toLowerCase()
            )
          ).length;

    const pendingRewards =
      Number.isFinite(Number(summary.pendingRewards))
        ? Number(summary.pendingRewards)
        : rewards.filter((reward) =>
            ["pending", "processing", "scheduled"].includes(
              normalizeText(reward.status).toLowerCase()
            )
          ).length;

    const accessLevel = normalizeText(summary.accessLevel || "member");
    const statusLabel = normalizeText(summary.statusLabel || "Active Member");

    setText("[data-total-rewards]", formatNumber(totalRewards));
    setText("[data-active-rewards]", formatNumber(activeRewards));
    setText("[data-pending-rewards]", formatNumber(pendingRewards));
    setText("[data-rewards-access-level]", accessLevel);
    setText("[data-rewards-status-label]", statusLabel);

    const totalPoints =
      Number.isFinite(Number(summary.totalPoints))
        ? Number(summary.totalPoints)
        : rewards.reduce((acc, reward) => {
            const value =
              reward.points ??
              reward.value ??
              reward.amount ??
              reward.balance ??
              0;
            return acc + (Number.isFinite(Number(value)) ? Number(value) : 0);
          }, 0);

    setText("[data-total-points]", formatPoints(totalPoints));
  }

  function normalizeReward(reward = {}, index = 0) {
    return {
      id: normalizeText(reward.id || reward.rewardId || reward.slug || `reward-${index + 1}`),
      title:
        normalizeText(reward.title || reward.name || reward.label) ||
        `Reward ${index + 1}`,
      description:
        normalizeText(reward.description || reward.summary || reward.details) ||
        "Premium member reward available through Card Leo Rewards.",
      category: normalizeText(reward.category || reward.type || "Member Benefit"),
      status: normalizeText(reward.status || reward.state || "Active"),
      points:
        reward.points ??
        reward.value ??
        reward.amount ??
        reward.balance ??
        null,
      expiresAt:
        reward.expiresAt ||
        reward.expires_at ||
        reward.expirationDate ||
        reward.expiration_date ||
        null,
      redeemedAt:
        reward.redeemedAt ||
        reward.redeemed_at ||
        reward.usedAt ||
        reward.used_at ||
        null,
      createdAt:
        reward.createdAt ||
        reward.created_at ||
        reward.earnedAt ||
        reward.earned_at ||
        null,
      code: normalizeText(reward.code || reward.redemptionCode || ""),
      ctaLabel: normalizeText(reward.ctaLabel || reward.buttonLabel || "View Reward"),
      ctaHref: normalizeText(reward.ctaHref || reward.link || "#"),
      meta: Array.isArray(reward.meta) ? reward.meta : [],
    };
  }

  function renderRewards(rewards = []) {
    const containers = document.querySelectorAll(
      "[data-rewards-grid], #rewards-grid, #portal-rewards-grid"
    );

    if (!containers.length) return;

    const normalized = rewards.map(normalizeReward);

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!normalized.length) {
        const empty = document.createElement("div");
        empty.style.padding = "20px";
        empty.style.borderRadius = "20px";
        empty.style.background = "rgba(255,255,255,0.03)";
        empty.style.border = "1px solid rgba(255,255,255,0.08)";
        empty.style.color = "rgba(244, 234, 211, 0.76)";
        empty.innerHTML = `
          <strong style="display:block;color:#f8f3e8;font-size:1rem;margin-bottom:8px;">
            No rewards available yet
          </strong>
          <span>
            Your next member rewards will appear here once they are issued to your account.
          </span>
        `;
        container.appendChild(empty);
        return;
      }

      normalized.forEach((reward) => {
        const tone = normalizeStatusTone(reward.status);
        const badge = badgeStyles(tone);

        const card = document.createElement("article");
        card.style.display = "grid";
        card.style.gap = "14px";
        card.style.padding = "20px";
        card.style.borderRadius = "22px";
        card.style.background =
          "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02))";
        card.style.border = "1px solid rgba(255,255,255,0.08)";
        card.style.boxShadow = "0 18px 40px rgba(0,0,0,0.22)";

        const top = document.createElement("div");
        top.style.display = "flex";
        top.style.alignItems = "flex-start";
        top.style.justifyContent = "space-between";
        top.style.gap = "12px";
        top.style.flexWrap = "wrap";

        const titleWrap = document.createElement("div");
        titleWrap.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="
              display:inline-flex;
              align-items:center;
              justify-content:center;
              padding:6px 10px;
              border-radius:999px;
              font-size:0.72rem;
              letter-spacing:0.08em;
              text-transform:uppercase;
              color:rgba(244,234,211,0.78);
              background:rgba(255,255,255,0.05);
              border:1px solid rgba(255,255,255,0.08);
            ">${escapeHtml(reward.category)}</span>
          </div>
          <h3 style="margin:10px 0 6px;color:#f8f3e8;font-size:1.12rem;line-height:1.2;">
            ${escapeHtml(reward.title)}
          </h3>
          <p style="margin:0;color:rgba(244,234,211,0.76);line-height:1.65;font-size:0.95rem;">
            ${escapeHtml(reward.description)}
          </p>
        `;

        const status = document.createElement("span");
        status.textContent = reward.status;
        status.style.display = "inline-flex";
        status.style.alignItems = "center";
        status.style.justifyContent = "center";
        status.style.padding = "8px 12px";
        status.style.borderRadius = "999px";
        status.style.fontSize = "0.78rem";
        status.style.fontWeight = "700";
        status.style.letterSpacing = "0.04em";
        status.style.background = badge.background;
        status.style.color = badge.color;
        status.style.border = badge.border;

        top.appendChild(titleWrap);
        top.appendChild(status);

        const stats = document.createElement("div");
        stats.style.display = "grid";
        stats.style.gridTemplateColumns = "repeat(auto-fit, minmax(140px, 1fr))";
        stats.style.gap = "12px";

        const statItems = [
          {
            label: "Reward Value",
            value:
              reward.points !== null && reward.points !== undefined
                ? formatPoints(reward.points)
                : "Included",
          },
          {
            label: "Earned / Added",
            value: reward.createdAt ? formatDate(reward.createdAt) : "—",
          },
          {
            label: "Expires",
            value: reward.expiresAt ? formatDate(reward.expiresAt) : "No expiry",
          },
          {
            label: "Redeemed",
            value: reward.redeemedAt ? formatDate(reward.redeemedAt) : "Not yet",
          },
        ];

        statItems.forEach((item) => {
          const box = document.createElement("div");
          box.style.padding = "14px";
          box.style.borderRadius = "16px";
          box.style.background = "rgba(255,255,255,0.03)";
          box.style.border = "1px solid rgba(255,255,255,0.07)";
          box.innerHTML = `
            <div style="font-size:0.78rem;color:rgba(244,234,211,0.64);margin-bottom:6px;letter-spacing:0.04em;text-transform:uppercase;">
              ${escapeHtml(item.label)}
            </div>
            <div style="font-size:0.98rem;color:#f8f3e8;font-weight:700;">
              ${escapeHtml(item.value)}
            </div>
          `;
          stats.appendChild(box);
        });

        const bottom = document.createElement("div");
        bottom.style.display = "flex";
        bottom.style.alignItems = "center";
        bottom.style.justifyContent = "space-between";
        bottom.style.flexWrap = "wrap";
        bottom.style.gap = "12px";

        const codeText = document.createElement("div");
        codeText.style.color = "rgba(244,234,211,0.72)";
        codeText.style.fontSize = "0.92rem";
        codeText.innerHTML = reward.code
          ? `<strong style="color:#f4ead3;">Code:</strong> ${escapeHtml(reward.code)}`
          : `<strong style="color:#f4ead3;">Last updated:</strong> ${escapeHtml(
              formatDateTime(reward.createdAt || reward.expiresAt || reward.redeemedAt)
            )}`;

        const action =
          reward.ctaHref && reward.ctaHref !== "#"
            ? document.createElement("a")
            : document.createElement("button");

        if (action.tagName === "A") {
          action.href = reward.ctaHref;
          action.target = "_self";
          action.rel = "noopener noreferrer";
        } else {
          action.type = "button";
          action.disabled = true;
        }

        action.textContent = reward.ctaLabel || "View Reward";
        action.style.display = "inline-flex";
        action.style.alignItems = "center";
        action.style.justifyContent = "center";
        action.style.padding = "12px 16px";
        action.style.borderRadius = "14px";
        action.style.border = "0";
        action.style.fontWeight = "700";
        action.style.textDecoration = "none";
        action.style.background =
          "linear-gradient(135deg, rgba(216,176,94,0.95), rgba(162,124,48,0.96))";
        action.style.color = "#140f07";
        action.style.boxShadow = "0 14px 30px rgba(216,176,94,0.18)";

        bottom.appendChild(codeText);
        bottom.appendChild(action);

        card.appendChild(top);
        card.appendChild(stats);
        card.appendChild(bottom);

        container.appendChild(card);
      });
    });
  }

  async function loadRewards() {
    state.isLoading = true;

    const pageStatus =
      document.querySelector("[data-rewards-page-status]") ||
      document.querySelector("#rewards-page-status") ||
      document.querySelector("[data-rewards-status]");

    clearStatus(pageStatus);

    try {
      const result = await fetchJson(CONFIG.rewardsEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return false;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return false;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to load your rewards."
        );
      }

      const payload = inferRewardsPayload(result.data);

      state.rewards = Array.isArray(payload.rewards) ? payload.rewards : [];
      applyMember(payload.member);
      applySupport(payload.support);
      applySummary(payload.summary, state.rewards);
      renderRewards(state.rewards);

      return true;
    } catch (error) {
      renderRewards([]);
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your rewards right now."
      );
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  function bindLogoutButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-logout]");
      if (!trigger) return;

      event.preventDefault();

      if (window.CardLeoAuthGuard?.logout) {
        await window.CardLeoAuthGuard.logout(CONFIG.authGuardOptions);
      } else {
        window.location.href = CONFIG.loginPage;
      }
    });
  }

  function bindRefreshButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-rewards-refresh]");
      if (!trigger) return;

      event.preventDefault();
      await loadRewards();
    });
  }

  async function init() {
    try {
      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      bindLogoutButtons();
      bindRefreshButtons();

      await loadRewards();
    } catch (error) {
      const pageStatus =
        document.querySelector("[data-rewards-page-status]") ||
        document.querySelector("#rewards-page-status") ||
        document.querySelector("[data-rewards-status]");

      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your rewards page."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalRewards = {
    init,
    reload: loadRewards,
    getState: function () {
      return {
        member: state.member,
        rewards: state.rewards,
        summary: state.summary,
        support: state.support,
        isLoading: state.isLoading,
      };
    },
  };
})();