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
  "succeeded",
]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "cardleo_auth",
  "cardleo_portal_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const TOKEN_COOKIE_NAMES = [
  "cardleo_session_token",
  "session_token",
  "auth_token",
  "login_token",
  "portal_token",
  "token",
];

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  return res.end(JSON.stringify(payload));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .reduce((cookies, cookie) => {
      const index = cookie.indexOf("=");

      if (index === -1) return cookies;

      const name = cookie.slice(0, index).trim();
      const value = cookie.slice(index + 1).trim();

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

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeBase64JsonParse(value) {
  const raw = String(value || "");

  if (!raw) return null;

  const attempts = [raw, raw.replace(/-/g, "+").replace(/_/g, "/")];

  for (const attempt of attempts) {
    try {
      const padded = attempt.padEnd(Math.ceil(attempt.length / 4) * 4, "=");
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);

      if (isObject(parsed)) return parsed;
    } catch {
      // Try next decode format.
    }
  }

  return null;
}

function parseSessionValue(rawValue) {
  const decoded = decodeCookieValue(rawValue);

  if (!decoded) return null;

  const parsedJson = safeJsonParse(decoded);
  if (isObject(parsedJson)) return parsedJson;

  const parsedBase64 = safeBase64JsonParse(decoded);
  if (isObject(parsedBase64)) return parsedBase64;

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);

  for (const name of SESSION_COOKIE_NAMES) {
    const raw = cookies[name];

    if (!raw) continue;

    const parsed = parseSessionValue(raw);

    if (isObject(parsed)) {
      return {
        name,
        raw,
        value: parsed,
      };
    }
  }

  return null;
}

function readTokenCookie(req) {
  const cookies = parseCookieHeader(req);

  for (const name of TOKEN_COOKIE_NAMES) {
    const raw = cookies[name];

    if (!raw) continue;

    const token = normalizeString(decodeCookieValue(raw));

    if (token) {
      return {
        name,
        token,
      };
    }
  }

  return null;
}

function getSessionIdentity(req) {
  const sessionCookie = readSessionCookie(req);
  const tokenCookie = readTokenCookie(req);
  const session = sessionCookie?.value || {};

  const member = isObject(session.member) ? session.member : {};
  const profile = isObject(session.profile) ? session.profile : {};
  const user = isObject(session.user) ? session.user : {};
  const userMetadata = isObject(user.user_metadata) ? user.user_metadata : {};

  const queryEmail = normalizeEmail(req.query?.email);

  const ids = [
    session.signupId,
    session.signup_id,
    session.memberId,
    session.member_id,
    session.id,

    member.id,
    member.signupId,
    member.signup_id,
    member.memberId,
    member.member_id,

    profile.id,
    profile.signupId,
    profile.signup_id,
    profile.memberId,
    profile.member_id,

    userMetadata.signupId,
    userMetadata.signup_id,
    userMetadata.memberId,
    userMetadata.member_id,

    user.id,
    req.query?.member_id,
    req.query?.memberId,
    req.query?.id,
  ]
    .map(normalizeString)
    .filter(Boolean);

  const emails = [
    queryEmail,
    session.email,
    session.userEmail,
    member.email,
    profile.email,
    user.email,
    userMetadata.email,
  ]
    .map(normalizeEmail)
    .filter(Boolean);

  const token =
    normalizeString(tokenCookie?.token) ||
    normalizeString(
      session.token ||
        session.sessionToken ||
        session.session_token ||
        session.authToken ||
        session.auth_token ||
        session.loginToken ||
        session.login_token ||
        session.portalToken ||
        session.portal_token ||
        session.session?.token ||
        session.session?.access_token
    ) ||
    normalizeString(req.headers.authorization).replace(/^Bearer\s+/i, "");

  return {
    ids: Array.from(new Set(ids)),
    emails: Array.from(new Set(emails)),
    token,
    sessionCookieName: sessionCookie?.name || "",
    tokenCookieName: tokenCookie?.name || "",
  };
}

function isMissingOptionalColumn(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    details.includes("does not exist") ||
    details.includes("schema cache") ||
    details.includes("could not find")
  );
}

async function findMemberByToken(token) {
  if (!token) return null;

  let result = await supabaseAdmin
    .from("signups")
    .select("*")
    .or(
      [
        `session_token.eq.${token}`,
        `auth_token.eq.${token}`,
        `login_token.eq.${token}`,
        `portal_token.eq.${token}`,
      ].join(",")
    )
    .maybeSingle();

  if (result.error && isMissingOptionalColumn(result.error)) {
    return null;
  }

  if (result.error) throw result.error;

  return result.data?.id ? result.data : null;
}

async function findMemberById(id) {
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;

  return data?.id ? data : null;
}

async function findMemberByEmail(email) {
  const safeEmail = normalizeEmail(email);

  if (!safeEmail || !isValidEmail(safeEmail)) return null;

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .ilike("email", safeEmail)
    .maybeSingle();

  if (error) throw error;

  return data?.id ? data : null;
}

async function findCurrentMember(req) {
  const identity = getSessionIdentity(req);

  if (identity.token) {
    const byToken = await findMemberByToken(identity.token);
    if (byToken?.id) return byToken;
  }

  for (const id of identity.ids) {
    const byId = await findMemberById(id);
    if (byId?.id) return byId;
  }

  for (const email of identity.emails) {
    const byEmail = await findMemberByEmail(email);
    if (byEmail?.id) return byEmail;
  }

  return null;
}

