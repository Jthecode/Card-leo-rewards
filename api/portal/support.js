// api/portal/support.js

import { getPortalOverview } from "../../lib/portal.js";
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { portalProfileRateLimit, supportRateLimit } from "../../lib/rate-limit.js";
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

    if (parsed) return parsed;
  }

  return null;
}

function extractIdentity(session) {
  const user = isObject(session?.user) ? session.user : {};
  const member = isObject(session?.member) ? session.member : {};
  const profile = isObject(session?.profile) ? session.profile : {};

  const email = normalizeEmail(
    firstNonEmpty(session?.email, user?.email, profile?.email, member?.email)
  );

  const portalUserId = normalizeText(
    firstNonEmpty(
      session?.portalUserId,
      session?.userId,
      session?.memberId,
      user?.id,
      member?.portalUserId,
      member?.memberId,
      profile?.portalUserId
    )
  );

  const signupId = normalizeText(
    firstNonEmpty(
      session?.signupId,
      member?.signupId,
      profile?.signupId,
      session?.recordId
    )
  );

  const userId = normalizeText(
    firstNonEmpty(
      session?.userId,
      profile?.id,
      user?.id
    )
  );

  return {
    email,
    portalUserId,
    signupId,
    userId,
  };
}

function hasIdentity(identity) {
  return Boolean(
    identity?.email || identity?.portalUserId || identity?.signupId || identity?.userId
  );
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes", "enabled", "active", "approved", "allowed"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "disabled", "inactive", "pending", "blocked"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function getPortalAccess(overview, member) {
  const checks = [
    overview?.portalAccess,
    overview?.accessGranted,
    overview?.isAllowed,
    member?.portalAccess,
    member?.accessGranted,
    member?.isAllowed,
  ];

  for (const value of checks) {
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
  if (["pending", "disabled", "blocked", "denied", "inactive"].includes(status)) return false;

  return true;
}

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return isObject(req.body) ? req.body : {};
}

function getMemberName(member, profile) {
  const firstName = normalizeText(
    firstNonEmpty(profile?.firstName, profile?.first_name, member?.firstName, member?.givenName)
  );
  const lastName = normalizeText(
    firstNonEmpty(profile?.lastName, profile?.last_name, member?.lastName, member?.familyName)
  );

  return normalizeText(
    firstNonEmpty(
      member?.fullName,
      member?.name,
      profile?.full_name,
      [firstName, lastName].filter(Boolean).join(" "),
      "Card Leo Member"
    )
  );
}

function normalizePriority(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (["low", "normal", "high", "urgent"].includes(normalized)) return normalized;
  if (["standard", "priority"].includes(normalized)) {
    return normalized === "standard" ? "normal" : "high";
  }
  return "normal";
}

function normalizeCategory(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (
    [
      "general",
      "account",
      "rewards",
      "billing",
      "technical",
      "verification",
      "referral",
      "other",
      "benefits",
      "profile-update",
      "account-access",
    ].includes(normalized)
  ) {
    if (normalized === "account-access") return "account";
    if (normalized === "benefits") return "general";
    if (normalized === "profile-update") return "account";
    return normalized;
  }

  return "general";
}

function normalizePreferredResponse(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (["email", "phone", "portal", "sms"].includes(normalized)) return normalized;
  return "";
}

function validateSupportPayload(body) {
  const subject = normalizeText(body?.subject);
  const category = normalizeCategory(body?.category);
  const priority = normalizePriority(body?.priority);
  const preferredResponse = normalizePreferredResponse(body?.preferredResponse);
  const message = normalizeText(body?.message);

  if (!subject) {
    return { ok: false, message: "Please enter a support subject." };
  }

  if (subject.length > 120) {
    return { ok: false, message: "Support subject must be 120 characters or fewer." };
  }

  if (!message) {
    return { ok: false, message: "Please enter a support message." };
  }

  if (message.length < 10) {
    return {
      ok: false,
      message: "Please provide a little more detail so support can help effectively.",
    };
  }

  if (message.length > 2500) {
    return { ok: false, message: "Support message must be 2500 characters or fewer." };
  }

  return {
    ok: true,
    data: {
      subject,
      category,
      priority,
      preferredResponse,
      message,
    },
  };
}

