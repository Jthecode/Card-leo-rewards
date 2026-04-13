// api/admin/signups.js

import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  ok,
  unauthorized,
  forbidden,
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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = [
  "all",
  "new",
  "reviewing",
  "approved",
  "rejected",
  "invited",
  "active",
];
const VALID_SORTS = ["newest", "oldest", "name", "status"];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), max);
}

function normalizeStatus(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizeSort(value) {
  const normalized = String(value || "newest").trim().toLowerCase();
  return VALID_SORTS.includes(normalized) ? normalized : "newest";
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getFullName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || null;
}

function normalizeSearch(value) {
  return String(value || "").trim();
}

function buildRange(page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const from = (safePage - 1) * limit;
  const to = from + limit - 1;
  return { page: safePage, from, to };
}

function getSortConfig(sort) {
  switch (sort) {
    case "oldest":
      return { column: "created_at", ascending: true };
    case "name":
      return { column: "first_name", ascending: true };
    case "status":
      return { column: "status", ascending: true };
    case "newest":
    default:
      return { column: "created_at", ascending: false };
  }
}

function mapSignupRow(row, noteCount = 0) {
  const fullName = getFullName(row.first_name, row.last_name);

  return {
    id: row.id,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName,
    email: row.email || null,
    phone: row.phone || null,
    city: row.city || null,
    state: row.state || null,
    referralName: row.referral_name || null,
    interest: row.interest || null,
    goals: row.goals || null,
    agreed: Boolean(row.agreed),
    status: row.status || "new",
    statusLabel: titleCase(row.status || "new"),
    source: row.source || "website",
    sourceLabel: titleCase(row.source || "website"),
    signupPage: row.signup_page || null,
    portalUserId: row.portal_user_id || null,
    portalLoginUrl: row.portal_login_url || null,
    notes: row.notes || null,
    noteCount: Number(noteCount || 0),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
    hasPortalUser: Boolean(row.portal_user_id),
    isActionable: ["new", "reviewing"].includes(String(row.status || "").toLowerCase()),
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

function applySearch(query, search) {
  if (!search) return query;

  const escaped = search.replaceAll(",", " ").replaceAll("%", "");
  return query.or(
    [
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`,
      `phone.ilike.%${escaped}%`,
      `city.ilike.%${escaped}%`,
      `state.ilike.%${escaped}%`,
      `referral_name.ilike.%${escaped}%`,
      `interest.ilike.%${escaped}%`,
      `status.ilike.%${escaped}%`,
    ].join(",")
  );
}

async function getStatusCounts(search = "") {
  const statuses = ["new", "reviewing", "approved", "rejected", "invited", "active"];
  const entries = await Promise.all(
    statuses.map(async (status) => {
      let query = supabaseAdmin
        .from("signups")
        .select("id", { count: "exact", head: true })
        .eq("status", status);

      query = applySearch(query, search);

      const { count, error } = await query;
      return {
        status,
        count: error ? 0 : Number(count || 0),
      };
    })
  );

  return entries.reduce((acc, entry) => {
    acc[entry.status] = entry.count;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_signups" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const rate = adminRateLimit(req, res);

    if (!rate.allowed) {
      return serverError(
        res,
        "Too many admin requests. Please try again later.",
        { retryAfter: rate.retryAfter, statusCode: 429, error: "rate_limited" }
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
      return forbidden(res, "You do not have permission to manage signups.");
    }

    const status = normalizeStatus(req.query?.status);
    const sort = normalizeSort(req.query?.sort);
    const search = normalizeSearch(req.query?.search);
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const { page, from, to } = buildRange(req.query?.page, limit);
    const sortConfig = getSortConfig(sort);

    let query = supabaseAdmin
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
        ].join(", "),
        { count: "exact" }
      );

    if (status !== "all") {
      query = query.eq("status", status);
    }

    query = applySearch(query, search);
    query = query.order(sortConfig.column, { ascending: sortConfig.ascending });
    query = query.range(from, to);

    const [signupsResult, statusCounts] = await Promise.all([
      query,
      getStatusCounts(search),
    ]);

    if (signupsResult.error) {
      return serverError(res, "Unable to load signups.", {
        error: signupsResult.error.message,
      });
    }

    const rows = signupsResult.data || [];
    const signupIds = rows.map((row) => row.id);
    let noteCountMap = {};

    if (signupIds.length > 0) {
      const notesResult = await supabaseAdmin
        .from("admin_notes")
        .select("entity_id")
        .eq("entity_type", "signup")
        .in("entity_id", signupIds);

      if (notesResult.error) {
        return serverError(res, "Unable to load signup notes.", {
          error: notesResult.error.message,
        });
      }

      noteCountMap = (notesResult.data || []).reduce((acc, note) => {
        const key = note.entity_id;
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {});
    }

    const signups = rows.map((row) => mapSignupRow(row, noteCountMap[row.id] || 0));
    const total = Number(signupsResult.count || 0);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

    const summary = {
      total,
      actionable:
        Number(statusCounts.new || 0) + Number(statusCounts.reviewing || 0),
      active: Number(statusCounts.active || 0),
      invited: Number(statusCounts.invited || 0),
      approved: Number(statusCounts.approved || 0),
      rejected: Number(statusCounts.rejected || 0),
      statusCounts: {
        new: Number(statusCounts.new || 0),
        reviewing: Number(statusCounts.reviewing || 0),
        approved: Number(statusCounts.approved || 0),
        rejected: Number(statusCounts.rejected || 0),
        invited: Number(statusCounts.invited || 0),
        active: Number(statusCounts.active || 0),
      },
    };

    logRequestSuccess(req, {
      scope: "admin_signups",
      adminId: adminContext.profile.id,
      page,
      limit,
      returned: signups.length,
    });

    return ok(
      res,
      {
        admin: {
          id: adminContext.profile.id,
          email: adminContext.profile.email,
          fullName:
            adminContext.profile.full_name ||
            getFullName(
              adminContext.profile.first_name,
              adminContext.profile.last_name
            ) ||
            null,
          isSuperAdmin: Boolean(adminContext.adminRole.is_super_admin),
          canManageMembers: Boolean(adminContext.adminRole.can_manage_members),
        },
        filters: {
          statuses: VALID_STATUSES,
          activeStatus: status,
          sorts: VALID_SORTS,
          activeSort: sort,
          search,
          limit,
          page,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
          from: total === 0 ? 0 : from + 1,
          to: Math.min(to + 1, total),
        },
        summary,
        signups,
      },
      "Admin signups loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_signups_unexpected" });

    return serverError(
      res,
      "Failed to load admin signups.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}