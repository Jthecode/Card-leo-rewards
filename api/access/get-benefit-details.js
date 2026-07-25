// api/access/get-benefit-details.js
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
 * Examples:
 * ACCESS_BENEFIT_DETAILS_ENDPOINT=/v1/offers/details
 * ACCESS_BENEFIT_DETAILS_ENDPOINT=/api/offers/details
 *
 * This file supports:
 * - /api/offers/details?id=OFFER_ID
 * - /api/offers/details/OFFER_ID
 * - POST fallback with { id, offerId }
 */
const ACCESS_BENEFIT_DETAILS_ENDPOINT =
  process.env.ACCESS_BENEFIT_DETAILS_ENDPOINT || "/api/offers/details";

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

const DEFAULT_BENEFIT_DETAILS = [
  {
    id: "cardleo-dining-001",
    merchantName: "Local Dining Savings",
    title: "Dining Deals",
    category: "restaurants",
    categoryName: "Restaurants",
    categoryIcon: "🍽️",
    discount: "Up to 30% off",
    description:
      "Save at participating restaurants, casual dining spots, cafes, and local food partners through your Card Leo Rewards membership.",
    terms:
      "Offer availability may vary by location and merchant. Final savings, redemption rules, and restrictions are shown before use.",
    instructions:
      "Search dining offers inside the Card Leo Benefits portal, choose a participating merchant, and follow the redemption instructions shown on the offer.",
    redemptionType: "Show deal in portal",
    locationType: "local",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
    featured: true,
  },
  {
    id: "cardleo-travel-001",
    merchantName: "Travel Savings",
    title: "Hotel & Travel Offers",
    category: "travel",
    categoryName: "Travel",
    categoryIcon: "✈️",
    discount: "Exclusive member rates",
    description:
      "Access member-only savings for hotels, rental cars, attractions, vacation planning, and travel-related offers.",
    terms:
      "Travel savings may vary by date, availability, destination, and provider. Review all offer details before booking.",
    instructions:
      "Open the travel offer inside Card Leo Benefits, review the terms, and follow the booking or redemption steps.",
    redemptionType: "View offer details",
    locationType: "online",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
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
      "Browse online and retail shopping offers across clothing, accessories, home, lifestyle, and everyday purchases.",
    terms:
      "Some shopping discounts may require a promo code, portal click-through, or specific redemption step.",
    instructions:
      "Select a shopping offer, review the instructions, then use the displayed code or offer link if provided.",
    redemptionType: "View offer details",
    locationType: "online",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
    featured: true,
  },
  {
    id: "cardleo-entertainment-001",
    merchantName: "Entertainment Access",
    title: "Events & Attractions",
    category: "entertainment",
    categoryName: "Entertainment",
    categoryIcon: "🎟️",
    discount: "Special member pricing",
    description:
      "Find savings for movies, events, attractions, activities, family entertainment, and local experiences.",
    terms:
      "Offer availability, pricing, and restrictions may vary by event, date, venue, and provider.",
    instructions:
      "Choose an entertainment offer, review availability, and follow the redemption or booking instructions.",
    redemptionType: "View offer details",
    locationType: "online",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
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
      "Explore gyms, active lifestyle deals, wellness services, personal care, and fitness-related discounts.",
    terms:
      "Fitness and wellness offers may vary by location, provider, membership level, and availability.",
    instructions:
      "Open the fitness offer, review the merchant instructions, and redeem through the listed steps.",
    redemptionType: "View offer details",
    locationType: "local",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
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
      "Save on electronics, devices, accessories, software, and technology-related member offers.",
    terms:
      "Electronics offers may change quickly and may be limited by inventory, retailer rules, or promo dates.",
    instructions:
      "Select an electronics offer and follow the code, link, or redemption instructions shown.",
    redemptionType: "View offer details",
    locationType: "online",
    imageUrl: "",
    detailsUrl: "",
    redeemUrl: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    website: "",
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

function getRequestUrl(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "www.cardleorewards.com";

  return new URL(
    req.url || "/api/access/get-benefit-details",
    `${proto}://${host}`
  );
}

function getBenefitIdFromRequest(req) {
  const url = getRequestUrl(req);

  return normalizeString(
    url.searchParams.get("id") ||
      url.searchParams.get("offer_id") ||
      url.searchParams.get("offerId") ||
      url.searchParams.get("benefit_id") ||
      url.searchParams.get("benefitId") ||
      url.searchParams.get("deal_id") ||
      url.searchParams.get("dealId") ||
      ""
  );
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

function pickCategoryName(value) {
  const text = normalizeString(value).toLowerCase();

  if (text.includes("restaurant") || text.includes("dining") || text.includes("food")) {
    return "Restaurants";
  }

  if (text.includes("travel") || text.includes("hotel") || text.includes("car")) {
    return "Travel";
  }

  if (text.includes("shopping") || text.includes("retail")) {
    return "Shopping";
  }

  if (text.includes("entertainment") || text.includes("movie") || text.includes("event")) {
    return "Entertainment";
  }

  if (text.includes("fitness") || text.includes("gym")) {
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

  return "Lifestyle Benefits";
}

function pickCategoryIcon(value) {
  const text = normalizeString(value).toLowerCase();

  if (text.includes("restaurant") || text.includes("dining") || text.includes("food")) {
    return "🍽️";
  }

  if (text.includes("travel") || text.includes("hotel") || text.includes("car")) {
    return "✈️";
  }

  if (text.includes("shopping") || text.includes("retail")) {
    return "🛍️";
  }

  if (text.includes("entertainment") || text.includes("movie") || text.includes("event")) {
    return "🎟️";
  }

  if (text.includes("fitness") || text.includes("gym")) {
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

function readNestedObject(object, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = object;

    for (const part of parts) {
      current = current?.[part];
    }

    if (isObject(current)) return current;
  }

  return null;
}

function normalizeBenefitDetails(offer, fallbackId = "") {
  const merchantName = normalizeString(
    offer.merchantName ||
      offer.merchant_name ||
      offer.merchant ||
      offer.vendor ||
      offer.store ||
      offer.company ||
      offer.businessName ||
      offer.business_name ||
      offer.name ||
      "Card Leo Benefit"
  );

  const title = normalizeString(
    offer.title ||
      offer.offerTitle ||
      offer.offer_title ||
      offer.headline ||
      offer.name ||
      merchantName
  );

  const categoryRaw = normalizeString(
    offer.category ||
      offer.categoryName ||
      offer.category_name ||
      offer.type ||
      offer.vertical ||
      offer.department ||
      ""
  );

  const categoryName = pickCategoryName(categoryRaw || title || merchantName);
  const category = slugify(categoryRaw || categoryName);

  const id = normalizeString(
    offer.id ||
      offer.offerId ||
      offer.offer_id ||
      offer.dealId ||
      offer.deal_id ||
      offer.benefitId ||
      offer.benefit_id ||
      fallbackId ||
      `${slugify(merchantName || title)}`
  );

  const discount = normalizeString(
    offer.discount ||
      offer.discountText ||
      offer.discount_text ||
      offer.savings ||
      offer.offer ||
      offer.shortDescription ||
      offer.short_description ||
      "Member savings"
  );

  const description = normalizeString(
    offer.description ||
      offer.longDescription ||
      offer.long_description ||
      offer.summary ||
      offer.details ||
      `Save with ${merchantName || title} through Card Leo Rewards.`
  );

  const terms = normalizeString(
    offer.terms ||
      offer.termsAndConditions ||
      offer.terms_and_conditions ||
      offer.restrictions ||
      offer.disclaimer ||
      "Offer terms, availability, participating locations, and restrictions may vary. Review the offer before redeeming."
  );

  const instructions = normalizeString(
    offer.instructions ||
      offer.redemptionInstructions ||
      offer.redemption_instructions ||
      offer.howToRedeem ||
      offer.how_to_redeem ||
      offer.redeemInstructions ||
      offer.redeem_instructions ||
      "Review this offer inside the Card Leo Benefits portal and follow the merchant redemption instructions."
  );

  const imageUrl = normalizeString(
    offer.imageUrl ||
      offer.image_url ||
      offer.logoUrl ||
      offer.logo_url ||
      offer.thumbnail ||
      offer.thumbnailUrl ||
      offer.thumbnail_url ||
      ""
  );

  const detailsUrl = normalizeString(
    offer.detailsUrl ||
      offer.details_url ||
      offer.url ||
      offer.offerUrl ||
      offer.offer_url ||
      ""
  );

  const redeemUrl = normalizeString(
    offer.redeemUrl ||
      offer.redeem_url ||
      offer.redemptionUrl ||
      offer.redemption_url ||
      offer.couponUrl ||
      offer.coupon_url ||
      detailsUrl ||
      ""
  );

  const promoCode = normalizeString(
    offer.promoCode ||
      offer.promo_code ||
      offer.couponCode ||
      offer.coupon_code ||
      offer.code ||
      ""
  );

  const locationType = normalizeString(
    offer.locationType ||
      offer.location_type ||
      offer.channel ||
      offer.offerType ||
      offer.offer_type ||
      (redeemUrl ? "online" : "local")
  );

  const redemptionType = normalizeString(
    offer.redemptionType ||
      offer.redemption_type ||
      offer.redeemType ||
      offer.redeem_type ||
      "View details"
  );

  const address = normalizeString(
    offer.address ||
      offer.streetAddress ||
      offer.street_address ||
      offer.location?.address ||
      ""
  );

  const city = normalizeString(offer.city || offer.location?.city || "");
  const state = normalizeString(offer.state || offer.location?.state || "");
  const zip = normalizeString(
    offer.zip ||
      offer.zipCode ||
      offer.zip_code ||
      offer.postalCode ||
      offer.postal_code ||
      offer.location?.zip ||
      ""
  );

  const phone = normalizeString(
    offer.phone ||
      offer.phoneNumber ||
      offer.phone_number ||
      offer.merchantPhone ||
      offer.merchant_phone ||
      ""
  );

  const website = normalizeString(
    offer.website ||
      offer.websiteUrl ||
      offer.website_url ||
      offer.merchantWebsite ||
      offer.merchant_website ||
      ""
  );

  return {
    id,
    merchantName,
    title,
    category,
    categoryName,
    categoryIcon: pickCategoryIcon(categoryName),
    discount,
    description,
    terms,
    instructions,
    locationType,
    redemptionType,
    imageUrl,
    detailsUrl,
    redeemUrl,
    promoCode,
    address,
    city,
    state,
    zip,
    phone,
    website,
    featured: Boolean(offer.featured),
    raw: offer,
  };
}

function findDefaultBenefitById(id) {
  const requested = normalizeString(id).toLowerCase();

  if (!requested) return null;

  return (
    DEFAULT_BENEFIT_DETAILS.find((benefit) => {
      return (
        normalizeString(benefit.id).toLowerCase() === requested ||
        slugify(benefit.id) === slugify(requested) ||
        slugify(benefit.category) === slugify(requested) ||
        slugify(benefit.categoryName) === slugify(requested)
      );
    }) || null
  );
}

function buildDetailsQueryParams(id, member) {
  const search = new URLSearchParams();

  search.set("accountNumber", ACCESS_ACCOUNT_NUMBER);
  search.set("programId", ACCESS_PROGRAM_ID);
  search.set("account_number", ACCESS_ACCOUNT_NUMBER);
  search.set("program_id", ACCESS_PROGRAM_ID);

  search.set("id", id);
  search.set("offer_id", id);
  search.set("offerId", id);

  if (member?.access_member_id) {
    search.set("accessMemberId", member.access_member_id);
    search.set("access_member_id", member.access_member_id);
    search.set("memberId", member.access_member_id);
    search.set("member_id", member.access_member_id);
  }

  if (member?.email) search.set("email", member.email);

  return search;
}

function buildDetailsPayload(id, member) {
  return {
    accountNumber: ACCESS_ACCOUNT_NUMBER,
    account_number: ACCESS_ACCOUNT_NUMBER,
    programId: ACCESS_PROGRAM_ID,
    program_id: ACCESS_PROGRAM_ID,

    id,
    offerId: id,
    offer_id: id,
    benefitId: id,
    benefit_id: id,
    dealId: id,
    deal_id: id,

    member: {
      id: member?.id || "",
      email: member?.email || "",
      firstName: member?.first_name || "",
      lastName: member?.last_name || "",
      accessMemberId: member?.access_member_id || "",
    },
  };
}

function extractOfferObject(accessResult) {
  return (
    readNestedObject(accessResult, [
      "offer",
      "benefit",
      "deal",
      "item",
      "result",
      "data.offer",
      "data.benefit",
      "data.deal",
      "data.item",
      "data.result",
      "data",
      "response.offer",
      "response.data.offer",
      "response.result",
    ]) || accessResult
  );
}

async function callAccessBenefitDetails(id, member) {
  const fallbackBenefit = findDefaultBenefitById(id);

  if (!ACCESS_API_BASE_URL || !ACCESS_ACCOUNT_NUMBER || !ACCESS_PROGRAM_ID) {
    return {
      ok: false,
      status: 500,
      message:
        "Access API is not fully configured. Showing Card Leo default benefit details.",
      benefit:
        fallbackBenefit ||
        normalizeBenefitDetails(
          {
            id,
            title: "Card Leo Lifestyle Benefit",
            merchantName: "Card Leo Rewards",
            category: "lifestyle-benefits",
          },
          id
        ),
      access_result: null,
    };
  }

  if (!ACCESS_API_TOKEN && (!ACCESS_API_USERNAME || !hasRealAccessPassword())) {
    return {
      ok: false,
      status: 500,
      message:
        "Access API authentication is missing. Showing Card Leo default benefit details.",
      benefit:
        fallbackBenefit ||
        normalizeBenefitDetails(
          {
            id,
            title: "Card Leo Lifestyle Benefit",
            merchantName: "Card Leo Rewards",
            category: "lifestyle-benefits",
          },
          id
        ),
      access_result: null,
    };
  }

  const baseUrl = buildAccessApiUrl(ACCESS_BENEFIT_DETAILS_ENDPOINT);
  const queryParams = buildDetailsQueryParams(id, member);
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
    return {
      ok: false,
      status: 502,
      message:
        error?.message ||
        "Unable to connect to Access Development benefit details API. Showing Card Leo default benefit details.",
      benefit:
        fallbackBenefit ||
        normalizeBenefitDetails(
          {
            id,
            title: "Card Leo Lifestyle Benefit",
            merchantName: "Card Leo Rewards",
            category: "lifestyle-benefits",
          },
          id
        ),
      access_result: null,
      access_url: url,
    };
  }

  if (!response.ok) {
    try {
      const postResponse = await fetch(baseUrl, {
        method: "POST",
        headers: buildAccessHeaders(),
        body: JSON.stringify(buildDetailsPayload(id, member)),
      });

      const postResult = await parseAccessResponse(postResponse);

      if (postResponse.ok) {
        const offerObject = extractOfferObject(postResult);
        const benefit = normalizeBenefitDetails(offerObject, id);

        if (benefit?.id) {
          return {
            ok: true,
            status: postResponse.status,
            message: "Benefit details loaded.",
            benefit,
            access_result: postResult,
            access_url: baseUrl,
          };
        }
      }

      return {
        ok: false,
        status: postResponse.status,
        message:
          postResult?.message ||
          postResult?.error ||
          accessResult?.message ||
          accessResult?.error ||
          `Access benefit details failed with status ${response.status}. Showing Card Leo default benefit details.`,
        benefit:
          fallbackBenefit ||
          normalizeBenefitDetails(
            {
              id,
              title: "Card Leo Lifestyle Benefit",
              merchantName: "Card Leo Rewards",
              category: "lifestyle-benefits",
            },
            id
          ),
        access_result: postResult,
        access_url: baseUrl,
      };
    } catch {
      return {
        ok: false,
        status: response.status,
        message:
          accessResult?.message ||
          accessResult?.error ||
          `Access benefit details failed with status ${response.status}. Showing Card Leo default benefit details.`,
        benefit:
          fallbackBenefit ||
          normalizeBenefitDetails(
            {
              id,
              title: "Card Leo Lifestyle Benefit",
              merchantName: "Card Leo Rewards",
              category: "lifestyle-benefits",
            },
            id
          ),
        access_result: accessResult,
        access_url: url,
      };
    }
  }

  const offerObject = extractOfferObject(accessResult);
  const benefit = normalizeBenefitDetails(offerObject, id);

  if (!benefit?.id) {
    return {
      ok: false,
      status: response.status,
      message:
        "Access benefit details response did not include a usable offer. Showing Card Leo default benefit details.",
      benefit:
        fallbackBenefit ||
        normalizeBenefitDetails(
          {
            id,
            title: "Card Leo Lifestyle Benefit",
            merchantName: "Card Leo Rewards",
            category: "lifestyle-benefits",
          },
          id
        ),
      access_result: accessResult,
      access_url: url,
    };
  }

  return {
    ok: true,
    status: response.status,
    message: "Benefit details loaded.",
    benefit,
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
        message: "Please log in before viewing benefit details.",
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
      console.error("Benefit details member lookup error:", error);

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
          "Your membership must be paid and active before viewing benefit details.",
        redirectTo: "/signup.html?status=payment_required",
      });
    }

    const id = getBenefitIdFromRequest(req);

    if (!id) {
      return sendJson(res, 400, {
        success: false,
        ok: false,
        authenticated: true,
        message:
          "Missing benefit id. Use /api/access/get-benefit-details?id=BENEFIT_ID.",
      });
    }

    const accessResponse = await callAccessBenefitDetails(id, member);

    return sendJson(res, 200, {
      success: true,
      ok: true,
      authenticated: true,
      source: accessResponse.ok ? "access-development" : "card-leo-defaults",
      message: accessResponse.message,
      benefit: accessResponse.benefit,
      debug: getSafeDebugPayload(accessResponse),
    });
  } catch (error) {
    console.error("Card Leo get benefit details error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message ||
        "Something went wrong while loading benefit details.",
    });
  }
}