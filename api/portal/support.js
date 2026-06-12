// api/portal/support.js
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
import {
  portalProfileRateLimit,
  supportRateLimit,
} from "../../lib/rate-limit.js";
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

const DEFAULT_PORTAL_PATH = "/portal/index.html";
const DEFAULT_TIMEZONE = "America/New_York";

const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

const SESSION_COOKIE_NAMES = [
  "cardleo_session",
  "card_leo_session",
  "member_session",
  "portal_session",
  "session",
];

const SUPPORT_CATEGORIES = [
  "general",
  "account",
  "rewards",
  "billing",
  "technical",
  "verification",
  "referral",
  "other",
];

const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"];
const RESPONSE_METHODS = ["email", "phone", "portal", "sms"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function parseCookies(req) {
  if (req?.cookies && typeof req.cookies === "object") {
    return req.cookies;
  }

  const header = req?.headers?.cookie || "";

  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!key) return cookies;

      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }

      return cookies;
    }, {});
}

function readSessionCookie(req) {
  const cookies = parseCookies(req);
  const configuredName = getSessionCookieName?.();

  const names = Array.from(
    new Set(
      [configuredName, ...SESSION_COOKIE_NAMES]
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  for (const name of names) {
    const raw = cookies[name];

    if (!raw) continue;

    const parsed = safeJsonParse(raw, null);

    if (isObject(parsed)) {
      return {
        cookieName: name,
        raw,
        data: parsed,
      };
    }
  }

  return null;
}

function getRequestBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "string") {
    const parsed = safeJsonParse(req.body, null);
    return isObject(parsed) ? parsed : {};
  }

  return isObject(req.body) ? req.body : {};
}

