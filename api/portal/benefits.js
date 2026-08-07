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
}// api/portal/benefits.js
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

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "invited",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
  "auto_approved",
]);

const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "succeeded",
  "complete",
  "completed",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "approved",
  "paid",
  "current",
]);

const INACTIVE_STATUSES = new Set([
  "inactive",
  "disabled",
  "suspended",
  "paused",
  "denied",
  "closed",
  "cancelled",
  "canceled",
  "unpaid",
  "past_due",
]);

const POSSIBLE_SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
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
      "Secure access to your Card Leo Rewards dashboard, profile, rewards activity, referral tower, benefits, and account settings.",
    category: "core",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Included",
    featured: true,
    sortOrder: 10,
  },
  {
    code: "access_perks_lifestyle",
    title: "Access Perks Lifestyle Savings",
    description:
      "Restaurants, shopping, travel, entertainment, fitness, grocery coupons, and local savings through the Card Leo Rewards benefits portal.",
    category: "offers",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Access Perks",
    featured: true,
    sortOrder: 12,
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
      "Submit support requests and receive help with rewards, account questions, benefits access, and membership issues.",
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
      "Accrue company-building earnings from active paid membership cycles and unlock them after the required active team member rules are met.",
    category: "rewards",
    tiers: ["core", "silver", "gold", "platinum", "vip"],
    badge: "Team Unlock",
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value || "").toLowerCase();
}

function normalizeTier(value) {
  const tier = normalizeText(value || "core").toLowerCase();

  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) {
    return tier;
  }

  return "core";
}

