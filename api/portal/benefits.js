// api/portal/benefits.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { getAccessTokenFromRequest } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_TIMEZONE = "America/New_York";

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
  return String(value || "").trim();
}

function normalizeTier(value) {
  const tier = String(value || "core").trim().toLowerCase();
  if (["core", "silver", "gold", "platinum", "vip"].includes(tier)) return tier;
  return "core";
}

function normalizeMemberStatus(value) {
  const status = String(value || "pending").trim().toLowerCase();
  if (["pending", "active", "paused", "suspended", "closed"].includes(status)) {
    return status;
  }
  return "pending";
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
  if (currentIndex < 0 || currentIndex === tiers.length - 1) return null;
  return tiers[currentIndex + 1];
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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
        requiredTier:
          benefit.tiers.length === 1
            ? benefit.tiers[0]
            : benefit.tiers[0] || "core",
        unlocked,
        locked: !unlocked,
        lockedReason: lockedBecauseTier
          ? `Available starting at ${titleCase(
              benefit.tiers[0] || "core"
            )} tier.`
          : null,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function buildDynamicBenefits({
  profile,
  onboarding,
  rewardAccount,
  referralsEnabled,
  rewardsEnabled,
}) {
  const benefits = [];
  const memberStatus = normalizeMemberStatus(profile?.member_status);
  const onboardingPercent = Number(onboarding?.onboarding_percent || 0);
  const profileComplete = Boolean(onboarding?.profile_completed);
  const emailVerified =
    Boolean(onboarding?.email_verified) || Boolean(profile?.email_verified_at);
  const rewardsActive = Boolean(onboarding?.rewards_activated);

  const directEarned = Number(rewardAccount?.total_direct_referral_earned || 0);
  const overrideEarned = Number(rewardAccount?.total_override_earned || 0);
  const companyPending = Number(rewardAccount?.company_building_pending || 0);
  const companyReleased = Number(rewardAccount?.company_building_released || 0);
  const companyForfeited = Number(rewardAccount?.company_building_forfeited || 0);
  const totalRewardsEarned = Number(rewardAccount?.total_rewards_earned || 0);
  const totalRewardsPaid = Number(rewardAccount?.total_rewards_paid || 0);

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
  }

  if (rewardsEnabled) {
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
  }

  if (rewardsEnabled) {
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
  }

  if (rewardsEnabled) {
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

async function getAuthenticatedUser(req) {
  const accessToken = getAccessTokenFromRequest(req);

  if (!accessToken) {
    return { user: null, error: "Missing access token." };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !data?.user) {
    return {
      user: null,
      error: error?.message || "Unable to authenticate this request.",
    };
  }

  return { user: data.user, error: null };
}

async function getFeatureFlags() {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "portal.features")
    .maybeSingle();

  return data?.value || {};
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_benefits" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const { user, error: authError } = await getAuthenticatedUser(req);

    if (!user) {
      return unauthorized(res, authError || "Unauthorized.");
    }

    const profileId = user.id;

    const [
      profileResult,
      onboardingResult,
      rewardAccountResult,
      featureFlags,
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select(`
          id,
          email,
          first_name,
          last_name,
          full_name,
          member_status,
          role,
          tier,
          referral_code,
          created_at,
          email_verified_at
        `)
        .eq("id", profileId)
        .maybeSingle(),

      supabaseAdmin
        .from("member_onboarding")
        .select(`
          profile_id,
          accepted_terms,
          accepted_privacy,
          profile_completed,
          email_verified,
          first_login_completed,
          rewards_activated,
          onboarding_percent,
          onboarding_status
        `)
        .eq("profile_id", profileId)
        .maybeSingle(),

      supabaseAdmin
        .from("reward_accounts")
        .select(`
          profile_id,
          account_status,
          total_cardleo_allocated,
          total_direct_referral_earned,
          total_override_earned,
          company_building_pending,
          company_building_released,
          company_building_forfeited,
          total_member_revenue_processed,
          total_rewards_earned,
          total_rewards_paid,
          last_membership_paid_at,
          last_direct_referral_at,
          last_override_at,
          last_company_building_release_at
        `)
        .eq("profile_id", profileId)
        .maybeSingle(),

      getFeatureFlags(),
    ]);

    if (profileResult.error) {
      return serverError(res, "Unable to load member profile.", {
        error: profileResult.error.message,
      });
    }

    const profile = profileResult.data;

    if (!profile) {
      return notFound(res, "Member profile not found.");
    }

    const tier = normalizeTier(profile.tier);
    const nextTier = getNextTier(tier);
    const featureFlagsSafe = {
      rewards_enabled: featureFlags?.rewards_enabled !== false,
      referrals_enabled: featureFlags?.referrals_enabled !== false,
      support_enabled: featureFlags?.support_enabled !== false,
      benefits_enabled: featureFlags?.benefits_enabled !== false,
    };

    const staticBenefits = buildStaticBenefits(tier, featureFlagsSafe);
    const dynamicBenefits = buildDynamicBenefits({
      profile,
      onboarding: onboardingResult.data || null,
      rewardAccount: rewardAccountResult.data || null,
      referralsEnabled: featureFlagsSafe.referrals_enabled,
      rewardsEnabled: featureFlagsSafe.rewards_enabled,
    });

    const benefits = [...dynamicBenefits, ...staticBenefits].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    const grouped = groupBenefitsByCategory(benefits);
    const unlockedCount = benefits.filter((item) => item.unlocked).length;
    const lockedCount = benefits.filter((item) => item.locked).length;

    logRequestSuccess(req, {
      scope: "portal_benefits",
      profileId,
      tier,
      benefitCount: benefits.length,
    });

    return ok(
      res,
      {
        summary: {
          profileId: profile.id,
          memberName:
            profile.full_name ||
            [profile.first_name, profile.last_name].filter(Boolean).join(" "),
          email: profile.email,
          tier,
          tierLabel: titleCase(tier),
          nextTier,
          nextTierLabel: nextTier ? titleCase(nextTier) : null,
          memberStatus: normalizeMemberStatus(profile.member_status),
          timezone: DEFAULT_TIMEZONE,
          totals: {
            benefits: benefits.length,
            unlocked: unlockedCount,
            locked: lockedCount,
          },
        },
        featureFlags: featureFlagsSafe,
        onboarding: onboardingResult.data || null,
        rewardAccount: rewardAccountResult.data || null,
        benefits,
        groups: grouped,
      },
      "Benefits loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_benefits_unexpected" });

    return serverError(
      res,
      "Failed to load portal benefits.",
      { error: error?.message || "Unknown error." }
    );
  }
}