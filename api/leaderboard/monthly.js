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

const EMPTY_RESPONSE = {
  success: true,
  ok: true,
  authenticated: true,
  message: "Monthly leaderboard loaded.",
  leaderboard: [],
  rows: [],
  members: [],
  topEarners: [],
  top_earners: [],
};

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  return res.end(JSON.stringify(payload));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeComparable(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactComparable(value) {
  return normalizeComparable(value).replace(/[^a-z0-9@._-]/g, "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function moneyAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatName(member) {
  const fullName = normalizeString(member?.full_name || member?.fullName);

  if (fullName) return fullName;

  const firstName = normalizeString(member?.first_name || member?.firstName);
  const lastName = normalizeString(member?.last_name || member?.lastName);
  const name = [firstName, lastName].filter(Boolean).join(" ");

  return name || normalizeEmail(member?.email) || "Card Leo Member";
}

function getFirstName(member) {
  return normalizeString(member?.first_name || member?.firstName);
}

function getLastName(member) {
  return normalizeString(member?.last_name || member?.lastName);
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
  const status = normalizeString(member?.status).toLowerCase();
  const paymentStatus = normalizeString(member?.payment_status).toLowerCase();
  const membershipStatus = normalizeString(member?.membership_status).toLowerCase();
  const approvalStatus = normalizeString(member?.approval_status).toLowerCase();

  return (
    ACTIVE_STATUSES.has(status) ||
    ACTIVE_STATUSES.has(paymentStatus) ||
    ACTIVE_STATUSES.has(membershipStatus) ||
    ACTIVE_STATUSES.has(approvalStatus)
  );
}

function getReferralEmail(member) {
  return normalizeEmail(
    member?.referral_email ||
      member?.referralEmail ||
      member?.sponsor_email ||
      member?.sponsorEmail ||
      ""
  );
}

function getReferralName(member) {
  return normalizeString(
    member?.referral_name ||
      member?.referralName ||
      member?.sponsor_name ||
      member?.sponsorName ||
      ""
  );
}

function getReferralCode(member) {
  return normalizeString(
    member?.referral_code ||
      member?.referralCode ||
      member?.sponsor_code ||
      member?.sponsorCode ||
      ""
  );
}

function getMemberReferralCode(member) {
  const saved = normalizeString(member?.referral_code || member?.referralCode);

  if (saved) return compactComparable(saved);

  const email = normalizeEmail(member?.email);
  const emailPrefix = email.split("@")[0];

  return compactComparable(emailPrefix || member?.id || "");
}

function getMemberAliases(member) {
  const email = normalizeEmail(member?.email);
  const emailPrefix = email ? email.split("@")[0] : "";
  const firstName = getFirstName(member);
  const lastName = getLastName(member);
  const fullName = formatName(member);
  const referralCode = getMemberReferralCode(member);
  const id = normalizeString(member?.id);

  const aliases = [
    email,
    emailPrefix,
    firstName,
    lastName,
    fullName,
    `${firstName} ${lastName}`,
    `${lastName} ${firstName}`,
    referralCode,
    id,
  ];

  // Helpful alias for Maurece/Moe situation.
  if (
    normalizeComparable(firstName) === "maurece" ||
    normalizeComparable(firstName) === "maurice" ||
    normalizeComparable(fullName).includes("maurece") ||
    normalizeComparable(fullName).includes("maurice")
  ) {
    aliases.push("moe");
  }

  return Array.from(
    new Set(
      aliases
        .map((value) => normalizeString(value))
        .filter(Boolean)
    )
  );
}

function getReferralValues(member) {
  const values = [
    getReferralEmail(member),
    getReferralName(member),
    getReferralCode(member),
    member?.sponsor,
    member?.sponsor_id,
    member?.sponsorId,
    member?.referred_by,
    member?.referredBy,
    member?.referred_by_email,
    member?.referredByEmail,
    member?.upline_email,
    member?.uplineEmail,
  ];

  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value))
        .filter(Boolean)
    )
  );
}

function valuesMatch(value, alias) {
  const cleanValue = normalizeComparable(value);
  const cleanAlias = normalizeComparable(alias);
  const compactValue = compactComparable(value);
  const compactAlias = compactComparable(alias);

  if (!cleanValue || !cleanAlias) return false;

  if (cleanValue === cleanAlias) return true;
  if (compactValue && compactAlias && compactValue === compactAlias) return true;

  return false;
}

function matchesReferrer(member, referrer) {
  if (!member || !referrer) return false;

  const memberEmail = normalizeEmail(member.email);
  const referrerEmail = normalizeEmail(referrer.email);

  if (!memberEmail || !referrerEmail) return false;
  if (memberEmail === referrerEmail) return false;

  const referralValues = getReferralValues(member);
  const referrerAliases = getMemberAliases(referrer);

  for (const referralValue of referralValues) {
    for (const alias of referrerAliases) {
      if (valuesMatch(referralValue, alias)) {
        return true;
      }
    }
  }

  return false;
}

