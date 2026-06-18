// assets/js/portal-billing.js

(() => {
  const API = {
    me: "/api/auth/me",
    billingPortal: "/api/billing/portal",
    createCheckout: "/api/billing/create-checkout-session",
    logout: "/api/auth/logout",
  };

  const CONFIG = {
    activationFee: 25,
    monthlyFee: 20,
    billingDay: 10,
    payoutWindow: "1st–3rd monthly",
    successUrl:
      window.location.origin +
      "/thank-you.html?payment=success&membership=activated",
    cancelUrl: window.location.origin + "/portal/billing.html?payment=cancelled",
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

  const els = {
    statusBanner: document.getElementById("statusBanner"),

    logoutButton: document.getElementById("logoutButton"),

    manageBillingButtons: [
      document.getElementById("manageBillingButton"),
      document.getElementById("manageBillingButtonTwo"),
      document.getElementById("manageBillingButtonThree"),
    ].filter(Boolean),

    activateButtons: [
      document.getElementById("activateMembershipButton"),
      document.getElementById("activateMembershipButtonTwo"),
      document.getElementById("activateMembershipButtonThree"),
    ].filter(Boolean),

    cardMemberName: document.getElementById("cardMemberName"),
    cardMemberTier: document.getElementById("cardMemberTier"),
    cardBillingStatus: document.getElementById("cardBillingStatus"),
    cardBillingPlan: document.getElementById("cardBillingPlan"),

    billingStatusBadge: document.getElementById("billingStatusBadge"),

    memberName: document.getElementById("memberName"),
    memberEmail: document.getElementById("memberEmail"),
    memberTier: document.getElementById("memberTier"),
    membershipStatus: document.getElementById("membershipStatus"),
    paymentStatus: document.getElementById("paymentStatus"),
    approvalStatus: document.getElementById("approvalStatus"),
    stripeCustomer: document.getElementById("stripeCustomer"),
    subscriptionId: document.getElementById("subscriptionId"),
    nextBillingDate: document.getElementById("nextBillingDate"),
    portalAccess: document.getElementById("portalAccess"),

    heroCopy: document.getElementById("heroCopy"),
  };

  const state = {
    member: null,
    loading: false,
  };

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

  function money(value) {
    const number = Number(value || 0);

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number.isFinite(number) ? number : 0);
  }

  function formatDate(value) {
    if (!value) return `${CONFIG.billingDay}th monthly`;

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
      member?.payment_status || member?.paymentStatus || "payment_pending"
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

  function getStatusLabel(member) {
    const status = getStatus(member);

    if (isPaidActive(member)) return "Active";
    if (isBadStatus(member)) return titleCase(status);
    if (isPendingPayment(member)) return "Payment Required";

    return titleCase(status || "Payment Required");
  }

  function getPaymentLabel(member) {
    const paymentStatus = getPaymentStatus(member);

    if (paymentStatus === "succeeded") return "Paid";
    if (paymentStatus === "current") return "Current";
    if (paymentStatus === "payment_pending") return "Payment Pending";
    if (paymentStatus === "pending_payment") return "Payment Pending";
    if (paymentStatus === "past_due") return "Past Due";

    return titleCase(paymentStatus || "Payment Pending");
  }

  function getApprovalLabel(member) {
    const approvalStatus = getApprovalStatus(member);

    if (isPaidActive(member)) return "Auto Approved";
    if (approvalStatus === "payment_pending") return "Payment Pending";
    if (approvalStatus === "pending_payment") return "Payment Pending";

    return titleCase(approvalStatus || "Automatic After Payment");
  }

  function statusBadgeClass(label) {
    const value = normalizeText(label).toLowerCase();

    if (
      value.includes("pending") ||
      value.includes("required") ||
      value.includes("past due") ||
      value.includes("unpaid")
    ) {
      return "status-pill pending";
    }

    if (
      value.includes("declined") ||
      value.includes("denied") ||
      value.includes("cancel") ||
      value.includes("failed") ||
      value.includes("suspended")
    ) {
      return "status-pill error";
    }

    return "status-pill";
  }

  function getNextBillingDate(member) {
    return (
      member?.next_billing_date ||
      member?.nextBillingDate ||
      member?.current_period_end ||
      member?.currentPeriodEnd ||
      ""
    );
  }

  function renderMember(member) {
    state.member = member || {};

    const fullName = getFullName(state.member);
    const tier = getTier(state.member);
    const email = normalizeText(state.member?.email, "Member account");
    const statusLabel = getStatusLabel(state.member);
    const paymentLabel = getPaymentLabel(state.member);
    const approvalLabel = getApprovalLabel(state.member);
    const paid = isPaidActive(state.member);

    const stripeCustomerId =
      normalizeText(state.member?.stripe_customer_id) ||
      normalizeText(state.member?.stripeCustomerId) ||
      "—";

    const subscription =
      normalizeText(state.member?.stripe_subscription_id) ||
      normalizeText(state.member?.stripeSubscriptionId) ||
      "—";

    const nextBilling = getNextBillingDate(state.member);

    if (els.cardMemberName) els.cardMemberName.textContent = fullName;
    if (els.cardMemberTier) els.cardMemberTier.textContent = tier;
    if (els.cardBillingStatus) {
      els.cardBillingStatus.textContent = paid
        ? "Billing Active"
        : "Payment Required";
    }
    if (els.cardBillingPlan) {
      els.cardBillingPlan.textContent = `${money(CONFIG.monthlyFee)} Monthly`;
    }

    if (els.memberName) els.memberName.textContent = fullName;
    if (els.memberEmail) els.memberEmail.textContent = email;
    if (els.memberTier) els.memberTier.textContent = tier;
    if (els.membershipStatus) els.membershipStatus.textContent = statusLabel;
    if (els.paymentStatus) els.paymentStatus.textContent = paymentLabel;
    if (els.approvalStatus) els.approvalStatus.textContent = approvalLabel;
    if (els.stripeCustomer) els.stripeCustomer.textContent = stripeCustomerId;
    if (els.subscriptionId) els.subscriptionId.textContent = subscription;
    if (els.nextBillingDate) els.nextBillingDate.textContent = formatDate(nextBilling);
    if (els.portalAccess) {
      els.portalAccess.textContent = paid ? "Enabled" : "Payment Required";
    }

    if (els.billingStatusBadge) {
      els.billingStatusBadge.textContent = paid
        ? "Billing Active"
        : "Payment Required";

      els.billingStatusBadge.className = statusBadgeClass(
        paid ? "Billing Active" : "Payment Required"
      );
    }

    if (els.heroCopy) {
      els.heroCopy.textContent = paid
        ? "Your membership billing is active. You can manage your payment method, subscription, and billing details from this page."
        : "Your membership payment is still required. Complete activation to unlock full member portal access.";
    }

    document.querySelectorAll("[data-member-name]").forEach((node) => {
      node.textContent = fullName;
    });

    document.querySelectorAll("[data-member-email]").forEach((node) => {
      node.textContent = email;
    });

    document.querySelectorAll("[data-member-tier]").forEach((node) => {
      node.textContent = tier;
    });

    document.querySelectorAll("[data-payment-status]").forEach((node) => {
      node.textContent = paymentLabel;
    });

    document.querySelectorAll("[data-approval-status]").forEach((node) => {
      node.textContent = approvalLabel;
    });

    document.querySelectorAll("[data-portal-access]").forEach((node) => {
      node.textContent = paid ? "Enabled" : "Payment Required";
    });

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = email;
    document.body.dataset.memberStatus = getStatus(state.member);
    document.body.dataset.memberPaymentStatus = getPaymentStatus(state.member);
    document.body.dataset.memberApprovalStatus = getApprovalStatus(state.member);
    document.body.dataset.portalAccess = paid ? "enabled" : "payment_required";

    document.querySelectorAll("[data-paid-only]").forEach((node) => {
      node.hidden = !paid;
    });

    document.querySelectorAll("[data-payment-required-only]").forEach((node) => {
      node.hidden = paid;
    });

    showBanner(
      paid
        ? "Your billing status is active."
        : "Membership payment is required before full portal access is unlocked.",
      paid ? "success" : "warning"
    );
  }

  function setButtonLoading(buttons, loading, text) {
    buttons.forEach((button) => {
      button.disabled = loading;

      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }

      button.textContent = loading ? text : button.dataset.originalText;
    });
  }

  async function loadSession() {
    state.loading = true;

    try {
      const data = await fetchJson(API.me);

      if (!data) return;

      if (data.authenticated === false) {
        redirectToLogin();
        return;
      }

      const member = data.member || data.profile || data.user || null;

      if (!member) {
        showBanner("We could not load your member billing profile.", "error");
        return;
      }

      renderMember(member);
    } catch (error) {
      console.error("[portal-billing] load error:", error);

      showBanner(
        error?.message || "Unable to load billing information right now.",
        "error"
      );
    } finally {
      state.loading = false;
    }
  }

  async function openBillingPortal() {
    setButtonLoading(els.manageBillingButtons, true, "Opening...");

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
        showBanner(
          "Billing portal is not available yet. Please contact support.",
          "warning"
        );
        return;
      }

      window.location.href = url;
    } catch (error) {
      console.error("[portal-billing] billing portal error:", error);

      showBanner(
        error?.message || "Unable to open billing portal right now.",
        "error"
      );
    } finally {
      setButtonLoading(els.manageBillingButtons, false, "Manage Billing");
    }
  }

  async function startCheckout() {
    setButtonLoading(els.activateButtons, true, "Preparing...");

    try {
      const member = state.member || {};

      const signupId = member.id || member.signup_id || member.signupId || "";

      const data = await fetchJson(API.createCheckout, {
        method: "POST",
        body: JSON.stringify({
          signup_id: signupId,
          signupId,

          email: member.email,

          firstName: member.firstName || member.first_name,
          first_name: member.firstName || member.first_name,

          lastName: member.lastName || member.last_name,
          last_name: member.lastName || member.last_name,

          fullName: getFullName(member),
          full_name: getFullName(member),

          activation_fee_amount: CONFIG.activationFee,
          monthly_fee_amount: CONFIG.monthlyFee,
          billing_day: CONFIG.billingDay,

          success_url:
            CONFIG.successUrl +
            "&signup_id=" +
            encodeURIComponent(signupId || "") +
            "&session_id={CHECKOUT_SESSION_ID}",

          cancel_url:
            CONFIG.cancelUrl +
            "&signup_id=" +
            encodeURIComponent(signupId || ""),
        }),
      });

      const url =
        data?.url ||
        data?.checkout_url ||
        data?.checkoutUrl ||
        data?.payment_url ||
        data?.paymentUrl ||
        data?.redirectTo;

      if (!url) {
        showBanner(
          "Checkout could not be started because no payment link was returned.",
          "error"
        );
        return;
      }

      window.location.href = url;
    } catch (error) {
      console.error("[portal-billing] checkout error:", error);

      showBanner(
        error?.message || "Unable to start secure checkout right now.",
        "error"
      );
    } finally {
      setButtonLoading(els.activateButtons, false, "Complete Activation");
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
      console.error("[portal-billing] logout error:", error);

      els.logoutButton.disabled = false;
      els.logoutButton.textContent = originalText;

      alert("We couldn't log you out right now. Please try again.");
    }
  }

  function handlePaymentQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const payment = String(params.get("payment") || "").toLowerCase();

    if (payment === "cancelled" || payment === "canceled") {
      showBanner(
        "Payment was cancelled. You can restart activation here.",
        "warning"
      );
    }

    if (payment === "success") {
      showBanner(
        "Payment was successful. Your membership should update automatically once confirmation is complete.",
        "success"
      );
    }
  }

  function bindEvents() {
    els.manageBillingButtons.forEach((button) => {
      button.addEventListener("click", openBillingPortal);
    });

    els.activateButtons.forEach((button) => {
      button.addEventListener("click", startCheckout);
    });

    els.logoutButton?.addEventListener("click", handleLogout);

    document
      .querySelectorAll("[data-billing-portal], [data-open-billing]")
      .forEach((button) => {
        if (button.dataset.portalBillingBound === "true") return;

        button.dataset.portalBillingBound = "true";

        button.addEventListener("click", (event) => {
          event.preventDefault();
          openBillingPortal();
        });
      });

    document
      .querySelectorAll("[data-start-checkout], [data-complete-activation]")
      .forEach((button) => {
        if (button.dataset.portalCheckoutBound === "true") return;

        button.dataset.portalCheckoutBound = "true";

        button.addEventListener("click", (event) => {
          event.preventDefault();
          startCheckout();
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
    handlePaymentQueryParams();
    loadSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.CardLeoPortalBilling = {
    init,
    reload: loadSession,
    openBillingPortal,
    startCheckout,
    getState() {
      return { ...state };
    },
    helpers: {
      isPaidActive,
      isPendingPayment,
      isBadStatus,
      money,
      formatDate,
    },
  };
})();