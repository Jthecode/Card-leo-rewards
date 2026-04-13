// lib/portal.js
import { supabaseAdmin } from "./supabase-admin.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function toNullable(value) {
  const text = normalizeText(value);
  return text || null;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeParseJson(value, fallback = null) {
  if (!value) return fallback;

  if (isObject(value)) return value;

  if (typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getMemberStatusLabel(status) {
  const normalized = normalizeText(status).toLowerCase();

  switch (normalized) {
    case "approved":
      return "Approved";
    case "active":
      return "Active";
    case "pending":
      return "Pending Review";
    case "invited":
      return "Invitation Sent";
    case "declined":
      return "Declined";
    case "suspended":
      return "Suspended";
    default:
      return "Submitted";
  }
}

function canAccessPortal(status) {
  const normalized = normalizeText(status).toLowerCase();
  return ["approved", "active", "invited"].includes(normalized);
}

function mapSignupToPortalMember(signup) {
  if (!signup) return null;

  return {
    id: signup.id,
    firstName: normalizeText(signup.first_name),
    lastName: normalizeText(signup.last_name),
    fullName: [signup.first_name, signup.last_name]
      .map(normalizeText)
      .filter(Boolean)
      .join(" "),
    email: normalizeEmail(signup.email),
    phone: normalizeText(signup.phone),
    city: normalizeText(signup.city),
    state: normalizeText(signup.state),
    referralName: normalizeText(signup.referral_name),
    interest: normalizeText(signup.interest),
    goals: normalizeText(signup.goals),
    agreed: Boolean(signup.agreed),
    status: normalizeText(signup.status) || "submitted",
    statusLabel: getMemberStatusLabel(signup.status),
    source: normalizeText(signup.source),
    signupPage: normalizeText(signup.signup_page),
    portalUserId: toNullable(signup.portal_user_id),
    portalLoginUrl: toNullable(signup.portal_login_url),
    createdAt: signup.created_at || null,
    portalAccess: canAccessPortal(signup.status),
  };
}

function mapPortalOverview(member, extras = {}) {
  if (!member) return null;

  return {
    member,
    rewards: ensureArray(extras.rewards),
    announcements: ensureArray(extras.announcements),
    actions: ensureArray(extras.actions),
    support: {
      email: "support@cardleorewards.com",
      phone: "",
      hours: "Mon–Fri, 9:00 AM – 5:00 PM",
      ...(isObject(extras.support) ? extras.support : {}),
    },
  };
}

async function readSingleSignupByQuery(queryBuilder) {
  const { data, error } = await queryBuilder.limit(1).maybeSingle();

  if (error) {
    throw new Error(error.message || "Unable to fetch portal member.");
  }

  return data || null;
}

export async function getPortalSignupById(id) {
  const signupId = normalizeText(id);
  if (!signupId) return null;

  return readSingleSignupByQuery(
    supabaseAdmin.from("signups").select("*").eq("id", signupId)
  );
}

export async function getPortalSignupByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return readSingleSignupByQuery(
    supabaseAdmin.from("signups").select("*").eq("email", normalizedEmail)
  );
}

export async function getPortalSignupByPortalUserId(portalUserId) {
  const normalizedPortalUserId = normalizeText(portalUserId);
  if (!normalizedPortalUserId) return null;

  return readSingleSignupByQuery(
    supabaseAdmin
      .from("signups")
      .select("*")
      .eq("portal_user_id", normalizedPortalUserId)
  );
}

export async function getPortalMember({ id, email, portalUserId } = {}) {
  let signup = null;

  if (portalUserId) {
    signup = await getPortalSignupByPortalUserId(portalUserId);
  }

  if (!signup && email) {
    signup = await getPortalSignupByEmail(email);
  }

  if (!signup && id) {
    signup = await getPortalSignupById(id);
  }

  return mapSignupToPortalMember(signup);
}

export async function linkPortalUserToSignup({
  signupId,
  email,
  portalUserId,
  portalLoginUrl,
  status,
} = {}) {
  const normalizedSignupId = normalizeText(signupId);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPortalUserId = normalizeText(portalUserId);

  if (!normalizedSignupId && !normalizedEmail) {
    throw new Error("A signupId or email is required to link a portal user.");
  }

  if (!normalizedPortalUserId) {
    throw new Error("portalUserId is required.");
  }

  const updates = {
    portal_user_id: normalizedPortalUserId,
    portal_login_url: toNullable(portalLoginUrl),
  };

  if (normalizeText(status)) {
    updates.status = normalizeText(status).toLowerCase();
  }

  let query = supabaseAdmin.from("signups").update(updates).select("*").limit(1);

  if (normalizedSignupId) {
    query = query.eq("id", normalizedSignupId);
  } else {
    query = query.eq("email", normalizedEmail);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message || "Unable to link portal user.");
  }

  return mapSignupToPortalMember(data);
}

