// assets/js/admin-rewards.js

(() => {
  const API = {
    rewards: "/api/admin/rewards",
    createReward: "/api/admin/rewards/create",
    updateReward: "/api/admin/rewards/update",
    deleteReward: "/api/admin/rewards/delete",
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

    createRewardButton: document.getElementById("createRewardButton"),
    refreshButton: document.getElementById("refreshButton"),
    applyFiltersButton: document.getElementById("applyFiltersButton"),

    searchInput: document.getElementById("searchInput"),
    statusFilter: document.getElementById("statusFilter"),
    categoryFilter: document.getElementById("categoryFilter"),

    rewardsStatusBadge: document.getElementById("rewardsStatusBadge"),

    totalRewards: document.getElementById("totalRewards"),
    activeRewards: document.getElementById("activeRewards"),
    referralValue: document.getElementById("referralValue"),
    pendingRewards: document.getElementById("pendingRewards"),

    rewardsTableBody: document.getElementById("rewardsTableBody"),

    formTitle: document.getElementById("formTitle"),
    rewardForm: document.getElementById("rewardForm"),
    rewardId: document.getElementById("rewardId"),
    rewardTitle: document.getElementById("rewardTitle"),
    rewardDescription: document.getElementById("rewardDescription"),
    rewardCategory: document.getElementById("rewardCategory"),
    rewardStatus: document.getElementById("rewardStatus"),
    rewardValue: document.getElementById("rewardValue"),
    rewardCode: document.getElementById("rewardCode"),
    rewardVisibility: document.getElementById("rewardVisibility"),
    saveRewardButton: document.getElementById("saveRewardButton"),
    resetFormButton: document.getElementById("resetFormButton"),

    cardSubtitle: document.getElementById("cardSubtitle"),
    cardStatus: document.getElementById("cardStatus"),
  };

  let rewards = [];

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

  function defaultRewards() {
    return [
      {
        id: "referral-reward",
        title: "Approved Referral Reward",
        description:
          "Earn $7 for every approved member who joins through a referral link.",
        category: "referral",
        status: "active",
        value: CONFIG.referralRewardAmount,
        code: "REFERRAL-7",
        visibility: "member",
      },
      {
        id: "monthly-leaderboard",
        title: "Monthly Leaderboard Reward",
        description:
          "Members compete monthly for top referral placement and reward opportunities.",
        category: "leaderboard",
        status: "active",
        value: 0,
        code: "LEADERBOARD",
        visibility: "member",
      },
      {
        id: "lifestyle-benefits",
        title: "Lifestyle Benefit Access",
        description:
          "Dining, travel, shopping, entertainment, and member lifestyle value.",
        category: "lifestyle",
        status: "active",
        value: 0,
        code: "LIFESTYLE",
        visibility: "member",
      },
      {
        id: "monthly-payout-window",
        title: "Monthly Payout Window",
        description:
          "Monthly reward payouts are prepared between the 1st and 3rd.",
        category: "payouts",
        status: "active",
        value: 0,
        code: "PAYOUT-1-3",
        visibility: "member",
      },
      {
        id: "membership-billing-rule",
        title: "Membership Billing Rule",
        description:
          "$25 one-time activation fee, then $20 recurring monthly membership billed on the 10th.",
        category: "billing",
        status: "active",
        value: CONFIG.monthlyFee,
        code: "BILLING-25-20",
        visibility: "admin",
      },
      {
        id: "automatic-approval-rule",
        title: "Automatic Approval After Payment",
        description:
          "Members are automatically approved after successful payment confirmation.",
        category: "account",
        status: "active",
        value: 0,
        code: "AUTO-APPROVAL",
        visibility: "admin",
      },
    ];
  }

  function normalizeReward(row, index) {
    return {
      id:
        normalizeText(row.id) ||
        normalizeText(row.reward_id) ||
        normalizeText(row.rewardId) ||
        `reward-${index + 1}`,
      title:
        normalizeText(row.title) ||
        normalizeText(row.name) ||
        `Reward ${index + 1}`,
      description:
        normalizeText(row.description) ||
        normalizeText(row.details) ||
        "Card Leo Rewards member reward.",
      category:
        normalizeText(row.category) ||
        normalizeText(row.type) ||
        "referral",
      status:
        normalizeText(row.status) ||
        normalizeText(row.state) ||
        "active",
      value: Number(row.value || row.amount || row.reward_amount || 0),
      code:
        normalizeText(row.code) ||
        normalizeText(row.reward_code) ||
        normalizeText(row.reference),
      visibility:
        normalizeText(row.visibility) ||
        normalizeText(row.visible_to) ||
        "member",
    };
  }

  function normalizePayload(payload = {}) {
    const root = unwrap(payload);

    const rows = Array.isArray(root.rewards)
      ? root.rewards
      : Array.isArray(root.rows)
        ? root.rows
        : Array.isArray(root.items)
          ? root.items
          : [];

    return rows.length ? rows.map(normalizeReward) : defaultRewards();
  }

  function renderStats() {
    const total = rewards.length;
    const active = rewards.filter((reward) => reward.status === "active").length;
    const pending = rewards.filter((reward) =>
      ["pending", "locked", "processing"].includes(reward.status)
    ).length;

    const referralReward = rewards.find(
      (reward) => reward.category === "referral" && Number(reward.value) > 0
    );

    if (els.totalRewards) els.totalRewards.textContent = String(total);
    if (els.activeRewards) els.activeRewards.textContent = String(active);
    if (els.pendingRewards) els.pendingRewards.textContent = String(pending);
    if (els.referralValue) {
      els.referralValue.textContent = money(
        referralReward?.value || CONFIG.referralRewardAmount
      );
    }

    if (els.cardSubtitle) {
      els.cardSubtitle.textContent = `${active} active rewards`;
    }

    if (els.cardStatus) {
      els.cardStatus.textContent = `${total} Total`;
    }

    document.querySelectorAll("[data-total-rewards]").forEach((node) => {
      node.textContent = String(total);
    });

    document.querySelectorAll("[data-active-rewards]").forEach((node) => {
      node.textContent = String(active);
    });

    document.querySelectorAll("[data-pending-rewards]").forEach((node) => {
      node.textContent = String(pending);
    });

    document.querySelectorAll("[data-referral-value]").forEach((node) => {
      node.textContent = money(referralReward?.value || CONFIG.referralRewardAmount);
    });
  }

  function getFilteredRewards() {
    const search = normalizeText(els.searchInput?.value).toLowerCase();
    const status = normalizeText(els.statusFilter?.value).toLowerCase();
    const category = normalizeText(els.categoryFilter?.value).toLowerCase();

    return rewards.filter((reward) => {
      const matchesSearch =
        !search ||
        reward.title.toLowerCase().includes(search) ||
        reward.description.toLowerCase().includes(search) ||
        reward.code.toLowerCase().includes(search) ||
        reward.category.toLowerCase().includes(search);

      const matchesStatus = !status || reward.status === status;
      const matchesCategory = !category || reward.category === category;

      return matchesSearch && matchesStatus && matchesCategory;
    });
  }

  function renderTable() {
    if (!els.rewardsTableBody) return;

    const rows = getFilteredRewards();

    if (!rows.length) {
      els.rewardsTableBody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-box">No rewards found.</div>
          </td>
        </tr>
      `;
      return;
    }

    els.rewardsTableBody.innerHTML = rows
      .map((reward) => {
        const status = reward.status.toLowerCase();

        return `
          <tr>
            <td>
              <strong>${escapeHtml(reward.title)}</strong>
              <div class="muted">${escapeHtml(reward.description)}</div>
              ${
                reward.code
                  ? `<div class="muted">Code: ${escapeHtml(reward.code)}</div>`
                  : ""
              }
            </td>

            <td>${escapeHtml(titleCase(reward.category))}</td>

            <td class="money">${escapeHtml(money(reward.value))}</td>

            <td>
              <span class="status-tag ${escapeHtml(status)}">
                ${escapeHtml(titleCase(status))}
              </span>
            </td>

            <td>${escapeHtml(titleCase(reward.visibility))}</td>

            <td>
              <div class="row-actions">
                <button class="mini-btn" type="button" data-edit="${escapeHtml(reward.id)}">
                  Edit
                </button>

                ${
                  status === "active"
                    ? `<button class="mini-btn danger" type="button" data-toggle="${escapeHtml(reward.id)}" data-status="inactive">Deactivate</button>`
                    : `<button class="mini-btn activate" type="button" data-toggle="${escapeHtml(reward.id)}" data-status="active">Activate</button>`
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function resetForm() {
    if (els.formTitle) els.formTitle.textContent = "Create Reward";
    if (els.rewardId) els.rewardId.value = "";
    if (els.rewardTitle) els.rewardTitle.value = "";
    if (els.rewardDescription) els.rewardDescription.value = "";
    if (els.rewardCategory) els.rewardCategory.value = "referral";
    if (els.rewardStatus) els.rewardStatus.value = "active";
    if (els.rewardValue) els.rewardValue.value = "";
    if (els.rewardCode) els.rewardCode.value = "";
    if (els.rewardVisibility) els.rewardVisibility.value = "member";

    showBanner("");
  }

  function editReward(id) {
    const reward = rewards.find((item) => item.id === id);

    if (!reward) {
      showBanner("Reward not found.", "error");
      return;
    }

    if (els.formTitle) els.formTitle.textContent = "Update Reward";
    if (els.rewardId) els.rewardId.value = reward.id;
    if (els.rewardTitle) els.rewardTitle.value = reward.title;
    if (els.rewardDescription) els.rewardDescription.value = reward.description;
    if (els.rewardCategory) els.rewardCategory.value = reward.category;
    if (els.rewardStatus) els.rewardStatus.value = reward.status;
    if (els.rewardValue) els.rewardValue.value = reward.value;
    if (els.rewardCode) els.rewardCode.value = reward.code;
    if (els.rewardVisibility) els.rewardVisibility.value = reward.visibility;

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function getFormData() {
    return {
      id: normalizeText(els.rewardId?.value),
      title: normalizeText(els.rewardTitle?.value),
      description: normalizeText(els.rewardDescription?.value),
      category: normalizeText(els.rewardCategory?.value, "referral"),
      status: normalizeText(els.rewardStatus?.value, "active"),
      value: Number(els.rewardValue?.value || 0),
      code: normalizeText(els.rewardCode?.value),
      visibility: normalizeText(els.rewardVisibility?.value, "member"),
      referral_reward_amount: CONFIG.referralRewardAmount,
      activation_fee_amount: CONFIG.activationFee,
      monthly_fee_amount: CONFIG.monthlyFee,
      billing_day: CONFIG.billingDay,
      payout_window: CONFIG.payoutWindow,
    };
  }

  async function loadRewards() {
    setLoading(els.refreshButton, true, "Refreshing...");

    if (els.rewardsStatusBadge) {
      els.rewardsStatusBadge.textContent = "Loading";
      els.rewardsStatusBadge.className = "status-pill pending";
    }

    try {
      const data = await fetchJson(API.rewards);

      rewards = normalizePayload(data);

      renderStats();
      renderTable();

      if (els.rewardsStatusBadge) {
        els.rewardsStatusBadge.textContent = "Loaded";
        els.rewardsStatusBadge.className = "status-pill";
      }

      showBanner("Rewards loaded.", "success");
    } catch (error) {
      console.error("[admin-rewards] load error:", error);

      rewards = defaultRewards();

      renderStats();
      renderTable();

      if (els.rewardsStatusBadge) {
        els.rewardsStatusBadge.textContent = "Fallback";
        els.rewardsStatusBadge.className = "status-pill pending";
      }

      showBanner(
        error?.message || "Unable to load API rewards. Showing default reward rules.",
        "warning"
      );
    } finally {
      setLoading(els.refreshButton, false, "Refresh Rewards");
    }
  }

  async function saveReward(event) {
    event.preventDefault();

    const formData = getFormData();

    if (!formData.title) {
      showBanner("Please enter a reward title.", "error");
      els.rewardTitle?.focus();
      return;
    }

    if (!formData.description) {
      showBanner("Please enter a reward description.", "error");
      els.rewardDescription?.focus();
      return;
    }

    setLoading(els.saveRewardButton, true, "Saving...");

    try {
      const isUpdate = Boolean(formData.id);

      const data = await fetchJson(isUpdate ? API.updateReward : API.createReward, {
        method: "POST",
        body: JSON.stringify(formData),
      });

      const savedReward = normalizeReward(
        data.reward || data.item || formData,
        rewards.length
      );

      if (isUpdate) {
        rewards = rewards.map((reward) =>
          reward.id === formData.id ? { ...reward, ...savedReward } : reward
        );
      } else {
        rewards = [
          ...rewards,
          {
            ...savedReward,
            id: savedReward.id || `reward-${Date.now()}`,
          },
        ];
      }

      renderStats();
      renderTable();
      resetForm();

      showBanner(
        data?.message || `Reward ${isUpdate ? "updated" : "created"} successfully.`,
        "success"
      );
    } catch (error) {
      console.error("[admin-rewards] save error:", error);

      showBanner(error?.message || "Unable to save reward.", "error");
    } finally {
      setLoading(els.saveRewardButton, false, "Save Reward");
    }
  }

  async function toggleRewardStatus(id, status) {
    const reward = rewards.find((item) => item.id === id);

    if (!reward) {
      showBanner("Reward not found.", "error");
      return;
    }

    try {
      await fetchJson(API.updateReward, {
        method: "POST",
        body: JSON.stringify({
          ...reward,
          status,
        }),
      });

      rewards = rewards.map((item) =>
        item.id === id ? { ...item, status } : item
      );

      renderStats();
      renderTable();

      showBanner(`Reward marked ${titleCase(status)}.`, "success");
    } catch (error) {
      console.error("[admin-rewards] toggle error:", error);

      rewards = rewards.map((item) =>
        item.id === id ? { ...item, status } : item
      );

      renderStats();
      renderTable();

      showBanner(
        error?.message ||
          "Reward status updated locally, but the API did not confirm.",
        "warning"
      );
    }
  }

  async function deleteReward(id) {
    const reward = rewards.find((item) => item.id === id);

    if (!reward) {
      showBanner("Reward not found.", "error");
      return;
    }

    const confirmed = window.confirm(
      `Delete reward "${reward.title}"? This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await fetchJson(API.deleteReward, {
        method: "POST",
        body: JSON.stringify({
          id,
        }),
      });

      rewards = rewards.filter((item) => item.id !== id);

      renderStats();
      renderTable();

      showBanner("Reward deleted.", "success");
    } catch (error) {
      console.error("[admin-rewards] delete error:", error);

      showBanner(error?.message || "Unable to delete reward.", "error");
    }
  }

  function exportCsv() {
    const rows = getFilteredRewards();

    const headers = [
      "Reward ID",
      "Title",
      "Description",
      "Category",
      "Status",
      "Value",
      "Code",
      "Visibility",
    ];

    const csvRows = [
      headers,
      ...rows.map((reward) => [
        reward.id,
        reward.title,
        reward.description,
        reward.category,
        reward.status,
        reward.value,
        reward.code,
        reward.visibility,
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
    link.download = "card-leo-rewards.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showBanner("Rewards CSV exported.", "success");
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
      console.error("[admin-rewards] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function bindEvents() {
    els.createRewardButton?.addEventListener("click", () => {
      resetForm();

      window.scrollTo({
        top: 0,
        behavior: "smooth",
      });

      els.rewardTitle?.focus();
    });

    els.refreshButton?.addEventListener("click", loadRewards);

    els.applyFiltersButton?.addEventListener("click", () => {
      renderTable();
      showBanner("Filters applied.", "success");
    });

    els.searchInput?.addEventListener("input", renderTable);
    els.statusFilter?.addEventListener("change", renderTable);
    els.categoryFilter?.addEventListener("change", renderTable);

    els.rewardForm?.addEventListener("submit", saveReward);
    els.resetFormButton?.addEventListener("click", resetForm);

    els.logoutButton?.addEventListener("click", handleLogout);

    els.rewardsTableBody?.addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit]");
      const toggleButton = event.target.closest("[data-toggle]");
      const deleteButton = event.target.closest("[data-delete]");

      if (editButton) {
        editReward(editButton.getAttribute("data-edit"));
        return;
      }

      if (toggleButton) {
        toggleRewardStatus(
          toggleButton.getAttribute("data-toggle"),
          toggleButton.getAttribute("data-status")
        );
        return;
      }

      if (deleteButton) {
        deleteReward(deleteButton.getAttribute("data-delete"));
      }
    });

    document.querySelectorAll("[data-export-rewards]").forEach((button) => {
      if (button.dataset.exportRewardsBound === "true") return;

      button.dataset.exportRewardsBound = "true";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        exportCsv();
      });
    });
  }

  function init() {
    setStaticText();
    bindEvents();
    loadRewards();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, {
      once: true,
    });
  } else {
    init();
  }

  window.CardLeoAdminRewards = {
    init,
    reload: loadRewards,
    saveReward,
    editReward,
    toggleRewardStatus,
    deleteReward,
    exportCsv,
    getState() {
      return {
        rewards: [...rewards],
      };
    },
    helpers: {
      money,
      titleCase,
      defaultRewards,
    },
  };
})();