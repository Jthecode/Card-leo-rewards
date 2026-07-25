// api/access/get-benefit-categories.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const ACCESS_API_BASE_URL = process.env.ACCESS_API_BASE_URL || "";
const ACCESS_ACCOUNT_NUMBER = process.env.ACCESS_ACCOUNT_NUMBER || "";
const ACCESS_PROGRAM_ID = process.env.ACCESS_PROGRAM_ID || "";
const ACCESS_API_TOKEN = process.env.ACCESS_API_TOKEN || "";
const ACCESS_API_USERNAME = process.env.ACCESS_API_USERNAME || "";
const ACCESS_API_PASSWORD = process.env.ACCESS_API_PASSWORD || "";

/**
 * Add this later in Vercel once Access Development gives the real endpoint.
 *
 * Example:
 * ACCESS_CATEGORIES_ENDPOINT=/v1/categories
 */
const ACCESS_CATEGORIES_ENDPOINT =
  process.env.ACCESS_CATEGORIES_ENDPOINT || "/api/categories";

const ACTIVE_STATUSES = new Set(["active", "approved", "paid", "current"]);

const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "active",
  "current",
  "succeeded",
  "complete",
  "completed",
]);

const ACTIVE_MEMBERSHIP_STATUSES = new Set([
  "active",
  "activated",
  "paid",
  "approved",
  "current",
]);

const DEFAULT_CATEGORIES = [
  {
    id: "restaurants",
    name: "Restaurants",
    slug: "restaurants",
    description: "Dining deals, local restaurants, fast casual, and national food savings.",
    icon: "🍽️",
    featured: true,
  },
  {
    id: "travel",
    name: "Travel",
    slug: "travel",
    description: "Hotels, rental cars, vacation savings, and travel-related discounts.",
    icon: "✈️",
    featured: true,
  },
  {
    id: "shopping",
    name: "Shopping",
    slug: "shopping",
    description: "Retail savings, online shopping deals, clothing, and everyday purchases.",
    icon: "🛍️",
    featured: true,
  },
  {
    id: "entertainment",
    name: "Entertainment",
    slug: "entertainment",
    description: "Movies, attractions, events, activities, and entertainment offers.",
    icon: "🎟️",
    featured: true,
  },
  {
    id: "fitness",
    name: "Fitness",
    slug: "fitness",
    description: "Gyms, wellness, fitness services, and active lifestyle savings.",
    icon: "💪",
    featured: true,
  },
  {
    id: "health-wellness",
    name: "Health & Wellness",
    slug: "health-wellness",
    description: "Wellness, personal care, health-related savings, and lifestyle support.",
    icon: "♡",
    featured: false,
  },
  {
    id: "electronics",
    name: "Electronics",
    slug: "electronics",
    description: "Technology, devices, accessories, and electronics savings.",
    icon: "📱",
    featured: false,
  },
  {
    id: "local-deals",
    name: "Local Deals",
    slug: "local-deals",
    description: "Nearby offers based on member location and local savings.",
    icon: "📍",
    featured: false,
  },
];

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

function normalizeStatus(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(value, fallback = null) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
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

function parseCookieHeader(req) {
  const cookieHeader = req?.headers?.cookie || "";

  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");

      if (index === -1) return cookies;

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (!name) return cookies;

      cookies[name] = value;
      return cookies;
    }, {});
}