async function getAllMembers() {
  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw error;

  return Array.isArray(data) ? data : [];
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
        ? through
          ? `${through.name} referred ${formatName(member)}`
          : "Team referral through Member B"
        : `Direct referral: ${formatName(member)}`,
    referred_through_email: through?.email || "",
    referred_through_name: through?.name || "",
    referral_email: getReferralEmail(member),
    referral_name: getReferralName(member),
    referral_code: getReferralCode(member),
    created_at: member.created_at || member.createdAt || null,
    joined_at: member.created_at || member.createdAt || null,
  };
}

function buildTowerFloors({ directRows, teamRows }) {
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
      description: `${row.referred_through_name || row.referred_through_email} referred ${row.name}.`,
    });

    floorNumber += 1;
  });

  while (floors.length < 12) {
    floors.push({
      floor: floorNumber,
      label: "Open Floor",
      name: "Open Floor",
      email: "",
      status: "locked",
      amount: 0,
      type: "locked",
      description: "Open referral tower slot.",
    });

    floorNumber += 1;
  }

  return floors.slice(0, 12);
}

async function saveCalculatedTotals(member, summary) {
  const fullPayload = {
    direct_referral_earnings: summary.directEarnings,
    team_referral_earnings: summary.teamEarnings,
    account_credit: summary.teamEarnings,
    growth_pool_credit: summary.growthPoolCredit,
    total_referral_earnings: summary.totalEarned,
    allowance_balance: summary.totalEarned,
    reward_balance: summary.totalEarned,
    updated_at: new Date().toISOString(),
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(fullPayload)
    .eq("id", member.id);

  if (!result.error) return;

  if (!isMissingOptionalColumn(result.error)) {
    console.error("Referral totals save failed:", result.error);
    return;
  }

  const fallbackPayload = {
    updated_at: new Date().toISOString(),
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", member.id);

  if (result.error) {
    console.error("Referral totals fallback save failed:", result.error);
  }
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
    const debug =
      String(req.query?.debug ?? "").toLowerCase() === "true" ||
      String(req.query?.debug ?? "") === "1";

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

    const approvedDirectCount = approvedDirectReferrals.length;
    const approvedTeamCount = approvedTeamReferrals.length;

    const directEarnings = approvedDirectCount * DIRECT_REFERRAL_REWARD;
    const teamEarnings = approvedTeamCount * TEAM_REFERRAL_REWARD;
    const growthPoolCredit = approvedTeamCount * GROWTH_POOL_REWARD;
    const totalEarned = directEarnings + teamEarnings;

    const totalReferralCount = directReferrals.length + teamReferrals.length;
    const approvedReferralCount = approvedDirectCount + approvedTeamCount;
    const pendingReferralCount =
      directReferrals.filter((member) => !isApprovedMember(member)).length +
      teamReferrals.filter((member) => !isApprovedMember(member)).length;

    const summary = {
      totalReferrals: totalReferralCount,
      total_referrals: totalReferralCount,

      approvedReferrals: approvedReferralCount,
      approved_referrals: approvedReferralCount,

      pendingReferrals: pendingReferralCount,
      pending_referrals: pendingReferralCount,

      directReferrals: directReferrals.length,
      direct_referrals: directReferrals.length,

      approvedDirectReferrals: approvedDirectCount,
      approved_direct_referrals: approvedDirectCount,

      teamReferrals: teamReferrals.length,
      team_referrals: teamReferrals.length,

      approvedTeamReferrals: approvedTeamCount,
      approved_team_referrals: approvedTeamCount,

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

      accountCredit: teamEarnings,
      account_credit: teamEarnings,
    };

    const referrals = [...directRows, ...teamRows];

    const tower = {
      directRewardAmount: DIRECT_REFERRAL_REWARD,
      direct_reward_amount: DIRECT_REFERRAL_REWARD,

      teamRewardAmount: TEAM_REFERRAL_REWARD,
      team_reward_amount: TEAM_REFERRAL_REWARD,

      growthPoolRewardAmount: GROWTH_POOL_REWARD,
      growth_pool_reward_amount: GROWTH_POOL_REWARD,

      floors: buildTowerFloors({
        directRows,
        teamRows,
      }),
    };

    await saveCalculatedTotals(currentMember, summary);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      message: "Referral totals loaded.",
      month_key: getMonthKey(),
      month_label: getMonthLabel(),

      reward_rules: {
        direct_referral_label: "Member A referred Member B",
        direct_referral_amount: DIRECT_REFERRAL_REWARD,
        team_referral_label: "Member B referred Member C",
        team_referral_amount: TEAM_REFERRAL_REWARD,
        growth_pool_amount: GROWTH_POOL_REWARD,
        total_formula: "approved direct referrals × 7 + approved team referrals × 1",
      },

      member: {
        id: currentMember.id,
        name: formatName(currentMember),
        full_name: formatName(currentMember),
        email: currentEmail,
        status: currentMember.status,
        payment_status: currentMember.payment_status,
        membership_status: currentMember.membership_status,
        approval_status: currentMember.approval_status,
      },

      summary,
      stats: summary,

      referrals,
      recentReferrals: referrals.slice(0, 12),
      recent_referrals: referrals.slice(0, 12),

      direct_referrals: directRows,
      directReferrals: directRows,

      team_referrals: teamRows,
      teamReferrals: teamRows,

      tower,

      debug: debug
        ? {
            current_member: {
              email: currentEmail,
              name: formatName(currentMember),
            },
            chain: buildDebugChain(allMembers),
            expected_for_maurece_without_micah: {
              direct: "Marethia direct referral = $7.",
              team: "Monica second-level referral through Marethia = $1.",
              total: "$8.",
              growth_pool: "$2.",
            },
          }
        : undefined,
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