function getSessionExpiresAt(sessionMeta) {
  const session = sessionMeta?.data || {};

  const candidates = [
    session.expires_at,
    session.expiresAt,
    session.exp,
    session.session?.expires_at,
    session.session?.expiresAt,
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

function isSessionExpired(sessionMeta) {
  const expiresAt = getSessionExpiresAt(sessionMeta);

  if (!expiresAt) return true;

  return expiresAt <= getUnixNow();
}

function getSessionMemberId(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeText(
    session.member?.id ||
      session.profile?.id ||
      session.user?.id ||
      session.signupId ||
      session.signup_id ||
      session.memberId ||
      session.member_id ||
      session.id
  );
}

function getSessionEmail(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeEmail(
    session.member?.email ||
      session.profile?.email ||
      session.user?.email ||
      session.email ||
      session.userEmail
  );
}

function getSessionRole(sessionMeta) {
  const session = sessionMeta?.data || {};

  return normalizeText(
    session.role ||
      session.profile?.role ||
      session.user?.role ||
      session.user?.user_metadata?.role ||
      session.member?.role ||
      "member"
  ).toLowerCase();
}

function isAdminRole(role) {
  return ["admin", "support", "owner", "staff"].includes(
    normalizeText(role).toLowerCase()
  );
}

function getClientIp(req) {
  const forwarded =
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["cf-connecting-ip"] ||
    "";

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "";
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

  const status = normalizeStatus(member.status);
  const tier = normalizeTier(member.tier || "core");

  return {
    id: member.id || null,
    signupId: member.id || null,
    portalUserId: member.portal_user_id || null,

    email: member.email || null,
    firstName: member.first_name || "",
    lastName: member.last_name || "",
    fullName: getDisplayName(member),
    name: getDisplayName(member),

    phone: member.phone || "",
    city: member.city || "",
    state: member.state || "",
    interest: member.interest || "",
    goals: member.goals || "",
    referralName: member.referral_name || "",

    status: member.status || "",
    memberStatus: normalizeMemberStatus(member.status),

    tier,
    tierLabel: titleCase(tier),
    referralCode: member.referral_code || "",

    portalLoginUrl: member.portal_login_url || DEFAULT_PORTAL_PATH,
    portalAccess: ACTIVE_STATUSES.has(status),
    accessLevel: "member",

    emailVerified: Boolean(member.email_verified),
    emailVerifiedAt: member.email_verified_at || null,

    joinedAt: member.created_at || null,
    createdAt: member.created_at || null,
    updatedAt: member.updated_at || null,

    role: "member",
  };
}

function buildProfile(member) {
  const safeMember = sanitizeMember(member);

  if (!safeMember) return null;

  return {
    id: safeMember.id,
    email: safeMember.email,
    first_name: safeMember.firstName,
    last_name: safeMember.lastName,
    full_name: safeMember.fullName,
    phone: safeMember.phone,
    city: safeMember.city,
    state: safeMember.state,
    interest: safeMember.interest,
    goals: safeMember.goals,
    referral_name: safeMember.referralName,
    tier: safeMember.tier,
    referral_code: safeMember.referralCode,
    role: "member",
    status: safeMember.status,
    email_verified: safeMember.emailVerified,
    email_verified_at: safeMember.emailVerifiedAt,
    created_at: safeMember.createdAt,
    updated_at: safeMember.updatedAt,
  };
}

async function getSignupRecord({ signupId, email }) {
  const extendedFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "interest",
    "goals",
    "referral_name",
    "agreed",
    "tier",
    "referral_code",
    "email_verified",
    "email_verified_at",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
    "portal_settings",
  ].join(", ");

  const baseFields = [
    "id",
    "email",
    "status",
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "city",
    "state",
    "interest",
    "goals",
    "referral_name",
    "created_at",
    "updated_at",
    "portal_login_url",
    "portal_user_id",
  ].join(", ");

  let query = supabaseAdmin.from("signups").select(extendedFields).limit(1);

  if (signupId) {
    query = query.eq("id", signupId);
  } else {
    query = query.eq("email", email);
  }

  let result = await query.maybeSingle();

  if (result.error && isMissingOptionalTableOrColumn(result.error)) {
    let fallbackQuery = supabaseAdmin.from("signups").select(baseFields).limit(1);

    if (signupId) {
      fallbackQuery = fallbackQuery.eq("id", signupId);
    } else {
      fallbackQuery = fallbackQuery.eq("email", email);
    }

    const fallback = await fallbackQuery.maybeSingle();

    return {
      data: fallback.data
        ? {
            ...fallback.data,
            portal_settings: {},
          }
        : null,
      error: fallback.error,
    };
  }

  return result;
}

async function resolvePortalContext(req, res) {
  const sessionMeta = readSessionCookie(req);

  if (!sessionMeta?.data) {
    return {
      ok: false,
      response: unauthorized(res, "You must be logged in to access member support."),
    };
  }

  if (isSessionExpired(sessionMeta)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Session expired. Please log in again."),
    };
  }

  if (sessionMeta.data.authenticated !== true) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(res, "Invalid session. Please log in again."),
    };
  }

  const signupId = getSessionMemberId(sessionMeta);
  const email = getSessionEmail(sessionMeta);
  const role = getSessionRole(sessionMeta);

  if (!signupId && !email) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: unauthorized(
        res,
        "Your session is missing member identity details. Please log in again."
      ),
    };
  }

  const { data: signupRecord, error } = await getSignupRecord({
    signupId,
    email,
  });

  if (error) {
    throw error;
  }

  if (!signupRecord?.id) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: notFound(res, "We could not locate your Card Leo Rewards member record."),
    };
  }

  const status = normalizeStatus(signupRecord.status || "pending");

  if (!ACTIVE_STATUSES.has(status) && !isAdminRole(role)) {
    clearAuthCookies(res);

    return {
      ok: false,
      response: forbidden(
        res,
        status === "pending" || status === "reviewing"
          ? "Your account is pending approval."
          : "Your account is not active.",
        {
          member: sanitizeMember(signupRecord),
        }
      ),
    };
  }

  return {
    ok: true,
    sessionMeta,
    signupRecord,
    role,
    response: null,
  };
}

function normalizePriority(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (SUPPORT_PRIORITIES.includes(normalized)) return normalized;
  if (normalized === "standard") return "normal";
  if (normalized === "priority") return "high";

  return "normal";
}

function normalizeCategory(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (normalized === "account-access") return "account";
  if (normalized === "benefits") return "general";
  if (normalized === "profile-update") return "account";

  if (SUPPORT_CATEGORIES.includes(normalized)) {
    return normalized;
  }

  return "general";
}