function normalizeSupportChannels(support) {
  const items = Array.isArray(support?.channels)
    ? support.channels
    : Array.isArray(support?.contactOptions)
      ? support.contactOptions
      : [];

  if (items.length) return items;

  return [
    {
      label: "Email",
      value: firstNonEmpty(
        support?.email,
        support?.supportEmail,
        support?.contactEmail,
        "support@cardleorewards.com"
      ),
    },
    {
      label: "Priority Route",
      value: firstNonEmpty(support?.primaryRoute, support?.channel, "Member Support"),
    },
    {
      label: "Availability",
      value: firstNonEmpty(
        support?.hours,
        support?.availability,
        support?.supportHours,
        "Member support availability varies by account status"
      ),
    },
  ];
}

function buildSummary(overview, member, support, recentRequests) {
  const summary = isObject(overview?.summary) ? overview.summary : {};

  return {
    accessLevel: firstNonEmpty(
      summary?.accessLevel,
      member?.accessLevel,
      member?.membershipLevel,
      "Premium Access"
    ),
    statusLabel: firstNonEmpty(
      summary?.statusLabel,
      member?.statusLabel,
      member?.status,
      "Active"
    ),
    priorityTier: firstNonEmpty(
      support?.priorityTier,
      support?.priority,
      summary?.priorityTier,
      "Premium"
    ),
    recentRequestCount: Array.isArray(recentRequests) ? recentRequests.length : 0,
  };
}

function normalizeSupportRequestRow(row) {
  if (!isObject(row)) return null;

  const meta = isObject(row.metadata) ? row.metadata : {};

  return {
    id: firstNonEmpty(row.id, meta.ticketId, ""),
    subject: firstNonEmpty(row.subject, meta.subject, "Support Request"),
    category: firstNonEmpty(row.category, meta.category, row.topic, "general"),
    priority: firstNonEmpty(row.priority, meta.priority, "normal"),
    preferredResponse: firstNonEmpty(
      row.preferred_response,
      meta.preferredResponse,
      ""
    ),
    status: firstNonEmpty(row.status, meta.status, "open"),
    message: firstNonEmpty(row.message, meta.message, ""),
    createdAt: firstNonEmpty(row.created_at, row.inserted_at, meta.createdAt, ""),
    updatedAt: firstNonEmpty(row.updated_at, meta.updatedAt, ""),
  };
}

