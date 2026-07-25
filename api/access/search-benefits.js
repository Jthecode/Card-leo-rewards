// api/access/search-benefits.js
import crypto from "crypto";
import { supabaseAdmin } from "../../lib/supabase-admin.js";

/**
 * Vercel Environment Variables Needed:
 *
 * ACCESS_API_BASE_URL=https://offer.adcrws.com
 * ACCESS_SEARCH_BENEFITS_ENDPOINT=/v1/offers.json
 * ACCESS_API_TOKEN=your_access_token
 * ACCESS_ANONYMOUS_MEMBER_KEY=anonymous
 *
 * Optional:
 * ACCESS_DEFAULT_POSTAL_CODE=34956
 * ACCESS_DEFAULT_DISTANCE=50mi
 */

const ACCESS_API_BASE_URL =
  process.env.ACCESS_API_BASE_URL || "https://offer.adcrws.com";

const ACCESS_API_TOKEN = process.env.ACCESS_API_TOKEN || "";

const ACCESS_ANONYMOUS_MEMBER_KEY =
  process.env.ACCESS_ANONYMOUS_MEMBER_KEY || "anonymous";

const ACCESS_SEARCH_BENEFITS_ENDPOINT =
  process.env.ACCESS_SEARCH_BENEFITS_ENDPOINT || "/v1/offers.json";

const ACCESS_DEFAULT_POSTAL_CODE =
  process.env.ACCESS_DEFAULT_POSTAL_CODE || "34956";

const ACCESS_DEFAULT_DISTANCE = process.env.ACCESS_DEFAULT_DISTANCE || "50mi";

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

