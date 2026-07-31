// api/referrals/me.js
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

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  return cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=")
    ? decodeURIComponent(
        cookieHeader
          .split(";")
          .map((cookie) => cookie.trim())
          .find((cookie) => cookie.startsWith(`${name}=`))
          ?.split("=")
          .slice(1)
          .join("=") || ""
      )
    : "";
}

function pickSessionToken(req) {
  return (
    getCookie(req, "cardleo_session") ||
    getCookie(req, "cardleo_session_token") ||
    getCookie(req, "session") ||
    getCookie(req, "token") ||
    normalizeString(req.headers.authorization).replace(/^Bearer\s+/i, "")
  );
}

async function findCurrentMember(req) {
  const sessionToken = pickSessionToken(req);

  if (sessionToken) {
    const sessionLookup = await supabaseAdmin
      .from("signups")
      .select("*")
      .or(
        [
          `session_token.eq.${sessionToken}`,
          `auth_token.eq.${sessionToken}`,
          `login_token.eq.${sessionToken}`,
          `portal_token.eq.${sessionToken}`,
        ].join(",")
      )
      .maybeSingle();

    if (sessionLookup.data?.id) {
      return sessionLookup.data;
    }
  }

  const queryEmail = normalizeEmail(req.query?.email);

  if (queryEmail && isValidEmail(queryEmail)) {
    const byEmail = await supabaseAdmin
      .from("signups")
      .select("*")
      .ilike("email", queryEmail)
      .maybeSingle();

    if (byEmail.data?.id) {
      return byEmail.data;
    }
  }

  const meResponse = await supabaseAdmin
    .from("signups")
    .select("*")
    .limit(1);

  if (meResponse.error) {
    throw meResponse.error;
  }

  return null;
}