async function fetchRecentSupportRequests(email) {
  if (!email || !supabaseAdmin) return [];

  try {
    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .select("*")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      return [];
    }

    return (Array.isArray(data) ? data : [])
      .map(normalizeSupportRequestRow)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildDefaultFaq() {
  return [
    {
      id: "faq-1",
      question: "How do I get help with rewards or benefits?",
      answer:
        "Use the support form in your member portal and choose the most relevant category so your request is routed correctly.",
    },
    {
      id: "faq-2",
      question: "How is my support priority determined?",
      answer:
        "Priority is based on your current account standing, support configuration, and the urgency selected for the request.",
    },
    {
      id: "faq-3",
      question: "Where will I receive updates?",
      answer:
        "Updates are typically sent through your member support route, email, or the response method selected with your request.",
    },
  ];
}

function buildSupportPayload(overview, member, profile, recentRequests) {
  const support = isObject(overview?.support) ? overview.support : {};

  return {
    email: firstNonEmpty(
      support?.email,
      support?.supportEmail,
      support?.contactEmail,
      "support@cardleorewards.com"
    ),
    hours: firstNonEmpty(
      support?.hours,
      support?.availability,
      support?.supportHours,
      "Member support hours vary by account and request type."
    ),
    priorityTier: firstNonEmpty(
      support?.priorityTier,
      support?.priority,
      "Premium"
    ),
    primaryRoute: firstNonEmpty(
      support?.primaryRoute,
      support?.channel,
      support?.supportRoute,
      "Member Support"
    ),
    lastUpdated: firstNonEmpty(
      support?.lastUpdated,
      support?.updatedAt,
      new Date().toISOString()
    ),
    guidance: Array.isArray(support?.guidance)
      ? support.guidance
      : Array.isArray(support?.notes)
        ? support.notes
        : [
            `Your account is currently operating at the ${firstNonEmpty(
              member?.accessLevel,
              member?.membershipLevel,
              "Premium Access"
            )} level.`,
            `Support requests route through ${firstNonEmpty(
              support?.primaryRoute,
              support?.channel,
              "Member Support"
            )}.`,
            `Current support posture: ${firstNonEmpty(
              member?.statusLabel,
              member?.status,
              "Active"
            )}.`,
          ],
    channels: normalizeSupportChannels(support),
    faq: Array.isArray(support?.faq) ? support.faq : buildDefaultFaq(),
    recentRequests,
  };
}

async function resolvePortalContext(req) {
  const session = getSessionFromRequest(req);

  if (!session) {
    return {
      ok: false,
      status: 401,
      payload: {
        success: false,
        message: "You must be logged in to access member support.",
      },
    };
  }

  const identity = extractIdentity(session);

  if (!hasIdentity(identity)) {
    return {
      ok: false,
      status: 401,
      payload: {
        success: false,
        message: "Your session is missing a valid portal identity.",
      },
    };
  }

  const overview = await getPortalOverview({
    email: identity.email,
    portalUserId: identity.portalUserId,
    signupId: identity.signupId || identity.userId,
  });

  if (!overview || !isObject(overview)) {
    return {
      ok: false,
      status: 404,
      payload: {
        success: false,
        message: "We could not find a member record for this account.",
      },
    };
  }

  const member = isObject(overview?.member)
    ? overview.member
    : isObject(overview?.data?.member)
      ? overview.data.member
      : null;

  if (!member) {
    return {
      ok: false,
      status: 404,
      payload: {
        success: false,
        message: "No member record was found for this account.",
      },
    };
  }

  const portalAccess = getPortalAccess(overview, member);

  if (!portalAccess) {
    return {
      ok: false,
      status: 403,
      payload: {
        success: false,
        message: "Your member account exists, but portal support access is not enabled yet.",
        member: {
          memberId: firstNonEmpty(member?.memberId, member?.portalUserId, member?.signupId, ""),
          email: firstNonEmpty(member?.email, identity?.email, ""),
          status: firstNonEmpty(member?.status, member?.statusLabel, "pending"),
          accessLevel: firstNonEmpty(
            member?.accessLevel,
            member?.membershipLevel,
            "Pending Access"
          ),
        },
      },
    };
  }

  const profile = isObject(overview?.profile)
    ? overview.profile
    : isObject(overview?.data?.profile)
      ? overview.data.profile
      : {};

  return {
    ok: true,
    identity,
    overview,
    member,
    profile,
  };
}

async function handleGet(req, res) {
  const portal = await resolvePortalContext(req);

  if (!portal.ok) {
    if (portal.status === 401) return unauthorized(res, portal.payload.message, portal.payload.member || null);
    if (portal.status === 403) return forbidden(res, portal.payload.message, portal.payload.member || null);
    if (portal.status === 404) return notFound(res, portal.payload.message);
  }

  const recentRequests = await fetchRecentSupportRequests(portal.identity.email);
  const support = buildSupportPayload(
    portal.overview,
    portal.member,
    portal.profile,
    recentRequests
  );
  const summary = buildSummary(portal.overview, portal.member, support, recentRequests);

  return ok(
    res,
    {
      member: portal.member,
      profile: portal.profile,
      summary,
      support,
      fetchedAt: new Date().toISOString(),
    },
    "Support loaded successfully."
  );
}

async function createSupportRequestRecord({ identity, member, profile, supportPayload }) {
  if (!supabaseAdmin) {
    throw new Error("Support database client is not configured.");
  }

  const memberName = getMemberName(member, profile);
  const email = normalizeEmail(firstNonEmpty(profile?.email, member?.email, identity?.email));

  const insertPayload = {
    name: memberName,
    email,
    phone: normalizeText(firstNonEmpty(profile?.phone, member?.phone, "")) || null,
    topic: supportPayload.category,
    message: supportPayload.message,
    source: "portal",
    contact_page: "portal/support",
    status: "new",
  };

  const { data, error } = await supabaseAdmin
    .from("contact_messages")
    .insert([insertPayload])
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message || "Failed to create support request.");
  }

  return normalizeSupportRequestRow({
    ...data,
    subject: supportPayload.subject,
    category: supportPayload.category,
    priority: supportPayload.priority,
    preferred_response: supportPayload.preferredResponse,
    metadata: {
      portal: true,
      category: supportPayload.category,
      priority: supportPayload.priority,
      preferredResponse: supportPayload.preferredResponse,
      portalUserId: firstNonEmpty(
        member?.portalUserId,
        member?.memberId,
        identity?.portalUserId,
        ""
      ),
      memberId: firstNonEmpty(member?.memberId, member?.portalUserId, ""),
      signupId: firstNonEmpty(member?.signupId, profile?.signupId, identity?.signupId, ""),
      accessLevel: firstNonEmpty(member?.accessLevel, member?.membershipLevel, ""),
      statusLabel: firstNonEmpty(member?.statusLabel, member?.status, ""),
      createdAt: new Date().toISOString(),
      ticketType: "member_support",
      subject: supportPayload.subject,
    },
  });
}