function safeBase64JsonParse(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSessionValue(rawValue) {
  const decoded = decodeCookieValue(rawValue);

  if (!decoded) return null;

  const parsedJson = safeJsonParse(decoded, null);
  if (isObject(parsedJson)) return parsedJson;

  const parsedBase64 = safeBase64JsonParse(decoded);
  if (isObject(parsedBase64)) return parsedBase64;

  return null;
}

function readSessionCookie(req) {
  const cookies = parseCookieHeader(req);

  const names = [
    "cardleo_session",
    "card_leo_session",
    "member_session",
    "portal_session",
    "session",
  ];

  for (const name of names) {
    if (!cookies[name]) continue;

    const parsed = parseSessionValue(cookies[name]);

    if (isObject(parsed)) {
      return {
        name,
        value: parsed,
      };
    }
  }

  return null;
}

function getUnixNow() {
  return Math.floor(Date.now() / 1000);
}

function isSessionExpired(sessionCookie) {
  const value = sessionCookie?.value || {};

  const expiresAt = Number(
    value.expires_at ||
      value.expiresAt ||
      value.exp ||
      value.session?.expires_at ||
      value.session?.expiresAt ||
      0
  );

  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;

  return expiresAt <= getUnixNow();
}

function getSessionIdentity(sessionCookie) {
  const value = sessionCookie?.value || {};
  const member = isObject(value.member) ? value.member : {};
  const profile = isObject(value.profile) ? value.profile : {};
  const user = isObject(value.user) ? value.user : {};
  const userMetadata = isObject(user.user_metadata) ? user.user_metadata : {};

  const ids = [
    value.signupId,
    value.signup_id,
    value.memberId,
    value.member_id,
    value.id,

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
  ]
    .map(normalizeString)
    .filter(Boolean);

  const portalUserIds = [
    value.portalUserId,
    value.portal_user_id,

    member.portalUserId,
    member.portal_user_id,

    profile.portalUserId,
    profile.portal_user_id,

    user.portalUserId,
    user.portal_user_id,

    userMetadata.portalUserId,
    userMetadata.portal_user_id,
  ]
    .map(normalizeString)
    .filter(Boolean);

  const email = normalizeEmail(
    value.email ||
      value.userEmail ||
      member.email ||
      profile.email ||
      user.email ||
      userMetadata.email
  );

  return {
    ids: Array.from(new Set(ids)),
    portalUserIds: Array.from(new Set(portalUserIds)),
    email,
  };
}

function hasPortalAccessForMember(member) {
  if (!member) return false;

  const status = normalizeStatus(member.status);
  const paymentStatus = normalizeStatus(member.payment_status);
  const membershipStatus = normalizeStatus(member.membership_status);

  return (
    ACTIVE_STATUSES.has(status) ||
    PAID_PAYMENT_STATUSES.has(paymentStatus) ||
    ACTIVE_MEMBERSHIP_STATUSES.has(membershipStatus)
  );
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
    message.includes("could not find") ||
    message.includes("schema cache") ||
    details.includes("does not exist") ||
    details.includes("could not find") ||
    details.includes("schema cache")
  );
}

function getSelectFields({ extended = true } = {}) {
  const base = [
    "id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "city",
    "state",
    "status",
    "payment_status",
    "membership_status",
    "portal_user_id",
    "portal_login_url",
    "created_at",
    "updated_at",
  ];

  if (!extended) {
    return base.join(", ");
  }

  return [
    ...base,
    "full_name",
    "referral_name",
    "tier",
    "referral_code",
    "activation_fee_amount",
    "monthly_fee_amount",
    "billing_day",
    "stripe_customer_id",
    "stripe_subscription_id",
    "access_member_id",
    "access_enrollment_status",
    "access_enrolled_at",
    "access_last_sync_at",
    "access_sso_url",
  ].join(", ");
}

async function queryMemberBy({ column, value, extended = true }) {
  if (!value) {
    return {
      data: null,
      error: null,
    };
  }

  return supabaseAdmin
    .from("signups")
    .select(getSelectFields({ extended }))
    .eq(column, value)
    .maybeSingle();
}

async function findMemberFromSession(sessionCookie) {
  const identity = getSessionIdentity(sessionCookie);

  const attempts = [];

  for (const id of identity.ids) {
    attempts.push({
      column: "id",
      value: id,
    });
  }

  for (const portalUserId of identity.portalUserIds) {
    attempts.push({
      column: "portal_user_id",
      value: portalUserId,
    });
  }

  if (identity.email) {
    attempts.push({
      column: "email",
      value: identity.email,
    });
  }

  const uniqueAttempts = [];
  const seen = new Set();

  for (const attempt of attempts) {
    const key = `${attempt.column}:${attempt.value}`;

    if (!attempt.value || seen.has(key)) continue;

    seen.add(key);
    uniqueAttempts.push(attempt);
  }

  let lastError = null;

  for (const attempt of uniqueAttempts) {
    let result = await queryMemberBy({
      column: attempt.column,
      value: attempt.value,
      extended: true,
    });

    if (result.error && isMissingOptionalColumn(result.error)) {
      result = await queryMemberBy({
        column: attempt.column,
        value: attempt.value,
        extended: false,
      });
    }

    if (result.error) {
      lastError = result.error;
      continue;
    }

    if (result.data?.id) {
      return {
        member: result.data,
        error: null,
        matchedBy: attempt.column,
      };
    }
  }

  return {
    member: null,
    error: lastError,
    matchedBy: "",
  };
}

