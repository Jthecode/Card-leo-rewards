// api/portal/referral-tower.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import {
  getSessionCookieFromRequest,
  safeJsonParse,
} from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DIRECT_REFERRAL_AMOUNT = 7;
const MAX_TOWER_FLOORS = 12;

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);
const PENDING_STATUSES = new Set([
  "pending",
  "reviewing",
  "new",
  "submitted",
]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function safeDate(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeBase64JsonParse(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req?.headers?.cookie || "";

  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf("=");
      if (index === -1) return acc;

      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (key) {
        acc[key] = safeDecode(value);
      }

      return acc;
    }, {});
}

function getSessionPayload(req) {
  const directCookie = getSessionCookieFromRequest(req);

  if (directCookie) {
    const parsed =
      safeJsonParse(directCookie, null) || safeBase64JsonParse(directCookie);

    if (isObject(parsed)) return parsed;
  }

  const cookies = parseCookies(req);

  for (const name of SESSION_COOKIE_NAMES) {
    const raw = cookies[name];
    if (!raw) continue;

    const parsed =
      safeJsonParse(raw, null) ||
      safeBase64JsonParse(raw) ||
      safeJsonParse(safeDecode(raw), null) ||
      safeBase64JsonParse(safeDecode(raw));

    if (isObject(parsed)) return parsed;
  }

  return null;
}

function getIdentityFromSession(session) {
  const user = isObject(session?.user) ? session.user : {};
  const member = isObject(session?.member) ? session.member : {};
  const profile = isObject(session?.profile) ? session.profile : {};

  return {
    signupId: normalizeText(
      session?.signupId ||
        session?.signup_id ||
        session?.recordId ||
        member?.id ||
        member?.signupId ||
        profile?.id ||
        user?.id
    ),
    email: normalizeKey(
      session?.email ||
        member?.email ||
        profile?.email ||
        user?.email
    ),
  };
}

function getDisplayName(member) {
  const fullName = normalizeText(member?.full_name);

  if (fullName) return fullName;

  return [member?.first_name, member?.last_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function getReferralName(member) {
  return getDisplayName(member) || member?.email || member?.id || "";
}

function buildReferralLink(req, member) {
  const host =
    req.headers?.["x-forwarded-host"] ||
    req.headers?.host ||
    "www.cardleorewards.com";

  const proto =
    req.headers?.["x-forwarded-proto"] ||
    (String(host).includes("localhost") ? "http" : "https");

  const origin = `${proto}://${host}`;
  const referralName = getReferralName(member);

  try {
    const url = new URL("/signup.html", origin);
    url.searchParams.set("ref", referralName);
    return url.toString();
  } catch {
    return `https://www.cardleorewards.com/signup.html?ref=${encodeURIComponent(
      referralName
    )}`;
  }
}

function buildReferralKeys(member) {
  return Array.from(
    new Set(
      [
        member.id,
        member.portal_user_id,
        member.email,
        member.full_name,
        member.first_name,
        getDisplayName(member),
        [member.first_name, member.last_name].filter(Boolean).join(" "),
      ]
        .map(normalizeKey)
        .filter(Boolean)
    )
  );
}

function isApprovedReferral(signup) {
  return ACTIVE_STATUSES.has(normalizeKey(signup?.status));
}

function isPendingReferral(signup) {
  return PENDING_STATUSES.has(normalizeKey(signup?.status));
}

function isReferralForMember(signup, memberKeys) {
  const referralName = normalizeKey(signup?.referral_name);
  if (!referralName) return false;

  return memberKeys.includes(referralName);
}

function mapReferral(signup) {
  const status = normalizeKey(signup.status || "pending");
  const approved = isApprovedReferral(signup);
  const pending = isPendingReferral(signup);

  return {
    id: signup.id,
    name:
      normalizeText(signup.full_name) ||
      [signup.first_name, signup.last_name].filter(Boolean).join(" ") ||
      "New Member",
    email: signup.email || "",
    status,
    statusLabel: titleCase(status || "Pending"),
    approved,
    pending,
    amount: approved ? DIRECT_REFERRAL_AMOUNT : 0,
    pendingAmount: pending ? DIRECT_REFERRAL_AMOUNT : 0,
    joinedAt: safeDate(signup.created_at),
  };
}

function buildTowerFloors(referrals) {
  const sorted = [...referrals].sort((a, b) => {
    const aTime = new Date(a.joinedAt || 0).getTime();
    const bTime = new Date(b.joinedAt || 0).getTime();
    return aTime - bTime;
  });

  const visible = sorted.slice(0, MAX_TOWER_FLOORS);

  return Array.from({ length: MAX_TOWER_FLOORS }).map((_, index) => {
    const referral = visible[index];

    if (!referral) {
      return {
        floor: index + 1,
        filled: false,
        state: "empty",
        label: "Open floor",
        amount: 0,
      };
    }

    return {
      floor: index + 1,
      filled: true,
      state: referral.approved ? "earned" : referral.pending ? "pending" : "closed",
      label: referral.name,
      amount: referral.approved ? referral.amount : referral.pendingAmount,
      referral,
    };
  });
}

function buildLeaderboard(allSignups) {
  const groups = new Map();

  for (const signup of allSignups) {
    const referralName = normalizeText(signup.referral_name);
    const key = normalizeKey(referralName);

    if (!key) continue;

    const current =
      groups.get(key) || {
        referralName,
        totalReferrals: 0,
        approvedReferrals: 0,
        pendingReferrals: 0,
        earnedAmount: 0,
        pendingAmount: 0,
      };

    current.totalReferrals += 1;

    if (isApprovedReferral(signup)) {
      current.approvedReferrals += 1;
      current.earnedAmount += DIRECT_REFERRAL_AMOUNT;
    } else if (isPendingReferral(signup)) {
      current.pendingReferrals += 1;
      current.pendingAmount += DIRECT_REFERRAL_AMOUNT;
    }

    groups.set(key, current);
  }

  return Array.from(groups.values())
    .map((item) => ({
      ...item,
      earnedAmount: money(item.earnedAmount),
      pendingAmount: money(item.pendingAmount),
    }))
    .sort((a, b) => {
      if (b.earnedAmount !== a.earnedAmount) {
        return b.earnedAmount - a.earnedAmount;
      }

      return b.approvedReferrals - a.approvedReferrals;
    })
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
    }));
}