const DEFAULT_BENEFITS = [
  {
    id: "cardleo-travel-001",
    merchantName: "Travel Savings",
    title: "Travel Deals",
    category: "travel",
    categoryName: "Travel",
    categoryIcon: "✈️",
    discount: "Exclusive member rates",
    description:
      "Access travel savings for hotels, rental cars, attractions, and member-only vacation deals.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=travel",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-parks-001",
    merchantName: "Parks & Tickets",
    title: "Theme Park Deals",
    category: "parks-and-tickets",
    categoryName: "Parks & Tickets",
    categoryIcon: "🎟️",
    discount: "Special member pricing",
    description:
      "Find savings on attractions, theme parks, movie tickets, events, and entertainment experiences.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=parks-and-tickets",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-deals-001",
    merchantName: "Member Deals",
    title: "Everyday Deals",
    category: "deals",
    categoryName: "Deals",
    categoryIcon: "🔥",
    discount: "Member-only savings",
    description:
      "Browse featured discounts, online offers, local savings, and everyday member deals.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=deals",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-insurance-001",
    merchantName: "Insurance Savings",
    title: "Insurance Benefits",
    category: "insurance",
    categoryName: "Insurance",
    categoryIcon: "🛡️",
    discount: "Member access",
    description:
      "Explore insurance-related benefits and member savings opportunities.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=insurance",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-grocery-001",
    merchantName: "Grocery Coupons",
    title: "Grocery Savings",
    category: "grocery-coupons",
    categoryName: "Grocery Coupons",
    categoryIcon: "🛒",
    discount: "Coupons available",
    description:
      "Access grocery coupons and household savings through Card Leo Rewards.",
    locationType: "online",
    redemptionType: "View coupons",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=grocery-coupons",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-financial-001",
    merchantName: "Financial Wellness",
    title: "Financial Wellness",
    category: "financial-wellness",
    categoryName: "Financial Wellness",
    categoryIcon: "💳",
    discount: "Member access",
    description: "Explore financial wellness resources and member benefits.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=financial-wellness",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-health-001",
    merchantName: "Health & Wellness",
    title: "Health & Wellness",
    category: "health-and-wellness",
    categoryName: "Health & Wellness",
    categoryIcon: "♡",
    discount: "Member savings",
    description:
      "Browse wellness, personal care, health-related savings, and lifestyle support offers.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=health-and-wellness",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-dining-001",
    merchantName: "Local Dining Savings",
    title: "Dining Deals",
    category: "restaurants",
    categoryName: "Restaurants",
    categoryIcon: "🍽️",
    discount: "Up to 30% off",
    description:
      "Save at participating restaurants, casual dining spots, cafes, and local food partners.",
    locationType: "local",
    redemptionType: "Show deal in portal",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=restaurants",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-shopping-001",
    merchantName: "Retail Rewards",
    title: "Shopping Discounts",
    category: "shopping",
    categoryName: "Shopping",
    categoryIcon: "🛍️",
    discount: "Member-only savings",
    description:
      "Browse online and retail shopping offers across clothing, accessories, home, and everyday purchases.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=shopping",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-fitness-001",
    merchantName: "Fitness & Wellness",
    title: "Fitness Benefits",
    category: "fitness",
    categoryName: "Fitness",
    categoryIcon: "💪",
    discount: "Member savings",
    description:
      "Explore gyms, active lifestyle deals, wellness services, and fitness-related discounts.",
    locationType: "local",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=fitness",
    redeemUrl: "",
    featured: true,
  },
  {
    id: "cardleo-electronics-001",
    merchantName: "Electronics Savings",
    title: "Tech & Electronics",
    category: "electronics",
    categoryName: "Electronics",
    categoryIcon: "📱",
    discount: "Exclusive offers",
    description:
      "Save on electronics, devices, accessories, and technology-related member offers.",
    locationType: "online",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=electronics",
    redeemUrl: "",
    featured: false,
  },
  {
    id: "cardleo-local-001",
    merchantName: "Local Deals",
    title: "Local Member Savings",
    category: "local-deals",
    categoryName: "Local Deals",
    categoryIcon: "📍",
    discount: "Nearby offers",
    description: "Find local deals and participating businesses near your area.",
    locationType: "local",
    redemptionType: "View offer details",
    imageUrl: "",
    detailsUrl: "/portal/benefits.html?category=local-deals",
    redeemUrl: "",
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
    "access_member_key",
    "member_key",
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

function makeExternalMemberId(member) {
  const raw = `${member?.id || ""}:${member?.email || ""}:card-leo-rewards`;

  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function getAccessMemberKey(member) {
  return (
    normalizeString(member?.access_member_key) ||
    normalizeString(member?.member_key) ||
    normalizeString(member?.access_member_id) ||
    ACCESS_ANONYMOUS_MEMBER_KEY ||
    makeExternalMemberId(member)
  );
}

function buildAccessHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (ACCESS_API_TOKEN) {
    headers["Access-Token"] = ACCESS_API_TOKEN;
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

function pickCategoryName(value) {
  const text = normalizeString(value).toLowerCase();

  if (text.includes("hardware") || text.includes("home") || text.includes("garden")) {
    return "Home & Garden";
  }

  if (text.includes("park") || text.includes("ticket") || text.includes("attraction")) {
    return "Parks & Tickets";
  }

  if (text.includes("restaurant") || text.includes("dining") || text.includes("food")) {
    return "Restaurants";
  }

  if (text.includes("travel") || text.includes("hotel") || text.includes("car")) {
    return "Travel";
  }

  if (text.includes("grocery") || text.includes("coupon")) {
    return "Grocery Coupons";
  }

  if (text.includes("insurance")) {
    return "Insurance";
  }

  if (text.includes("financial") || text.includes("finance")) {
    return "Financial Wellness";
  }

  if (text.includes("shopping") || text.includes("retail")) {
    return "Shopping";
  }

  if (text.includes("entertainment") || text.includes("movie") || text.includes("event")) {
    return "Entertainment";
  }

  if (text.includes("fitness") || text.includes("gym") || text.includes("studio")) {
    return "Fitness";
  }

  if (text.includes("health") || text.includes("wellness")) {
    return "Health & Wellness";
  }

  if (text.includes("electronic") || text.includes("tech")) {
    return "Electronics";
  }

  if (text.includes("local") || text.includes("nearby")) {
    return "Local Deals";
  }

  if (text.includes("deal") || text.includes("offer")) {
    return "Deals";
  }

  return value ? normalizeString(value) : "Lifestyle Benefits";
}

function pickCategoryIcon(value) {
  const text = normalizeString(value).toLowerCase();

  if (text.includes("home") || text.includes("garden") || text.includes("hardware")) {
    return "🏠";
  }

  if (text.includes("park") || text.includes("ticket") || text.includes("attraction")) {
    return "🎟️";
  }

  if (text.includes("restaurant") || text.includes("dining") || text.includes("food")) {
    return "🍽️";
  }

  if (text.includes("travel") || text.includes("hotel") || text.includes("car")) {
    return "✈️";
  }

  if (text.includes("grocery") || text.includes("coupon")) {
    return "🛒";
  }

  if (text.includes("insurance")) {
    return "🛡️";
  }

  if (text.includes("financial") || text.includes("finance")) {
    return "💳";
  }

  if (text.includes("shopping") || text.includes("retail")) {
    return "🛍️";
  }

  if (text.includes("entertainment") || text.includes("movie") || text.includes("event")) {
    return "🎬";
  }

  if (text.includes("fitness") || text.includes("gym") || text.includes("studio")) {
    return "💪";
  }

  if (text.includes("health") || text.includes("wellness")) {
    return "♡";
  }

  if (text.includes("electronic") || text.includes("tech")) {
    return "📱";
  }

  if (text.includes("local") || text.includes("nearby")) {
    return "📍";
  }

  return "★";
}

function getRequestUrl(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "www.cardleorewards.com";

  return new URL(req.url || "/api/access/search-benefits", `${proto}://${host}`);
}

function getSearchParams(req) {
  const url = getRequestUrl(req);

  const q = normalizeString(
    url.searchParams.get("q") ||
      url.searchParams.get("query") ||
      url.searchParams.get("search") ||
      ""
  );

  const category = slugify(
    url.searchParams.get("category") ||
      url.searchParams.get("category_key") ||
      url.searchParams.get("category_slug") ||
      url.searchParams.get("categorySlug") ||
      ""
  );

  const city = normalizeString(url.searchParams.get("city") || "");
  const state = normalizeString(url.searchParams.get("state") || "");

  const postalCode = normalizeString(
    url.searchParams.get("postal_code") ||
      url.searchParams.get("postalCode") ||
      url.searchParams.get("zip") ||
      url.searchParams.get("zipcode") ||
      ""
  );

  const distance = normalizeString(url.searchParams.get("distance") || "");

  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);

  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") || 100) || 100)
  );

  return {
    q,
    category,
    city,
    state,
    postalCode,
    distance,
    page,
    limit,
  };
}

function filterDefaultBenefits(params) {
  const query = params.q.toLowerCase();
  const category = slugify(params.category);

  let benefits = [...DEFAULT_BENEFITS];

  if (category && category !== "all") {
    benefits = benefits.filter((benefit) => {
      return (
        slugify(benefit.category) === category ||
        slugify(benefit.categoryName) === category
      );
    });
  }

  if (query) {
    benefits = benefits.filter((benefit) => {
      const haystack = [
        benefit.merchantName,
        benefit.title,
        benefit.category,
        benefit.categoryName,
        benefit.discount,
        benefit.description,
        benefit.locationType,
        benefit.redemptionType,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }

  const start = (params.page - 1) * params.limit;
  const end = start + params.limit;
  const paginated = benefits.slice(start, end);

  return {
    benefits: paginated,
    total: benefits.length,
    page: params.page,
    limit: params.limit,
    hasMore: end < benefits.length,
  };
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

function readNestedValue(object, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = object;

    for (const part of parts) {
      current = current?.[part];
    }

    const value = normalizeString(current);

    if (value) return value;
  }

  return "";
}

function unwrapJsonApiResource(resource) {
  if (!isObject(resource)) return resource;

  const attributes = isObject(resource.attributes) ? resource.attributes : {};
  const relationships = isObject(resource.relationships)
    ? resource.relationships
    : {};

  return {
    id: resource.id,
    type: resource.type,
    ...attributes,
    relationships,
    links: resource.links || attributes.links || {},
    raw_json_api: resource,
  };
}

function normalizeCategoryFromOffer(offer) {
  const categories = Array.isArray(offer.categories) ? offer.categories : [];
  const firstCategory = categories[0] || {};

  const categoryRaw = normalizeString(
    firstCategory.category_name ||
      firstCategory.name ||
      firstCategory.title ||
      firstCategory.category_key ||
      offer.category_name ||
      offer.categoryName ||
      offer.category ||
      offer.category_key ||
      offer.categoryKey ||
      offer.type ||
      offer.vertical ||
      offer.department ||
      "Deals"
  );

  const categoryName = pickCategoryName(categoryRaw);
  const category = slugify(categoryRaw || categoryName);

  return {
    category,
    categoryName,
    categoryIcon: pickCategoryIcon(categoryName),
  };
}

function cleanDescription(value) {
  return normalizeString(value)
    .replace(/\s+/g, " ")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function formatDiscountFromOffer(offer) {
  const savingsAmount = normalizeString(offer.savings_amount);
  const offerValue = normalizeString(offer.offer_value);
  const discountValue = normalizeString(offer.discount_value);
  const discountType = normalizeString(offer.discount_type).toLowerCase();
  const title = normalizeString(offer.title);

  if (title) return title;

  if (savingsAmount && savingsAmount !== "0.0" && savingsAmount !== "0") {
    return savingsAmount.startsWith("$") ? `Save ${savingsAmount}` : `Save $${savingsAmount}`;
  }

  if (discountValue && discountType === "amount") {
    return discountValue.startsWith("$") ? `${discountValue} off` : `$${discountValue} off`;
  }

  if (discountValue && ["percentage", "percent"].includes(discountType)) {
    return `${discountValue}% off`;
  }

  if (offerValue && offerValue !== "0" && offerValue !== "0.0") {
    return offerValue.startsWith("$") ? `Value ${offerValue}` : `Value $${offerValue}`;
  }

  return "Member savings";
}

function normalizeBenefit(rawOffer, index = 0) {
  const offer = unwrapJsonApiResource(rawOffer);

  const accessOffer = isObject(offer.offer) ? offer.offer : {};
  const offerStore = isObject(offer.offer_store) ? offer.offer_store : {};
  const physicalLocation = isObject(offer.physical_location)
    ? offer.physical_location
    : {};
  const links = isObject(offer.links) ? offer.links : {};

  const categoryInfo = normalizeCategoryFromOffer(offer);

  const merchantName = normalizeString(
    offerStore.name ||
      offerStore.location_name ||
      accessOffer.name ||
      accessOffer.title ||
      offer.merchantName ||
      offer.merchant_name ||
      offer.merchant ||
      offer.vendor ||
      offer.company ||
      offer.businessName ||
      offer.business_name ||
      offer.name ||
      `Access Offer ${index + 1}`
  );

  const title = normalizeString(
    offer.title ||
      offer.offerTitle ||
      offer.offer_title ||
      offer.headline ||
      accessOffer.title ||
      accessOffer.name ||
      merchantName ||
      `Access Offer ${index + 1}`
  );

  const id = normalizeString(
    offer.id ||
      offer.offer_key ||
      offer.offerKey ||
      offer.offer_group_key ||
      offer.offerGroupKey ||
      offer.location_key ||
      offer.locationKey ||
      offerStore.store_key ||
      offerStore.storeKey ||
      accessOffer.offer_key ||
      `${slugify(merchantName || title)}-${index + 1}`
  );

  const discount = formatDiscountFromOffer(offer);

  const description = cleanDescription(
    accessOffer.description ||
      offer.description ||
      offer.longDescription ||
      offer.long_description ||
      offer.summary ||
      offer.details ||
      offer.restrictions ||
      `Save with ${merchantName} through Card Leo Rewards.`
  );

  const terms = cleanDescription(
    offer.terms_of_use ||
      offer.terms ||
      offer.termsAndConditions ||
      offer.terms_and_conditions ||
      accessOffer.terms ||
      ""
  );

  const imageUrl = normalizeString(
    offer.logo_url ||
      offer.offer_photo_url ||
      offer.imageUrl ||
      offer.image_url ||
      offer.logoUrl ||
      offer.logo ||
      offer.thumbnail ||
      offer.thumbnailUrl ||
      links.image ||
      links.logo ||
      ""
  );

  const detailsUrl = normalizeString(
    links.show_offer ||
      links.show_store ||
      links.show_location ||
      offer.detailsUrl ||
      offer.details_url ||
      offer.url ||
      offer.offerUrl ||
      offer.offer_url ||
      offer.redemptionUrl ||
      offer.redemption_url ||
      ""
  );

  const redeemUrl = normalizeString(
    links.redeem_offer ||
      links.instore ||
      links.instore_print ||
      offer.redeemUrl ||
      offer.redeem_url ||
      offer.redemptionUrl ||
      offer.redemption_url ||
      ""
  );

  const address = normalizeString(
    offerStore.street_address ||
      offerStore.address ||
      physicalLocation.street_address ||
      physicalLocation.address ||
      offer.address ||
      offer.streetAddress ||
      offer.street_address ||
      ""
  );

  const city = normalizeString(
    offerStore.city_locality ||
      offerStore.city ||
      physicalLocation.city_locality ||
      physicalLocation.city ||
      offer.city ||
      ""
  );

  const state = normalizeString(
    offerStore.state_region ||
      offerStore.state ||
      physicalLocation.state_region ||
      physicalLocation.state ||
      offer.state ||
      ""
  );

  const zip = normalizeString(
    offerStore.postal_code ||
      offerStore.zip ||
      physicalLocation.postal_code ||
      physicalLocation.zip ||
      offer.postal_code ||
      offer.zip ||
      offer.zipCode ||
      ""
  );

  const phone = normalizeString(
    offerStore.phone_number ||
      offerStore.phone ||
      physicalLocation.phone_number ||
      offer.phone ||
      ""
  );

  const website = normalizeString(
    offerStore.web_address ||
      offerStore.website ||
      accessOffer.web_address ||
      accessOffer.website ||
      ""
  );

  const isOnlineExclusive =
    offer.online_exclusive === true ||
    normalizeString(offer.online_exclusive).toLowerCase() === "true";

  const locationType = isOnlineExclusive ? "online" : "local";

  const redemptionMethods = Array.isArray(offer.redemption_methods)
    ? offer.redemption_methods
    : [];

  const redemptionType =
    redemptionMethods.length > 0
      ? redemptionMethods.join(", ")
      : redeemUrl
        ? "Redeem offer"
        : "View details";

  return {
    id,
    merchantName,
    title,
    category: categoryInfo.category,
    categoryName: categoryInfo.categoryName,
    categoryIcon: categoryInfo.categoryIcon,
    discount,
    description,
    terms,
    instructions:
      redemptionType === "View details"
        ? "Open this offer to view redemption instructions."
        : `Redeem using: ${redemptionType}.`,
    locationType,
    redemptionType,
    imageUrl,
    detailsUrl,
    redeemUrl,
    website,
    phone,
    address,
    city,
    state,
    zip,
    featured: Boolean(offer.featured || index < 6),
    raw: rawOffer,
  };
}

function normalizeAccessBenefits(accessResult) {
  const offers = readNestedArray(accessResult, [
    "data",
    "offers",
    "benefits",
    "deals",
    "items",
    "results",
    "response.offers",
    "response.data",
    "response.data.offers",
    "response.results",
  ]);

  if (!offers.length) return [];

  return offers
    .map((offer, index) => normalizeBenefit(offer, index))
    .filter((benefit) => benefit.id && benefit.title);
}

function getTotalFromAccess(accessResult, fallbackCount) {
  const value = Number(
    readNestedValue(accessResult, [
      "meta.total",
      "meta.total_count",
      "meta.count",
      "meta.record_count",
      "total",
      "totalCount",
      "total_count",
      "count",
      "data.total",
      "data.totalCount",
      "data.total_count",
      "data.count",
      "pagination.total",
      "data.pagination.total",
    ])
  );

  if (Number.isFinite(value) && value >= 0) return value;

  return fallbackCount;
}

function buildSearchQueryParams(params, member) {
  const search = new URLSearchParams();

  const memberKey = getAccessMemberKey(member);

  search.set("member_key", memberKey);
  search.set("page", String(params.page || 1));
  search.set("per_page", String(params.limit || 100));

  const postalCode =
    params.postalCode ||
    normalizeString(member?.zip) ||
    normalizeString(member?.postal_code) ||
    ACCESS_DEFAULT_POSTAL_CODE;

  const distance = params.distance || ACCESS_DEFAULT_DISTANCE;

  if (postalCode) search.set("postal_code", postalCode);
  if (distance) search.set("distance", distance);

  if (params.q) {
    search.set("search", params.q);
  }

  if (params.category && params.category !== "all") {
    search.set("category_key", params.category);
  }

  return search;
}

async function callAccessSearchBenefits(params, member) {
  if (!ACCESS_API_BASE_URL || !ACCESS_API_TOKEN) {
    const fallback = filterDefaultBenefits(params);

    return {
      ok: false,
      status: 500,
      message:
        "Access Offers API is not fully configured. Showing Card Leo default benefit examples.",
      ...fallback,
      access_result: null,
    };
  }

  const baseUrl = buildAccessApiUrl(ACCESS_SEARCH_BENEFITS_ENDPOINT);
  const queryParams = buildSearchQueryParams(params, member);
  const url = `${baseUrl}?${queryParams.toString()}`;

  let response;
  let accessResult;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildAccessHeaders(),
    });

    accessResult = await parseAccessResponse(response);
  } catch (error) {
    const fallback = filterDefaultBenefits(params);

    return {
      ok: false,
      status: 502,
      message:
        error?.message ||
        "Unable to connect to Access Offers API. Showing Card Leo default benefit examples.",
      ...fallback,
      access_result: null,
      access_url: url,
    };
  }

  if (!response.ok) {
    const fallback = filterDefaultBenefits(params);

    return {
      ok: false,
      status: response.status,
      message:
        accessResult?.errors?.[0]?.detail ||
        accessResult?.errors?.[0]?.title ||
        accessResult?.message ||
        accessResult?.error ||
        `Access benefits search failed with status ${response.status}. Showing Card Leo default benefit examples.`,
      ...fallback,
      access_result: accessResult,
      access_url: url,
    };
  }

  const benefits = normalizeAccessBenefits(accessResult);

  if (!benefits.length) {
    const fallback = filterDefaultBenefits(params);

    return {
      ok: false,
      status: response.status,
      message:
        accessResult?.message ||
        "Access returned no offers for this request. Showing Card Leo default benefit examples.",
      ...fallback,
      access_result: accessResult,
      access_url: url,
    };
  }

  return {
    ok: true,
    status: response.status,
    message: "Benefits loaded from Access Offers API.",
    benefits,
    total: getTotalFromAccess(accessResult, benefits.length),
    page: params.page,
    limit: params.limit,
    hasMore: benefits.length >= params.limit,
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
        message: "Please log in before searching benefits.",
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
      console.error("Search benefits member lookup error:", error);

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
          "Your membership must be paid and active before searching benefits.",
        redirectTo: "/signup.html?status=payment_required",
      });
    }

    const params = getSearchParams(req);
    const accessResponse = await callAccessSearchBenefits(params, member);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      source: accessResponse.ok ? "access-development" : "card-leo-defaults",
      message: accessResponse.message,
      benefits: accessResponse.benefits,
      total: accessResponse.total,
      count: accessResponse.benefits.length,
      page: accessResponse.page,
      limit: accessResponse.limit,
      hasMore: accessResponse.hasMore,
      query: params.q,
      category: params.category,
      debug: getSafeDebugPayload(accessResponse),
    });
  } catch (error) {
    console.error("Card Leo search benefits error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message || "Something went wrong while searching benefits.",
    });
  }
}