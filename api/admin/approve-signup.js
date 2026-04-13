// api/admin/approve-signup.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  methodNotAllowed,
  serverError,
  setNoStore,
} from "../../lib/responses.js";
import { adminRateLimit } from "../../lib/rate-limit.js";
import { getAccessTokenFromRequest } from "../../lib/cookies.js";
import {
  logRequestStart,
  logRequestSuccess,
  logRequestError,
} from "../../lib/logger.js";

const DEFAULT_REDIRECT_PATH = "/reset-password.html";
const ALLOWED_CURRENT_STATUSES = ["new", "reviewing", "approved", "invited"];
const NEXT_STATUS_VALUES = ["approved", "invited", "active"];

function getRequestBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getFullName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || null;
}

function parseOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host || "";
  const proto = forwardedProto || (host.includes("localhost") ? "http" : "https");

  if (!host) return "https://www.cardleorewards.com";
  return `${proto}://${host}`;
}

function buildRedirectTo(req, customRedirectTo = "") {
  const origin = parseOrigin(req);
  const custom = normalizeText(customRedirectTo);

  if (custom) {
    try {
      return new URL(custom, origin).toString();
    } catch {
      return `${origin}${DEFAULT_REDIRECT_PATH}`;
    }
  }

  return `${origin}${DEFAULT_REDIRECT_PATH}`;
}

function normalizeNextStatus(value, fallback = "approved") {
  const normalized = normalizeText(value).toLowerCase();
  return NEXT_STATUS_VALUES.includes(normalized) ? normalized : fallback;
}

