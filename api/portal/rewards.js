// api/portal/rewards.js

import { getPortalOverview } from "../../lib/portal.js";
import { getRewardDashboard } from "../../lib/rewards.js";
import {
  ok,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { getSessionCookieFromRequest, safeJsonParse } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function parseCookieHeader(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) return acc;

      const key = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();

      if (!key) return acc;

      acc[key] = value;
      return acc;
    }, {});
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryParseBase64Json(value) {
  try {
    const decoded = Buffer.from(String(value), "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function getCookieBag(req) {
  const parsedHeaderCookies = parseCookieHeader(req?.headers?.cookie || "");
  const runtimeCookies = isObject(req?.cookies) ? req.cookies : {};

  return {
    ...parsedHeaderCookies,
    ...runtimeCookies,
  };
}

function readSessionPayload(rawValue) {
  if (!rawValue) return null;

  if (isObject(rawValue)) return rawValue;

  const decoded = safeDecodeURIComponent(String(rawValue).trim());
  if (!decoded) return null;

  const parsedJson = tryParseJson(decoded);
  if (parsedJson) return parsedJson;

  const parsedBase64Json = tryParseBase64Json(decoded);
  if (parsedBase64Json) return parsedBase64Json;

  if (decoded.includes("@")) {
    return { email: decoded };
  }

  return null;
}

function getSessionFromRequest(req) {
  const directSessionCookie = getSessionCookieFromRequest(req);

  if (directSessionCookie) {
    const parsedDirect =
      safeJsonParse(directSessionCookie, null) ||
      tryParseBase64Json(directSessionCookie);

    if (parsedDirect) {
      return parsedDirect;
    }
  }

  const cookies = getCookieBag(req);

  for (const cookieName of SESSION_COOKIE_NAMES) {
    const rawValue = cookies[cookieName];
    const parsed = readSessionPayload(rawValue);

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function extractIdentity(session) {
  const user = isObject(session?.user) ? session.user : {};
  const member = isObject(session?.member) ? session.member : {};
  const profile = isObject(session?.profile) ? session.profile : {};

  const email = normalizeEmail(
    firstNonEmpty(
      session?.email,
      user?.email,
      profile?.email,
      member?.email
    )
  );

  const portalUserId = String(
    firstNonEmpty(
      session?.portalUserId,
      session?.userId,
      session?.memberId,
      user?.id,
      member?.portalUserId,
      member?.memberId,
      profile?.portalUserId
    ) || ""
  ).trim();

  const signupId = String(
    firstNonEmpty(
      session?.signupId,
      profile?.signupId,
      member?.signupId,
      session?.recordId
    ) || ""
  ).trim();

  return {
    email,
    portalUserId,
    signupId,
  };
}

function hasIdentity(identity) {
  return Boolean(identity?.email || identity?.portalUserId || identity?.signupId);
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "enabled", "active", "approved"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "disabled", "inactive", "pending"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") return value > 0;
  return null;
}

function getPortalAccess(overview, member) {
  const directChecks = [
    overview?.portalAccess,
    overview?.accessGranted,
    overview?.isAllowed,
    member?.portalAccess,
    member?.accessGranted,
    member?.isAllowed,
  ];

  for (const value of directChecks) {
    const result = coerceBoolean(value);
    if (result !== null) return result;
  }

  const status = String(
    firstNonEmpty(
      member?.status,
      member?.memberStatus,
      overview?.status,
      overview?.memberStatus,
      ""
    )
  )
    .trim()
    .toLowerCase();

  if (["approved", "active", "enabled", "live"].includes(status)) return true;
  if (["pending", "disabled", "blocked", "denied", "inactive"].includes(status)) {
    return false;
  }

  return true;
}

function normalizeRewardStatus(value) {
  const status = String(value || "").trim().toLowerCase();

  if (!status) return "posted";
  if (["pending", "posted", "voided", "paid", "released"].includes(status)) {
    return status;
  }

  return status;
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function normalizeTransactions(transactions) {
  if (!Array.isArray(transactions)) return [];

  return transactions.map((tx, index) => {
    const item = isObject(tx) ? tx : {};

    return {
      id: firstNonEmpty(item.id, `reward-tx-${index + 1}`),
      title: firstNonEmpty(item.title, item.transactionType, `Reward Activity ${index + 1}`),
      description: firstNonEmpty(
        item.description,
        "Card Leo Rewards activity."
      ),
      status: normalizeRewardStatus(
        firstNonEmpty(item.transactionStatus, item.status, "posted")
      ),
      amount: money(item.amount),
      type: firstNonEmpty(item.transactionType, item.type, "manual_adjustment"),
      referenceType: firstNonEmpty(item.referenceType, item.reference_type, ""),
      referenceId: firstNonEmpty(item.referenceId, item.reference_id, ""),
      postedAt: firstNonEmpty(item.postedAt, item.createdAt, ""),
      metadata: isObject(item.metadata) ? item.metadata : {},
      sourceProfileId: firstNonEmpty(item.sourceProfileId, ""),
      relatedProfileId: firstNonEmpty(item.relatedProfileId, ""),
    };
  });
}

function normalizePayouts(payouts) {
  if (!Array.isArray(payouts)) return [];

  return payouts.map((payout, index) => {
    const item = isObject(payout) ? payout : {};

    return {
      id: firstNonEmpty(item.id, `reward-payout-${index + 1}`),
      payoutType: firstNonEmpty(item.payoutType, item.type, "manual"),
      payoutStatus: firstNonEmpty(item.payoutStatus, item.status, "pending"),
      amount: money(item.amount),
      periodStart: firstNonEmpty(item.periodStart, ""),
      periodEnd: firstNonEmpty(item.periodEnd, ""),
      paidAt: firstNonEmpty(item.paidAt, ""),
      notes: firstNonEmpty(item.notes, ""),
      externalPayoutId: firstNonEmpty(item.externalPayoutId, ""),
      metadata: isObject(item.metadata) ? item.metadata : {},
    };
  });
}

function normalizePayments(payments) {
  if (!Array.isArray(payments)) return [];

  return payments.map((payment, index) => {
    const item = isObject(payment) ? payment : {};

    return {
      id: firstNonEmpty(item.id, `membership-payment-${index + 1}`),
      paymentMonth: Number(item.paymentMonth || 0),
      amountCharged: money(item.amountCharged),
      cardleoAmount: money(item.cardleoAmount),
      directReferralAmount: money(item.directReferralAmount),
      overrideAmount: money(item.overrideAmount),
      companyBuildingAmount: money(item.companyBuildingAmount),
      paymentStatus: firstNonEmpty(item.paymentStatus, "paid"),
      billingPeriodStart: firstNonEmpty(item.billingPeriodStart, ""),
      billingPeriodEnd: firstNonEmpty(item.billingPeriodEnd, ""),
      paidAt: firstNonEmpty(item.paidAt, ""),
      externalPaymentId: firstNonEmpty(item.externalPaymentId, ""),
    };
  });
}

function normalizeCycles(cycles) {
  if (!Array.isArray(cycles)) return [];

  return cycles.map((cycle, index) => {
    const item = isObject(cycle) ? cycle : {};

    return {
      id: firstNonEmpty(item.id, `membership-cycle-${index + 1}`),
      cycleNumber: Number(item.cycleNumber || 0),
      cycleStartDate: firstNonEmpty(item.cycleStartDate, ""),
      cycleEndDate: firstNonEmpty(item.cycleEndDate, ""),
      paidMonthsCount: Number(item.paidMonthsCount || 0),
      requiredPaidMonths: Number(item.requiredPaidMonths || 4),
      companyBuildingAccrued: money(item.companyBuildingAccrued),
      companyBuildingReleased: money(item.companyBuildingReleased),
      cycleStatus: firstNonEmpty(item.cycleStatus, "open"),
      completedAt: firstNonEmpty(item.completedAt, ""),
      releasedAt: firstNonEmpty(item.releasedAt, ""),
      forfeitedAt: firstNonEmpty(item.forfeitedAt, ""),
    };
  });
}

function buildSummary(rewardDashboard, member) {
  const summary = isObject(rewardDashboard?.summary) ? rewardDashboard.summary : {};
  const account = isObject(rewardDashboard?.account) ? rewardDashboard.account : {};

  return {
    membershipMonthlyAmount: money(summary.membershipMonthlyAmount || 20),
    cardleoAmount: money(summary.cardleoAmount || 10),
    directReferralAmount: money(summary.directReferralAmount || 7),
    overrideReferralAmount: money(summary.overrideReferralAmount || 1),
    companyBuildingAmount: money(summary.companyBuildingAmount || 2),
    companyBuildingCycleMonths: Number(summary.companyBuildingCycleMonths || 4),
    totalCardleoAllocated: money(
      summary.totalCardleoAllocated ?? account.totalCardleoAllocated
    ),
    totalDirectReferralEarned: money(
      summary.totalDirectReferralEarned ?? account.totalDirectReferralEarned
    ),
    totalOverrideEarned: money(
      summary.totalOverrideEarned ?? account.totalOverrideEarned
    ),
    companyBuildingPending: money(
      summary.companyBuildingPending ?? account.companyBuildingPending
    ),
    companyBuildingReleased: money(
      summary.companyBuildingReleased ?? account.companyBuildingReleased
    ),
    companyBuildingForfeited: money(
      summary.companyBuildingForfeited ?? account.companyBuildingForfeited
    ),
    totalRewardsEarned: money(
      summary.totalRewardsEarned ?? account.totalRewardsEarned
    ),
    totalRewardsPaid: money(
      summary.totalRewardsPaid ?? account.totalRewardsPaid
    ),
    accessLevel: firstNonEmpty(
      member?.accessLevel,
      member?.membershipLevel,
      "Premium Access"
    ),
    statusLabel: firstNonEmpty(
      member?.statusLabel,
      member?.status,
      "Active"
    ),
  };
}

function normalizeNotices(overview) {
  const notices =
    (Array.isArray(overview?.notices) && overview.notices) ||
    (Array.isArray(overview?.announcements) && overview.announcements) ||
    [];

  return notices.map((notice, index) => {
    const item = isObject(notice) ? notice : {};

    if (!isObject(notice)) {
      return {
        id: `notice-${index + 1}`,
        title: `Notice ${index + 1}`,
        body: String(notice || ""),
      };
    }

    return {
      id: firstNonEmpty(item.id, `notice-${index + 1}`),
      title: firstNonEmpty(item.title, item.name, `Notice ${index + 1}`),
      body: firstNonEmpty(
        item.body,
        item.message,
        item.description,
        "Important member update available."
      ),
    };
  });
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_rewards" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const session = getSessionFromRequest(req);

    if (!session) {
      return unauthorized(res, "You must be logged in to view rewards.");
    }

    const identity = extractIdentity(session);

    if (!hasIdentity(identity)) {
      return unauthorized(
        res,
        "Your session is missing a valid portal identity."
      );
    }

    const overview = await getPortalOverview({
      email: identity.email,
      portalUserId: identity.portalUserId,
      signupId: identity.signupId,
    });

    if (!overview || !isObject(overview)) {
      return notFound(
        res,
        "We could not find a member record for this account."
      );
    }

    const member = isObject(overview.member)
      ? overview.member
      : isObject(overview.data?.member)
        ? overview.data.member
        : null;

    if (!member) {
      return notFound(
        res,
        "No member record was found for this account."
      );
    }

    const portalAccess = getPortalAccess(overview, member);

    if (!portalAccess) {
      return forbidden(
        res,
        "Your member account exists, but portal rewards access is not enabled yet.",
        {
          member: {
            memberId: firstNonEmpty(
              member.memberId,
              member.portalUserId,
              member.signupId,
              ""
            ),
            email: firstNonEmpty(member.email, identity.email, ""),
            status: firstNonEmpty(member.status, member.statusLabel, "pending"),
            accessLevel: firstNonEmpty(
              member.accessLevel,
              member.membershipLevel,
              "Pending Access"
            ),
          },
        }
      );
    }

    const profile = isObject(overview.profile)
      ? overview.profile
      : isObject(overview.data?.profile)
        ? overview.data.profile
        : {};

    const rewardProfileId = firstNonEmpty(
      profile?.id,
      member?.profileId,
      member?.portalUserId,
      identity.portalUserId
    );

    let rewardDashboard = {
      account: null,
      recentTransactions: [],
      recentPayouts: [],
      recentPayments: [],
      cycles: [],
      summary: {},
    };

    if (rewardProfileId) {
      rewardDashboard = await getRewardDashboard(rewardProfileId, {
        recentLimit: 10,
      });
    }

    const transactions = normalizeTransactions(
      rewardDashboard?.recentTransactions || []
    );
    const payouts = normalizePayouts(rewardDashboard?.recentPayouts || []);
    const payments = normalizePayments(rewardDashboard?.recentPayments || []);
    const cycles = normalizeCycles(rewardDashboard?.cycles || []);
    const notices = normalizeNotices(overview);
    const summary = buildSummary(rewardDashboard, member);

    logRequestSuccess(req, {
      scope: "portal_rewards",
      email: identity.email,
      profileId: rewardProfileId || "",
      transactionCount: transactions.length,
      payoutCount: payouts.length,
    });

    return ok(
      res,
      {
        member,
        profile,
        rewardAccount: rewardDashboard?.account || null,
        rewards: transactions,
        payouts,
        membershipPayments: payments,
        cycles,
        summary,
        notices,
        support: isObject(overview.support) ? overview.support : null,
        fetchedAt: new Date().toISOString(),
      },
      "Rewards loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "portal_rewards_unexpected" });

    return serverError(
      res,
      "Something went wrong while loading member rewards.",
      process.env.NODE_ENV === "development"
        ? { error: String(error?.message || error) }
        : null
    );
  }
}