async function getAllMembers() {
  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  return Array.isArray(data) ? data : [];
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

function matchesReferrer(member, referrer) {
  const referrerEmail = normalizeEmail(referrer.email);
  const referrerCode = normalizeString(referrer.referral_code || referrer.referralCode);
  const referrerId = normalizeString(referrer.id);

  const memberReferralEmail = getReferralEmail(member);
  const memberReferralName = getReferralName(member).toLowerCase();
  const memberReferralCode = getReferralCode(member);

  if (memberReferralEmail && memberReferralEmail === referrerEmail) return true;
  if (memberReferralName && memberReferralName === referrerEmail) return true;
  if (memberReferralCode && memberReferralCode === referrerEmail) return true;

  if (referrerCode) {
    const cleanReferrerCode = referrerCode.toLowerCase();

    if (memberReferralName === cleanReferrerCode) return true;
    if (memberReferralCode.toLowerCase() === cleanReferrerCode) return true;
  }

  if (referrerId) {
    const cleanReferrerId = referrerId.toLowerCase();

    if (memberReferralName === cleanReferrerId) return true;
    if (memberReferralCode.toLowerCase() === cleanReferrerId) return true;
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

function buildReferralRow(member, options = {}) {
  const amount = moneyAmount(options.amount);
  const level = options.level || "direct";
  const through = options.through || null;
  const approved = isApprovedMember(member);

  return {
    id: normalizeString(member.id),
    name: formatName(member),
    full_name: formatName(member),
    email: normalizeEmail(member.email),
    phone: normalizeString(member.phone),
    status: approved ? "approved" : "pending",
    statusLabel: approved ? "Approved" : "Pending",
    payment_status: normalizeString(member.payment_status),
    membership_status: normalizeString(member.membership_status),
    approval_status: normalizeString(member.approval_status),
    level,
    type: level,
    amount: approved ? amount : 0,
    reward_amount: approved ? amount : 0,
    earned: approved ? amount : 0,
    note:
      level === "team"
        ? `Team referral through ${through?.email || through?.name || "Member B"}`
        : "Direct referral",
    referred_through_email: through?.email || "",
    referred_through_name: through?.name || "",
    referral_email: getReferralEmail(member),
    referral_name: getReferralName(member),
    referral_code: getReferralCode(member),
    created_at: member.created_at || member.createdAt || null,
    joined_at: member.created_at || member.createdAt || null,
  };
}

function buildTowerFloors({ directRows, teamRows, summary }) {
  const floors = [];
  let floorNumber = 1;

  directRows.forEach((row) => {
    floors.push({
      floor: floorNumber,
      label: "Member A referred Member B",
      name: row.name,
      email: row.email,
      status: row.status === "approved" ? "approved" : "pending",
      amount: row.status === "approved" ? DIRECT_REFERRAL_REWARD : 0,
      type: "direct",
      description: `${row.name} joined from your referral link.`,
    });

    floorNumber += 1;
  });

  teamRows.forEach((row) => {
    floors.push({
      floor: floorNumber,
      label: "Member B referred Member C",
      name: row.name,
      email: row.email,
      status: row.status === "approved" ? "approved" : "pending",
      amount: row.status === "approved" ? TEAM_REFERRAL_REWARD : 0,
      type: "team",
      description: `${row.referred_through_email} referred ${row.email}.`,
    });

    floorNumber += 1;
  });

  if (summary.directReferrals >= 10) {
    floors.push({
      floor: floorNumber,
      label: "Company Growth Allowance",
      name: "Allowance Bonus",
      email: "",
      status: "approved",
      amount: 100,
      type: "growth",
      description: "Example company growth allowance after 10 active direct referrals.",
    });
  }

  return floors;
}

async function saveCalculatedTotals(member, summary) {
  const updatePayload = {
    direct_referral_earnings: summary.directEarnings,
    team_referral_earnings: summary.teamEarnings,
    account_credit: summary.teamEarnings,
    growth_pool_credit: summary.growthPoolCredit,
    total_referral_earnings: summary.totalEarned,
    allowance_balance: summary.totalEarned,
    reward_balance: summary.totalEarned,
  };

  const { error } = await supabaseAdmin
    .from("signups")
    .update(updatePayload)
    .eq("id", member.id);

  if (error) {
    console.error("Referral totals save failed:", error);
  }
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
    const currentMember = await findCurrentMember(req);

    if (!currentMember?.id) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Not authenticated. Please log in again.",
      });
    }

    const currentEmail = normalizeEmail(currentMember.email);

    if (!currentEmail || !isValidEmail(currentEmail)) {
      return sendJson(res, 400, {
        success: false,
        ok: false,
        authenticated: true,
        message: "Current member does not have a valid email address.",
      });
    }

    const allMembers = await getAllMembers();

    const directReferrals = uniqueMembersByIdOrEmail(
      allMembers.filter((member) => {
        const memberEmail = normalizeEmail(member.email);

        if (!memberEmail || memberEmail === currentEmail) return false;

        return matchesReferrer(member, currentMember);
      })
    );

    const approvedDirectReferrals = directReferrals.filter(isApprovedMember);

    const teamReferrals = uniqueMembersByIdOrEmail(
      allMembers.filter((possibleTeamMember) => {
        const teamMemberEmail = normalizeEmail(possibleTeamMember.email);

        if (!teamMemberEmail || teamMemberEmail === currentEmail) return false;

        return approvedDirectReferrals.some((directMember) => {
          const directEmail = normalizeEmail(directMember.email);

          if (!directEmail || teamMemberEmail === directEmail) return false;

          return matchesReferrer(possibleTeamMember, directMember);
        });
      })
    );

    const approvedTeamReferrals = teamReferrals.filter(isApprovedMember);

    const directRows = directReferrals.map((member) =>
      buildReferralRow(member, {
        level: "direct",
        amount: DIRECT_REFERRAL_REWARD,
      })
    );

    const teamRows = teamReferrals.map((member) => {
      const throughMember = approvedDirectReferrals.find((directMember) =>
        matchesReferrer(member, directMember)
      );

      return buildReferralRow(member, {
        level: "team",
        amount: TEAM_REFERRAL_REWARD,
        through: throughMember
          ? {
              email: normalizeEmail(throughMember.email),
              name: formatName(throughMember),
            }
          : null,
      });
    });

    const directEarnings = approvedDirectReferrals.length * DIRECT_REFERRAL_REWARD;
    const teamEarnings = approvedTeamReferrals.length * TEAM_REFERRAL_REWARD;
    const growthPoolCredit = approvedTeamReferrals.length * GROWTH_POOL_REWARD;
    const totalEarned = directEarnings + teamEarnings;

    const summary = {
      totalReferrals: directReferrals.length + teamReferrals.length,
      total_referrals: directReferrals.length + teamReferrals.length,

      approvedReferrals: approvedDirectReferrals.length + approvedTeamReferrals.length,
      approved_referrals: approvedDirectReferrals.length + approvedTeamReferrals.length,

      pendingReferrals:
        directReferrals.filter((member) => !isApprovedMember(member)).length +
        teamReferrals.filter((member) => !isApprovedMember(member)).length,
      pending_referrals:
        directReferrals.filter((member) => !isApprovedMember(member)).length +
        teamReferrals.filter((member) => !isApprovedMember(member)).length,

      directReferrals: directReferrals.length,
      direct_referrals: directReferrals.length,
      approvedDirectReferrals: approvedDirectReferrals.length,
      approved_direct_referrals: approvedDirectReferrals.length,

      teamReferrals: teamReferrals.length,
      team_referrals: teamReferrals.length,
      approvedTeamReferrals: approvedTeamReferrals.length,
      approved_team_referrals: approvedTeamReferrals.length,

      directEarnings,
      direct_earnings: directEarnings,
      teamEarnings,
      team_earnings: teamEarnings,
      growthPoolCredit,
      growth_pool_credit: growthPoolCredit,
      totalEarned,
      total_earned: totalEarned,
      allowanceBalance: totalEarned,
      allowance_balance: totalEarned,
      rewardBalance: totalEarned,
      reward_balance: totalEarned,
    };

    const referrals = [...directRows, ...teamRows];

    const tower = {
      directRewardAmount: DIRECT_REFERRAL_REWARD,
      teamRewardAmount: TEAM_REFERRAL_REWARD,
      growthPoolRewardAmount: GROWTH_POOL_REWARD,
      floors: buildTowerFloors({
        directRows,
        teamRows,
        summary,
      }),
    };

    await saveCalculatedTotals(currentMember, summary);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      message: "Referral totals loaded.",
      member: {
        id: currentMember.id,
        name: formatName(currentMember),
        email: currentEmail,
        status: currentMember.status,
        payment_status: currentMember.payment_status,
        membership_status: currentMember.membership_status,
      },
      summary,
      stats: summary,
      referrals,
      direct_referrals: directRows,
      team_referrals: teamRows,
      recentReferrals: referrals.slice(0, 12),
      recent_referrals: referrals.slice(0, 12),
      tower,
    });
  } catch (error) {
    console.error("Card Leo referrals/me error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message: error?.message || "Unable to load referral totals right now.",
    });
  }
}