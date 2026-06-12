// api/portal/benefits.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  forbidden,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import {
  clearAuthCookies,
  safeJsonParse,
  getSessionCookieName,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_PORTAL_PATH = "/portal/index.html";

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const BASE_BENEFITS = [
  {
    code: "member_portal",
    title: "Member Portal Access",
    description:
      "Secure access to your Card Leo Rewards dashboard, profile, rewards activity, and account settings.",
    category: "core",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: true,
    sortOrder: 10,
  },
  {
    code: "reward_tracking",
    title: "Reward Tracking",
    description:
      "Track available rewards, pending earnings, released company-building totals, and recent account activity in one place.",
    category: "rewards",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: true,
    sortOrder: 20,
  },
  {
    code: "support_access",
    title: "Member Support",
    description:
      "Submit support requests and receive help with rewards, account questions, and membership issues.",
    category: "support",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: false,
    sortOrder: 30,
  },
  {
    code: "company_building",
    title: "Company-Building Earnings",
    description:
      "Accrue company-building earnings from active paid membership cycles and unlock them after the required payment period.",
    category: "rewards",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "4-Month Unlock",
    featured: true,
    sortOrder: 40,
  },
  {
    code: "referral_access",
    title: "Referral Program Access",
    description:
      "Invite new members, track direct referral bonuses, and monitor override earnings when referrals are enabled.",
    category: "referrals",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Popular",
    featured: true,
    sortOrder: 50,
  },
  {
    code: "priority_support",
    title: "Priority Support Routing",
    description:
      "Priority routing for support conversations and faster assistance on important account matters.",
    category: "support",
    tiers: ["gold", "platinum", "vip"],
    badge: "Priority",
    featured: true,
    sortOrder: 60,
  },
  {
    code: "premium_offers",
    title: "Premium Member Offers",
    description:
      "Access to enhanced promotions, premium partner perks, and select member-only offers.",
    category: "offers",
    tiers: ["silver", "gold", "platinum", "vip"],
    badge: "Perk",
    featured: true,
    sortOrder: 70,
  },
  {
    code: "vip_concierge",
    title: "VIP Concierge Access",
    description:
      "High-touch support and elevated member experience for top-tier members and special campaigns.",
    category: "vip",
    tiers: ["vip"],
    badge: "VIP",
    featured: true,
    sortOrder: 80,
  },
];

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value || "pending").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeText(value || "core").toLowerCase();

  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) {
    return tier;
  }

  return "core";
}

function normalizeMemberStatus(value) {
  const status = normalizeStatus(value);

  if (["active", "approved", "invited"].includes(status)) return "active";
  if (["pending", "reviewing"].includes(status)) return "pending";
  if (["disabled", "suspended", "paused"].includes(status)) return "suspended";
  if (["denied", "closed"].includes(status)) return status;

  return status || "pending";
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function getTierRank(tier) {
  const order = {
    core: 1,
    silver: 2,
    gold: 3,
    platinum: 4,
    vip: 5,
  };

  return order[normalizeTier(tier)] || 1;
}

function getNextTier(tier) {
  const tiers = ["core", "silver", "gold", "platinum", "vip"];
  const currentIndex = tiers.indexOf(normalizeTier(tier));

  if (currentIndex < 0 || currentIndex === tiers.length - 1) {
    return null;
  }

  return tiers[currentIndex + 1];
}

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (name) cookies[name] = value;

      return cookies;
    }, {});
}

function decodeCookieValue(value) {
  const raw = String(value || "");

  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const decoded = decodeCookieValue(cookies[name]);
    const parsed = safeJsonParse(decoded, null);

    if (parsed && typeof parsed === "object") {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getSessionExpiresAt(sessionCookie) {
  const value = sessionCookie?.value || {};
  const candidates = [value.expires_at, value.session?.expires_at];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionCookie) {
  const expiresAt = getSessionExpiresAt(sessionCookie);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionCookie) {
  const value = sessionCookie?.value || {};

  return normalizeText(
    value.member?.id ||
      value.profile?.id ||
      value.user?.id ||
      value.id
  );
}

function getSessionEmail(sessionCookie) {
  const value = sessionCookie?.value || {};

  return normalizeEmail(
    value.member?.email ||
      value.profile?.email ||
      value.user?.email ||
      value.email
  );
}

function isMissingOptionalTableOrColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache") ||
    details.includes("does not exist") ||
    details.includes("could not find") ||
    details.includes("schema cache")
  );
}

