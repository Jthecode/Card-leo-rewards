// assets/js/portal-rewards.js

(function () {
  const CONFIG = {
    meEndpoint: "/api/auth/me",
    rewardsEndpoint: "/api/portal/rewards",
    billingPortalEndpoint: "/api/billing/portal",
    logoutEndpoint: "/api/auth/logout",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",

    activationFee: 25,
    monthlyFee: 20,
    billingDay: 10,
    referralRewardAmount: 7,
    payoutWindow: "1st–3rd monthly",

    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      autoBindLogout: true,
      debug: false,
    },
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
    profile: null,
    rewards: [],
    payouts: [],
    payments: [],
    cycles: [],
    summary: null,
    rewardAccount: null,
    support: null,
    notices: [],
    raw: null,
    isLoading: false,
    authReady: false,
  };

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
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
      .replace(/[_-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function money(value) {
    const num = Number(value || 0);

    if (!Number.isFinite(num)) {
      return "$0.00";
    }

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num);
  }

  function formatNumber(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return "0";
    return new Intl.NumberFormat("en-US").format(num);
  }

  function formatPoints(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return "0 pts";
    return `${new Intl.NumberFormat("en-US").format(num)} pts`;
  }

  function formatDate(value, fallback = "—") {
    if (!value) return fallback;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function formatDateTime(value) {
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

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));

    return {
      response,
      payload,
      data: unwrapApiPayload(payload),
      message: normalizeText(payload?.message || unwrapApiPayload(payload)?.message),
    };
  }

  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.loginPage}?next=${encodeURIComponent(next)}`;
  }

  function redirectToUnauthorized() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.unauthorizedPage}?next=${encodeURIComponent(next)}`;
  }

  function setText(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setHtml(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.innerHTML = String(value ?? "");
    });
  }

  function setHidden(selector, hidden) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.hidden = Boolean(hidden);
    });
  }

  function getStatusNode() {
    return (
      document.querySelector("[data-rewards-page-status]") ||
      document.querySelector("#rewards-page-status") ||
      document.querySelector("[data-rewards-status]") ||
      document.querySelector("#rewards-status") ||
      document.querySelector("#statusBanner")
    );
  }

  function setStatus(target, type, message) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

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
    } else if (type === "warning") {
      el.style.background = "rgba(255, 209, 102, 0.10)";
      el.style.color = "#ffeaa6";
      el.style.borderColor = "rgba(255, 209, 102, 0.28)";
    } else {
      el.style.background = "rgba(216, 176, 94, 0.10)";
      el.style.color = "#f4ead3";
      el.style.borderColor = "rgba(216, 176, 94, 0.25)";
    }
  }

  function clearStatus(target) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function getFullName(member = {}, profile = {}) {
    const fullName =
      normalizeText(member.fullName) ||
      normalizeText(member.full_name) ||
      normalizeText(member.name) ||
      normalizeText(profile.fullName) ||
      normalizeText(profile.full_name) ||
      normalizeText(profile.name);

    if (fullName) return fullName;

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      normalizeText(profile.firstName || profile.first_name);

    const lastName =
      normalizeText(member.lastName || member.last_name) ||
      normalizeText(profile.lastName || profile.last_name);

    return [firstName, lastName].filter(Boolean).join(" ") || "Card Leo Member";
  }

  function getFirstName(member = {}, profile = {}) {
    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      normalizeText(profile.firstName || profile.first_name);

    if (firstName) return firstName;

    return getFullName(member, profile).split(/\s+/)[0] || "Member";
  }

  function getMemberStatus(member = {}, profile = {}) {
    return normalizeText(
      member.membership_status ||
        member.membershipStatus ||
        member.memberStatus ||
        member.member_status ||
        member.status ||
        profile.membership_status ||
        profile.membershipStatus ||
        profile.memberStatus ||
        profile.member_status ||
        profile.status ||
        "payment_pending"
    ).toLowerCase();
  }

  function getPaymentStatus(member = {}, profile = {}) {
    return normalizeText(
      member.payment_status ||
        member.paymentStatus ||
        profile.payment_status ||
        profile.paymentStatus ||
        ""
    ).toLowerCase();
  }

  function getApprovalStatus(member = {}, profile = {}) {
    return normalizeText(
      member.approval_status ||
        member.approvalStatus ||
        profile.approval_status ||
        profile.approvalStatus ||
        ""
    ).toLowerCase();
  }

  function getTier(member = {}, profile = {}) {
    return normalizeText(
      member.tier_name ||
        member.tierName ||
        member.membership_tier ||
        member.membershipTier ||
        member.tier ||
        member.accessLevel ||
        member.access_level ||
        profile.tier_name ||
        profile.tierName ||
        profile.membership_tier ||
        profile.membershipTier ||
        profile.tier ||
        "VIP Member"
    );
  }

  function getStatusLabel(status) {
    const value = normalizeText(status).toLowerCase();

    if (value === "auto_approved") return "Auto Approved";
    if (value === "payment_pending") return "Payment Pending";
    if (value === "pending_payment") return "Payment Pending";
    if (value === "checkout_created") return "Checkout Created";
    if (value === "past_due") return "Past Due";

    return titleCase(value || "Payment Pending");
  }

  function isPaidActive(member = {}, profile = {}) {
    const memberStatus = getMemberStatus(member, profile);
    const paymentStatus = getPaymentStatus(member, profile);
    const approvalStatus = getApprovalStatus(member, profile);

    return (
      ACTIVE_STATUSES.has(memberStatus) ||
      ACTIVE_STATUSES.has(paymentStatus) ||
      ACTIVE_STATUSES.has(approvalStatus)
    );
  }

  function isPendingPayment(member = {}, profile = {}) {
    const memberStatus = getMemberStatus(member, profile);
    const paymentStatus = getPaymentStatus(member, profile);
    const approvalStatus = getApprovalStatus(member, profile);

    return (
      PENDING_STATUSES.has(memberStatus) ||
      PENDING_STATUSES.has(paymentStatus) ||
      PENDING_STATUSES.has(approvalStatus)
    );
  }

  function isBadStatus(member = {}, profile = {}) {
    const memberStatus = getMemberStatus(member, profile);
    const paymentStatus = getPaymentStatus(member, profile);
    const approvalStatus = getApprovalStatus(member, profile);

    return (
      BAD_STATUSES.has(memberStatus) ||
      BAD_STATUSES.has(paymentStatus) ||
      BAD_STATUSES.has(approvalStatus)
    );
  }

  function getPortalAccess(member = {}, profile = {}) {
    if (typeof member.portalAccess === "boolean") return member.portalAccess;
    if (typeof member.portal_access === "boolean") return member.portal_access;

    return isPaidActive(member, profile);
  }

  function getNextBillingDate(member = {}) {
    return (
      member.next_billing_date ||
      member.nextBillingDate ||
      member.current_period_end ||
      member.currentPeriodEnd ||
      ""
    );
  }

  function normalizeMember(member = {}, profile = {}) {
    const safeMember = isObject(member) ? member : {};
    const safeProfile = isObject(profile) ? profile : {};

    const fullName = getFullName(safeMember, safeProfile);
    const firstName = getFirstName(safeMember, safeProfile);
    const status = getMemberStatus(safeMember, safeProfile);
    const paymentStatus = getPaymentStatus(safeMember, safeProfile);
    const approvalStatus =
      getApprovalStatus(safeMember, safeProfile) ||
      (isPaidActive(safeMember, safeProfile) ? "auto_approved" : "payment_pending");

    const tier = getTier(safeMember, safeProfile);

    return {
      ...safeMember,
      id:
        safeMember.id ||
        safeMember.signupId ||
        safeMember.signup_id ||
        safeProfile.id ||
        "",
      signupId:
        safeMember.signupId ||
        safeMember.signup_id ||
        safeMember.id ||
        safeProfile.signupId ||
        safeProfile.signup_id ||
        safeProfile.id ||
        "",
      portalUserId: safeMember.portalUserId || safeMember.portal_user_id || "",
      firstName,
      first_name: firstName,
      lastName:
        safeMember.lastName ||
        safeMember.last_name ||
        safeProfile.lastName ||
        safeProfile.last_name ||
        "",
      fullName,
      full_name: fullName,
      name: fullName,
      email: normalizeEmail(safeMember.email || safeProfile.email),
      phone: safeMember.phone || safeProfile.phone || "",
      city: safeMember.city || safeProfile.city || "",
      state: safeMember.state || safeProfile.state || "",
      status,
      memberStatus: status,
      member_status: status,
      membershipStatus: status,
      membership_status: status,
      paymentStatus,
      payment_status: paymentStatus,
      approvalStatus,
      approval_status: approvalStatus,
      tier,
      tierLabel: titleCase(tier),
      portalAccess: getPortalAccess(
        {
          ...safeMember,
          status,
          payment_status: paymentStatus,
          approval_status: approvalStatus,
        },
        safeProfile
      ),
      accessLevel: safeMember.accessLevel || safeMember.access_level || tier || "member",
      joinedAt:
        safeMember.joinedAt ||
        safeMember.joined_at ||
        safeMember.createdAt ||
        safeMember.created_at ||
        null,
      createdAt: safeMember.createdAt || safeMember.created_at || null,
      updatedAt: safeMember.updatedAt || safeMember.updated_at || null,
      stripeCustomerId:
        safeMember.stripeCustomerId || safeMember.stripe_customer_id || "",
      stripe_customer_id:
        safeMember.stripeCustomerId || safeMember.stripe_customer_id || "",
      stripeSubscriptionId:
        safeMember.stripeSubscriptionId || safeMember.stripe_subscription_id || "",
      stripe_subscription_id:
        safeMember.stripeSubscriptionId || safeMember.stripe_subscription_id || "",
      nextBillingDate: getNextBillingDate(safeMember),
      next_billing_date: getNextBillingDate(safeMember),
      activationFeeAmount:
        Number(safeMember.activationFeeAmount || safeMember.activation_fee_amount) ||
        CONFIG.activationFee,
      monthlyFeeAmount:
        Number(safeMember.monthlyFeeAmount || safeMember.monthly_fee_amount) ||
        CONFIG.monthlyFee,
      billingDay:
        Number(safeMember.billingDay || safeMember.billing_day) ||
        CONFIG.billingDay,
    };
  }

  function normalizeStatusTone(status) {
    const value = normalizeText(status).toLowerCase();

    if (
      [
        "active",
        "available",
        "earned",
        "approved",
        "unlocked",
        "posted",
        "paid",
        "released",
        "success",
        "auto_approved",
      ].includes(value)
    ) {
      return "success";
    }

    if (
      [
        "pending",
        "processing",
        "in review",
        "scheduled",
        "reward_pending",
        "open",
        "payment_pending",
        "pending_payment",
        "checkout_created",
      ].includes(value)
    ) {
      return "warning";
    }

    if (
      [
        "expired",
        "inactive",
        "redeemed",
        "used",
        "ended",
        "voided",
        "cancelled",
        "canceled",
        "denied",
        "failed",
        "suspended",
      ].includes(value)
    ) {
      return "danger";
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
        background: "rgba(255,209,102,0.12)",
        color: "#ffeaa6",
        border: "1px solid rgba(255,209,102,0.24)",
      };
    }

    if (tone === "danger") {
      return {
        background: "rgba(239,68,68,0.12)",
        color: "#ffd2d8",
        border: "1px solid rgba(239,68,68,0.24)",
      };
    }

    return {
      background: "rgba(255,255,255,0.06)",
      color: "#f8f3e8",
      border: "1px solid rgba(255,255,255,0.10)",
    };
  }

  function inferRewardsPayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);

    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackProfile = isObject(fallback.profile) ? fallback.profile : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...(isObject(data.member) ? data.member : {}),
        ...(isObject(data.user) ? data.user : {}),
      },
      {
        ...fallbackProfile,
        ...(isObject(data.profile) ? data.profile : {}),
      }
    );

    const profile =
      (isObject(data.profile) && data.profile) ||
      fallbackProfile ||
      {};

    const support =
      (isObject(data.support) && data.support) ||
      fallbackSupport ||
      {};

    const summary =
      (isObject(data.summary) && data.summary) ||
      (isObject(data.stats) && data.stats) ||
      {};

    const rewardAccount =
      (isObject(data.rewardAccount) && data.rewardAccount) ||
      (isObject(data.reward_account) && data.reward_account) ||
      null;

    const rewards = Array.isArray(data.rewards)
      ? data.rewards
      : Array.isArray(data.transactions)
        ? data.transactions
        : [];

    const payouts = Array.isArray(data.payouts) ? data.payouts : [];

    const payments = Array.isArray(data.membershipPayments)
      ? data.membershipPayments
      : Array.isArray(data.payments)
        ? data.payments
        : [];

    const cycles = Array.isArray(data.cycles) ? data.cycles : [];

    const notices = Array.isArray(data.notices)
      ? data.notices
      : Array.isArray(data.announcements)
        ? data.announcements
        : [];

    return {
      member,
      profile,
      support,
      summary,
      rewardAccount,
      rewards,
      payouts,
      payments,
      cycles,
      notices,
      raw: data,
    };
  }

  function applyMember(member = {}) {
    state.member = normalizeMember(member, state.profile || {});

    const fullName = state.member.fullName;
    const firstName = state.member.firstName || "Member";
    const status = state.member.memberStatus || state.member.status || "payment_pending";
    const paymentStatus = state.member.payment_status || "";
    const approvalStatus = state.member.approval_status || "";
    const accessLevel = state.member.accessLevel || state.member.tier || "member";

    const paid = isPaidActive(state.member);
    const pending = isPendingPayment(state.member);
    const bad = isBadStatus(state.member);

    const visibleStatus = paid
      ? "Active"
      : bad
        ? getStatusLabel(status || paymentStatus)
        : pending
          ? "Payment Required"
          : getStatusLabel(status);

    setText("[data-member-name]", fullName);
    setText("[data-member-full-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", state.member.email || "");
    setText("[data-member-status]", visibleStatus);
    setText("[data-member-tier]", titleCase(state.member.tier || "VIP Member"));
    setText("[data-member-access-level]", titleCase(accessLevel));
    setText("[data-member-accesslevel]", titleCase(accessLevel));
    setText("[data-member-joined-at]", formatDate(state.member.joinedAt));

    setText("[data-payment-status]", getStatusLabel(paymentStatus || (paid ? "paid" : "payment_pending")));
    setText("[data-approval-status]", getStatusLabel(approvalStatus || (paid ? "auto_approved" : "payment_pending")));
    setText("[data-portal-access]", paid ? "Enabled" : "Payment Required");

    setText("[data-activation-fee]", money(state.member.activationFeeAmount || CONFIG.activationFee));
    setText("[data-monthly-fee]", `${money(state.member.monthlyFeeAmount || CONFIG.monthlyFee)}/month`);
    setText("[data-billing-day]", `${state.member.billingDay || CONFIG.billingDay}th monthly`);
    setText("[data-next-billing-date]", formatDate(state.member.nextBillingDate, `${CONFIG.billingDay}th monthly`));
    setText("[data-payout-window]", CONFIG.payoutWindow);
    setText("[data-referral-reward-amount]", money(CONFIG.referralRewardAmount));

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = state.member.email || "";
    document.body.dataset.memberStatus = status;
    document.body.dataset.memberPaymentStatus = paymentStatus;
    document.body.dataset.memberApprovalStatus = approvalStatus;
    document.body.dataset.memberAccessLevel = accessLevel;
    document.body.dataset.memberId = state.member.id || state.member.signupId || "";
    document.body.dataset.portalAccess = paid ? "enabled" : "payment_required";

    document.querySelectorAll("[data-paid-only]").forEach((node) => {
      node.hidden = !paid;
    });

    document.querySelectorAll("[data-payment-required-only]").forEach((node) => {
      node.hidden = paid;
    });

    document.querySelectorAll("[data-member-status-pill]").forEach((node) => {
      node.textContent = visibleStatus;
      node.dataset.status = paid ? "active" : bad ? "error" : "pending";
      node.classList.toggle("pending", !paid && !bad);
      node.classList.toggle("error", bad);
    });
  }

  function applySupport(support = {}) {
    state.support = isObject(support) ? support : {};

    const email = normalizeText(state.support.email, "support@cardleorewards.com");
    const phone = normalizeText(state.support.phone, "Not listed");
    const hours = normalizeText(state.support.hours, "Mon–Fri, 9:00 AM–6:00 PM");

    setText("[data-support-email]", email);
    setText("[data-support-phone]", phone);
    setText("[data-support-hours]", hours);

    document.querySelectorAll("[data-support-email-link]").forEach((node) => {
      node.textContent = email;
      node.href = `mailto:${email}`;
    });
  }

  function buildDefaultRewards(member = {}) {
    const paid = isPaidActive(member);

    return [
      {
        id: "approved-referral-reward",
        title: "Approved Referral Reward",
        description: `Earn ${money(CONFIG.referralRewardAmount)} for each approved member you refer.`,
        category: "Referral Reward",
        status: paid ? "active" : "payment_pending",
        amount: CONFIG.referralRewardAmount,
        code: "REFERRAL-7",
      },
      {
        id: "monthly-leaderboard",
        title: "Monthly Leaderboard Rewards",
        description:
          "Compete on the referral leaderboard and rise each month with approved referrals.",
        category: "Leaderboard",
        status: paid ? "active" : "payment_pending",
        amount: 0,
        code: "LEADERBOARD",
      },
      {
        id: "member-benefits",
        title: "Member Benefits Access",
        description:
          "Unlock dining, travel, shopping, entertainment, and lifestyle benefit access with active membership.",
        category: "Benefits",
        status: paid ? "active" : "locked",
        amount: 0,
        code: "BENEFITS",
      },
      {
        id: "monthly-payout-window",
        title: "Monthly Payout Window",
        description:
          "Eligible monthly reward payouts are prepared between the 1st and 3rd of each month.",
        category: "Payouts",
        status: "processing",
        amount: 0,
        code: "PAYOUT-1-3",
      },
    ];
  }

  function buildComputedSummary(summary = {}, rewards = [], rewardAccount = null, member = {}) {
    const account = isObject(rewardAccount) ? rewardAccount : {};
    const safeRewards = rewards.length ? rewards : buildDefaultRewards(member);

    const approvedReferrals = Number(
      summary.approvedReferrals ||
        summary.approved_referrals ||
        account.approvedReferrals ||
        account.approved_referrals ||
        0
    );

    const pendingReferrals = Number(
      summary.pendingReferrals ||
        summary.pending_referrals ||
        account.pendingReferrals ||
        account.pending_referrals ||
        0
    );

    const totalRewardsEarned = Number(
      summary.totalRewardsEarned ??
        summary.total_rewards_earned ??
        account.totalRewardsEarned ??
        account.total_rewards_earned ??
        summary.earnedAmount ??
        summary.earned_amount ??
        approvedReferrals * CONFIG.referralRewardAmount ??
        0
    );

    const totalRewardsPaid = Number(
      summary.totalRewardsPaid ??
        summary.total_rewards_paid ??
        account.totalRewardsPaid ??
        account.total_rewards_paid ??
        0
    );

    const companyBuildingPending = Number(
      summary.companyBuildingPending ??
        account.companyBuildingPending ??
        account.company_building_pending ??
        0
    );

    const companyBuildingReleased = Number(
      summary.companyBuildingReleased ??
        account.companyBuildingReleased ??
        account.company_building_released ??
        0
    );

    const directReferralEarned = Number(
      summary.totalDirectReferralEarned ??
        account.totalDirectReferralEarned ??
        account.total_direct_referral_earned ??
        approvedReferrals * CONFIG.referralRewardAmount ??
        0
    );

    const overrideEarned = Number(
      summary.totalOverrideEarned ??
        account.totalOverrideEarned ??
        account.total_override_earned ??
        0
    );

    const activeRewards = safeRewards.filter((reward) =>
      [
        "active",
        "available",
        "earned",
        "unlocked",
        "posted",
        "released",
        "paid",
        "approved",
      ].includes(
        normalizeText(
          reward.status || reward.transactionStatus || reward.transaction_status
        ).toLowerCase()
      )
    ).length;

    const pendingRewards = safeRewards.filter((reward) =>
      [
        "pending",
        "processing",
        "scheduled",
        "reward_pending",
        "payment_pending",
      ].includes(
        normalizeText(
          reward.status || reward.transactionStatus || reward.transaction_status
        ).toLowerCase()
      )
    ).length;

    return {
      totalRewards: Number(summary.totalRewards ?? summary.total_rewards ?? safeRewards.length),
      activeRewards: Number(summary.activeRewards ?? summary.active_rewards ?? activeRewards),
      pendingRewards: Number(summary.pendingRewards ?? summary.pending_rewards ?? pendingRewards),

      approvedReferrals: Number.isFinite(approvedReferrals) ? approvedReferrals : 0,
      pendingReferrals: Number.isFinite(pendingReferrals) ? pendingReferrals : 0,
      totalRewardsEarned: Number.isFinite(totalRewardsEarned) ? totalRewardsEarned : 0,
      totalRewardsPaid: Number.isFinite(totalRewardsPaid) ? totalRewardsPaid : 0,
      companyBuildingPending: Number.isFinite(companyBuildingPending) ? companyBuildingPending : 0,
      companyBuildingReleased: Number.isFinite(companyBuildingReleased) ? companyBuildingReleased : 0,
      directReferralEarned: Number.isFinite(directReferralEarned) ? directReferralEarned : 0,
      overrideEarned: Number.isFinite(overrideEarned) ? overrideEarned : 0,

      accessLevel: normalizeText(summary.accessLevel || summary.access_level || state.member?.accessLevel || "member"),
      statusLabel: normalizeText(summary.statusLabel || summary.status_label || state.member?.memberStatus || "Payment Pending"),
    };
  }

  function applySummary(summary = {}, rewards = [], rewardAccount = null) {
    state.summary = buildComputedSummary(
      summary,
      rewards,
      rewardAccount,
      state.member || {}
    );

    setText("[data-total-rewards]", formatNumber(state.summary.totalRewards));
    setText("[data-active-rewards]", formatNumber(state.summary.activeRewards));
    setText("[data-pending-rewards]", formatNumber(state.summary.pendingRewards));

    setText("[data-approved-referrals]", formatNumber(state.summary.approvedReferrals));
    setText("[data-pending-referrals]", formatNumber(state.summary.pendingReferrals));

    setText("[data-rewards-access-level]", titleCase(state.summary.accessLevel));
    setText("[data-rewards-status-label]", titleCase(state.summary.statusLabel));

    setText("[data-total-points]", formatPoints(state.summary.totalRewardsEarned));
    setText("[data-total-rewards-earned]", money(state.summary.totalRewardsEarned));
    setText("[data-total-rewards-paid]", money(state.summary.totalRewardsPaid));
    setText("[data-company-building-pending]", money(state.summary.companyBuildingPending));
    setText("[data-company-building-released]", money(state.summary.companyBuildingReleased));
    setText("[data-direct-referral-earned]", money(state.summary.directReferralEarned));
    setText("[data-override-earned]", money(state.summary.overrideEarned));

    setText("[data-current-balance]", money(Math.max(0, state.summary.totalRewardsEarned - state.summary.totalRewardsPaid)));
  }

  function normalizeReward(reward = {}, index = 0) {
    const amount =
      reward.amount ??
      reward.points ??
      reward.value ??
      reward.balance ??
      reward.total ??
      null;

    return {
      id: normalizeText(reward.id || reward.rewardId || reward.reward_id || reward.slug || `reward-${index + 1}`),
      title:
        normalizeText(reward.title || reward.name || reward.label || reward.transactionType || reward.transaction_type) ||
        `Reward ${index + 1}`,
      description:
        normalizeText(reward.description || reward.summary || reward.details) ||
        "Premium member reward activity available through Card Leo Rewards.",
      category: normalizeText(reward.category || reward.type || reward.transactionType || reward.transaction_type || "Member Reward"),
      status: normalizeText(reward.status || reward.transactionStatus || reward.transaction_status || reward.state || "posted"),
      amount,
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
        reward.paidAt ||
        reward.paid_at ||
        null,
      createdAt:
        reward.postedAt ||
        reward.posted_at ||
        reward.createdAt ||
        reward.created_at ||
        reward.earnedAt ||
        reward.earned_at ||
        null,
      code: normalizeText(reward.code || reward.redemptionCode || reward.referenceId || reward.reference_id || ""),
      ctaLabel: normalizeText(reward.ctaLabel || reward.buttonLabel || "View Details"),
      ctaHref: normalizeText(reward.ctaHref || reward.link || "#"),
      metadata: isObject(reward.metadata) ? reward.metadata : {},
    };
  }

  function buildEmptyRewardHtml() {
    return `
      <div style="
        padding:20px;
        border-radius:20px;
        background:rgba(255,255,255,0.03);
        border:1px solid rgba(255,255,255,0.08);
        color:rgba(244,234,211,0.76);
      ">
        <strong style="display:block;color:#f8f3e8;font-size:1rem;margin-bottom:8px;">
          Rewards are ready
        </strong>
        <span>
          Your next Card Leo Rewards activity will appear here once rewards, referrals, or payouts are issued.
        </span>
      </div>
    `;
  }

  function rewardCardHtml(reward) {
    const tone = normalizeStatusTone(reward.status);
    const badge = badgeStyles(tone);

    const valueLabel =
      reward.amount !== null && reward.amount !== undefined && reward.amount !== ""
        ? money(reward.amount)
        : "Included";

    return `
      <article style="
        display:grid;
        gap:14px;
        padding:20px;
        border-radius:22px;
        background:linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02));
        border:1px solid rgba(255,255,255,0.08);
        box-shadow:0 18px 40px rgba(0,0,0,0.22);
      ">
        <div style="
          display:flex;
          align-items:flex-start;
          justify-content:space-between;
          gap:12px;
          flex-wrap:wrap;
        ">
          <div>
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
            ">
              ${escapeHtml(titleCase(reward.category))}
            </span>

            <h3 style="margin:10px 0 6px;color:#f8f3e8;font-size:1.12rem;line-height:1.2;">
              ${escapeHtml(titleCase(reward.title))}
            </h3>

            <p style="margin:0;color:rgba(244,234,211,0.76);line-height:1.65;font-size:0.95rem;">
              ${escapeHtml(reward.description)}
            </p>
          </div>

          <span style="
            display:inline-flex;
            align-items:center;
            justify-content:center;
            padding:8px 12px;
            border-radius:999px;
            font-size:0.78rem;
            font-weight:700;
            letter-spacing:0.04em;
            background:${badge.background};
            color:${badge.color};
            border:${badge.border};
          ">
            ${escapeHtml(getStatusLabel(reward.status))}
          </span>
        </div>

        <div style="
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));
          gap:12px;
        ">
          ${[
            ["Reward Value", valueLabel],
            ["Posted / Added", reward.createdAt ? formatDate(reward.createdAt) : "—"],
            ["Expires", reward.expiresAt ? formatDate(reward.expiresAt) : "No expiry"],
            ["Redeemed / Paid", reward.redeemedAt ? formatDate(reward.redeemedAt) : "Not yet"],
          ]
            .map(
              ([label, value]) => `
                <div style="
                  padding:14px;
                  border-radius:16px;
                  background:rgba(255,255,255,0.03);
                  border:1px solid rgba(255,255,255,0.07);
                ">
                  <div style="
                    font-size:0.78rem;
                    color:rgba(244,234,211,0.64);
                    margin-bottom:6px;
                    letter-spacing:0.04em;
                    text-transform:uppercase;
                  ">
                    ${escapeHtml(label)}
                  </div>
                  <div style="font-size:0.98rem;color:#f8f3e8;font-weight:700;">
                    ${escapeHtml(value)}
                  </div>
                </div>
              `
            )
            .join("")}
        </div>

        <div style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          flex-wrap:wrap;
          gap:12px;
        ">
          <div style="color:rgba(244,234,211,0.72);font-size:0.92rem;">
            ${
              reward.code
                ? `<strong style="color:#f4ead3;">Reference:</strong> ${escapeHtml(reward.code)}`
                : `<strong style="color:#f4ead3;">Last updated:</strong> ${escapeHtml(
                    formatDateTime(reward.createdAt || reward.expiresAt || reward.redeemedAt)
                  )}`
            }
          </div>

          ${
            reward.ctaHref && reward.ctaHref !== "#"
              ? `
                <a href="${escapeHtml(reward.ctaHref)}" style="
                  display:inline-flex;
                  align-items:center;
                  justify-content:center;
                  padding:12px 16px;
                  border-radius:14px;
                  border:0;
                  font-weight:700;
                  text-decoration:none;
                  background:linear-gradient(135deg, rgba(216,176,94,0.95), rgba(162,124,48,0.96));
                  color:#140f07;
                  box-shadow:0 14px 30px rgba(216,176,94,0.18);
                ">
                  ${escapeHtml(reward.ctaLabel)}
                </a>
              `
              : `
                <span style="
                  display:inline-flex;
                  align-items:center;
                  justify-content:center;
                  padding:12px 16px;
                  border-radius:14px;
                  border:1px solid rgba(255,255,255,0.08);
                  font-weight:700;
                  color:rgba(244,234,211,0.72);
                  background:rgba(255,255,255,0.04);
                ">
                  Details
                </span>
              `
          }
        </div>
      </article>
    `;
  }

  function renderRewards(rewards = []) {
    const containers = document.querySelectorAll(
      "[data-rewards-grid], #rewards-grid, #portal-rewards-grid, #rewardsList"
    );

    if (!containers.length) return;

    const sourceRewards = rewards.length ? rewards : buildDefaultRewards(state.member || {});
    const normalized = sourceRewards.map(normalizeReward);

    containers.forEach((container) => {
      container.innerHTML = normalized.length
        ? normalized.map(rewardCardHtml).join("")
        : buildEmptyRewardHtml();
    });
  }

  function normalizeNotice(notice = {}, index = 0) {
    return {
      id: normalizeText(notice.id || `notice-${index + 1}`),
      title: normalizeText(notice.title || notice.name || `Reward Notice ${index + 1}`),
      body: normalizeText(
        notice.body || notice.message || notice.description,
        "Important Card Leo Rewards update available."
      ),
    };
  }

  function defaultNotices(member = {}) {
    const paid = isPaidActive(member);

    return [
      {
        id: "membership-status",
        title: paid ? "Membership active" : "Payment required",
        body: paid
          ? "Your paid membership is active, so your rewards, benefits, referrals, and portal access can remain unlocked."
          : "Complete your activation payment to unlock full rewards, referrals, benefits, and portal access.",
      },
      {
        id: "referral-rewards",
        title: "Referral rewards",
        body: `Every approved referral can add ${money(CONFIG.referralRewardAmount)} to your rewards account.`,
      },
      {
        id: "payout-window",
        title: "Monthly payout window",
        body: `Monthly reward payouts are prepared ${CONFIG.payoutWindow}.`,
      },
    ];
  }

  function renderNotices(notices = []) {
    const containers = document.querySelectorAll(
      "[data-rewards-notices], [data-notices-list], #rewards-notices, #noticesList"
    );

    if (!containers.length) return;

    const list = notices.length
      ? notices.map(normalizeNotice)
      : defaultNotices(state.member || {});

    containers.forEach((container) => {
      container.innerHTML = list
        .map(
          (item) => `
            <div style="
              padding:16px;
              border-radius:18px;
              background:rgba(255,255,255,0.035);
              border:1px solid rgba(255,255,255,0.07);
              margin-bottom:12px;
            ">
              <strong style="display:block;color:#f8f3e8;margin-bottom:6px;">
                ${escapeHtml(item.title)}
              </strong>
              <p style="margin:0;color:rgba(244,234,211,0.72);line-height:1.6;">
                ${escapeHtml(item.body)}
              </p>
            </div>
          `
        )
        .join("");
    });
  }

  function renderCycles(cycles = []) {
    const containers = document.querySelectorAll(
      "[data-rewards-cycles], [data-cycles-list], #rewards-cycles"
    );

    if (!containers.length) return;

    containers.forEach((container) => {
      if (!cycles.length) {
        container.innerHTML = `
          <div style="color:rgba(244,234,211,0.72);line-height:1.6;">
            Company-building cycles will appear here after eligible membership activity.
          </div>
        `;
        return;
      }

      container.innerHTML = cycles
        .map((cycle, index) => {
          const cycleNumber = cycle.cycleNumber || cycle.cycle_number || index + 1;
          const status = cycle.cycleStatus || cycle.cycle_status || "open";
          const paidMonths = cycle.paidMonthsCount || cycle.paid_months_count || 0;
          const requiredMonths = cycle.requiredPaidMonths || cycle.required_paid_months || 4;

          return `
            <div style="
              padding:16px;
              border-radius:18px;
              background:rgba(255,255,255,0.035);
              border:1px solid rgba(255,255,255,0.07);
              margin-bottom:12px;
            ">
              <strong style="display:block;color:#f8f3e8;margin-bottom:6px;">
                Cycle ${escapeHtml(cycleNumber)} · ${escapeHtml(titleCase(status))}
              </strong>
              <p style="margin:0;color:rgba(244,234,211,0.72);line-height:1.6;">
                Paid months: ${escapeHtml(paidMonths)} / ${escapeHtml(requiredMonths)}
                · Released: ${escapeHtml(money(cycle.companyBuildingReleased || cycle.company_building_released || 0))}
              </p>
            </div>
          `;
        })
        .join("");
    });
  }

  function applyStaticBillingText() {
    setText("[data-static-activation-fee]", money(CONFIG.activationFee));
    setText("[data-static-monthly-fee]", `${money(CONFIG.monthlyFee)}/month`);
    setText("[data-static-billing-day]", `${CONFIG.billingDay}th monthly`);
    setText("[data-static-approval-method]", "Automatic after payment");
    setText("[data-static-payout-window]", CONFIG.payoutWindow);
    setText("[data-static-referral-reward]", money(CONFIG.referralRewardAmount));
  }

  function renderPayload(payload, fallback = {}) {
    const parsed = inferRewardsPayload(payload, fallback);

    state.raw = parsed.raw;
    state.member = parsed.member;
    state.profile = parsed.profile;
    state.rewardAccount = parsed.rewardAccount;
    state.rewards = parsed.rewards;
    state.payouts = parsed.payouts;
    state.payments = parsed.payments;
    state.cycles = parsed.cycles;
    state.notices = parsed.notices;

    applyStaticBillingText();
    applyMember(parsed.member);
    applySupport(parsed.support);
    applySummary(parsed.summary, parsed.rewards, parsed.rewardAccount);
    renderRewards(parsed.rewards);
    renderNotices(parsed.notices);
    renderCycles(parsed.cycles);

    setHidden("[data-rewards-loading]", true);
    setHidden("[data-rewards-ready]", false);

    return parsed;
  }

  async function loadSessionFirst() {
    const result = await fetchJson(CONFIG.meEndpoint, {
      method: "GET",
    });

    if (result.response.status === 401) {
      redirectToLogin();
      return null;
    }

    if (!result.response.ok) {
      throw new Error(result.message || "Unable to verify your session.");
    }

    if (result.data.authenticated !== true) {
      redirectToLogin();
      return null;
    }

    if (
      !isObject(result.data.member) &&
      !isObject(result.data.profile) &&
      !isObject(result.data.user)
    ) {
      throw new Error("Your session is active, but your member details were not returned.");
    }

    return renderPayload({
      success: true,
      data: {
        member: result.data.member || result.data.profile || result.data.user || {},
        profile: result.data.profile || null,
        support: result.data.support || null,
        summary: {
          totalRewards: 0,
          activeRewards: 0,
          pendingRewards: 0,
          accessLevel:
            result.data.member?.accessLevel ||
            result.data.member?.tier ||
            "member",
          statusLabel:
            result.data.member?.memberStatus ||
            result.data.member?.status ||
            "Payment Pending",
        },
        rewards: [],
        notices: defaultNotices(result.data.member || result.data.profile || {}),
      },
    });
  }

  async function loadRewardsEnhancement(fallbackPayload) {
    try {
      const result = await fetchJson(CONFIG.rewardsEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return null;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return null;
      }

      if (!result.response.ok) {
        return fallbackPayload || null;
      }

      return renderPayload(result.payload, fallbackPayload || {});
    } catch (error) {
      console.warn("Rewards enhancement skipped:", error);
      return fallbackPayload || null;
    }
  }

  async function loadRewards() {
    if (state.isLoading) return false;

    state.isLoading = true;

    const pageStatus = getStatusNode();
    clearStatus(pageStatus);
    setHidden("[data-rewards-loading]", false);

    try {
      const sessionPayload = await loadSessionFirst();

      if (!sessionPayload) return false;

      await loadRewardsEnhancement(sessionPayload);

      const paid = isPaidActive(state.member || {});
      const bad = isBadStatus(state.member || {});

      if (paid) {
        setStatus(pageStatus, "success", "Your rewards dashboard is active.");
      } else if (bad) {
        setStatus(pageStatus, "error", "Your membership status needs attention before rewards can be fully unlocked.");
      } else {
        setStatus(pageStatus, "warning", "Complete membership payment to unlock full reward access.");
      }

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
      setHidden("[data-rewards-loading]", true);
    }
  }

  async function openBillingPortal() {
    const pageStatus = getStatusNode();

    try {
      setStatus(pageStatus, "info", "Opening secure billing portal...");

      const result = await fetchJson(CONFIG.billingPortalEndpoint, {
        method: "POST",
        body: JSON.stringify({
          return_url: window.location.href,
        }),
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return;
      }

      const url =
        normalizeText(result.data?.url) ||
        normalizeText(result.data?.billing_portal_url) ||
        normalizeText(result.data?.billingPortalUrl) ||
        normalizeText(result.data?.redirectTo) ||
        normalizeText(result.payload?.url);

      if (!url) {
        window.location.href = "/portal/billing.html";
        return;
      }

      window.location.href = url;
    } catch (error) {
      console.warn("[portal-rewards] billing portal unavailable:", error);
      window.location.href = "/portal/billing.html";
    }
  }

  function bindBillingButtons() {
    document
      .querySelectorAll(
        "[data-billing-portal], [data-open-billing], #billingPortalButton, #manageBillingButton"
      )
      .forEach((button) => {
        if (button.dataset.rewardsBillingBound === "true") return;

        button.dataset.rewardsBillingBound = "true";

        button.addEventListener("click", async (event) => {
          event.preventDefault();
          await openBillingPortal();
        });
      });
  }

  function bindLogoutButtons() {
    if (window.CardLeoAuthGuard?.bindLogoutButtons) {
      window.CardLeoAuthGuard.bindLogoutButtons(CONFIG.authGuardOptions);
      return;
    }

    document.querySelectorAll("[data-logout], [data-member-logout], #logoutButton").forEach((button) => {
      if (button.dataset.rewardsLogoutBound === "true") return;

      button.dataset.rewardsLogoutBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        try {
          await fetch(CONFIG.logoutEndpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json",
            },
          });
        } catch {
          // Still redirect.
        }

        window.location.href = CONFIG.loginPage;
      });
    });
  }

  function bindRefreshButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-rewards-refresh]");
      if (!trigger) return;

      event.preventDefault();

      const originalText = "value" in trigger ? trigger.value : trigger.textContent;

      try {
        if ("disabled" in trigger) trigger.disabled = true;

        if ("value" in trigger) {
          trigger.value = "Refreshing...";
        } else {
          trigger.textContent = "Refreshing...";
        }

        await loadRewards();
      } finally {
        if ("disabled" in trigger) trigger.disabled = false;

        if ("value" in trigger) {
          trigger.value = originalText;
        } else {
          trigger.textContent = originalText;
        }
      }
    });
  }

  async function init() {
    const pageStatus = getStatusNode();

    try {
      applyStaticBillingText();
      bindLogoutButtons();
      bindRefreshButtons();
      bindBillingButtons();

      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      await loadRewards();
    } catch (error) {
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your rewards page."
      );
    }
  }

  window.addEventListener("cardleo:auth-ready", (event) => {
    const detail = event?.detail || {};

    if (detail.member && !state.authReady) {
      state.authReady = true;

      renderPayload({
        success: true,
        data: {
          member: detail.member,
          profile: detail.profile || null,
          support: detail.support || null,
          rewards: [],
          summary: {
            totalRewards: 0,
            activeRewards: 0,
            pendingRewards: 0,
            accessLevel: detail.member.accessLevel || detail.member.tier || "member",
            statusLabel: detail.member.status || "Payment Pending",
          },
          notices: defaultNotices(detail.member),
        },
      });
    }
  });

  window.addEventListener("cardleo:auth-failed", () => {
    redirectToLogin();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalRewards = {
    init,
    reload: loadRewards,
    render: renderPayload,
    openBillingPortal,
    getState: function () {
      return { ...state };
    },
    helpers: {
      isPaidActive,
      isPendingPayment,
      isBadStatus,
      getStatusLabel,
      money,
    },
  };
})();