function normalizePreferredResponse(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (RESPONSE_METHODS.includes(normalized)) return normalized;

  return "email";
}

function validateSupportPayload(body) {
  const subject = normalizeText(body?.subject);
  const category = normalizeCategory(body?.category);
  const priority = normalizePriority(body?.priority);
  const preferredResponse = normalizePreferredResponse(
    body?.preferredResponse || body?.preferred_response
  );
  const message = normalizeText(body?.message);

  const errors = {};

  if (!subject) {
    errors.subject = "Please enter a support subject.";
  }

  if (subject && subject.length > 120) {
    errors.subject = "Support subject must be 120 characters or fewer.";
  }

  if (!message) {
    errors.message = "Please enter a support message.";
  }

  if (message && message.length < 10) {
    errors.message =
      "Please provide a little more detail so support can help effectively.";
  }

  if (message && message.length > 2500) {
    errors.message = "Support message must be 2500 characters or fewer.";
  }

  return {
    ok: Object.keys(errors).length === 0,
    message: Object.values(errors)[0] || "",
    errors,
    data: {
      subject,
      category,
      priority,
      preferredResponse,
      message,
    },
  };
}

function normalizeSupportRequestRow(row) {
  if (!isObject(row)) return null;

  const metadata = isObject(row.metadata) ? row.metadata : {};

  return {
    id: firstNonEmpty(row.id, metadata.ticketId, metadata.requestId, ""),
    subject: firstNonEmpty(
      row.subject,
      metadata.subject,
      row.topic,
      metadata.category,
      "Support Request"
    ),
    category: normalizeCategory(firstNonEmpty(row.category, row.topic, metadata.category)),
    priority: normalizePriority(firstNonEmpty(row.priority, metadata.priority)),
    preferredResponse: normalizePreferredResponse(
      firstNonEmpty(row.preferred_response, metadata.preferredResponse, "email")
    ),
    status: firstNonEmpty(row.status, metadata.status, "open"),
    message: firstNonEmpty(row.message, metadata.message, ""),
    source: firstNonEmpty(row.source, metadata.source, "portal"),
    createdAt: safeDate(firstNonEmpty(row.created_at, row.inserted_at, metadata.createdAt)),
    updatedAt: safeDate(firstNonEmpty(row.updated_at, metadata.updatedAt)),
    metadata,
  };
}

async function fetchRecentSupportRequests(email) {
  const safeEmail = normalizeEmail(email);

  if (!safeEmail) return [];

  try {
    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .select("*")
      .eq("email", safeEmail)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      if (isMissingOptionalTableOrColumn(error)) return [];
      throw error;
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
        "Use the support form in your member portal and choose the most relevant category so your request can be routed correctly.",
    },
    {
      id: "faq-2",
      question: "Where will I receive support updates?",
      answer:
        "Updates are usually sent by email unless you choose another preferred response method.",
    },
    {
      id: "faq-3",
      question: "What should I include in my support message?",
      answer:
        "Include the issue, what page you were on, what you expected to happen, and any error message you saw.",
    },
  ];
}

function buildSupportChannels(settings = {}) {
  const support = isObject(settings.support) ? settings.support : {};
  const configuredChannels = Array.isArray(support.channels)
    ? support.channels
    : [];

  if (configuredChannels.length) {
    return configuredChannels;
  }

  return [
    {
      label: "Email",
      value: support.email || "support@cardleorewards.com",
    },
    {
      label: "Priority Route",
      value: support.primaryRoute || "Member Support",
    },
    {
      label: "Availability",
      value: support.hours || "Mon–Fri, 9:00 AM–6:00 PM",
    },
  ];
}

