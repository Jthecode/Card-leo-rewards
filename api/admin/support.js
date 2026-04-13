// api/admin/support.js

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
  "open",
  "in_progress",
  "waiting_on_member",
  "resolved",
  "closed",
];

const VALID_PRIORITIES = [
  "all",
  "low",
  "normal",
  "high",
  "urgent",
];

const VALID_CATEGORIES = [
  "all",
  "general",
  "account",
  "rewards",
  "billing",
  "technical",
  "verification",
  "referral",
  "other",
];

const VALID_ASSIGNED = [
  "all",
  "assigned",
  "unassigned",
  "mine",
];

const VALID_SORTS = [
  "newest",
  "oldest",
  "updated",
  "priority",
  "status",
];

function toPositiveInteger(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), max);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_STATUSES.includes(normalized) ? normalized : "all";
}

function normalizePriority(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_PRIORITIES.includes(normalized) ? normalized : "all";
}

function normalizeCategory(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_CATEGORIES.includes(normalized) ? normalized : "all";
}

function normalizeAssigned(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_ASSIGNED.includes(normalized) ? normalized : "all";
}

function normalizeSort(value) {
  const normalized = normalizeString(value).toLowerCase();
  return VALID_SORTS.includes(normalized) ? normalized : "updated";
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

function buildRange(page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const from = (safePage - 1) * limit;
  const to = from + limit - 1;
  return { page: safePage, from, to };
}

function getSortConfig(sort) {
  switch (sort) {
    case "newest":
      return { column: "created_at", ascending: false };
    case "oldest":
      return { column: "created_at", ascending: true };
    case "priority":
      return { column: "priority", ascending: false };
    case "status":
      return { column: "status", ascending: true };
    case "updated":
    default:
      return { column: "last_message_at", ascending: false };
  }
}

function mapProfileSummary(row) {
  if (!row) return null;

  return {
    id: row.id,
    email: row.email || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    fullName:
      row.full_name || getFullName(row.first_name, row.last_name) || null,
    memberStatus: row.member_status || null,
    role: row.role || null,
    tier: row.tier || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapContactSummary(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name || null,
    email: row.email || null,
    phone: row.phone || null,
    topic: row.topic || null,
    status: row.status || null,
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapSupportMessagePreview(row) {
  if (!row) return null;

  return {
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type || null,
    senderName: row.sender_name || null,
    senderEmail: row.sender_email || null,
    body: row.body || null,
    isInternal: Boolean(row.is_internal),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  };
}

function mapTicketRow(
  row,
  {
    memberProfile,
    assignedProfile,
    contactMessage,
    latestMessage,
    messageCount,
    internalNoteCount,
  }
) {
  return {
    id: row.id,
    ticketNumber: row.ticket_number || null,
    subject: row.subject || null,

    category: row.category || "general",
    categoryLabel: titleCase(row.category || "general"),

    priority: row.priority || "normal",
    priorityLabel: titleCase(row.priority || "normal"),

    status: row.status || "open",
    statusLabel: titleCase(row.status || "open"),

    source: row.source || "portal",
    sourceLabel: titleCase(row.source || "portal"),

    profileId: row.profile_id || null,
    contactMessageId: row.contact_message_id || null,
    assignedToProfileId: row.assigned_to_profile_id || null,

    firstResponseAt: safeDate(row.first_response_at),
    resolvedAt: safeDate(row.resolved_at),
    closedAt: safeDate(row.closed_at),
    lastMessageAt: safeDate(row.last_message_at),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),

    metadata: row.metadata || {},

    flags: {
      isAssigned: Boolean(row.assigned_to_profile_id),
      isResolved: row.status === "resolved",
      isClosed: row.status === "closed",
      hasMember: Boolean(row.profile_id),
      hasContactMessage: Boolean(row.contact_message_id),
      hasInternalNotes: Number(internalNoteCount || 0) > 0,
    },

    counts: {
      messageCount: Number(messageCount || 0),
      internalNoteCount: Number(internalNoteCount || 0),
    },

    member: memberProfile,
    assignee: assignedProfile,
    contactMessage,
    latestMessage,
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
      `ticket_number.ilike.%${escaped}%`,
      `subject.ilike.%${escaped}%`,
      `category.ilike.%${escaped}%`,
      `priority.ilike.%${escaped}%`,
      `status.ilike.%${escaped}%`,
      `source.ilike.%${escaped}%`,
    ].join(",")
  );
}

function applyFilters(query, { status, priority, category, assigned, viewerProfileId, search }) {
  let nextQuery = query;

  if (status !== "all") {
    nextQuery = nextQuery.eq("status", status);
  }

  if (priority !== "all") {
    nextQuery = nextQuery.eq("priority", priority);
  }

  if (category !== "all") {
    nextQuery = nextQuery.eq("category", category);
  }

  if (assigned === "assigned") {
    nextQuery = nextQuery.not("assigned_to_profile_id", "is", null);
  } else if (assigned === "unassigned") {
    nextQuery = nextQuery.is("assigned_to_profile_id", null);
  } else if (assigned === "mine") {
    nextQuery = nextQuery.eq("assigned_to_profile_id", viewerProfileId);
  }

  nextQuery = applySearch(nextQuery, search);
  return nextQuery;
}

async function getStatusCounts({ priority, category, assigned, viewerProfileId, search }) {
  const statuses = ["open", "in_progress", "waiting_on_member", "resolved", "closed"];

  const entries = await Promise.all(
    statuses.map(async (status) => {
      let query = supabaseAdmin
        .from("support_tickets")
        .select("id", { count: "exact", head: true });

      query = applyFilters(query, {
        status,
        priority,
        category,
        assigned,
        viewerProfileId,
        search,
      });

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

async function getPriorityCounts({ status, category, assigned, viewerProfileId, search }) {
  const priorities = ["low", "normal", "high", "urgent"];

  const entries = await Promise.all(
    priorities.map(async (priority) => {
      let query = supabaseAdmin
        .from("support_tickets")
        .select("id", { count: "exact", head: true });

      query = applyFilters(query, {
        status,
        priority,
        category,
        assigned,
        viewerProfileId,
        search,
      });

      const { count, error } = await query;

      return {
        priority,
        count: error ? 0 : Number(count || 0),
      };
    })
  );

  return entries.reduce((acc, entry) => {
    acc[entry.priority] = entry.count;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  setNoStore(res);
  logRequestStart(req, { scope: "admin_support" });

  if (req.method !== "GET") {
    return methodNotAllowed(res, ["GET"], "Method not allowed. Use GET.");
  }

  try {
    const rate = adminRateLimit(req, res);

    if (!rate.allowed) {
      return forbidden(res, "Too many admin requests. Please try again later.", {
        retryAfter: rate.retryAfter,
        error: "rate_limited",
      });
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

    if (!adminContext.adminRole.can_manage_support && !adminContext.adminRole.is_super_admin) {
      return forbidden(res, "You do not have permission to manage support.");
    }

    const status = normalizeStatus(req.query?.status);
    const priority = normalizePriority(req.query?.priority);
    const category = normalizeCategory(req.query?.category);
    const assigned = normalizeAssigned(req.query?.assigned);
    const sort = normalizeSort(req.query?.sort);
    const search = normalizeString(req.query?.search);
    const limit = toPositiveInteger(req.query?.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const { page, from, to } = buildRange(req.query?.page, limit);
    const sortConfig = getSortConfig(sort);

    let query = supabaseAdmin
      .from("support_tickets")
      .select(
        [
          "id",
          "profile_id",
          "contact_message_id",
          "ticket_number",
          "subject",
          "category",
          "priority",
          "status",
          "source",
          "assigned_to_profile_id",
          "first_response_at",
          "resolved_at",
          "closed_at",
          "last_message_at",
          "metadata",
          "created_at",
          "updated_at",
        ].join(", "),
        { count: "exact" }
      );

    query = applyFilters(query, {
      status,
      priority,
      category,
      assigned,
      viewerProfileId: adminContext.profile.id,
      search,
    });

    query = query.order(sortConfig.column, { ascending: sortConfig.ascending });
    query = query.range(from, to);

    const [ticketsResult, statusCounts, priorityCounts] = await Promise.all([
      query,
      getStatusCounts({
        priority,
        category,
        assigned,
        viewerProfileId: adminContext.profile.id,
        search,
      }),
      getPriorityCounts({
        status,
        category,
        assigned,
        viewerProfileId: adminContext.profile.id,
        search,
      }),
    ]);

    if (ticketsResult.error) {
      return serverError(res, "Unable to load support tickets.", {
        error: ticketsResult.error.message,
      });
    }

    const tickets = ticketsResult.data || [];
    const ticketIds = tickets.map((row) => row.id);
    const profileIds = Array.from(
      new Set(
        tickets
          .flatMap((row) => [row.profile_id, row.assigned_to_profile_id])
          .filter(Boolean)
      )
    );
    const contactMessageIds = Array.from(
      new Set(tickets.map((row) => row.contact_message_id).filter(Boolean))
    );

    let profileMap = {};
    let contactMessageMap = {};
    let latestMessageMap = {};
    let messageCountMap = {};
    let noteCountMap = {};

    if (profileIds.length > 0) {
      const profilesResult = await supabaseAdmin
        .from("profiles")
        .select(
          "id, email, first_name, last_name, full_name, member_status, role, tier, created_at, updated_at"
        )
        .in("id", profileIds);

      if (profilesResult.error) {
        return serverError(res, "Unable to load ticket profiles.", {
          error: profilesResult.error.message,
        });
      }

      profileMap = (profilesResult.data || []).reduce((acc, row) => {
        acc[row.id] = mapProfileSummary(row);
        return acc;
      }, {});
    }

    if (contactMessageIds.length > 0) {
      const contactMessagesResult = await supabaseAdmin
        .from("contact_messages")
        .select("id, name, email, phone, topic, status, created_at, updated_at")
        .in("id", contactMessageIds);

      if (contactMessagesResult.error) {
        return serverError(res, "Unable to load linked contact messages.", {
          error: contactMessagesResult.error.message,
        });
      }

      contactMessageMap = (contactMessagesResult.data || []).reduce((acc, row) => {
        acc[row.id] = mapContactSummary(row);
        return acc;
      }, {});
    }

    if (ticketIds.length > 0) {
      const [messagesResult, notesResult] = await Promise.all([
        supabaseAdmin
          .from("support_messages")
          .select(
            "id, ticket_id, sender_type, sender_name, sender_email, body, is_internal, created_at, updated_at"
          )
          .in("ticket_id", ticketIds)
          .order("created_at", { ascending: false }),

        supabaseAdmin
          .from("admin_notes")
          .select("entity_id")
          .eq("entity_type", "support_ticket")
          .in("entity_id", ticketIds),
      ]);

      if (messagesResult.error) {
        return serverError(res, "Unable to load ticket messages.", {
          error: messagesResult.error.message,
        });
      }

      if (notesResult.error) {
        return serverError(res, "Unable to load support notes.", {
          error: notesResult.error.message,
        });
      }

      for (const row of messagesResult.data || []) {
        const key = row.ticket_id;

        if (!latestMessageMap[key]) {
          latestMessageMap[key] = mapSupportMessagePreview(row);
        }

        messageCountMap[key] = Number(messageCountMap[key] || 0) + 1;
      }

      noteCountMap = (notesResult.data || []).reduce((acc, row) => {
        const key = row.entity_id;
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {});
    }

    const mappedTickets = tickets.map((row) =>
      mapTicketRow(row, {
        memberProfile: row.profile_id ? profileMap[row.profile_id] || null : null,
        assignedProfile: row.assigned_to_profile_id
          ? profileMap[row.assigned_to_profile_id] || null
          : null,
        contactMessage: row.contact_message_id
          ? contactMessageMap[row.contact_message_id] || null
          : null,
        latestMessage: latestMessageMap[row.id] || null,
        messageCount: messageCountMap[row.id] || 0,
        internalNoteCount: noteCountMap[row.id] || 0,
      })
    );

    const total = Number(ticketsResult.count || 0);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

    logRequestSuccess(req, {
      scope: "admin_support",
      adminId: adminContext.profile.id,
      returned: mappedTickets.length,
      total,
      page,
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
          canManageSupport: Boolean(adminContext.adminRole.can_manage_support),
        },

        filters: {
          statuses: VALID_STATUSES,
          activeStatus: status,
          priorities: VALID_PRIORITIES,
          activePriority: priority,
          categories: VALID_CATEGORIES,
          activeCategory: category,
          assignedOptions: VALID_ASSIGNED,
          activeAssigned: assigned,
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

        summary: {
          total,
          open: Number(statusCounts.open || 0),
          inProgress: Number(statusCounts.in_progress || 0),
          waitingOnMember: Number(statusCounts.waiting_on_member || 0),
          resolved: Number(statusCounts.resolved || 0),
          closed: Number(statusCounts.closed || 0),
          urgent: Number(priorityCounts.urgent || 0),
          high: Number(priorityCounts.high || 0),
          normal: Number(priorityCounts.normal || 0),
          low: Number(priorityCounts.low || 0),
        },

        tickets: mappedTickets,
      },
      "Admin support tickets loaded successfully."
    );
  } catch (error) {
    logRequestError(req, error, { scope: "admin_support_unexpected" });

    return serverError(
      res,
      "Failed to load admin support tickets.",
      process.env.NODE_ENV === "development"
        ? { error: error?.message || "Unknown error." }
        : null
    );
  }
}