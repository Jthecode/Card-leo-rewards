// lib/audit.js

import { supabaseAdmin } from "./supabase-admin.js";

export const AUDIT_ENTITY_TYPES = {
  SIGNUP: "signup",
  PROFILE: "profile",
  REWARD_ACCOUNT: "reward_account",
  REWARD_TRANSACTION: "reward_transaction",
  REWARD_PAYOUT: "reward_payout",
  MEMBERSHIP_CYCLE: "membership_cycle",
  MEMBERSHIP_PAYMENT: "membership_payment",
  SUPPORT_TICKET: "support_ticket",
  SUPPORT_MESSAGE: "support_message",
  REFERRAL: "referral",
  SETTING: "setting",
  ADMIN_ROLE: "admin_role",
  SYSTEM: "system",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value, fallback = "") {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || fallback;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toPositiveInteger(value, fallback = 50, max = 200) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.floor(num), max);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function normalizeEntityType(value) {
  const normalized = normalizeLower(value);
  if (Object.values(AUDIT_ENTITY_TYPES).includes(normalized)) {
    return normalized;
  }
  return AUDIT_ENTITY_TYPES.SYSTEM;
}

function getClientIp(req) {
  if (!req?.headers) return null;

  const forwardedFor =
    req.headers["x-forwarded-for"] ||
    req.headers["X-Forwarded-For"] ||
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"];

  if (Array.isArray(forwardedFor)) {
    return normalizeText(forwardedFor[0] || "") || null;
  }

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return normalizeText(forwardedFor.split(",")[0]) || null;
  }

  return normalizeText(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "") || null;
}

function getUserAgent(req) {
  return (
    normalizeText(req?.headers?.["user-agent"] || "") ||
    normalizeText(req?.headers?.["User-Agent"] || "") ||
    null
  );
}

function redactValue(key, value) {
  const normalizedKey = normalizeLower(key);

  const sensitiveFragments = [
    "password",
    "token",
    "secret",
    "cookie",
    "authorization",
    "access_token",
    "refresh_token",
    "apikey",
    "api_key",
    "session",
    "ssn",
    "creditcard",
    "card_number",
    "cvv",
  ];

  if (sensitiveFragments.some((fragment) => normalizedKey.includes(fragment))) {
    return "[REDACTED]";
  }

  if (typeof value === "string" && value.length > 2000) {
    return `${value.slice(0, 2000)}…`;
  }

  return value;
}

function sanitizeMetadata(input, depth = 0) {
  if (depth > 5) return "[MAX_DEPTH]";
  if (input == null) return {};

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((value) => sanitizeMetadata(value, depth + 1));
  }

  if (!isPlainObject(input)) {
    if (typeof input === "string" && input.length > 2000) {
      return `${input.slice(0, 2000)}…`;
    }
    return input;
  }

  const output = {};

  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    if (Array.isArray(value)) {
      output[key] = redactValue(
        key,
        value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1))
      );
      continue;
    }

    if (isPlainObject(value)) {
      output[key] = redactValue(key, sanitizeMetadata(value, depth + 1));
      continue;
    }

    output[key] = redactValue(key, value);
  }

  return output;
}

function mapAuditLogRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    actorProfileId: row.actor_profile_id || null,
    targetProfileId: row.target_profile_id || null,
    entityType: row.entity_type || AUDIT_ENTITY_TYPES.SYSTEM,
    entityId: row.entity_id || null,
    action: row.action || null,
    title: row.title || null,
    description: row.description || null,
    metadata: row.metadata || {},
    ipAddress: row.ip_address || null,
    userAgent: row.user_agent || null,
    createdAt: safeDate(row.created_at),
  };
}