function buildSupportPayload(member, recentRequests = []) {
  const settings = isObject(member?.portal_settings)
    ? member.portal_settings
    : {};
  const support = isObject(settings.support) ? settings.support : {};
  const safeMember = sanitizeMember(member);

  return {
    email: support.email || "support@cardleorewards.com",
    phone: support.phone || "",
    hours: support.hours || "Mon–Fri, 9:00 AM–6:00 PM",
    priorityTier: support.priorityTier || titleCase(safeMember.tier || "core"),
    primaryRoute: support.primaryRoute || "Member Support",
    lastUpdated: support.updatedAt || support.lastUpdated || new Date().toISOString(),
    guidance: Array.isArray(support.guidance)
      ? support.guidance
      : [
          `Your account is currently ${safeMember.memberStatus}.`,
          `Support requests route through ${support.primaryRoute || "Member Support"}.`,
          "For account or rewards issues, include as much detail as possible.",
        ],
    channels: buildSupportChannels(settings),
    faq: Array.isArray(support.faq) ? support.faq : buildDefaultFaq(),
    recentRequests,
    endpoints: {
      support: "/api/portal/support",
      contact: "/api/contact",
      profile: "/api/portal/profile",
      settings: "/api/portal/settings",
    },
  };
}

function buildSummary(member, recentRequests = []) {
  const safeMember = sanitizeMember(member);

  return {
    memberId: safeMember.id,
    memberName: safeMember.fullName,
    email: safeMember.email,
    memberStatus: safeMember.memberStatus,
    statusLabel: titleCase(safeMember.memberStatus),
    tier: safeMember.tier,
    tierLabel: safeMember.tierLabel,
    accessLevel: safeMember.accessLevel || "member",
    priorityTier: safeMember.tierLabel || "Core",
    recentRequestCount: recentRequests.length,
    timezone: DEFAULT_TIMEZONE,
  };
}

function buildFullMessage({ supportPayload, member }) {
  const safeMember = sanitizeMember(member);

  return [
    `Subject: ${supportPayload.subject}`,
    `Category: ${supportPayload.category}`,
    `Priority: ${supportPayload.priority}`,
    `Preferred Response: ${supportPayload.preferredResponse}`,
    `Member: ${safeMember.fullName}`,
    `Email: ${safeMember.email}`,
    "",
    supportPayload.message,
  ].join("\n");
}

async function insertContactMessage({ member, supportPayload, req }) {
  const safeMember = sanitizeMember(member);
  const createdAt = new Date().toISOString();

  const metadata = {
    portal: true,
    ticketType: "member_support",
    subject: supportPayload.subject,
    category: supportPayload.category,
    priority: supportPayload.priority,
    preferredResponse: supportPayload.preferredResponse,
    memberId: safeMember.id,
    signupId: safeMember.signupId,
    portalUserId: safeMember.portalUserId,
    accessLevel: safeMember.accessLevel,
    memberStatus: safeMember.memberStatus,
    tier: safeMember.tier,
    ip: getClientIp(req),
    userAgent: normalizeText(req.headers?.["user-agent"]),
    createdAt,
  };

  const fullPayload = {
    name: safeMember.fullName,
    email: safeMember.email,
    phone: safeMember.phone || null,
    topic: supportPayload.category,
    subject: supportPayload.subject,
    category: supportPayload.category,
    priority: supportPayload.priority,
    preferred_response: supportPayload.preferredResponse,
    message: supportPayload.message,
    source: "portal",
    contact_page: "portal/support",
    status: "new",
    metadata,
  };

  const mediumPayload = {
    name: safeMember.fullName,
    email: safeMember.email,
    phone: safeMember.phone || null,
    topic: supportPayload.category,
    message: buildFullMessage({ supportPayload, member }),
    source: "portal",
    contact_page: "portal/support",
    status: "new",
  };

  const minimalPayload = {
    name: safeMember.fullName,
    email: safeMember.email,
    message: buildFullMessage({ supportPayload, member }),
  };

  const attempts = [fullPayload, mediumPayload, minimalPayload];
  let lastError = null;

  for (const payload of attempts) {
    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .insert([payload])
      .select("*")
      .single();

    if (!error) {
      return {
        persisted: true,
        storageConfigured: true,
        request: normalizeSupportRequestRow({
          ...data,
          subject: supportPayload.subject,
          category: supportPayload.category,
          priority: supportPayload.priority,
          preferred_response: supportPayload.preferredResponse,
          metadata: {
            ...metadata,
            ...(isObject(data?.metadata) ? data.metadata : {}),
          },
        }),
      };
    }

    lastError = error;

    if (isMissingOptionalTableOrColumn(error)) {
      continue;
    }

    throw error;
  }

  if (lastError && isMissingOptionalTableOrColumn(lastError)) {
    return {
      persisted: false,
      storageConfigured: false,
      request: normalizeSupportRequestRow({
        id: `support-draft-${Date.now()}`,
        subject: supportPayload.subject,
        category: supportPayload.category,
        priority: supportPayload.priority,
        preferred_response: supportPayload.preferredResponse,
        message: supportPayload.message,
        status: "not_saved",
        source: "portal",
        created_at: createdAt,
        metadata,
      }),
      error: lastError,
    };
  }

  throw lastError || new Error("Unable to create support request.");
}