function hasRealAccessPassword() {
  const password = normalizeString(ACCESS_API_PASSWORD).toLowerCase();

  if (!password) return false;
  if (password.includes("your_access_password")) return false;
  if (password.includes("your_access_passwor")) return false;

  return true;
}

function buildAccessHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Account-Number": ACCESS_ACCOUNT_NUMBER,
    "X-Program-ID": ACCESS_PROGRAM_ID,
    "X-Program-Id": ACCESS_PROGRAM_ID,
  };

  if (ACCESS_API_TOKEN) {
    headers.Authorization = `Bearer ${ACCESS_API_TOKEN}`;
    headers["X-Access-Token"] = ACCESS_API_TOKEN;
    headers["X-API-Token"] = ACCESS_API_TOKEN;
    headers.Token = ACCESS_API_TOKEN;
  }

  if (ACCESS_API_USERNAME && hasRealAccessPassword()) {
    const basic = Buffer.from(
      `${ACCESS_API_USERNAME}:${ACCESS_API_PASSWORD}`
    ).toString("base64");

    headers.Authorization = headers.Authorization || `Basic ${basic}`;
    headers["X-Access-Username"] = ACCESS_API_USERNAME;
  }

  return headers;
}

function buildAccessApiUrl(path) {
  const base = normalizeString(ACCESS_API_BASE_URL).replace(/\/+$/, "");
  const cleanPath = normalizeString(path).startsWith("/")
    ? normalizeString(path)
    : `/${normalizeString(path)}`;

  return `${base}${cleanPath}`;
}

async function parseAccessResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }

  const text = await response.text().catch(() => "");

  return {
    raw: text,
  };
}

function slugify(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pickCategoryIcon(nameOrSlug) {
  const value = normalizeString(nameOrSlug).toLowerCase();

  if (value.includes("restaurant") || value.includes("dining") || value.includes("food")) {
    return "🍽️";
  }

  if (value.includes("travel") || value.includes("hotel") || value.includes("car")) {
    return "✈️";
  }

  if (value.includes("shopping") || value.includes("retail")) {
    return "🛍️";
  }

  if (value.includes("entertainment") || value.includes("movie") || value.includes("event")) {
    return "🎟️";
  }

  if (value.includes("fitness") || value.includes("gym")) {
    return "💪";
  }

  if (value.includes("health") || value.includes("wellness")) {
    return "♡";
  }

  if (value.includes("electronic") || value.includes("tech")) {
    return "📱";
  }

  if (value.includes("local") || value.includes("nearby")) {
    return "📍";
  }

  return "★";
}

function readNestedArray(object, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = object;

    for (const part of parts) {
      current = current?.[part];
    }

    if (Array.isArray(current)) return current;
  }

  return [];
}

function normalizeAccessCategory(category, index = 0) {
  const name = normalizeString(
    category.name ||
      category.categoryName ||
      category.category_name ||
      category.title ||
      category.label ||
      category.description ||
      `Category ${index + 1}`
  );

  const id = normalizeString(
    category.id ||
      category.categoryId ||
      category.category_id ||
      category.code ||
      category.value ||
      slugify(name)
  );

  const slug = slugify(
    category.slug ||
      category.categorySlug ||
      category.category_slug ||
      name ||
      id
  );

  return {
    id: id || slug || `category-${index + 1}`,
    name: name || `Category ${index + 1}`,
    slug: slug || `category-${index + 1}`,
    description: normalizeString(
      category.shortDescription ||
        category.short_description ||
        category.description ||
        category.summary ||
        `Browse ${name || "member"} savings and discounts.`
    ),
    icon: normalizeString(category.icon) || pickCategoryIcon(name || slug),
    featured: Boolean(category.featured || index < 5),
    raw: category,
  };
}

