// assets/js/portal-referral-tower.js
(function () {
  const CONFIG = {
    endpoint: "/api/portal/referral-tower",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
  };

  const state = {
    loading: false,
    payload: null,
  };

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function money(value) {
    const num = Number(value || 0);

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number.isFinite(num) ? num : 0);
  }

  function unwrap(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    let payload = {};

    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (response.status === 401) {
      window.location.href =
        CONFIG.loginPage +
        "?next=" +
        encodeURIComponent(window.location.pathname + window.location.search);
      return null;
    }

    if (response.status === 403) {
      window.location.href = CONFIG.unauthorizedPage;
      return null;
    }

    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message || "Unable to load referral tower.");
    }

    return unwrap(payload);
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setStatus(message, type = "info") {
    document.querySelectorAll("[data-referral-tower-status]").forEach((node) => {
      if (!message) {
        node.hidden = true;
        node.textContent = "";
        node.dataset.state = "";
        return;
      }

      node.hidden = false;
      node.textContent = message;
      node.dataset.state = type;
    });
  }

  function getFloorClass(floor) {
    if (floor.state === "earned") return "tower-floor earned";
    if (floor.state === "pending") return "tower-floor pending";
    if (floor.state === "closed") return "tower-floor closed";
    return "tower-floor empty";
  }

  function renderSummary(payload) {
    const summary = payload?.summary || {};

    setText("[data-referral-member-name]", payload?.member?.name || "Member");
    setText("[data-referral-total]", summary.totalReferrals || 0);
    setText("[data-referral-approved]", summary.approvedReferrals || 0);
    setText("[data-referral-pending]", summary.pendingReferrals || 0);
    setText("[data-referral-earned]", money(summary.earnedAmount));
    setText("[data-referral-pending-money]", money(summary.pendingAmount));
    setText(
      "[data-referral-rank]",
      summary.leaderboardRank ? `#${summary.leaderboardRank}` : "Unranked"
    );
    setText(
      "[data-referral-next]",
      `${summary.referralsUntilNextMilestone || 0} approved referrals to level ${
        summary.nextMilestone || 5
      }`
    );

    document.querySelectorAll("[data-referral-link]").forEach((node) => {
      node.value = payload?.member?.referralLink || "";
      node.textContent = payload?.member?.referralLink || "";
    });
  }

  function renderTower(payload) {
    const container = document.querySelector("[data-referral-tower-floors]");
    if (!container) return;

    const floors = Array.isArray(payload?.tower?.floors)
      ? [...payload.tower.floors].reverse()
      : [];

    container.innerHTML = floors
      .map((floor) => {
        const amount = Number(floor.amount || 0);

        return `
          <div class="${getFloorClass(floor)}" title="${escapeHtml(
            floor.label || ""
          )}">
            <span class="tower-floor-number">${escapeHtml(floor.floor)}</span>
            <span class="tower-floor-name">${escapeHtml(
              floor.label || "Open floor"
            )}</span>
            <span class="tower-floor-money">
              ${amount > 0 ? escapeHtml(money(amount)) : "—"}
            </span>
          </div>
        `;
      })
      .join("");
  }

  function renderLeaderboard(payload) {
    const container = document.querySelector("[data-referral-leaderboard]");
    if (!container) return;

    const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];

    if (!rows.length) {
      container.innerHTML = `
        <div class="tower-empty">
          No leaderboard activity yet. The first approved referrals will appear here.
        </div>
      `;
      return;
    }

    container.innerHTML = rows
      .map((row) => {
        return `
          <div class="leaderboard-row">
            <div class="leaderboard-rank">#${escapeHtml(row.rank)}</div>
            <div class="leaderboard-member">
              <strong>${escapeHtml(row.referralName || "Member")}</strong>
              <span>${escapeHtml(row.totalReferrals || 0)} referrals • ${escapeHtml(
                row.approvedReferrals || 0
              )} approved</span>
            </div>
            <div class="leaderboard-money">${escapeHtml(money(row.earnedAmount))}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderRecentReferrals(payload) {
    const container = document.querySelector("[data-referral-recent]");
    if (!container) return;

    const referrals = Array.isArray(payload?.referrals) ? payload.referrals : [];

    if (!referrals.length) {
      container.innerHTML = `
        <div class="tower-empty">
          Your referral tower is ready. Your first approved referral will start building it.
        </div>
      `;
      return;
    }

    container.innerHTML = referrals
      .slice(0, 8)
      .map((referral) => {
        return `
          <div class="recent-referral-row">
            <div>
              <strong>${escapeHtml(referral.name || "New Member")}</strong>
              <span>${escapeHtml(referral.statusLabel || "Pending")}</span>
            </div>
            <div class="recent-referral-money">
              ${referral.approved ? escapeHtml(money(referral.amount)) : "Pending"}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function render(payload) {
    state.payload = payload;

    renderSummary(payload);
    renderTower(payload);
    renderLeaderboard(payload);
    renderRecentReferrals(payload);
  }

  async function copyReferralLink() {
    const link =
      state.payload?.member?.referralLink ||
      document.querySelector("[data-referral-link]")?.value ||
      "";

    if (!link) {
      setStatus("Referral link is not available yet.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(link);
      setStatus("Referral link copied.", "success");
    } catch {
      setStatus("Copy failed. Highlight and copy the referral link manually.", "error");
    }
  }

  async function loadTower() {
    if (state.loading) return;

    state.loading = true;
    setStatus("Loading your referral tower...", "info");

    document.querySelectorAll("[data-referral-tower-refresh]").forEach((button) => {
      button.disabled = true;
    });

    try {
      const payload = await fetchJson(CONFIG.endpoint);
      if (!payload) return;

      render(payload);
      setStatus("Referral tower updated.", "success");
    } catch (error) {
      setStatus(error?.message || "Unable to load referral tower.", "error");
    } finally {
      state.loading = false;

      document.querySelectorAll("[data-referral-tower-refresh]").forEach((button) => {
        button.disabled = false;
      });
    }
  }

  function injectStyles() {
    if (document.getElementById("cardleo-referral-tower-styles")) return;

    const style = document.createElement("style");
    style.id = "cardleo-referral-tower-styles";
    style.textContent = `
      .referral-tower-section {
        margin: 0 0 22px;
      }

      .referral-tower-shell {
        display: grid;
        grid-template-columns: 0.95fr 1.05fr;
        gap: 22px;
        align-items: stretch;
      }

      .referral-tower-card,
      .referral-board-card {
        position: relative;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 30px;
        background:
          radial-gradient(circle at top, rgba(215,179,106,0.13), transparent 34%),
          linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018)),
          rgba(10,19,35,0.84);
        box-shadow: 0 24px 70px rgba(0,0,0,0.34);
        padding: 28px;
        overflow: hidden;
      }

      .referral-tower-card::before,
      .referral-board-card::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(135deg, rgba(255,255,255,0.055), transparent 34%, rgba(215,179,106,0.045));
      }

      .referral-tower-top,
      .referral-board-top {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }

      .referral-tower-title {
        margin: 0;
        font-size: clamp(1.35rem, 3vw, 2rem);
        line-height: 1;
        letter-spacing: -0.04em;
      }

      .referral-tower-copy {
        margin: 8px 0 0;
        color: rgba(245,247,251,0.72);
        line-height: 1.65;
      }

      .referral-link-row {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        margin: 18px 0;
      }

      .referral-link-input {
        width: 100%;
        min-height: 46px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
        color: #f5f7fb;
        padding: 0 16px;
        outline: none;
      }

      .tower-visual {
        position: relative;
        z-index: 1;
        max-width: 430px;
        margin: 0 auto;
        padding: 18px;
        border-radius: 26px;
        background:
          radial-gradient(circle at top, rgba(241,208,141,0.12), transparent 34%),
          rgba(255,255,255,0.025);
        border: 1px solid rgba(255,255,255,0.06);
      }

      .referral-lions {
        width: min(220px, 58vw);
        margin: 0 auto 8px;
        filter: drop-shadow(0 14px 32px rgba(215,179,106,0.34));
      }

      .tower-lions-fallback {
        width: min(220px, 58vw);
        margin: 0 auto 10px;
        padding: 18px;
        text-align: center;
        border-radius: 24px;
        border: 1px solid rgba(215,179,106,0.28);
        color: #fff;
        text-shadow:
          0 0 8px rgba(215,179,106,0.95),
          0 0 18px rgba(215,179,106,0.45);
        font-size: 2rem;
        font-weight: 900;
        letter-spacing: 0.08em;
        background: rgba(215,179,106,0.08);
      }

      .tower-spire {
        width: 62%;
        height: 34px;
        margin: 0 auto;
        clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
        background: linear-gradient(135deg, #f1d08d, #b98625);
        box-shadow: 0 14px 34px rgba(215,179,106,0.2);
      }

      .tower-base {
        height: 22px;
        width: 88%;
        margin: 8px auto 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #f1d08d, #8b6a2d);
        box-shadow: 0 0 28px rgba(215,179,106,0.26);
      }

      .tower-floors {
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin-top: 8px;
      }

      .tower-floor {
        display: grid;
        grid-template-columns: 42px 1fr auto;
        gap: 12px;
        align-items: center;
        min-height: 42px;
        padding: 8px 12px;
        border-radius: 15px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.035);
      }

      .tower-floor.earned {
        background: linear-gradient(135deg, rgba(241,208,141,0.92), rgba(199,156,82,0.92));
        border-color: rgba(241,208,141,0.5);
        color: #1a1307;
        box-shadow: 0 10px 24px rgba(215,179,106,0.18);
      }

      .tower-floor.pending {
        background: linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.08));
        border-color: rgba(255,255,255,0.14);
      }

      .tower-floor.closed {
        opacity: 0.5;
      }

      .tower-floor.empty {
        opacity: 0.34;
      }

      .tower-floor-number {
        width: 31px;
        height: 31px;
        border-radius: 999px;
        display: inline-grid;
        place-items: center;
        font-size: 0.78rem;
        font-weight: 900;
        color: #120d05;
        background: linear-gradient(135deg, #f1d08d, #c79c52);
      }

      .tower-floor.earned .tower-floor-number {
        background: rgba(26,19,7,0.15);
        color: #1a1307;
      }

      .tower-floor-name {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .tower-floor-money {
        font-weight: 900;
        color: #f1d08d;
      }

      .tower-floor.earned .tower-floor-money {
        color: #065f36;
      }

      .tower-stats-grid {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .tower-stat {
        padding: 15px;
        border-radius: 18px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .tower-stat span {
        display: block;
        color: rgba(245,247,251,0.58);
        font-size: 0.72rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-bottom: 6px;
      }

      .tower-stat strong {
        display: block;
        font-size: 1.2rem;
        color: #f5f7fb;
      }

      .leaderboard-list,
      .recent-referrals-list {
        position: relative;
        z-index: 1;
        display: grid;
        gap: 12px;
      }

      .leaderboard-row,
      .recent-referral-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 14px;
        align-items: center;
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .recent-referral-row {
        grid-template-columns: 1fr auto;
      }

      .leaderboard-rank {
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        border-radius: 14px;
        background: linear-gradient(135deg, #f1d08d, #c79c52);
        color: #120d05;
        font-weight: 900;
      }

      .leaderboard-member span,
      .recent-referral-row span {
        display: block;
        margin-top: 4px;
        color: rgba(245,247,251,0.62);
        font-size: 0.9rem;
      }

      .leaderboard-money,
      .recent-referral-money {
        color: #f1d08d;
        font-weight: 900;
      }

      .tower-empty {
        padding: 16px;
        border-radius: 18px;
        border: 1px dashed rgba(255,255,255,0.16);
        color: rgba(245,247,251,0.68);
        text-align: center;
      }

      [data-referral-tower-status] {
        position: relative;
        z-index: 1;
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        color: rgba(245,247,251,0.72);
      }

      [data-referral-tower-status][data-state="success"] {
        color: #bfffe5;
        border-color: rgba(21,209,143,0.24);
        background: rgba(21,209,143,0.1);
      }

      [data-referral-tower-status][data-state="error"] {
        color: #ffd2d8;
        border-color: rgba(255,111,125,0.24);
        background: rgba(255,111,125,0.1);
      }

      @media (max-width: 1120px) {
        .referral-tower-shell {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 760px) {
        .referral-tower-card,
        .referral-board-card {
          padding: 22px;
        }

        .referral-tower-top,
        .referral-board-top {
          flex-direction: column;
        }

        .referral-link-row {
          grid-template-columns: 1fr;
        }

        .tower-stats-grid {
          grid-template-columns: 1fr;
        }

        .tower-floor {
          grid-template-columns: 34px 1fr;
        }

        .tower-floor-money {
          grid-column: 2;
        }

        .leaderboard-row {
          grid-template-columns: auto 1fr;
        }

        .leaderboard-money {
          grid-column: 2;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function bindEvents() {
    document.querySelectorAll("[data-referral-tower-refresh]").forEach((button) => {
      if (button.dataset.boundReferralRefresh === "true") return;

      button.dataset.boundReferralRefresh = "true";
      button.addEventListener("click", loadTower);
    });

    document.querySelectorAll("[data-referral-copy]").forEach((button) => {
      if (button.dataset.boundReferralCopy === "true") return;

      button.dataset.boundReferralCopy = "true";
      button.addEventListener("click", copyReferralLink);
    });
  }

  async function init() {
    injectStyles();
    bindEvents();
    await loadTower();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.CardLeoReferralTower = {
    init,
    reload: loadTower,
    getState: function () {
      return { ...state };
    },
  };
})();