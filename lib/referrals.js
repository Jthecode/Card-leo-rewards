// lib/referrals.js

const DEFAULT_PUBLIC_ORIGIN =
  "https://www.cardleorewards.com";

const DIRECT_REFERRAL_REWARD = 7;
const TEAM_REFERRAL_REWARD = 1;

const ACTIVE_MEMBER_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

const ACTIVE_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

const ACTIVE_APPROVAL_STATUSES = new Set([
  "approved",
  "active",
  "complete",
  "completed",
]);

const APPROVED_REFERRAL_STATUSES = new Set([
  "activated",
  "approved",
  "active",
  "reward_pending",
  "rewarded",
]);

const PENDING_REFERRAL_STATUSES = new Set([
  "invited",
  "opened",
  "registered",
  "pending",
  "payment_pending",
  "pending_payment",
]);

const TERMINAL_REFERRAL_STATUSES = new Set([
  "expired",
  "cancelled",
  "denied",
  "failed",
]);

/* ==========================================================================
   BASIC HELPERS
============================================================================ */

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value).toLowerCase();
}

function onlyAlphaNumeric(value) {
  return normalizeText(value).replace(
    /[^a-zA-Z0-9]/g,
    ""
  );
}

function titleCase(value) {
  return normalizeText(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1).toLowerCase()
    )
    .join(" ");
}

function money(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Number(
    number.toFixed(2)
  );
}