function getDisplayName(member) {
  const fullName = normalizeText(member?.full_name);

  if (fullName) return fullName;

  const joined = [member?.first_name, member?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");

  return joined || "Card Leo Member";
}

function sanitizeMember(member) {
  if (!member) return null;

  return {
    id: member.id || null,
    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member),
    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    status: member.status || "",
    memberStatus: normalizeMemberStatus(member.status),
    tier: normalizeTier(member.tier || "core"),
    referralCode: member.referral_code || "",
    portalUserId: member.portal_user_id || null,
    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,
    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,
    role: "member",
  };
}

async function getAuthenticatedMember(req, res) {
  const sessionCookie = readSessionCookie(req);

  if (!sessionCookie?.value) {
    return {
      member: null,
      response: unauthorized(res, "Unauthorized. Please sign in."),
    };
  }

  if (isSessionExpired(sessionCookie)) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session expired. Please sign in again."),
    };
  }

  if (sessionCookie.value.authenticated !== true) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session invalid. Please sign in again."),
    };
  }

  const memberId = getSessionMemberId(sessionCookie);
  const email = getSessionEmail(sessionCookie);

  let query = supabaseAdmin.from("signups").select(
    [
      "id",
      "first_name",
      "last_name",
      "full_name",
      "email",
      "phone",
      "city",
      "state",
      "interest",
      "agreed",
      "status",
      "tier",
      "referral_code",
      "email_verified",
      "email_verified_at",
      "portal_user_id",
      "portal_login_url",
      "created_at",
      "updated_at",
    ].join(", ")
  );

  if (memberId) {
    query = query.eq("id", memberId);
  } else if (email) {
    query = query.eq("email", email);
  } else {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session missing member information."),
    };
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").select(
      [
        "id",
        "first_name",
        "last_name",
        "full_name",
        "email",
        "phone",
        "city",
        "state",
        "interest",
        "agreed",
        "status",
        "portal_user_id",
        "portal_login_url",
        "created_at",
        "updated_at",
      ].join(", ")
    );

    if (memberId) {
      fallbackQuery = fallbackQuery.eq("id", memberId);
    } else {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    result = await fallbackQuery.maybeSingle();
  }

  if (result.error) {
    throw result.error;
  }

  if (!result.data?.id) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Account not found. Please sign in again."),
    };
  }

  const status = normalizeStatus(result.data.status || "pending");

  if (!ACTIVE_STATUSES.has(status)) {
    clearAuthCookies(res);

    return {
      member: null,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active."
      ),
    };
  }

  return {
    member: result.data,
    response: null,
  };
}

async function getFeatureFlags() {
  const fallback = {
    rewards_enabled: true,
    referrals_enabled: true,
    support_enabled: true,
    benefits_enabled: true,
  };

  try {
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", "portal.features")
      .maybeSingle();

    if (error && isMissingOptionalTableOrColumn(error)) return fallback;
    if (error) throw error;

    return {
      rewards_enabled: data?.value?.rewards_enabled !== false,
      referrals_enabled: data?.value?.referrals_enabled !== false,
      support_enabled: data?.value?.support_enabled !== false,
      benefits_enabled: data?.value?.benefits_enabled !== false,
    };
  } catch {
    return fallback;
  }
}

function buildDefaultOnboarding(member) {
  const safeMember = sanitizeMember(member);
  const emailVerified = Boolean(
    member?.email_verified || member?.email_verified_at
  );
  const profileCompleted = Boolean(
    normalizeText(member?.first_name) &&
      normalizeText(member?.last_name) &&
      normalizeText(member?.email) &&
      normalizeText(member?.phone)
  );
  const rewardsActivated = ACTIVE_STATUSES.has(normalizeStatus(member?.status));

  let percent = 0;

  if (profileCompleted) percent += 40;
  if (emailVerified) percent += 30;
  if (rewardsActivated) percent += 30;

  return {
    signup_id: safeMember.id,
    member_id: safeMember.id,
    accepted_terms: Boolean(member?.agreed),
    accepted_privacy: Boolean(member?.agreed),
    profile_completed: profileCompleted,
    email_verified: emailVerified,
    first_login_completed: true,
    rewards_activated: rewardsActivated,
    onboarding_percent: Math.max(0, Math.min(100, percent)),
    onboarding_status: percent >= 100 ? "complete" : "in_progress",
  };
}