function uniqueMembersByIdOrEmail(members) {
  const seen = new Set();

  return members.filter((member) => {
    const key = normalizeString(member?.id) || normalizeEmail(member?.email);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

async function getAllMembers() {
  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw error;

  return Array.isArray(data) ? data : [];
}

function buildMemberBreakdown(member, allMembers) {
  const memberEmail = normalizeEmail(member?.email);

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
      const possibleEmail = normalizeEmail(possibleDirect?.email);

      if (!possibleEmail || possibleEmail === memberEmail) return false;

      return matchesReferrer(possibleDirect, member);
    })
  );

  const approvedDirectReferrals = directReferrals.filter(isApprovedMember);

  const teamReferrals = uniqueMembersByIdOrEmail(
    allMembers.filter((possibleTeamMember) => {
      const teamEmail = normalizeEmail(possibleTeamMember?.email);

      if (!teamEmail || teamEmail === memberEmail) return false;

      return approvedDirectReferrals.some((directMember) => {
        const directEmail = normalizeEmail(directMember?.email);

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
  return breakdown.approvedTeamReferrals.slice(0, 10).map((teamMember) => {
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

function getDirectReferralExamples(breakdown) {
  return breakdown.approvedDirectReferrals.slice(0, 10).map((directMember) => ({
    member_b: {
      id: normalizeString(directMember.id),
      name: formatName(directMember),
      email: normalizeEmail(directMember.email),
    },
    label: "Member A referred Member B",
    amount: DIRECT_REFERRAL_REWARD,
    note: `Direct referral: ${formatName(directMember)}`,
  }));
}

function buildLeaderboardRow(member, breakdown) {
  const approvedDirectCount = breakdown.approvedDirectReferrals.length;
  const approvedTeamCount = breakdown.approvedTeamReferrals.length;
  const approvedCount = approvedDirectCount + approvedTeamCount;

  return {
    rank: 0,

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
    approval_status: normalizeString(member.approval_status),

    approvedReferrals: approvedCount,
    approved_referrals: approvedCount,

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

    direct_referral_examples: getDirectReferralExamples(breakdown),
    team_referral_examples: getTopTeamReferralExamples(member, breakdown),
    referral_examples: [
      ...getDirectReferralExamples(breakdown),
      ...getTopTeamReferralExamples(member, breakdown),
    ],

    labels: {
      direct: "Member A referred Member B",
      team: "Member B referred Member C",
      direct_amount: DIRECT_REFERRAL_REWARD,
      team_amount: TEAM_REFERRAL_REWARD,
      growth_pool_amount: GROWTH_POOL_REWARD,
    },
  };
}

function isMissingColumnError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    message.includes("column") ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    details.includes("column") ||
    details.includes("schema cache") ||
    details.includes("could not find")
  );
}

async function saveLeaderboardTotals(row) {
  const fullPayload = {
    direct_referral_earnings: row.directEarnings,
    team_referral_earnings: row.teamEarnings,
    account_credit: row.teamEarnings,
    growth_pool_credit: row.growthPoolCredit,
    total_referral_earnings: row.totalEarned,
    allowance_balance: row.totalEarned,
    reward_balance: row.totalEarned,
    updated_at: new Date().toISOString(),
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", row.id);

  if (!result.error) return;

  if (!isMissingColumnError(result.error)) {
    console.error("Leaderboard totals save failed:", {
      email: row.email,
      error: result.error,
    });

    return;
  }

  const fallbackPayload = {
    updated_at: new Date().toISOString(),
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", row.id);

  if (result.error) {
    console.error("Leaderboard fallback save failed:", {
      email: row.email,
      error: result.error,
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

function buildDebugChain(allMembers) {
  const targetEmails = [
    "maurecewilliams@yahoo.com",
    "marethiaa@yahoo.com",
    "monicawilliams10@gmail.com",
  ];

  return allMembers
    .filter((member) => targetEmails.includes(normalizeEmail(member.email)))
    .map((member) => ({
      email: normalizeEmail(member.email),
      name: formatName(member),
      status: normalizeString(member.status),
      payment_status: normalizeString(member.payment_status),
      membership_status: normalizeString(member.membership_status),
      approval_status: normalizeString(member.approval_status),
      referral_email: getReferralEmail(member),
      referral_name: getReferralName(member),
      referral_code: getReferralCode(member),
      approved: isApprovedMember(member),
    }));
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

    const includeZero =
      String(req.query?.include_zero ?? "true").toLowerCase() !== "false";

    const debug =
      String(req.query?.debug ?? "").toLowerCase() === "true" ||
      String(req.query?.debug ?? "") === "1";

    const allMembers = await getAllMembers();

    if (!allMembers.length) {
      return sendJson(res, 200, {
        ...EMPTY_RESPONSE,
        month_key: getMonthKey(),
        month_label: getMonthLabel(),
        summary: {
          totalMembers: 0,
          total_members: 0,
          totalLeaderboardMembers: 0,
          total_leaderboard_members: 0,
          totalDirectEarnings: 0,
          total_direct_earnings: 0,
          totalTeamEarnings: 0,
          total_team_earnings: 0,
          totalGrowthPoolCredit: 0,
          total_growth_pool_credit: 0,
          totalLeaderboardEarnings: 0,
          total_leaderboard_earnings: 0,
        },
      });
    }

    const approvedMembers = allMembers.filter((member) => {
      const email = normalizeEmail(member.email);

      return email && isValidEmail(email) && isApprovedMember(member);
    });

    const calculatedRows = approvedMembers.map((member) => {
      const breakdown = buildMemberBreakdown(member, allMembers);
      return buildLeaderboardRow(member, breakdown);
    });

    const filteredRows = includeZero
      ? calculatedRows
      : calculatedRows.filter((row) => row.totalEarned > 0);

    const leaderboardRows = sortLeaderboardRows(filteredRows).map((row, index) => ({
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

      debug: debug
        ? {
            chain: buildDebugChain(allMembers),
            expected_current_chain_without_micah: {
              maurece_or_moe:
                "Marethia direct referral = $7, Monica second-level referral through Marethia = $1, total = $8.",
              marethia:
                "Monica direct referral = $7, total = $7 until Micah creates an approved account.",
              monica:
                "No approved referrals yet until Micah creates an approved account.",
            },
          }
        : undefined,
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