// api/access/suspend-member.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";
import {
  buildMemberCustomerIdentifier,
  getAccessAmtConfigForDebug,
  suspendMemberInAccessAmt,
} from "../../lib/access-amt.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  return res.end(JSON.stringify(payload));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
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

  if (typeof req.body === "object") return req.body;

  return {};
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
    message.includes("schema cache") ||
    message.includes("could not find") ||
    details.includes("does not exist") ||
    details.includes("schema cache") ||
    details.includes("could not find")
  );
}

function getSafeMemberForResponse(member = {}) {
  return {
    id: member.id || null,
    email: normalizeEmail(member.email),
    first_name: member.first_name || "",
    last_name: member.last_name || "",
    full_name:
      member.full_name ||
      [member.first_name, member.last_name].filter(Boolean).join(" ") ||
      "",
    phone: member.phone || "",
    status: member.status || "",
    payment_status: member.payment_status || "",
    membership_status: member.membership_status || "",
    approval_status: member.approval_status || "",
    access_member_identifier: member.access_member_identifier || "",
    access_member_status: member.access_member_status || "",
    access_perks_ready: Boolean(member.access_perks_ready),
    access_synced_at: member.access_synced_at || null,
    access_suspended_at: member.access_suspended_at || null,
    access_sync_error: member.access_sync_error || "",
  };
}

async function findMemberByEmail(email) {
  const safeEmail = normalizeEmail(email);

  if (!safeEmail || !isValidEmail(safeEmail)) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .ilike("email", safeEmail)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function findMemberById(id) {
  const safeId = normalizeString(id);

  if (!safeId) return null;

  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .eq("id", safeId)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function findMember(req) {
  const body = getRequestBody(req);

  const id =
    normalizeString(body.id) ||
    normalizeString(body.member_id) ||
    normalizeString(body.memberId) ||
    normalizeString(req.query?.id) ||
    normalizeString(req.query?.member_id) ||
    normalizeString(req.query?.memberId);

  const email =
    normalizeEmail(body.email) ||
    normalizeEmail(body.email_address) ||
    normalizeEmail(req.query?.email) ||
    normalizeEmail(req.query?.email_address);

  if (id) {
    const byId = await findMemberById(id);
    if (byId?.id) return byId;
  }

  if (email) {
    const byEmail = await findMemberByEmail(email);
    if (byEmail?.id) return byEmail;
  }

  return null;
}

async function saveAccessSuspendSuccess(member, accessResult) {
  const now = new Date().toISOString();

  const payload = {
    access_member_identifier:
      accessResult.access_member_identifier ||
      buildMemberCustomerIdentifier(member),
    access_member_status: "SUSPEND",
    access_synced_at: now,
    access_suspended_at: now,
    access_sync_error: null,
    access_last_payload: accessResult.access_payload || accessResult.payload || null,
    access_last_response:
      accessResult.access_response || accessResult.response || null,
    access_perks_ready: false,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(payload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) {
    return result.data || {
      ...member,
      ...payload,
    };
  }

  if (!isMissingOptionalColumn(result.error)) {
    throw result.error;
  }

  const fallbackPayload = {
    updated_at: now,
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (result.error) throw result.error;

  return result.data || {
    ...member,
    ...fallbackPayload,
  };
}

async function saveAccessSuspendFailure(member, error) {
  const now = new Date().toISOString();

  const payload = {
    access_member_identifier: buildMemberCustomerIdentifier(member),
    access_member_status: "suspend_failed",
    access_sync_error:
      error?.message || "Access AMT suspend failed for this member.",
    access_last_payload: error?.payload || null,
    access_last_response: error?.response || null,
    updated_at: now,
  };

  let result = await supabaseAdmin
    .from("signups")
    .update(payload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (!result.error) {
    return result.data || {
      ...member,
      ...payload,
    };
  }

  if (!isMissingOptionalColumn(result.error)) {
    throw result.error;
  }

  const fallbackPayload = {
    updated_at: now,
  };

  result = await supabaseAdmin
    .from("signups")
    .update(fallbackPayload)
    .eq("id", member.id)
    .select("*")
    .maybeSingle();

  if (result.error) throw result.error;

  return result.data || {
    ...member,
    ...fallbackPayload,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET or POST.",
    });
  }

  try {
    const debug =
      String(req.query?.debug ?? "").toLowerCase() === "true" ||
      String(req.query?.debug ?? "") === "1";

    const dryRun =
      String(req.query?.dry_run ?? req.query?.dryRun ?? "").toLowerCase() ===
        "true" ||
      String(req.query?.dry_run ?? req.query?.dryRun ?? "") === "1";

    const member = await findMember(req);

    if (!member?.id) {
      return sendJson(res, 404, {
        success: false,
        ok: false,
        message:
          "Member not found. Send an email or member id to suspend in Access AMT.",
        example: {
          method: "POST",
          body: {
            email: "member@example.com",
          },
        },
        config: debug ? getAccessAmtConfigForDebug() : undefined,
      });
    }

    const accessMemberIdentifier = buildMemberCustomerIdentifier(member);

    const memberForAccess = {
      ...member,
      access_member_identifier: accessMemberIdentifier,
      member_customer_identifier: accessMemberIdentifier,
    };

    if (dryRun) {
      return sendJson(res, 200, {
        success: true,
        ok: true,
        dry_run: true,
        message: "Dry run only. Member was not suspended in Access AMT.",
        member: getSafeMemberForResponse({
          ...memberForAccess,
          access_member_status: "SUSPEND",
          access_perks_ready: false,
        }),
        access_member_identifier: accessMemberIdentifier,
        config: debug ? getAccessAmtConfigForDebug() : undefined,
      });
    }

    try {
      const accessResult = await suspendMemberInAccessAmt(memberForAccess);

      const updatedMember = await saveAccessSuspendSuccess(
        member,
        accessResult
      );

      return sendJson(res, 200, {
        success: true,
        ok: true,
        message: "Member suspended in Access AMT successfully.",
        member: getSafeMemberForResponse(updatedMember),
        access: {
          synced: true,
          member_status: "SUSPEND",
          member_customer_identifier: accessMemberIdentifier,
          status: accessResult.status,
          statusText: accessResult.statusText,
          url: accessResult.url,
          response: accessResult.response,
        },
        config: debug ? getAccessAmtConfigForDebug() : undefined,
      });
    } catch (accessError) {
      const updatedMember = await saveAccessSuspendFailure(member, accessError);

      return sendJson(res, accessError?.status || 502, {
        success: false,
        ok: false,
        message:
          accessError?.message ||
          "Access AMT rejected the member suspend request.",
        member: getSafeMemberForResponse(updatedMember),
        access: {
          synced: false,
          member_status: "suspend_failed",
          member_customer_identifier: accessMemberIdentifier,
          status: accessError?.status || null,
          statusText: accessError?.statusText || "",
          url: accessError?.url || "",
          response: accessError?.response || null,
        },
        config: debug ? getAccessAmtConfigForDebug() : undefined,
      });
    }
  } catch (error) {
    console.error("Card Leo access/suspend-member error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message ||
        "Unable to suspend member in Access AMT right now.",
    });
  }
}