async function handlePost(req, res) {
  const portal = await resolvePortalContext(req);

  if (!portal.ok) {
    if (portal.status === 401) return unauthorized(res, portal.payload.message, portal.payload.member || null);
    if (portal.status === 403) return forbidden(res, portal.payload.message, portal.payload.member || null);
    if (portal.status === 404) return notFound(res, portal.payload.message);
  }

  const body = getRequestBody(req);
  const validation = validateSupportPayload(body);

  if (!validation.ok) {
    return badRequest(res, validation.message);
  }

  const createdRequest = await createSupportRequestRecord({
    identity: portal.identity,
    member: portal.member,
    profile: portal.profile,
    supportPayload: validation.data,
  });

  const recentRequests = await fetchRecentSupportRequests(portal.identity.email);
  const support = buildSupportPayload(
    portal.overview,
    portal.member,
    portal.profile,
    recentRequests
  );
  const summary = buildSummary(portal.overview, portal.member, support, recentRequests);

  return ok(
    res,
    {
      request: createdRequest,
      member: portal.member,
      profile: portal.profile,
      summary,
      support,
      fetchedAt: new Date().toISOString(),
    },
    "Your support request has been submitted successfully."
  );
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "portal_support", method: req.method });

  try {
    if (req.method === "GET") {
      const rate = portalProfileRateLimit(req, res);

      if (!rate.allowed) {
        return badRequest(
          res,
          "Too many support view requests. Please try again later.",
          { retryAfter: rate.retryAfter },
          { statusCode: 429, error: "rate_limited" }
        );
      }

      const response = await handleGet(req, res);
      logRequestSuccess(req, { scope: "portal_support_get" });
      return response;
    }

    if (req.method === "POST") {
      const rate = supportRateLimit(req, res);

      if (!rate.allowed) {
        return badRequest(
          res,
          "Too many support submissions. Please try again later.",
          { retryAfter: rate.retryAfter },
          { statusCode: 429, error: "rate_limited" }
        );
      }

      const response = await handlePost(req, res);
      logRequestSuccess(req, { scope: "portal_support_post" });
      return response;
    }

    return methodNotAllowed(res, ["GET", "POST"], "Method not allowed. Use GET or POST.");
  } catch (error) {
    logRequestError(req, error, { scope: "portal_support_unexpected" });

    return serverError(
      res,
      "Something went wrong while processing member support.",
      process.env.NODE_ENV === "development"
        ? { error: String(error?.message || error) }
        : null
    );
  }
}