async function getMember(identity) {
  let query = supabaseAdmin
    .from("signups")
    .select(
      [
        "id",
        "first_name",
        "last_name",
        "full_name",
        "email",
        "phone",
        "city",
        "state",
        "status",
        "portal_user_id",
        "portal_login_url",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .limit(1);

  if (identity.signupId) {
    query = query.eq("id", identity.signupId);
  } else if (identity.email) {
    query = query.eq("email", identity.email);
  } else {
    return { data: null, error: null };
  }

  return query.maybeSingle();
}

async function getReferralSignups() {
  return supabaseAdmin
    .from("signups")
    .select(
      [
        "id",
        "first_name",
        "last_name",
        "full_name",
        "email",
        "status",
        "referral_name",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .not("referral_name", "is", null)
    .neq("referral_name", "")
    .order("created_at", { ascending: false })
    .limit(1000);
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_referral_tower" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const session = getSessionPayload(req);

    if (!session) {
      return unauthorized(res, "You must be logged in to view your referral tower.");
    }

    const identity = getIdentityFromSession(session);

    if (!identity.signupId && !identity.email) {
      return unauthorized(res, "Your session is missing member identity details.");
    }

    const { data: member, error: memberError } = await getMember(identity);

    if (memberError) {
      return serverError(res, "Unable to load your member account.", {
        error: memberError.message,
      });
    }

    if (!member?.id) {
      return unauthorized(res, "Member account not found. Please log in again.");
    }

    const { data: allReferralSignups, error: referralError } =
      await getReferralSignups();

    if (referralError) {
      return serverError(res, "Unable to load referral activity.", {
        error: referralError.message,
      });
    }

    const memberKeys = buildReferralKeys(member);

    const referrals = (allReferralSignups || [])
      .filter((signup) => isReferralForMember(signup, memberKeys))
      .filter((signup) => normalizeKey(signup.email) !== normalizeKey(member.email))
      .map(mapReferral);

    const approvedReferrals = referrals.filter((item) => item.approved).length;
    const pendingReferrals = referrals.filter((item) => item.pending).length;
    const totalReferrals = referrals.length;

    const earnedAmount = money(
      referrals.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    );

    const pendingAmount = money(
      referrals.reduce((sum, item) => sum + Number(item.pendingAmount || 0), 0)
    );

    const leaderboard = buildLeaderboard(allReferralSignups || []);
    const memberRank =
      leaderboard.find((row) => memberKeys.includes(normalizeKey(row.referralName)))
        ?.rank || null;

    const nextMilestone =
      approvedReferrals < 5
        ? 5
        : approvedReferrals < 10
          ? 10
          : approvedReferrals < 25
            ? 25
            : approvedReferrals < 50
              ? 50
              : 100;

    const payload = {
      member: {
        id: member.id,
        name: getDisplayName(member) || "Card Leo Member",
        email: member.email,
        status: member.status || "member",
        referralName: getReferralName(member),
        referralLink: buildReferralLink(req, member),
      },
      summary: {
        amountPerApprovedReferral: DIRECT_REFERRAL_AMOUNT,
        totalReferrals,
        approvedReferrals,
        pendingReferrals,
        earnedAmount,
        pendingAmount,
        towerLevel: Math.min(approvedReferrals, MAX_TOWER_FLOORS),
        maxTowerFloors: MAX_TOWER_FLOORS,
        nextMilestone,
        referralsUntilNextMilestone: Math.max(0, nextMilestone - approvedReferrals),
        leaderboardRank: memberRank,
      },
      tower: {
        lionsAsset: "/assets/cardleo-lions-white-gold.png",
        floors: buildTowerFloors(referrals),
      },
      referrals,
      leaderboard,
      fetchedAt: new Date().toISOString(),
    };

    logRequestSuccess(req, {
      scope: "portal_referral_tower",
      memberId: member.id,
      email: member.email,
      totalReferrals,
      earnedAmount,
    });

    return ok(res, payload, "Referral tower loaded successfully.");
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_referral_tower_unexpected",
    });

    return serverError(
      res,
      "Failed to load referral tower.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}