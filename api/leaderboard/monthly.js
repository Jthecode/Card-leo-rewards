// api/leaderboard/monthly.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const DIRECT_REFERRAL_REWARD = 7;
const TEAM_REFERRAL_REWARD = 1;
const GROWTH_POOL_REWARD = 2;

const ACTIVE_STATUSES = new Set([
  "active",
  "approved",
  "paid",
  "current",
  "complete",
  "completed",
  "succeeded",
]);

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(payload));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function moneyAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatName(member) {
  const fullName = normalizeString(member.full_name || member.fullName);

  if (fullName) return fullName;

  const firstName = normalizeString(member.first_name || member.firstName);
  const lastName = normalizeString(member.last_name || member.lastName);
  const name = [firstName, lastName].filter(Boolean).join(" ");

  return name || normalizeEmail(member.email) || "Card Leo Member";
}

function getInitials(member) {
  const name = formatName(member);
  const parts = name.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  if (parts[0]) return parts[0].slice(0, 2).toUpperCase();

  return "CL";
}

function isApprovedMember(member) {
  const status = normalizeString(member.status).toLowerCase();
  const paymentStatus = normalizeString(member.payment_status).toLowerCase();
  const membershipStatus = normalizeString(member.membership_status).toLowerCase();
  const approvalStatus = normalizeString(member.approval_status).toLowerCase();

  return (
    ACTIVE_STATUSES.has(status) ||
    ACTIVE_STATUSES.has(paymentStatus) ||
    ACTIVE_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
}

function getReferralEmail(member) {
  return normalizeEmail(
    member.referral_email ||
      member.referralEmail ||
      member.sponsor_email ||
      member.sponsorEmail ||
      ""
  );
}

function getReferralName(member) {
  return normalizeString(
    member.referral_name ||
      member.referralName ||
      member.sponsor_name ||
      member.sponsorName ||
      ""
  );
}

function getReferralCode(member) {
  return normalizeString(
    member.referral_code ||
      member.referralCode ||
      member.sponsor_code ||
      member.sponsorCode ||
      ""
  );
}

function normalizeCode(value) {
  return normalizeString(value).toLowerCase();
}

function getMemberReferralCode(member) {
  const saved = normalizeString(member.referral_code || member.referralCode);

  if (saved) return normalizeCode(saved);

  const email = normalizeEmail(member.email);
  const emailPrefix = email.split("@")[0];

  return normalizeCode(emailPrefix || member.id || "");
}

function matchesReferrer(member, referrer) {
  const referrerEmail = normalizeEmail(referrer.email);
  const referrerCode = getMemberReferralCode(referrer);
  const referrerId = normalizeCode(referrer.id);

  const memberReferralEmail = getReferralEmail(member);
  const memberReferralName = normalizeCode(getReferralName(member));
  const memberReferralCode = normalizeCode(getReferralCode(member));

  if (memberReferralEmail && memberReferralEmail === referrerEmail) return true;
  if (memberReferralName && memberReferralName === referrerEmail) return true;
  if (memberReferralCode && memberReferralCode === referrerEmail) return true;

  if (referrerCode) {
    if (memberReferralName === referrerCode) return true;
    if (memberReferralCode === referrerCode) return true;
  }

  if (referrerId) {
    if (memberReferralName === referrerId) return true;
    if (memberReferralCode === referrerId) return true;
  }

  return false;
}

function uniqueMembersByIdOrEmail(members) {
  const seen = new Set();

  return members.filter((member) => {
    const key = normalizeString(member.id) || normalizeEmail(member.email);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

async function getAllMembers() {
  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  return Array.isArray(data) ? data : [];
}

function buildMemberBreakdown(member, allMembers) {
  const memberEmail = normalizeEmail(member.email);

  if (!memberEmail || !isValidEmail(memberEmail)) {
    return {
      directReferrals: [],
      approvedDirectReferrals: [],
      teamReferrals: [],
      approvedTeamReferrals: [],
      directEarnings: 0,
      teamEarnings: 0,
      growthPoolCredit: 0,
      totalEarned: 0,
    };
  }

  const directReferrals = uniqueMembersByIdOrEmail(
    allMembers.filter((possibleDirect) => {
      const possibleEmail = normalizeEmail(possibleDirect.email);

      if (!possibleEmail || possibleEmail === memberEmail) return false;

      return matchesReferrer(possibleDirect, member);
    })
  );

  const approvedDirectReferrals = directReferrals.filter(isApprovedMember);

  const teamReferrals = uniqueMembersByIdOrEmail(
    allMembers.filter((possibleTeamMember) => {
      const teamEmail = normalizeEmail(possibleTeamMember.email);

      if (!teamEmail || teamEmail === memberEmail) return false;

      return approvedDirectReferrals.some((directMember) => {
        const directEmail = normalizeEmail(directMember.email);

        if (!directEmail || teamEmail === directEmail) return false;

        return matchesReferrer(possibleTeamMember, directMember);
      });
    })
  );

  const approvedTeamReferrals = teamReferrals.filter(isApprovedMember);

  const directEarnings = approvedDirectReferrals.length * DIRECT_REFERRAL_REWARD;
  const teamEarnings = approvedTeamReferrals.length * TEAM_REFERRAL_REWARD;
  const growthPoolCredit = approvedTeamReferrals.length * GROWTH_POOL_REWARD;
  const totalEarned = directEarnings + teamEarnings;

  return {
    directReferrals,
    approvedDirectReferrals,
    teamReferrals,
    approvedTeamReferrals,
    directEarnings,
    teamEarnings,
    growthPoolCredit,
    totalEarned,
  };
}

function getTopTeamReferralExamples(member, breakdown) {
  return breakdown.approvedTeamReferrals.slice(0, 5).map((teamMember) => {
    const through = breakdown.approvedDirectReferrals.find((directMember) =>
      matchesReferrer(teamMember, directMember)
    );

    return {
      member_b: through
        ? {
            id: normalizeString(through.id),
            name: formatName(through),
            email: normalizeEmail(through.email),
          }
        : null,
      member_c: {
        id: normalizeString(teamMember.id),
        name: formatName(teamMember),
        email: normalizeEmail(teamMember.email),
      },
      label: "Member B referred Member C",
      amount: TEAM_REFERRAL_REWARD,
      note: through
        ? `${formatName(through)} referred ${formatName(teamMember)}`
        : `A direct referral referred ${formatName(teamMember)}`,
    };
  });
}

function buildLeaderboardRow(member, index, breakdown) {
  const approvedDirectCount = breakdown.approvedDirectReferrals.length;
  const approvedTeamCount = breakdown.approvedTeamReferrals.length;

  return {
    rank: index + 1,

    id: normalizeString(member.id),
    member_id: normalizeString(member.id),

    name: formatName(member),
    memberName: formatName(member),
    member_name: formatName(member),
    full_name: formatName(member),
    initials: getInitials(member),

    email: normalizeEmail(member.email),
    status: normalizeString(member.status),
    payment_status: normalizeString(member.payment_status),
    membership_status: normalizeString(member.membership_status),

    approvedReferrals: approvedDirectCount + approvedTeamCount,
    approved_referrals: approvedDirectCount + approvedTeamCount,

    directReferrals: breakdown.directReferrals.length,
    direct_referrals: breakdown.directReferrals.length,
    approvedDirectReferrals: approvedDirectCount,
    approved_direct_referrals: approvedDirectCount,

    teamReferrals: breakdown.teamReferrals.length,
    team_referrals: breakdown.teamReferrals.length,
    approvedTeamReferrals: approvedTeamCount,
    approved_team_referrals: approvedTeamCount,

    directEarnings: breakdown.directEarnings,
    direct_earnings: breakdown.directEarnings,

    teamEarnings: breakdown.teamEarnings,
    team_earnings: breakdown.teamEarnings,

    growthPoolCredit: breakdown.growthPoolCredit,
    growth_pool_credit: breakdown.growthPoolCredit,

    earnedAmount: breakdown.totalEarned,
    earned_amount: breakdown.totalEarned,
    totalEarned: breakdown.totalEarned,
    total_earned: breakdown.totalEarned,

    allowanceBalance: breakdown.totalEarned,
    allowance_balance: breakdown.totalEarned,
    rewardBalance: breakdown.totalEarned,
    reward_balance: breakdown.totalEarned,

    payout_status: normalizeString(member.payout_status || "not_requested"),

    referral_examples: getTopTeamReferralExamples(member, breakdown),

    labels: {
      direct: "Member A referred Member B",
      team: "Member B referred Member C",
      direct_amount: DIRECT_REFERRAL_REWARD,
      team_amount: TEAM_REFERRAL_REWARD,
    },
  };
}

async function saveLeaderboardTotals(row) {
  const updatePayload = {
    direct_referral_earnings: row.directEarnings,
    team_referral_earnings: row.teamEarnings,
    account_credit: row.teamEarnings,
    growth_pool_credit: row.growthPoolCredit,
    total_referral_earnings: row.totalEarned,
    allowance_balance: row.totalEarned,
    reward_balance: row.totalEarned,
  };

  const { error } = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", row.id);

  if (error) {
    console.error("Leaderboard totals save failed:", {
      email: row.email,
      error,
    });
  }
}

function sortLeaderboardRows(rows) {
  return rows.sort((a, b) => {
    if (b.totalEarned !== a.totalEarned) {
      return b.totalEarned - a.totalEarned;
    }

    if (b.approvedReferrals !== a.approvedReferrals) {
      return b.approvedReferrals - a.approvedReferrals;
    }

    if (b.approvedDirectReferrals !== a.approvedDirectReferrals) {
      return b.approvedDirectReferrals - a.approvedDirectReferrals;
    }

    return a.name.localeCompare(b.name);
  });
}

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET.",
    });
  }

  try {
    const limit = Math.max(
      1,
      Math.min(100, Number(req.query?.limit || req.query?.per_page || 50))
    );

    const allMembers = await getAllMembers();

    const approvedMembers = allMembers.filter((member) => {
      const email = normalizeEmail(member.email);
      return email && isValidEmail(email) && isApprovedMember(member);
    });

    const calculatedRows = approvedMembers.map((member) => {
      const breakdown = buildMemberBreakdown(member, allMembers);

      return {
        member,
        breakdown,
        totalEarned: breakdown.totalEarned,
      };
    });

    const leaderboardRows = sortLeaderboardRows(
      calculatedRows.map((item, index) =>
        buildLeaderboardRow(item.member, index, item.breakdown)
      )
    ).map((row, index) => ({
      ...row,
      rank: index + 1,
    }));

    await Promise.allSettled(
      leaderboardRows.slice(0, limit).map((row) => saveLeaderboardTotals(row))
    );

    const visibleRows = leaderboardRows.slice(0, limit);

    const totalDirectEarnings = leaderboardRows.reduce(
      (sum, row) => sum + moneyAmount(row.directEarnings),
      0
    );

    const totalTeamEarnings = leaderboardRows.reduce(
      (sum, row) => sum + moneyAmount(row.teamEarnings),
      0
    );

    const totalGrowthPoolCredit = leaderboardRows.reduce(
      (sum, row) => sum + moneyAmount(row.growthPoolCredit),
      0
    );

    const totalLeaderboardEarnings = leaderboardRows.reduce(
      (sum, row) => sum + moneyAmount(row.totalEarned),
      0
    );

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      message: "Monthly leaderboard loaded.",
      month_key: getMonthKey(),
      month_label: getMonthLabel(),

      reward_rules: {
        direct_referral_label: "Member A referred Member B",
        direct_referral_amount: DIRECT_REFERRAL_REWARD,
        team_referral_label: "Member B referred Member C",
        team_referral_amount: TEAM_REFERRAL_REWARD,
        growth_pool_amount: GROWTH_POOL_REWARD,
        leaderboard_total_formula:
          "approved direct referrals × 7 + approved team referrals × 1",
      },

      summary: {
        totalMembers: approvedMembers.length,
        total_members: approvedMembers.length,

        totalLeaderboardMembers: leaderboardRows.length,
        total_leaderboard_members: leaderboardRows.length,

        totalDirectEarnings,
        total_direct_earnings: totalDirectEarnings,

        totalTeamEarnings,
        total_team_earnings: totalTeamEarnings,

        totalGrowthPoolCredit,
        total_growth_pool_credit: totalGrowthPoolCredit,

        totalLeaderboardEarnings,
        total_leaderboard_earnings: totalLeaderboardEarnings,
      },

      leaderboard: visibleRows,
      rows: visibleRows,
      members: visibleRows,
      topEarners: visibleRows,
      top_earners: visibleRows,
    });
  } catch (error) {
    console.error("Card Leo leaderboard/monthly error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message: error?.message || "Unable to load monthly leaderboard right now.",
    });
  }
}