function normalizeAccessCategories(accessResult) {
  const categories = readNestedArray(accessResult, [
    "categories",
    "data.categories",
    "data",
    "items",
    "results",
    "response.categories",
    "response.data.categories",
  ]);

  if (!categories.length) return [];

  return categories
    .map((category, index) => normalizeAccessCategory(category, index))
    .filter((category) => category.name && category.slug);
}

async function callAccessCategories() {
  if (!ACCESS_API_BASE_URL || !ACCESS_ACCOUNT_NUMBER || !ACCESS_PROGRAM_ID) {
    return {
      ok: false,
      status: 500,
      message:
        "Access API is not fully configured. Using Card Leo default categories.",
      categories: DEFAULT_CATEGORIES,
      access_result: null,
    };
  }

  if (!ACCESS_API_TOKEN && (!ACCESS_API_USERNAME || !hasRealAccessPassword())) {
    return {
      ok: false,
      status: 500,
      message:
        "Access API authentication is missing. Using Card Leo default categories.",
      categories: DEFAULT_CATEGORIES,
      access_result: null,
    };
  }

  const url = buildAccessApiUrl(ACCESS_CATEGORIES_ENDPOINT);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildAccessHeaders(),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message:
        error?.message ||
        "Unable to connect to Access Development categories API. Using Card Leo default categories.",
      categories: DEFAULT_CATEGORIES,
      access_result: null,
      access_url: url,
    };
  }

  const accessResult = await parseAccessResponse(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        accessResult?.message ||
        accessResult?.error ||
        `Access categories failed with status ${response.status}. Using Card Leo default categories.`,
      categories: DEFAULT_CATEGORIES,
      access_result: accessResult,
      access_url: url,
    };
  }

  const categories = normalizeAccessCategories(accessResult);

  if (!categories.length) {
    return {
      ok: false,
      status: response.status,
      message:
        "Access categories response did not include usable categories. Using Card Leo default categories.",
      categories: DEFAULT_CATEGORIES,
      access_result: accessResult,
      access_url: url,
    };
  }

  return {
    ok: true,
    status: response.status,
    message: "Benefit categories loaded.",
    categories,
    access_result: accessResult,
    access_url: url,
  };
}

function getSafeDebugPayload(accessResponse) {
  if (!accessResponse || !isObject(accessResponse)) return null;

  return {
    ok: accessResponse.ok,
    status: accessResponse.status,
    message: accessResponse.message,
    access_url: accessResponse.access_url || "",
  };
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
    const sessionCookie = readSessionCookie(req);

    if (!sessionCookie?.value || sessionCookie.value.authenticated !== true) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Please log in before viewing benefits.",
        redirectTo: "/login.html",
      });
    }

    if (isSessionExpired(sessionCookie)) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        authenticated: false,
        message: "Your session expired. Please log in again.",
        redirectTo: "/login.html",
      });
    }

    const { member, error } = await findMemberFromSession(sessionCookie);

    if (error) {
      console.error("Benefit categories member lookup error:", error);

      return sendJson(res, 500, {
        success: false,
        ok: false,
        message: "Unable to verify your Card Leo Rewards account.",
      });
    }

    if (!member?.id) {
      return sendJson(res, 404, {
        success: false,
        ok: false,
        message: "Member account not found. Please log in again.",
        redirectTo: "/login.html",
      });
    }

    if (!hasPortalAccessForMember(member)) {
      return sendJson(res, 402, {
        success: false,
        ok: false,
        authenticated: true,
        requires_payment: true,
        payment_required: true,
        message:
          "Your membership must be paid and active before viewing benefits.",
        redirectTo: "/signup.html?status=payment_required",
      });
    }

    const accessResponse = await callAccessCategories();

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      source: accessResponse.ok ? "access-development" : "card-leo-defaults",
      message: accessResponse.message,
      categories: accessResponse.categories,
      count: accessResponse.categories.length,
      debug: getSafeDebugPayload(accessResponse),
    });
  } catch (error) {
    console.error("Card Leo get benefit categories error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message ||
        "Something went wrong while loading benefit categories.",
    });
  }
}