export async function updatePortalLoginUrl({
  portalUserId,
  portalLoginUrl,
} = {}) {
  const normalizedPortalUserId = normalizeText(portalUserId);

  if (!normalizedPortalUserId) {
    throw new Error("portalUserId is required.");
  }

  const { data, error } = await supabaseAdmin
    .from("signups")
    .update({
      portal_login_url: toNullable(portalLoginUrl),
    })
    .eq("portal_user_id", normalizedPortalUserId)
    .select("*")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Unable to update portal login URL.");
  }

  return mapSignupToPortalMember(data);
}

export async function updatePortalMemberStatus({
  signupId,
  email,
  status,
} = {}) {
  const normalizedSignupId = normalizeText(signupId);
  const normalizedEmail = normalizeEmail(email);
  const normalizedStatus = normalizeText(status).toLowerCase();

  if (!normalizedSignupId && !normalizedEmail) {
    throw new Error("A signupId or email is required.");
  }

  if (!normalizedStatus) {
    throw new Error("status is required.");
  }

  let query = supabaseAdmin
    .from("signups")
    .update({ status: normalizedStatus })
    .select("*")
    .limit(1);

  if (normalizedSignupId) {
    query = query.eq("id", normalizedSignupId);
  } else {
    query = query.eq("email", normalizedEmail);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message || "Unable to update member status.");
  }

  return mapSignupToPortalMember(data);
}

export function buildPortalActions(member) {
  if (!member) return [];

  const actions = [
    {
      key: "view-profile",
      label: "Review profile",
      href: "/portal/profile",
      enabled: true,
    },
    {
      key: "contact-support",
      label: "Contact support",
      href: "/contact.html",
      enabled: true,
    },
  ];

  if (member.portalLoginUrl) {
    actions.unshift({
      key: "launch-portal",
      label: "Open member access",
      href: member.portalLoginUrl,
      enabled: true,
    });
  }

  if (!member.portalAccess) {
    actions.unshift({
      key: "application-status",
      label: `Application status: ${member.statusLabel}`,
      href: "/thank-you.html",
      enabled: true,
    });
  }

  return actions;
}

export function buildPortalAnnouncements(member) {
  if (!member) return [];

  const announcements = [
    {
      id: "welcome",
      title: "Welcome to Card Leo Rewards",
      body: "Your account is now connected to our premium member experience.",
    },
  ];

  if (!member.portalAccess) {
    announcements.push({
      id: "review",
      title: "Application under review",
      body: "Your submission has been received and is being reviewed by our team.",
    });
  }

  if (member.portalAccess) {
    announcements.push({
      id: "access",
      title: "Member access available",
      body: "Your portal access is enabled. You can continue into the member area anytime.",
    });
  }

  return announcements;
}

export function buildPortalRewards(member) {
  if (!member) return [];

  return [
    {
      id: "concierge",
      title: "Member Concierge",
      description: "Priority support and white-glove member assistance.",
      active: member.portalAccess,
    },
    {
      id: "offers",
      title: "Exclusive Offers",
      description: "Access premium promotions and member-only opportunities.",
      active: member.portalAccess,
    },
    {
      id: "status",
      title: "Application Tracking",
      description: "Monitor your current member application and approval status.",
      active: true,
    },
  ];
}

export async function getPortalOverview({ id, email, portalUserId } = {}) {
  const member = await getPortalMember({ id, email, portalUserId });

  if (!member) {
    return null;
  }

  return mapPortalOverview(member, {
    rewards: buildPortalRewards(member),
    announcements: buildPortalAnnouncements(member),
    actions: buildPortalActions(member),
  });
}

export async function requirePortalAccess({ id, email, portalUserId } = {}) {
  const member = await getPortalMember({ id, email, portalUserId });

  if (!member) {
    const error = new Error("Member record not found.");
    error.statusCode = 404;
    throw error;
  }

  if (!member.portalAccess) {
    const error = new Error("Portal access is not available for this account yet.");
    error.statusCode = 403;
    error.member = member;
    throw error;
  }

  return member;
}

export function createPortalResponsePayload(memberOrOverview) {
  if (!memberOrOverview) {
    return {
      success: false,
      member: null,
      overview: null,
    };
  }

  const hasMemberObject =
    isObject(memberOrOverview) && isObject(memberOrOverview.member);

  if (hasMemberObject) {
    return {
      success: true,
      member: memberOrOverview.member,
      overview: memberOrOverview,
    };
  }

  return {
    success: true,
    member: memberOrOverview,
    overview: mapPortalOverview(memberOrOverview, {
      rewards: buildPortalRewards(memberOrOverview),
      announcements: buildPortalAnnouncements(memberOrOverview),
      actions: buildPortalActions(memberOrOverview),
    }),
  };
}

export function parsePortalMetadata(value) {
  return safeParseJson(value, {});
}