async function handleGet(req, res) {
  const context = await resolvePortalContext(req, res);

  if (!context.ok) {
    return context.response;
  }

  const { signupRecord } = context;
  const safeMember = sanitizeMember(signupRecord);
  const profile = buildProfile(signupRecord);
  const recentRequests = await fetchRecentSupportRequests(safeMember.email);
  const support = buildSupportPayload(signupRecord, recentRequests);
  const summary = buildSummary(signupRecord, recentRequests);

  logRequestSuccess(req, {
    scope: "portal_support_get",
    memberId: safeMember.id,
    email: safeMember.email,
  });

  return ok(
    res,
    {
      member: safeMember,
      profile,
      summary,
      support,
      fetchedAt: new Date().toISOString(),
    },
    "Support loaded successfully."
  );
}

async function handlePost(req, res) {
  const context = await resolvePortalContext(req, res);

  if (!context.ok) {
    return context.response;
  }

  const { signupRecord } = context;
  const safeMember = sanitizeMember(signupRecord);
  const body = getRequestBody(req);
  const validation = validateSupportPayload(body);

  if (!validation.ok) {
    return badRequest(
      res,
      validation.message || "Please correct the highlighted support fields.",
      validation.errors || {}
    );
  }

  const created = await insertContactMessage({
    member: signupRecord,
    supportPayload: validation.data,
    req,
  });

  const recentRequests = await fetchRecentSupportRequests(safeMember.email);
  const support = buildSupportPayload(signupRecord, recentRequests);
  const summary = buildSummary(signupRecord, recentRequests);

  logRequestSuccess(req, {
    scope: "portal_support_post",
    memberId: safeMember.id,
    email: safeMember.email,
    persisted: created.persisted,
  });

  return ok(
    res,
    {
      persisted: created.persisted,
      storageConfigured: created.storageConfigured,
      request: created.request,
      member: safeMember,
      profile: buildProfile(signupRecord),
      summary,
      support,
      fetchedAt: new Date().toISOString(),
    },
    created.persisted
      ? "Your support request has been submitted successfully."
      : "Support request validated, but support storage is not configured yet."
  );
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, {
    scope: "portal_support",
    method: req.method,
  });

  try {
    if (req.method === "GET") {
      const rate = portalProfileRateLimit(req, res);

      if (rate && !rate.allowed) {
        return badRequest(
          res,
          "Too many support view requests. Please try again later.",
          {
            retryAfter: rate.retryAfter ?? null,
          },
          {
            statusCode: 429,
            error: "rate_limited",
          }
        );
      }

      return handleGet(req, res);
    }

    if (req.method === "POST") {
      const rate = supportRateLimit(req, res);

      if (rate && !rate.allowed) {
        return badRequest(
          res,
          "Too many support submissions. Please try again later.",
          {
            retryAfter: rate.retryAfter ?? null,
          },
          {
            statusCode: 429,
            error: "rate_limited",
          }
        );
      }

      return handlePost(req, res);
    }

    return methodNotAllowed(
      res,
      ["GET", "POST"],
      "Method not allowed. Use GET or POST."
    );
  } catch (error) {
    logRequestError(req, error, {
      scope: "portal_support_unexpected",
    });

    return serverError(
      res,
      "Something went wrong while processing member support.",
      process.env.NODE_ENV === "development"
        ? {
            error: String(error?.message || error),
            code: error?.code || null,
          }
        : null
    );
  }
}