function buildDefaultRewardAccount(member) {
  return {
    signup_id: member?.id || null,
    member_id: member?.id || null,
    account_status: ACTIVE_STATUSES.has(normalizeStatus(member?.status))
      ? "active"
      : "pending",
    total_cardleo_allocated: 0,
    total_direct_referral_earned: 0,
    total_override_earned: 0,
    company_building_pending: 0,
    company_building_released: 0,
    company_building_forfeited: 0,
    total_member_revenue_processed: 0,
    total_rewards_earned: 0,
    total_rewards_paid: 0,
    last_membership_paid_at: null,
    last_direct_referral_at: null,
    last_override_at: null,
    last_company_building_release_at: null,
  };
}

async function queryOptionalSingleByMemberColumns({ table, memberId, columns }) {
  for (const column of columns) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("*")
      .eq(column, memberId)
      .maybeSingle();

    if (!error) {
      return data || null;
    }

    if (isMissingOptionalTableOrColumn(error)) {
      continue;
    }

    throw error;
  }

  return null;
}

function buildStaticBenefits(memberTier, featureFlags = {}) {
  const normalizedTier = normalizeTier(memberTier);
  const tierRank = getTierRank(normalizedTier);

  const referralsEnabled = featureFlags.referrals_enabled !== false;
  const benefitsEnabled = featureFlags.benefits_enabled !== false;
  const rewardsEnabled = featureFlags.rewards_enabled !== false;
  const supportEnabled = featureFlags.support_enabled !== false;

  if (!benefitsEnabled) return [];

  return BASE_BENEFITS.filter((benefit) => {
    if (benefit.code === "referral_access" && !referralsEnabled) return false;

    if (
      ["reward_tracking", "company_building"].includes(benefit.code) &&
      !rewardsEnabled
    ) {
      return false;
    }

    if (
      ["support_access", "priority_support"].includes(benefit.code) &&
      !supportEnabled
    ) {
      return false;
    }

    return true;
  })
    .map((benefit) => {
      const requiredTierRank = Math.min(
        ...benefit.tiers.map((tier) => getTierRank(tier))
      );

      const unlocked = benefit.tiers.includes(normalizedTier);
      const lockedBecauseTier = !unlocked && tierRank < requiredTierRank;

      return {
        ...benefit,
        requiredTier: benefit.tiers[0] || "core",
        unlocked,
        locked: !unlocked,
        lockedReason: lockedBecauseTier
          ? `Available starting at ${titleCase(benefit.tiers[0] || "core")} tier.`
          : null,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function buildDynamicBenefits({
  member,
  onboarding,
  rewardAccount,
  referralsEnabled,
  rewardsEnabled,
}) {
  const benefits = [];

  const memberStatus = normalizeMemberStatus(member?.status);
  const onboardingPercent = Number(onboarding?.onboarding_percent || 0);
  const profileComplete = Boolean(onboarding?.profile_completed);
  const emailVerified =
    Boolean(onboarding?.email_verified) ||
    Boolean(member?.email_verified_at) ||
    Boolean(member?.email_verified);
  const rewardsActive = Boolean(onboarding?.rewards_activated);

  const directEarned = money(rewardAccount?.total_direct_referral_earned);
  const overrideEarned = money(rewardAccount?.total_override_earned);
  const companyPending = money(rewardAccount?.company_building_pending);
  const companyReleased = money(rewardAccount?.company_building_released);
  const companyForfeited = money(rewardAccount?.company_building_forfeited);
  const totalRewardsEarned = money(rewardAccount?.total_rewards_earned);
  const totalRewardsPaid = money(rewardAccount?.total_rewards_paid);

  benefits.push({
    code: "account_status",
    title: "Member Account Status",
    description:
      memberStatus === "active"
        ? "Your membership is active and your portal access is fully enabled."
        : "Your account is not fully active yet. Complete the remaining steps to unlock the full experience.",
    category: "account",
    badge: titleCase(memberStatus),
    featured: true,
    sortOrder: 5,
    unlocked: memberStatus === "active",
    locked: memberStatus !== "active",
    lockedReason:
      memberStatus === "active"
        ? null
        : "Activate your account to unlock the full member experience.",
    meta: {
      memberStatus,
    },
  });

  benefits.push({
    code: "onboarding_progress",
    title: "Onboarding Progress",
    description:
      onboardingPercent >= 100
        ? "Your onboarding is complete and your account is fully set up."
        : "Complete your onboarding checklist to unlock more value and improve your member experience.",
    category: "account",
    badge: `${Math.max(0, Math.min(100, onboardingPercent))}% Complete`,
    featured: true,
    sortOrder: 15,
    unlocked: onboardingPercent >= 100,
    locked: onboardingPercent < 100,
    lockedReason:
      onboardingPercent >= 100
        ? null
        : "Finish onboarding to complete account setup.",
    meta: {
      onboardingPercent: Math.max(0, Math.min(100, onboardingPercent)),
      profileComplete,
      emailVerified,
      rewardsActive,
    },
  });

  if (rewardsEnabled) {
    benefits.push({
      code: "rewards_balance",
      title: "Current Rewards Earnings",
      description:
        totalRewardsEarned > 0
          ? "You currently have tracked earnings across referrals and company-building activity."
          : "Your rewards account is ready. Earnings will appear here as your referrals and cycles progress.",
      category: "rewards",
      badge: `$${totalRewardsEarned.toFixed(2)} Earned`,
      featured: true,
      sortOrder: 25,
      unlocked: true,
      locked: false,
      lockedReason: null,
      meta: {
        totalRewardsEarned,
        totalRewardsPaid,
      },
    });

    benefits.push({
      code: "company_building_status",
      title: "Company-Building Status",
      description:
        companyReleased > 0
          ? "You have successfully unlocked company-building earnings from completed paid cycles."
          : companyPending > 0
            ? "You are accruing company-building earnings. Complete the required paid cycle to unlock them."
            : "Your company-building earnings section is ready and will grow as paid cycles are completed.",
      category: "rewards",
      badge:
        companyReleased > 0
          ? `$${companyReleased.toFixed(2)} Released`
          : `$${companyPending.toFixed(2)} Pending`,
      featured: true,
      sortOrder: 35,
      unlocked: companyReleased > 0 || companyPending > 0,
      locked: companyReleased <= 0 && companyPending <= 0,
      lockedReason:
        companyReleased <= 0 && companyPending <= 0
          ? "Company-building earnings will appear after eligible paid membership activity."
          : null,
      meta: {
        companyPending,
        companyReleased,
        companyForfeited,
      },
    });

    benefits.push({
      code: "email_verification",
      title: "Verified Account Rewards Access",
      description:
        emailVerified
          ? "Your email is verified, which helps secure your account and support reward eligibility."
          : "Verify your email to strengthen your account security and complete your member setup.",
      category: "security",
      badge: emailVerified ? "Verified" : "Action Needed",
      featured: false,
      sortOrder: 45,
      unlocked: emailVerified,
      locked: !emailVerified,
      lockedReason: emailVerified
        ? null
        : "Verify your email to complete your account setup.",
      meta: {
        emailVerified,
      },
    });

    benefits.push({
      code: "profile_completion_check",
      title: "Profile Completion Reward Eligibility",
      description:
        profileComplete
          ? "Your profile is complete and ready for reward eligibility checks and member personalization."
          : "Complete your profile details to unlock profile-based rewards and better member personalization.",
      category: "rewards",
      badge: profileComplete ? "Complete" : "Incomplete",
      featured: false,
      sortOrder: 55,
      unlocked: profileComplete,
      locked: !profileComplete,
      lockedReason: profileComplete
        ? null
        : "Complete your profile to unlock this benefit.",
      meta: {
        profileComplete,
      },
    });

    benefits.push({
      code: "rewards_activation",
      title: "Rewards Program Activation",
      description:
        rewardsActive
          ? "Your rewards profile is active and ready to track future earnings and payouts."
          : "Finish rewards activation to fully enable your Card Leo Rewards experience.",
      category: "rewards",
      badge: rewardsActive ? "Active" : "Pending",
      featured: false,
      sortOrder: 65,
      unlocked: rewardsActive,
      locked: !rewardsActive,
      lockedReason: rewardsActive
        ? null
        : "Finish rewards activation to unlock this feature.",
      meta: {
        rewardsActive,
      },
    });
  }

  if (referralsEnabled) {
    benefits.push({
      code: "referral_readiness",
      title: "Referral Readiness",
      description:
        memberStatus === "active" && emailVerified
          ? "Your account is in strong shape for referral participation and sharing your referral code."
          : "Activate and verify your account to get the most out of referral opportunities.",
      category: "referrals",
      badge:
        memberStatus === "active" && emailVerified ? "Ready" : "Almost Ready",
      featured: false,
      sortOrder: 75,
      unlocked: memberStatus === "active" && emailVerified,
      locked: !(memberStatus === "active" && emailVerified),
      lockedReason:
        memberStatus === "active" && emailVerified
          ? null
          : "Active status and verified email help unlock referral readiness.",
      meta: {
        referralsEnabled,
        directEarned,
        overrideEarned,
      },
    });

    benefits.push({
      code: "referral_earnings",
      title: "Referral Earnings Tracking",
      description:
        directEarned > 0 || overrideEarned > 0
          ? "You are earning from direct referrals and override activity."
          : "Referral earnings will appear here once your network begins generating activity.",
      category: "referrals",
      badge: `$${(directEarned + overrideEarned).toFixed(2)} Earned`,
      featured: true,
      sortOrder: 85,
      unlocked: true,
      locked: false,
      lockedReason: null,
      meta: {
        directEarned,
        overrideEarned,
      },
    });
  }

  return benefits.sort((a, b) => a.sortOrder - b.sortOrder);
}

function groupBenefitsByCategory(benefits) {
  const groups = {};

  for (const benefit of benefits) {
    const key = benefit.category || "other";

    if (!groups[key]) groups[key] = [];

    groups[key].push(benefit);
  }

  return Object.entries(groups).map(([category, items]) => ({
    category,
    title: titleCase(category),
    count: items.length,
    unlockedCount: items.filter((item) => item.unlocked).length,
    items: items.sort((a, b) => a.sortOrder - b.sortOrder),
  }));
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_benefits" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { member, response } = await getAuthenticatedMember(req, res);

    if (!member) {
      return response;
    }

    const safeMember = sanitizeMember(member);
    const memberId = safeMember.id;

    const featureFlags = await getFeatureFlags();

    const [onboardingOptional, rewardAccountOptional] = await Promise.all([
      queryOptionalSingleByMemberColumns({
        table: "member_onboarding",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
      }),

      queryOptionalSingleByMemberColumns({
        table: "reward_accounts",
        memberId,
        columns: ["member_id", "signup_id", "profile_id"],
      }),
    ]);

    const onboarding = onboardingOptional || buildDefaultOnboarding(member);
    const rewardAccount =
      rewardAccountOptional || buildDefaultRewardAccount(member);

    const tier = normalizeTier(member.tier || "core");
    const nextTier = getNextTier(tier);

    const staticBenefits = buildStaticBenefits(tier, featureFlags);
    const dynamicBenefits = buildDynamicBenefits({
      member,
      onboarding,
      rewardAccount,
      referralsEnabled: featureFlags.referrals_enabled,
      rewardsEnabled: featureFlags.rewards_enabled,
    });

    const benefits = [...dynamicBenefits, ...staticBenefits].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    const grouped = groupBenefitsByCategory(benefits);
    const unlockedCount = benefits.filter((item) => item.unlocked).length;
    const lockedCount = benefits.filter((item) => item.locked).length;

    logRequestSuccess(req, {
      scope: "portal_benefits",
      memberId,
      email: safeMember.email,
      tier,
      benefitCount: benefits.length,
    });

    return ok(
      res,
      {
        summary: {
          profileId: safeMember.id,
          memberId: safeMember.id,
          memberName: safeMember.fullName,
          email: safeMember.email,
          tier,
          tierLabel: titleCase(tier),
          nextTier,
          nextTierLabel: nextTier ? titleCase(nextTier) : null,
          memberStatus: safeMember.memberStatus,
          timezone: DEFAULT_TIMEZONE,
          totals: {
            benefits: benefits.length,
            unlocked: unlockedCount,
            locked: lockedCount,
          },
        },
        member: safeMember,
        featureFlags,
        onboarding,
        rewardAccount,
        benefits,
        groups: grouped,
      },
      "Benefits loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_benefits_unexpected",
    });

    return serverError(
      res,
      "Failed to load portal benefits.",
      process.env.NODE_ENV === "development"
        ? {
            error: error?.message || "Unknown error.",
            code: error?.code || null,
          }
        : null
    );
  }
}