function normalizeMemberStatus(member) {
  if (!member) return "pending";

  if (hasPortalAccess(member)) return "active";

  const status = normalizeStatus(member.status);

  if (["pending", "reviewing", ""].includes(status)) return "pending";
  if (["disabled", "suspended", "paused"].includes(status)) return "suspended";
  if (["denied", "closed", "cancelled", "canceled"].includes(status)) {
    return status;
  }

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

      if (!name) return cookies;

      cookies[name] = value;
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

function parseJsonObject(value) {
  if (isObject(value)) return value;

  const raw = normalizeText(value);

  if (!raw) return null;

  const decoded = decodeCookieValue(raw);
  const parsed = safeJsonParse(decoded, null);

  if (isObject(parsed)) return parsed;

  try {
    const base64Decoded = Buffer.from(decoded, "base64").toString("utf8");
    const parsedBase64 = safeJsonParse(base64Decoded, null);

    if (isObject(parsedBase64)) return parsedBase64;
  } catch {
    // Ignore invalid base64.
  }

  try {
    const normalized = decoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const base64UrlDecoded = Buffer.from(padded, "base64").toString("utf8");
    const parsedBase64Url = safeJsonParse(base64UrlDecoded, null);

    if (isObject(parsedBase64Url)) return parsedBase64Url;
  } catch {
    // Ignore invalid base64url.
  }

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);
  const configuredName =
    typeof getSessionCookieName === "function" ? getSessionCookieName() : "";

  const names = Array.from(
    new Set(
      [configuredName, ...POSSIBLE_SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseJsonObject(cookies[name]);

    if (isObject(parsed)) {
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
  const candidates = [
    value.expires_at,
    value.expiresAt,
    value.exp,
    value.session?.expires_at,
    value.session?.expiresAt,
  ];

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
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const metadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return normalizeText(
    member.id ||
      member.signupId ||
      member.signup_id ||
      member.memberId ||
      member.member_id ||
      profile.id ||
      profile.signupId ||
      profile.signup_id ||
      profile.memberId ||
      profile.member_id ||
      user.id ||
      metadata.signupId ||
      metadata.signup_id ||
      metadata.memberId ||
      metadata.member_id ||
      value.signupId ||
      value.signup_id ||
      value.memberId ||
      value.member_id ||
      value.id
  );
}

function getSessionEmail(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const metadata = isObject(user.user_metadata) ? user.user_metadata : {};

  return normalizeEmail(
    member.email ||
      profile.email ||
      user.email ||
      metadata.email ||
      value.email ||
      value.userEmail
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

function hasPortalAccess(member) {
  if (!member) return false;

  const status = normalizeStatus(member.status);
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);
  const approvalStatus = normalizeStatus(member.approval_status);

  if (
    INACTIVE_STATUSES.has(status) ||
    INACTIVE_STATUSES.has(paymentStatus) ||
    INACTIVE_STATUSES.has(membershipStatus) ||
    INACTIVE_STATUSES.has(approvalStatus)
  ) {
    return false;
  }

  return (
    ACTIVE_STATUSES.has(status) ||
    PAID_PAYMENT_STATUSES.has(paymentStatus) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
}

function getAccessMemberStatus(member) {
  return normalizeText(member?.access_member_status || "pending");
}

function getAccessPerksReady(member) {
  const raw = member?.access_perks_ready;

  if (typeof raw === "boolean") return raw;

  return getAccessMemberStatus(member).toUpperCase() === "OPEN";
}

function buildAccessPayload(member) {
  const accessMemberStatus = getAccessMemberStatus(member);
  const accessPerksReady = getAccessPerksReady(member);

  return {
    member_identifier: normalizeText(member?.access_member_identifier),
    member_customer_identifier: normalizeText(member?.access_member_identifier),
    member_status: accessMemberStatus,
    status: accessMemberStatus,
    synced_at: member?.access_synced_at || null,
    suspended_at: member?.access_suspended_at || null,
    sync_error: normalizeText(member?.access_sync_error),
    perks_ready: accessPerksReady,
    benefits_ready: accessPerksReady,
    ready: accessPerksReady,
  };
}

function sanitizeMember(member) {
  if (!member) return null;

  const portalAccess = hasPortalAccess(member);
  const access = buildAccessPayload(member);

  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);
  const approvalStatus = normalizeStatus(member.approval_status);
  const status = normalizeStatus(member.status) || "pending";

  return {
    id: member.id || null,
    signupId: member.id || null,
    signup_id: member.id || null,

    email: member.email || null,

    firstName: member.first_name || "",
    first_name: member.first_name || "",

    lastName: member.last_name || "",
    last_name: member.last_name || "",

    fullName: getDisplayName(member),
    full_name: getDisplayName(member),
    name: getDisplayName(member),

    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    goals: member.goals || "",

    status: portalAccess ? "active" : status,
    payment_status: paymentStatus,
    membership_status: portalAccess ? "active" : membershipStatus,
    approval_status: portalAccess ? "approved" : approvalStatus,

    paymentStatus,
    membershipStatus: portalAccess ? "active" : membershipStatus,
    approvalStatus: portalAccess ? "approved" : approvalStatus,

    memberStatus: normalizeMemberStatus(member),

    tier: normalizeTier(member.tier || "core"),
    tierLabel: titleCase(normalizeTier(member.tier || "core")),

    referralCode: member.referral_code || "",
    referral_code: member.referral_code || "",

    portalUserId: member.portal_user_id || null,
    portal_user_id: member.portal_user_id || null,

    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portal_login_url: member.portal_login_url || DEFAULT_PORTAL_PATH,

    portalAccess,
    portal_access: portalAccess,
    accessLevel: "member",
    access_level: "member",

    stripeCustomerId: member.stripe_customer_id || "",
    stripe_customer_id: member.stripe_customer_id || "",
    stripeSubscriptionId: member.stripe_subscription_id || "",
    stripe_subscription_id: member.stripe_subscription_id || "",
    stripeCheckoutSessionId: member.stripe_checkout_session_id || "",
    stripe_checkout_session_id: member.stripe_checkout_session_id || "",

    accessMemberIdentifier: access.member_identifier,
    access_member_identifier: access.member_identifier,
    accessMemberStatus: access.member_status,
    access_member_status: access.member_status,
    accessSyncedAt: access.synced_at,
    access_synced_at: access.synced_at,
    accessSuspendedAt: access.suspended_at,
    access_suspended_at: access.suspended_at,
    accessSyncError: access.sync_error,
    access_sync_error: access.sync_error,
    accessPerksReady: access.perks_ready,
    access_perks_ready: access.perks_ready,

    benefitsReady: access.benefits_ready,
    benefits_ready: access.benefits_ready,

    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,
    email_verified: Boolean(member.email_verified),
    email_verified_at: member.email_verified_at || null,

    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,
    created_at: member.created_at || null,
    updated_at: member.updated_at || null,

    role: "member",
  };
}

function getSignupSelectFields({ extended = true } = {}) {
  const base = [
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
  ];

  if (!extended) {
    return base.join(", ");
  }

  return [
    ...base,
    "goals",
    "payment_status",
    "membership_status",
    "approval_status",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_checkout_session_id",
    "access_member_identifier",
    "access_member_status",
    "access_synced_at",
    "access_suspended_at",
    "access_sync_error",
    "access_perks_ready",
  ].join(", ");
}

async function getSignupRecord({ memberId, email }) {
  let query = supabaseAdmin
    .from("signups")
    .select(getSignupSelectFields({ extended: true }))
    .limit(1);

  if (memberId) {
    query = query.eq("id", memberId);
  } else {
    query = query.ilike("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin
      .from("signups")
      .select(getSignupSelectFields({ extended: false }))
      .limit(1);

    if (memberId) {
      fallbackQuery = fallbackQuery.eq("id", memberId);
    } else {
      fallbackQuery = fallbackQuery.ilike("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            payment_status: "",
            membership_status: "",
            approval_status: "",
            access_member_identifier: "",
            access_member_status: "pending",
            access_synced_at: null,
            access_suspended_at: null,
            access_sync_error: "",
            access_perks_ready: false,
          }
        : null,
      error: fallback.error,
    };
  }

  return result;
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

  if (!memberId && !email) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Session missing member information."),
    };
  }

  const { data, error } = await getSignupRecord({
    memberId,
    email,
  });

  if (error) {
    throw error;
  }

  if (!data?.id) {
    clearAuthCookies(res);

    return {
      member: null,
      response: unauthorized(res, "Account not found. Please sign in again."),
    };
  }

  if (!hasPortalAccess(data)) {
    const status = normalizeStatus(data.status || "pending");

    return {
      member: null,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing" || !status
          ? "Your account is pending approval or payment."
          : "Your account is not active.",
        {
          authenticated: true,
          member: sanitizeMember(data),
          requires_payment: true,
          requiresPayment: true,
          redirectTo: "/signup.html?status=payment_required",
        }
      ),
    };
  }

  return {
    member: data,
    response: null,
  };
}

async function getFeatureFlags() {
  const fallback = {
    rewards_enabled: true,
    referrals_enabled: true,
    support_enabled: true,
    benefits_enabled: true,
    access_perks_enabled: true,
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
      access_perks_enabled: data?.value?.access_perks_enabled !== false,
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

  const rewardsActivated = hasPortalAccess(member);

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
    account_status: hasPortalAccess(member) ? "active" : "pending",
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

function buildStaticBenefits(memberTier, featureFlags = {}, member = {}) {
  const normalizedTier = normalizeTier(memberTier);
  const tierRank = getTierRank(normalizedTier);

  const referralsEnabled = featureFlags.referrals_enabled !== false;
  const benefitsEnabled = featureFlags.benefits_enabled !== false;
  const rewardsEnabled = featureFlags.rewards_enabled !== false;
  const supportEnabled = featureFlags.support_enabled !== false;
  const accessPerksEnabled = featureFlags.access_perks_enabled !== false;

  const access = buildAccessPayload(member);

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

    if (benefit.code === "access_perks_lifestyle" && !accessPerksEnabled) {
      return false;
    }

    return true;
  })
    .map((benefit) => {
      const requiredTierRank = Math.min(
        ...benefit.tiers.map((tier) => getTierRank(tier))
      );

      let unlocked = benefit.tiers.includes(normalizedTier);
      let lockedReason = null;

      const lockedBecauseTier = !unlocked && tierRank < requiredTierRank;

      if (lockedBecauseTier) {
        lockedReason = `Available starting at ${titleCase(
          benefit.tiers[0] || "core"
        )} tier.`;
      }

      if (benefit.code === "access_perks_lifestyle") {
        unlocked = hasPortalAccess(member);

        if (!access.perks_ready) {
          lockedReason =
            "Your membership is active, but Access Perks member sync is still pending until Access AMT confirms the member record.";
        }
      }

      return {
        ...benefit,
        requiredTier: benefit.tiers[0] || "core",
        unlocked,
        locked: !unlocked,
        lockedReason,
        href:
          benefit.code === "access_perks_lifestyle"
            ? "/portal/benefits.html"
            : DEFAULT_PORTAL_PATH,
        meta:
          benefit.code === "access_perks_lifestyle"
            ? {
                accessMemberIdentifier: access.member_identifier,
                accessMemberStatus: access.member_status,
                accessPerksReady: access.perks_ready,
                accessSyncError: access.sync_error,
              }
            : {},
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
  accessPerksEnabled,
}) {
  const benefits = [];

  const memberStatus = normalizeMemberStatus(member);
  const access = buildAccessPayload(member);

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
    code: "access_perks_status",
    title: "Access Perks Member Sync",
    description: access.perks_ready
      ? "Your Access Perks member record is active and benefits are ready inside the Card Leo portal."
      : access.sync_error
        ? "Your membership is active, but Access Perks sync is waiting on the correct Member AMT endpoint from Access Development."
        : "Your membership is active. Access Perks will show as active once the member record is confirmed.",
    category: "offers",
    badge: access.perks_ready
      ? "Active"
      : access.sync_error
        ? "Endpoint Pending"
        : "Syncing",
    featured: true,
    sortOrder: 8,
    unlocked: access.perks_ready,
    locked: !access.perks_ready,
    lockedReason: access.perks_ready
      ? null
      : "Access Perks benefits become active after the Access AMT member record syncs as OPEN.",
    href: "/portal/benefits.html",
    meta: {
      enabled: accessPerksEnabled !== false,
      accessMemberIdentifier: access.member_identifier,
      accessMemberStatus: access.member_status,
      accessSyncedAt: access.synced_at,
      accessSyncError: access.sync_error,
      accessPerksReady: access.perks_ready,
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
            ? "You are accruing company-building earnings. Eligible tier allowances are released after Member A recruits four new active team members."
            : "Your company-building earnings section is ready and will grow as eligible paid cycles and active team members are completed.",
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
    lockedCount: items.filter((item) => item.locked).length,
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
    const access = buildAccessPayload(member);

    const staticBenefits = buildStaticBenefits(tier, featureFlags, member);
    const dynamicBenefits = buildDynamicBenefits({
      member,
      onboarding,
      rewardAccount,
      referralsEnabled: featureFlags.referrals_enabled,
      rewardsEnabled: featureFlags.rewards_enabled,
      accessPerksEnabled: featureFlags.access_perks_enabled,
    });

    const benefits = [...dynamicBenefits, ...staticBenefits].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    const grouped = groupBenefitsByCategory(benefits);
    const unlockedCount = benefits.filter((item) => item.unlocked).length;
    const lockedCount = benefits.filter((item) => item.locked).length;
    const featuredBenefits = benefits.filter((item) => item.featured).slice(0, 8);

    logRequestSuccess(req, {
      scope: "portal_benefits",
      memberId,
      email: safeMember.email,
      tier,
      benefitCount: benefits.length,
      accessMemberStatus: access.member_status,
      accessPerksReady: access.perks_ready,
    });

    return ok(
      res,
      {
        authenticated: true,

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
          payment_status: safeMember.paymentStatus,
          membership_status: safeMember.membershipStatus,
          approval_status: safeMember.approvalStatus,
          portalAccess: safeMember.portalAccess,
          timezone: DEFAULT_TIMEZONE,
          totals: {
            benefits: benefits.length,
            unlocked: unlockedCount,
            locked: lockedCount,
          },
        },

        member: safeMember,
        profile: safeMember,

        access,

        accessPerks: {
          enabled: featureFlags.access_perks_enabled !== false,
          ready: access.perks_ready,
          status: access.member_status,
          member_identifier: access.member_identifier,
          synced_at: access.synced_at,
          suspended_at: access.suspended_at,
          sync_error: access.sync_error,
          portal_url: "/portal/benefits.html",
        },

        featureFlags,
        onboarding,
        rewardAccount,

        benefits,
        featuredBenefits,
        groups: grouped,

        categories: grouped.map((group) => ({
          slug: group.category,
          name: group.title,
          count: group.count,
          unlockedCount: group.unlockedCount,
          lockedCount: group.lockedCount,
        })),
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