function isValidEmail(value) {
  const email =
    normalizeEmail(value);

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

/* ==========================================================================
   REFERRAL CODE
============================================================================ */

function cleanReferralCode(value) {
  const raw =
    normalizeText(value);

  if (!raw) {
    return "";
  }

  try {
    const parsed =
      new URL(raw);

    const fromUrl =
      parsed.searchParams.get("ref") ||
      parsed.searchParams.get("referral") ||
      parsed.searchParams.get(
        "referral_code"
      ) ||
      parsed.searchParams.get("sponsor") ||
      parsed.searchParams.get("code") ||
      "";

    if (fromUrl) {
      return cleanReferralCode(
        fromUrl
      );
    }
  } catch {
    // Not a full URL.
  }

  return raw
    .replace(/^ref=/i, "")
    .replace(/^referral=/i, "")
    .replace(/^referral_code=/i, "")
    .replace(/^sponsor=/i, "")
    .replace(/^code=/i, "")
    .toLowerCase()
    .replace(
      /[^a-z0-9._@-]/g,
      ""
    );
}

function buildReferralCode(member = {}) {
  const existing =
    cleanReferralCode(
      member.referral_code ||
        member.referralCode ||
        member.sponsor_code ||
        member.sponsorCode
    );

  if (existing) {
    return existing;
  }

  const memberId =
    onlyAlphaNumeric(
      member.id ||
        member.member_id ||
        member.memberId ||
        member.signup_id ||
        member.signupId
    );

  if (memberId) {
    return `CL-${memberId
      .slice(0, 8)
      .toUpperCase()}`;
  }

  const email =
    normalizeEmail(
      member.email
    );

  if (email) {
    const prefix =
      onlyAlphaNumeric(
        email.split("@")[0]
      );

    if (prefix) {
      return `CL-${prefix
        .slice(0, 8)
        .toUpperCase()}`;
    }
  }

  const name =
    onlyAlphaNumeric(
      member.full_name ||
        member.fullName ||
        member.name
    );

  if (name) {
    return `CL-${name
      .slice(0, 8)
      .toUpperCase()}`;
  }

  return "";
}

/* ==========================================================================
   REFERRAL URL
============================================================================ */

function buildReferralUrl(
  memberOrCode,
  options = {}
) {
  const code =
    typeof memberOrCode === "string"
      ? cleanReferralCode(memberOrCode)
      : buildReferralCode(
          memberOrCode || {}
        );

  if (!code) {
    return "";
  }

  const origin =
    normalizeText(
      options.origin ||
        options.baseUrl ||
        options.base_url ||
        DEFAULT_PUBLIC_ORIGIN
    ).replace(/\/+$/, "");

  const signupPath =
    normalizeText(
      options.signupPath ||
        options.signup_path ||
        "/signup.html"
    );

  try {
    const url =
      new URL(
        signupPath,
        origin
      );

    url.searchParams.set(
      "ref",
      code
    );

    return url.toString();
  } catch {
    return (
      `${origin}${signupPath}` +
      `?ref=${encodeURIComponent(
        code
      )}`
    );
  }
}

/* ==========================================================================
   SHARE MESSAGE
============================================================================ */

function buildReferralShareMessage(
  memberOrCode,
  options = {}
) {
  const referralUrl =
    options.referralUrl ||
    options.referral_url ||
    buildReferralUrl(
      memberOrCode,
      options
    );

  if (!referralUrl) {
    return "";
  }

  const inviterName =
    normalizeText(
      options.inviterName ||
        options.inviter_name ||
        memberOrCode?.first_name ||
        memberOrCode?.firstName ||
        memberOrCode?.full_name ||
        memberOrCode?.fullName ||
        memberOrCode?.name
    );

  const intro =
    inviterName
      ? `${inviterName} invited you to join Card Leo Rewards.`
      : "You were invited to join Card Leo Rewards.";

  return [
    intro,
    "Use this personal referral link to create your account:",
    referralUrl,
    "Complete signup and membership activation so your account can be connected to the referral team.",
  ].join("\n\n");
}

/* ==========================================================================
   MEMBER STATUS
============================================================================ */

function isMemberApproved(member = {}) {
  const status =
    normalizeStatus(
      member.status
    );

  const membershipStatus =
    normalizeStatus(
      member.membership_status ||
        member.membershipStatus
    );

  const paymentStatus =
    normalizeStatus(
      member.payment_status ||
        member.paymentStatus
    );

  const approvalStatus =
    normalizeStatus(
      member.approval_status ||
        member.approvalStatus
    );

  if (
    ACTIVE_MEMBER_STATUSES.has(
      status
    )
  ) {
    return true;
  }

  if (
    ACTIVE_MEMBER_STATUSES.has(
      membershipStatus
    )
  ) {
    return true;
  }

  if (
    ACTIVE_PAYMENT_STATUSES.has(
      paymentStatus
    ) &&
    (
      !approvalStatus ||
      ACTIVE_APPROVAL_STATUSES.has(
        approvalStatus
      )
    )
  ) {
    return true;
  }

  if (
    ACTIVE_APPROVAL_STATUSES.has(
      approvalStatus
    ) &&
    (
      !paymentStatus ||
      ACTIVE_PAYMENT_STATUSES.has(
        paymentStatus
      )
    )
  ) {
    return true;
  }

  return false;
}

function isMemberPaid(member = {}) {
  const paymentStatus =
    normalizeStatus(
      member.payment_status ||
        member.paymentStatus
    );

  return ACTIVE_PAYMENT_STATUSES.has(
    paymentStatus
  );
}

/* ==========================================================================
   REFERRAL STATUS
============================================================================ */

function isReferralApproved(
  referral = {}
) {
  const status =
    normalizeStatus(
      referral.status ||
        referral.referral_status
    );

  return APPROVED_REFERRAL_STATUSES.has(
    status
  );
}

function isReferralPending(
  referral = {}
) {
  const status =
    normalizeStatus(
      referral.status ||
        referral.referral_status
    );

  if (
    TERMINAL_REFERRAL_STATUSES.has(
      status
    )
  ) {
    return false;
  }

  if (
    APPROVED_REFERRAL_STATUSES.has(
      status
    )
  ) {
    return false;
  }

  return (
    PENDING_REFERRAL_STATUSES.has(
      status
    ) ||
    !status
  );
}

/* ==========================================================================
   RELATIONSHIP IDS
============================================================================ */

function getReferrerMemberId(
  referral = {}
) {
  return normalizeText(
    referral.referrer_signup_id ||
      referral.referrer_member_id ||
      referral.referrer_profile_id ||
      referral.referrer_id ||
      referral.referrerId
  );
}

function getReferredMemberId(
  referral = {}
) {
  return normalizeText(
    referral.referred_signup_id ||
      referral.referred_member_id ||
      referral.referred_profile_id ||
      referral.referred_id ||
      referral.referredId
  );
}

/* ==========================================================================
   DIRECT / TEAM RELATIONSHIP
============================================================================ */

function determineReferralRelationship(
  referral = {},
  currentMember = {}
) {
  const currentMemberId =
    normalizeText(
      currentMember.id ||
        currentMember.member_id ||
        currentMember.memberId ||
        currentMember.signup_id ||
        currentMember.signupId
    );

  const currentMemberCode =
    buildReferralCode(
      currentMember
    );

  const referrerId =
    getReferrerMemberId(
      referral
    );

  const referredId =
    getReferredMemberId(
      referral
    );

  const referralCode =
    cleanReferralCode(
      referral.referral_code ||
        referral.referralCode ||
        referral.sponsor_code ||
        referral.sponsorCode
    );

  if (
    currentMemberId &&
    referrerId === currentMemberId
  ) {
    return "direct";
  }

  if (
    currentMemberCode &&
    referralCode &&
    referralCode ===
      currentMemberCode
  ) {
    return "direct";
  }

  if (
    currentMemberId &&
    referredId === currentMemberId
  ) {
    return "referred_me";
  }

  return "team";
}

/* ==========================================================================
   REWARD AMOUNT
============================================================================ */

function getReferralRewardAmount(
  referral = {},
  currentMember = {}
) {
  if (
    !isReferralApproved(
      referral
    )
  ) {
    return 0;
  }

  const relationship =
    determineReferralRelationship(
      referral,
      currentMember
    );

  if (
    relationship === "direct"
  ) {
    return DIRECT_REFERRAL_REWARD;
  }

  if (
    relationship === "team"
  ) {
    return TEAM_REFERRAL_REWARD;
  }

  return 0;
}

/* ==========================================================================
   SELF REFERRAL PROTECTION
============================================================================ */

function isSelfReferral({
  referrer,
  referred,
} = {}) {
  if (
    !referrer ||
    !referred
  ) {
    return false;
  }

  const referrerId =
    normalizeText(
      referrer.id ||
        referrer.member_id ||
        referrer.memberId
    );

  const referredId =
    normalizeText(
      referred.id ||
        referred.member_id ||
        referred.memberId
    );

  if (
    referrerId &&
    referredId &&
    referrerId === referredId
  ) {
    return true;
  }

  const referrerEmail =
    normalizeEmail(
      referrer.email
    );

  const referredEmail =
    normalizeEmail(
      referred.email
    );

  if (
    referrerEmail &&
    referredEmail &&
    referrerEmail ===
      referredEmail
  ) {
    return true;
  }

  return false;
}

/* ==========================================================================
   SPONSOR / REFERRER MATCHING
============================================================================ */

function getPossibleSponsorValues(
  input = {}
) {
  return [
    input.referral_code,
    input.referralCode,
    input.sponsor_code,
    input.sponsorCode,
    input.referral_email,
    input.referralEmail,
    input.sponsor_email,
    input.sponsorEmail,
    input.referral_name,
    input.referralName,
    input.sponsor_name,
    input.sponsorName,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function doesMemberMatchSponsor(
  member = {},
  sponsorInput = {}
) {
  const sponsorValues =
    getPossibleSponsorValues(
      sponsorInput
    );

  if (!sponsorValues.length) {
    return false;
  }

  const memberReferralCode =
    cleanReferralCode(
      buildReferralCode(member)
    );

  const memberEmail =
    normalizeEmail(
      member.email
    );

  const memberFullName =
    normalizeText(
      member.full_name ||
        member.fullName ||
        member.name ||
        [
          member.first_name ||
            member.firstName,
          member.last_name ||
            member.lastName,
        ]
          .filter(Boolean)
          .join(" ")
    ).toLowerCase();

  return sponsorValues.some(
    (value) => {
      const cleanedCode =
        cleanReferralCode(value);

      const cleanedEmail =
        normalizeEmail(value);

      const cleanedName =
        normalizeText(value)
          .toLowerCase();

      if (
        memberReferralCode &&
        cleanedCode &&
        memberReferralCode ===
          cleanedCode
      ) {
        return true;
      }

      if (
        memberEmail &&
        isValidEmail(cleanedEmail) &&
        memberEmail ===
          cleanedEmail
      ) {
        return true;
      }

      if (
        memberFullName &&
        cleanedName &&
        memberFullName ===
          cleanedName
      ) {
        return true;
      }

      return false;
    }
  );
}

/* ==========================================================================
   REWARD IDEMPOTENCY
============================================================================ */

function buildReferralRewardKey({
  referralId,
  memberId,
  relationship,
} = {}) {
  const safeReferralId =
    normalizeText(
      referralId
    );

  const safeMemberId =
    normalizeText(
      memberId
    );

  const safeRelationship =
    normalizeStatus(
      relationship
    );

  if (
    !safeReferralId ||
    !safeMemberId ||
    !safeRelationship
  ) {
    return "";
  }

  return [
    "referral",
    safeReferralId,
    safeMemberId,
    safeRelationship,
  ].join(":");
}

/* ==========================================================================
   REFERRAL SUMMARY
============================================================================ */

function summarizeReferralActivity(
  referrals = [],
  currentMember = {}
) {
  const summary = {
    totalReferrals: 0,

    directReferrals: 0,
    approvedDirectReferrals: 0,
    pendingDirectReferrals: 0,

    teamReferrals: 0,
    approvedTeamReferrals: 0,
    pendingTeamReferrals: 0,

    referredMe: 0,

    approvedReferrals: 0,
    pendingReferrals: 0,

    directEarnings: 0,
    teamEarnings: 0,

    totalReferralEarnings: 0,
  };

  for (
    const referral of referrals
  ) {
    const relationship =
      determineReferralRelationship(
        referral,
        currentMember
      );

    const approved =
      isReferralApproved(
        referral
      );

    const pending =
      isReferralPending(
        referral
      );

    const rewardAmount =
      getReferralRewardAmount(
        referral,
        currentMember
      );

    if (
      relationship ===
      "referred_me"
    ) {
      summary.referredMe += 1;
      continue;
    }

    summary.totalReferrals += 1;

    if (
      relationship ===
      "direct"
    ) {
      summary.directReferrals += 1;

      if (approved) {
        summary.approvedDirectReferrals +=
          1;
      }

      if (pending) {
        summary.pendingDirectReferrals +=
          1;
      }

      summary.directEarnings +=
        rewardAmount;
    }

    if (
      relationship ===
      "team"
    ) {
      summary.teamReferrals += 1;

      if (approved) {
        summary.approvedTeamReferrals +=
          1;
      }

      if (pending) {
        summary.pendingTeamReferrals +=
          1;
      }

      summary.teamEarnings +=
        rewardAmount;
    }

    if (approved) {
      summary.approvedReferrals += 1;
    }

    if (pending) {
      summary.pendingReferrals += 1;
    }
  }

  summary.directEarnings =
    money(
      summary.directEarnings
    );

  summary.teamEarnings =
    money(
      summary.teamEarnings
    );

  summary.totalReferralEarnings =
    money(
      summary.directEarnings +
        summary.teamEarnings
    );

  return summary;
}

/* ==========================================================================
   MAP REFERRAL FOR PORTAL
============================================================================ */

function mapReferralForPortal(
  referral = {},
  currentMember = {}
) {
  const relationship =
    determineReferralRelationship(
      referral,
      currentMember
    );

  const approved =
    isReferralApproved(
      referral
    );

  const pending =
    isReferralPending(
      referral
    );

  const rewardAmount =
    getReferralRewardAmount(
      referral,
      currentMember
    );

  return {
    ...referral,

    relationship,

    relationshipLabel:
      relationship === "direct"
        ? "Direct Referral"
        : relationship === "team"
          ? "Team Referral"
          : "Referred You",

    approved,

    pending,

    rewardAmount,

    rewardLabel:
      rewardAmount > 0
        ? `$${rewardAmount.toFixed(2)}`
        : "$0.00",
  };
}

/* ==========================================================================
   BUILD TOWER DATA
============================================================================ */

function buildReferralTower(
  referrals = [],
  currentMember = {}
) {
  const mapped =
    referrals.map(
      (referral) =>
        mapReferralForPortal(
          referral,
          currentMember
        )
    );

  const direct =
    mapped.filter(
      (item) =>
        item.relationship ===
        "direct"
    );

  const team =
    mapped.filter(
      (item) =>
        item.relationship ===
        "team"
    );

  const directApproved =
    direct.filter(
      (item) =>
        item.approved
    );

  const teamApproved =
    team.filter(
      (item) =>
        item.approved
    );

  return {
    direct: {
      members: direct,

      total:
        direct.length,

      approved:
        directApproved.length,

      pending:
        direct.filter(
          (item) =>
            item.pending
        ).length,

      rewardPerApprovedMember:
        DIRECT_REFERRAL_REWARD,

      projectedReward:
        money(
          directApproved.length *
            DIRECT_REFERRAL_REWARD
        ),
    },

    team: {
      members: team,

      total:
        team.length,

      approved:
        teamApproved.length,

      pending:
        team.filter(
          (item) =>
            item.pending
        ).length,

      rewardPerApprovedMember:
        TEAM_REFERRAL_REWARD,

      projectedReward:
        money(
          teamApproved.length *
            TEAM_REFERRAL_REWARD
        ),
    },

    totalMembers:
      direct.length +
      team.length,

    totalApproved:
      directApproved.length +
      teamApproved.length,

    totalProjectedReward:
      money(
        (
          directApproved.length *
          DIRECT_REFERRAL_REWARD
        ) +
        (
          teamApproved.length *
          TEAM_REFERRAL_REWARD
        )
      ),
  };
}

/* ==========================================================================
   EXPORTS
============================================================================ */

export {
  DIRECT_REFERRAL_REWARD,
  TEAM_REFERRAL_REWARD,

  ACTIVE_MEMBER_STATUSES,
  ACTIVE_PAYMENT_STATUSES,
  ACTIVE_APPROVAL_STATUSES,
  APPROVED_REFERRAL_STATUSES,
  PENDING_REFERRAL_STATUSES,
  TERMINAL_REFERRAL_STATUSES,

  normalizeText,
  normalizeEmail,
  normalizeStatus,
  onlyAlphaNumeric,
  titleCase,
  money,
  isValidEmail,

  cleanReferralCode,
  buildReferralCode,
  buildReferralUrl,
  buildReferralShareMessage,

  isMemberApproved,
  isMemberPaid,

  isReferralApproved,
  isReferralPending,

  getReferrerMemberId,
  getReferredMemberId,

  determineReferralRelationship,
  getReferralRewardAmount,

  isSelfReferral,

  getPossibleSponsorValues,
  doesMemberMatchSponsor,

  buildReferralRewardKey,

  summarizeReferralActivity,
  mapReferralForPortal,
  buildReferralTower,
};