async function writeAuditLog({
  actorProfileId = null,
  targetProfileId = null,
  entityType = AUDIT_ENTITY_TYPES.SYSTEM,
  entityId = null,
  action,
  title,
  description = "",
  metadata = {},
  ipAddress = null,
  userAgent = null,
}) {
  const normalizedAction = normalizeText(action);
  const normalizedTitle = normalizeText(title);

  if (!normalizedAction) {
    throw new Error("Audit log action is required.");
  }

  if (!normalizedTitle) {
    throw new Error("Audit log title is required.");
  }

  const result = await supabaseAdmin
    .from("admin_audit_logs")
    .insert({
      actor_profile_id: normalizeText(actorProfileId) || null,
      target_profile_id: normalizeText(targetProfileId) || null,
      entity_type: normalizeEntityType(entityType),
      entity_id: normalizeText(entityId) || null,
      action: normalizedAction,
      title: normalizedTitle,
      description: normalizeText(description) || null,
      metadata: sanitizeMetadata(metadata),
      ip_address: normalizeText(ipAddress) || null,
      user_agent: normalizeText(userAgent) || null,
    })
    .select(
      "id, actor_profile_id, target_profile_id, entity_type, entity_id, action, title, description, metadata, ip_address, user_agent, created_at"
    )
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to write audit log: ${result.error.message}`);
  }

  return mapAuditLogRow(result.data);
}

async function logAdminAction({
  req = null,
  actorProfileId = null,
  targetProfileId = null,
  entityType = AUDIT_ENTITY_TYPES.SYSTEM,
  entityId = null,
  action,
  title,
  description = "",
  metadata = {},
}) {
  return writeAuditLog({
    actorProfileId,
    targetProfileId,
    entityType,
    entityId,
    action,
    title,
    description,
    metadata,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
  });
}

async function logSystemEvent({
  action,
  title,
  description = "",
  metadata = {},
  entityType = AUDIT_ENTITY_TYPES.SYSTEM,
  entityId = null,
}) {
  return writeAuditLog({
    actorProfileId: null,
    targetProfileId: null,
    entityType,
    entityId,
    action,
    title,
    description,
    metadata,
    ipAddress: null,
    userAgent: "system",
  });
}

async function getAuditLogs({
  entityType = "",
  entityId = "",
  actorProfileId = "",
  targetProfileId = "",
  action = "",
  limit = 50,
}) {
  let query = supabaseAdmin
    .from("admin_audit_logs")
    .select(
      "id, actor_profile_id, target_profile_id, entity_type, entity_id, action, title, description, metadata, ip_address, user_agent, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(toPositiveInteger(limit, 50, 200));

  if (normalizeText(entityType)) {
    query = query.eq("entity_type", normalizeEntityType(entityType));
  }

  if (normalizeText(entityId)) {
    query = query.eq("entity_id", normalizeText(entityId));
  }

  if (normalizeText(actorProfileId)) {
    query = query.eq("actor_profile_id", normalizeText(actorProfileId));
  }

  if (normalizeText(targetProfileId)) {
    query = query.eq("target_profile_id", normalizeText(targetProfileId));
  }

  if (normalizeText(action)) {
    query = query.eq("action", normalizeText(action));
  }

  const result = await query;

  if (result.error) {
    throw new Error(`Unable to load audit logs: ${result.error.message}`);
  }

  return (result.data || []).map(mapAuditLogRow);
}

async function getLatestAuditLogForEntity(entityType, entityId) {
  const logs = await getAuditLogs({
    entityType,
    entityId,
    limit: 1,
  });

  return logs[0] || null;
}

async function createAdminNote({
  authorProfileId = null,
  targetProfileId = null,
  entityType = AUDIT_ENTITY_TYPES.SYSTEM,
  entityId = null,
  title = "",
  note,
  isInternal = true,
}) {
  const normalizedNote = normalizeText(note);

  if (!normalizedNote) {
    throw new Error("Admin note is required.");
  }

  const result = await supabaseAdmin
    .from("admin_notes")
    .insert({
      author_profile_id: normalizeText(authorProfileId) || null,
      target_profile_id: normalizeText(targetProfileId) || null,
      entity_type: normalizeEntityType(entityType),
      entity_id: normalizeText(entityId) || null,
      title: normalizeText(title) || null,
      note: normalizedNote,
      is_internal: Boolean(isInternal),
    })
    .select(
      "id, author_profile_id, target_profile_id, entity_type, entity_id, title, note, is_internal, created_at, updated_at"
    )
    .maybeSingle();

  if (result.error) {
    throw new Error(`Unable to create admin note: ${result.error.message}`);
  }

  return {
    id: result.data?.id || null,
    authorProfileId: result.data?.author_profile_id || null,
    targetProfileId: result.data?.target_profile_id || null,
    entityType: result.data?.entity_type || normalizeEntityType(entityType),
    entityId: result.data?.entity_id || null,
    title: result.data?.title || null,
    note: result.data?.note || normalizedNote,
    isInternal: Boolean(result.data?.is_internal),
    createdAt: safeDate(result.data?.created_at),
    updatedAt: safeDate(result.data?.updated_at),
  };
}

async function getAdminNotes({
  entityType = "",
  entityId = "",
  targetProfileId = "",
  limit = 50,
}) {
  let query = supabaseAdmin
    .from("admin_notes")
    .select(
      "id, author_profile_id, target_profile_id, entity_type, entity_id, title, note, is_internal, created_at, updated_at"
    )
    .order("created_at", { ascending: false })
    .limit(toPositiveInteger(limit, 50, 200));

  if (normalizeText(entityType)) {
    query = query.eq("entity_type", normalizeEntityType(entityType));
  }

  if (normalizeText(entityId)) {
    query = query.eq("entity_id", normalizeText(entityId));
  }

  if (normalizeText(targetProfileId)) {
    query = query.eq("target_profile_id", normalizeText(targetProfileId));
  }

  const result = await query;

  if (result.error) {
    throw new Error(`Unable to load admin notes: ${result.error.message}`);
  }

  return (result.data || []).map((row) => ({
    id: row.id,
    authorProfileId: row.author_profile_id || null,
    targetProfileId: row.target_profile_id || null,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    title: row.title || null,
    note: row.note || null,
    isInternal: Boolean(row.is_internal),
    createdAt: safeDate(row.created_at),
    updatedAt: safeDate(row.updated_at),
  }));
}

const audit = {
  AUDIT_ENTITY_TYPES,
  sanitizeMetadata,
  getClientIp,
  getUserAgent,
  writeAuditLog,
  logAdminAction,
  logSystemEvent,
  getAuditLogs,
  getLatestAuditLogForEntity,
  createAdminNote,
  getAdminNotes,
};

export {
  sanitizeMetadata,
  getClientIp,
  getUserAgent,
  writeAuditLog,
  logAdminAction,
  logSystemEvent,
  getAuditLogs,
  getLatestAuditLogForEntity,
  createAdminNote,
  getAdminNotes,
};

export default audit;