function mapSignupRow(row) {
  return {
    id: row.id,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName: getFullName(row.first_name, row.last_name),
    email: row.email || null,
    phone: row.phone || null,
    city: row.city || null,
    state: row.state || null,
    referralName: row.referral_name || null,
    interest: row.interest || null,
    goals: row.goals || null,
    agreed: Boolean(row.agreed),
    status: row.status || "new",
    source: row.source || "website",
    signupPage: row.signup_page || null,
    portalUserId: row.portal_user_id || null,
    portalLoginUrl: row.portal_login_url || null,
    notes: row.notes || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

async function getAuthenticatedUser(req) {
  const accessToken = getAccessTokenFromRequest(req);

  if (!accessToken) {
    return { user: null, error: "Missing access token." };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !data?.user) {
    return {
      user: null,
      error: error?.message || "Unable to authenticate this request.",
    };
  }

  return { user: data.user, error: null };
}

async function getAdminContext(profileId) {
  const [profileResult, adminRoleResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, email, first_name, last_name, full_name, role, member_status")
      .eq("id", profileId)
      .maybeSingle(),

    supabaseAdmin
      .from("admin_roles")
      .select(
        "profile_id, is_super_admin, can_manage_members, can_manage_rewards, can_manage_support, can_manage_referrals, can_view_audit_logs, can_manage_settings"
      )
      .eq("profile_id", profileId)
      .maybeSingle(),
  ]);

  return {
    profile: profileResult.data || null,
    profileError: profileResult.error || null,
    adminRole: adminRoleResult.data || null,
    adminRoleError: adminRoleResult.error || null,
  };
}

async function appendSignupNotes(signupId, existingNotes, incomingNote) {
  const cleanIncoming = normalizeText(incomingNote);
  if (!cleanIncoming) {
    return { nextNotes: existingNotes || "", changed: false };
  }

  const base = normalizeText(existingNotes);
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${cleanIncoming}`;
  const nextNotes = base ? `${base}\n\n${entry}` : entry;

  const updateResult = await supabaseAdmin
    .from("signups")
    .update({ notes: nextNotes })
    .eq("id", signupId)
    .select("notes")
    .maybeSingle();

  if (updateResult.error) {
    throw new Error(`Unable to update signup notes: ${updateResult.error.message}`);
  }

  return {
    nextNotes: updateResult.data?.notes || nextNotes,
    changed: true,
  };
}

async function findAuthUserByEmail(email) {
  const pageSize = 200;
  let page = 1;

  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: pageSize,
    });

    if (error) {
      throw new Error(`Unable to inspect existing auth users: ${error.message}`);
    }

    const users = data?.users || [];
    const match = users.find(
      (user) => normalizeEmail(user.email) === normalizeEmail(email)
    );

    if (match) return match;
    if (users.length < pageSize) break;

    page += 1;
  }

  return null;
}

function parseOriginFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "https://www.cardleorewards.com";
  }
}

async function ensureProfileForSignup({ signup, authUserId, redirectTo }) {
  const email = normalizeEmail(signup.email);
  const portalLoginUrl = `${parseOriginFromUrl(redirectTo)}/login.html`;

  const existingProfileResult = await supabaseAdmin
    .from("profiles")
    .select(
      "id, signup_id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, portal_login_url, created_at, updated_at"
    )
    .eq("id", authUserId)
    .maybeSingle();

  if (existingProfileResult.error) {
    throw new Error(`Unable to inspect profile: ${existingProfileResult.error.message}`);
  }

  const profilePayload = {
    id: authUserId,
    signup_id: signup.id,
    email,
    first_name: signup.firstName || "Member",
    last_name: signup.lastName || "User",
    phone: signup.phone || null,
    city: signup.city || null,
    state: signup.state || null,
    member_status: "active",
    role: "member",
    portal_login_url: portalLoginUrl,
  };

  const upsertResult = await supabaseAdmin
    .from("profiles")
    .upsert(profilePayload, { onConflict: "id" })
    .select(
      "id, signup_id, email, first_name, last_name, full_name, member_status, role, tier, referral_code, portal_login_url, created_at, updated_at"
    )
    .maybeSingle();

  if (upsertResult.error) {
    throw new Error(`Unable to create or update member profile: ${upsertResult.error.message}`);
  }

  const profile = upsertResult.data || existingProfileResult.data;

  const onboardingUpsert = await supabaseAdmin
    .from("member_onboarding")
    .upsert(
      {
        profile_id: authUserId,
        accepted_terms: Boolean(signup.agreed),
        accepted_privacy: Boolean(signup.agreed),
        onboarding_status: "in_progress",
        onboarding_percent: Boolean(signup.agreed) ? 20 : 10,
      },
      { onConflict: "profile_id" }
    );

  if (onboardingUpsert.error) {
    throw new Error(`Unable to initialize onboarding: ${onboardingUpsert.error.message}`);
  }

  const settingsUpsert = await supabaseAdmin
    .from("member_settings")
    .upsert(
      {
        profile_id: authUserId,
        preferred_contact_method: signup.phone ? "phone" : "email",
      },
      { onConflict: "profile_id" }
    );

  if (settingsUpsert.error) {
    throw new Error(`Unable to initialize member settings: ${settingsUpsert.error.message}`);
  }

  return profile;
}

async function awardWelcomeBonus(profileId) {
  const ruleResult = await supabaseAdmin
    .from("reward_rules")
    .select("id, rule_code, title, points_amount, is_active")
    .eq("rule_code", "WELCOME_BONUS")
    .maybeSingle();

  if (ruleResult.error) {
    throw new Error(`Unable to load welcome bonus rule: ${ruleResult.error.message}`);
  }

  const rule = ruleResult.data;
  if (!rule || !rule.is_active || Number(rule.points_amount || 0) <= 0) {
    return { awarded: false, rule: null, transaction: null };
  }

  const existingTransactionResult = await supabaseAdmin
    .from("reward_transactions")
    .select("id, profile_id, reward_rule_id, transaction_type, title, points, created_at")
    .eq("profile_id", profileId)
    .eq("reward_rule_id", rule.id)
    .eq("transaction_type", "earn")
    .eq("reference_type", "signup")
    .limit(1)
    .maybeSingle();

  if (existingTransactionResult.error) {
    throw new Error(
      `Unable to inspect existing welcome bonus transaction: ${existingTransactionResult.error.message}`
    );
  }

  if (existingTransactionResult.data) {
    return {
      awarded: false,
      rule,
      transaction: existingTransactionResult.data,
    };
  }

  const insertResult = await supabaseAdmin
    .from("reward_transactions")
    .insert({
      profile_id: profileId,
      reward_rule_id: rule.id,
      transaction_type: "earn",
      transaction_status: "posted",
      points: Number(rule.points_amount || 0),
      title: rule.title || "Welcome Bonus",
      description: "Welcome bonus awarded after signup approval and member activation.",
      reference_type: "signup",
      metadata: {
        automatic: true,
        trigger: "admin_approve_signup",
        rule_code: rule.rule_code,
      },
    })
    .select(
      "id, profile_id, reward_rule_id, transaction_type, transaction_status, points, title, description, created_at, posted_at"
    )
    .maybeSingle();

  if (insertResult.error) {
    throw new Error(`Unable to award welcome bonus: ${insertResult.error.message}`);
  }

  return {
    awarded: true,
    rule,
    transaction: insertResult.data || null,
  };
}

async function createMemberActivity(profileId, title, description, metadata = {}) {
  const insertResult = await supabaseAdmin.from("member_activity").insert({
    profile_id: profileId,
    activity_type: "account_created",
    title,
    description,
    metadata,
  });

  if (insertResult.error) {
    throw new Error(`Unable to create member activity: ${insertResult.error.message}`);
  }
}

async function createAdminNote({
  actorProfileId,
  targetProfileId,
  signupId,
  title,
  note,
}) {
  const cleanNote = normalizeText(note);
  if (!cleanNote) return;

  const result = await supabaseAdmin.from("admin_notes").insert({
    author_profile_id: actorProfileId,
    target_profile_id: targetProfileId || null,
    entity_type: "signup",
    entity_id: signupId,
    title: normalizeText(title) || "Signup Approval",
    note: cleanNote,
    is_internal: true,
  });

  if (result.error) {
    throw new Error(`Unable to create admin note: ${result.error.message}`);
  }
}

async function createAuditLog({
  actorProfileId,
  targetProfileId,
  signupId,
  action,
  title,
  description,
  metadata,
  req,
}) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ipAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : String(forwardedFor || "").split(",")[0].trim() || null;

  const result = await supabaseAdmin.from("admin_audit_logs").insert({
    actor_profile_id: actorProfileId,
    target_profile_id: targetProfileId || null,
    entity_type: "signup",
    entity_id: signupId,
    action,
    title,
    description: description || null,
    metadata: metadata || {},
    ip_address: ipAddress || null,
    user_agent: req.headers["user-agent"] || null,
  });

  if (result.error) {
    throw new Error(`Unable to create admin audit log: ${result.error.message}`);
  }
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_approve_signup" });

  if (req.method !== "POST") {
    return methodNotAllowed(res, ["POST"], "Method not allowed. Use POST.");
  }

  try {
    const rate = adminRateLimit(req, res);

    if (!rate.allowed) {
      return badRequest(
        res,
        "Too many admin approval requests. Please try again later.",
        { retryAfter: rate.retryAfter },
        { statusCode: 429, error: "rate_limited" }
      );
    }

    const { user, error: authError } = await getAuthenticatedUser(req);

    if (!user) {
      return unauthorized(res, authError || "Unauthorized.");
    }

    const adminContext = await getAdminContext(user.id);

    if (adminContext.profileError) {
      return serverError(res, "Unable to load admin profile.", {
        error: adminContext.profileError.message,
      });
    }

    if (adminContext.adminRoleError) {
      return serverError(res, "Unable to load admin permissions.", {
        error: adminContext.adminRoleError.message,
      });
    }

    if (!adminContext.profile || !adminContext.adminRole) {
      return forbidden(res, "Admin access is required.");
    }

    if (!adminContext.adminRole.can_manage_members && !adminContext.adminRole.is_super_admin) {
      return forbidden(res, "You do not have permission to approve signups.");
    }

    const body = getRequestBody(req);
    const signupId = normalizeText(body.signupId);
    const adminNote = normalizeText(body.note || body.adminNote);
    const approvalNote = normalizeText(body.approvalNote);
    const sendInvite = normalizeBoolean(body.sendInvite, true);
    const awardRewards = normalizeBoolean(body.awardWelcomeBonus, true);
    const nextStatus = normalizeNextStatus(
      body.status,
      sendInvite ? "invited" : "approved"
    );
    const redirectTo = buildRedirectTo(req, body.redirectTo);

    if (!signupId) {
      return badRequest(res, "signupId is required.");
    }

    const signupResult = await supabaseAdmin
      .from("signups")
      .select(
        [
          "id",
          "first_name",
          "last_name",
          "email",
          "phone",
          "city",
          "state",
          "referral_name",
          "interest",
          "goals",
          "agreed",
          "status",
          "source",
          "signup_page",
          "portal_user_id",
          "portal_login_url",
          "notes",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq("id", signupId)
      .maybeSingle();

    if (signupResult.error) {
      return serverError(res, "Unable to load signup.", {
        error: signupResult.error.message,
      });
    }

    if (!signupResult.data) {
      return notFound(res, "Signup not found.");
    }

    const signup = mapSignupRow(signupResult.data);
    const email = normalizeEmail(signup.email);

    if (!isValidEmail(email)) {
      return badRequest(res, "This signup does not have a valid email address.");
    }

    if (!ALLOWED_CURRENT_STATUSES.includes(String(signup.status || "").toLowerCase())) {
      return badRequest(
        res,
        `This signup cannot be approved from status "${signup.status}".`
      );
    }

    if (String(signup.status || "").toLowerCase() === "active" && signup.portalUserId) {
      return conflict(res, "This signup is already an active member.");
    }

    let authUserId = signup.portalUserId || null;
    let inviteSent = false;
    let existingAuthUser = null;

    if (!authUserId) {
      existingAuthUser = await findAuthUserByEmail(email);
      authUserId = existingAuthUser?.id || null;
    }

    if (sendInvite) {
      if (authUserId) {
        try {
          const inviteResult = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
            redirectTo,
            data: {
              first_name: signup.firstName || "",
              last_name: signup.lastName || "",
              source: "cardleo_rewards_signup_approval",
              signup_id: signup.id,
            },
          });

          if (inviteResult.error) {
            const message = String(inviteResult.error.message || "");
            const alreadyRegistered =
              message.toLowerCase().includes("already been registered") ||
              message.toLowerCase().includes("user already registered");

            if (!alreadyRegistered) {
              throw new Error(inviteResult.error.message);
            }
          } else {
            authUserId = inviteResult.data?.user?.id || authUserId;
            inviteSent = true;
          }
        } catch (error) {
          return serverError(res, "Unable to send member invite.", {
            error: error?.message || "Invite failed.",
          });
        }
      } else {
        const inviteResult = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
          redirectTo,
          data: {
            first_name: signup.firstName || "",
            last_name: signup.lastName || "",
            source: "cardleo_rewards_signup_approval",
            signup_id: signup.id,
          },
        });

        if (inviteResult.error) {
          return serverError(res, "Unable to send member invite.", {
            error: inviteResult.error.message,
          });
        }

        authUserId = inviteResult.data?.user?.id || null;
        inviteSent = Boolean(authUserId);
      }
    }

    if (!authUserId) {
      return conflict(
        res,
        "No auth user could be linked to this signup yet. Enable sendInvite or create the member account first."
      );
    }

    const profile = await ensureProfileForSignup({
      signup,
      authUserId,
      redirectTo,
    });

    const portalOrigin = parseOriginFromUrl(redirectTo);
    const portalLoginUrl = `${portalOrigin}/login.html`;

    const signupUpdatePayload = {
      status: nextStatus === "active" ? "active" : nextStatus,
      portal_user_id: authUserId,
      portal_login_url: portalLoginUrl,
    };

    const updatedSignupResult = await supabaseAdmin
      .from("signups")
      .update(signupUpdatePayload)
      .eq("id", signup.id)
      .select(
        [
          "id",
          "first_name",
          "last_name",
          "email",
          "phone",
          "city",
          "state",
          "referral_name",
          "interest",
          "goals",
          "agreed",
          "status",
          "source",
          "signup_page",
          "portal_user_id",
          "portal_login_url",
          "notes",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .maybeSingle();

    if (updatedSignupResult.error) {
      return serverError(res, "Unable to update signup approval state.", {
        error: updatedSignupResult.error.message,
      });
    }

    let finalSignup = mapSignupRow(updatedSignupResult.data || signupResult.data);

    if (approvalNote) {
      const noteUpdate = await appendSignupNotes(
        signup.id,
        finalSignup.notes || "",
        approvalNote
      );
      finalSignup = {
        ...finalSignup,
        notes: noteUpdate.nextNotes,
      };
    }

    const welcomeBonus = awardRewards
      ? await awardWelcomeBonus(profile.id)
      : { awarded: false, rule: null, transaction: null };

    await createMemberActivity(
      profile.id,
      "Account Approved",
      inviteSent
        ? "Your Card Leo Rewards membership was approved and an invite was sent."
        : "Your Card Leo Rewards membership was approved.",
      {
        signupId: signup.id,
        inviteSent,
        approvedBy: adminContext.profile.id,
        welcomeBonusAwarded: Boolean(welcomeBonus.awarded),
      }
    );

    if (adminNote) {
      await createAdminNote({
        actorProfileId: adminContext.profile.id,
        targetProfileId: profile.id,
        signupId: signup.id,
        title: "Signup Approved",
        note: adminNote,
      });
    }

    await createAuditLog({
      actorProfileId: adminContext.profile.id,
      targetProfileId: profile.id,
      signupId: signup.id,
      action: inviteSent ? "approve_and_invite_signup" : "approve_signup",
      title: inviteSent ? "Approved signup and sent invite" : "Approved signup",
      description: inviteSent
        ? "A signup was approved, linked to a member profile, and an invite was sent."
        : "A signup was approved and linked to a member profile.",
      metadata: {
        signupId: signup.id,
        authUserId,
        inviteSent,
        nextStatus: finalSignup.status,
        redirectTo,
        welcomeBonusAwarded: Boolean(welcomeBonus.awarded),
      },
      req,
    });

    logRequestSuccess(req, {
      scope: "admin_approve_signup",
      adminId: adminContext.profile.id,
      signupId: signup.id,
      authUserId,
      inviteSent,
      finalStatus: finalSignup.status,
    });

    return ok(
      res,
      {
        admin: {
          id: adminContext.profile.id,
          email: adminContext.profile.email,
          fullName:
            adminContext.profile.full_name ||
            getFullName(adminContext.profile.first_name, adminContext.profile.last_name),
          isSuperAdmin: Boolean(adminContext.adminRole.is_super_admin),
          canManageMembers: Boolean(adminContext.adminRole.can_manage_members),
        },
        signup: finalSignup,
        profile: {
          id: profile.id,
          signupId: profile.signup_id || signup.id,
          email: profile.email || email,
          firstName: profile.first_name || signup.firstName,
          lastName: profile.last_name || signup.lastName,
          fullName:
            profile.full_name ||
            getFullName(profile.first_name, profile.last_name) ||
            signup.fullName,
          memberStatus: profile.member_status || "active",
          role: profile.role || "member",
          tier: profile.tier || "core",
          referralCode: profile.referral_code || null,
          portalLoginUrl: profile.portal_login_url || portalLoginUrl,
          createdAt: safeDate(profile.created_at),
          updatedAt: safeDate(profile.updated_at),
        },
        invite: {
          sent: inviteSent,
          redirectTo,
          portalLoginUrl,
        },
        rewards: {
          welcomeBonusAwarded: Boolean(welcomeBonus.awarded),
          transaction: welcomeBonus.transaction
            ? {
                id: welcomeBonus.transaction.id,
                type: welcomeBonus.transaction.transaction_type || "earn",
                status: welcomeBonus.transaction.transaction_status || "posted",
                title: welcomeBonus.transaction.title || "Welcome Bonus",
                points: Number(welcomeBonus.transaction.points || 0),
                createdAt: safeDate(
                  welcomeBonus.transaction.posted_at || welcomeBonus.transaction.created_at
                ),
              }
            : null,
        },
      },
      inviteSent
        ? "Signup approved and invite sent successfully."
        : "Signup approved successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_approve_signup_unexpected" });

    return serverError(
      res,
      "Failed to approve signup.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}