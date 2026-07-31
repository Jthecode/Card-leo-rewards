// api/cron/nightly-new-members-email.js
import { supabaseAdmin } from "../../lib/supabase-admin.js";

const TIME_ZONE = "America/New_York";
const DEFAULT_FROM_EMAIL = "Card Leo Rewards <noreply@cardleorewards.com>";

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

function money(value) {
  const number = Number(value || 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(number) ? number : 0);
}

function formatDateTime(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function titleCase(value) {
  return normalizeString(value)
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getAuthToken(req) {
  const authHeader = normalizeString(req.headers.authorization);
  const bearer = authHeader.replace(/^Bearer\s+/i, "");

  return (
    normalizeString(req.headers["x-cron-secret"]) ||
    normalizeString(req.query?.secret) ||
    normalizeString(req.query?.token) ||
    bearer
  );
}

function isAuthorized(req) {
  const cronSecret = normalizeString(process.env.CRON_SECRET);

  if (!cronSecret) {
    return true;
  }

  return getAuthToken(req) === cronSecret;
}

function getZonedParts(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const actualParts = getZonedParts(utcGuess, TIME_ZONE);

  const actualAsUtc = Date.UTC(
    actualParts.year,
    actualParts.month - 1,
    actualParts.day,
    actualParts.hour,
    actualParts.minute,
    actualParts.second
  );

  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = actualAsUtc - utcGuess.getTime();

  return new Date(wantedAsUtc - offset);
}

function getTodayRangeEastern() {
  const now = new Date();
  const parts = getZonedParts(now, TIME_ZONE);

  const start = zonedTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });

  return {
    start,
    end: now,
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(now),
  };
}

function getFullName(member) {
  const fullName = normalizeString(member.full_name || member.fullName);

  if (fullName) return fullName;

  const firstName = normalizeString(member.first_name || member.firstName);
  const lastName = normalizeString(member.last_name || member.lastName);

  return [firstName, lastName].filter(Boolean).join(" ") || "Card Leo Member";
}

function getReferralDisplay(member) {
  return (
    normalizeString(member.referral_email) ||
    normalizeString(member.referral_name) ||
    normalizeString(member.referral_code) ||
    normalizeString(member.sponsor_email) ||
    normalizeString(member.sponsor_name) ||
    "—"
  );
}

function getStatus(member) {
  return titleCase(
    member.membership_status ||
      member.payment_status ||
      member.status ||
      member.approval_status ||
      "pending"
  );
}

function getPaymentStatus(member) {
  return titleCase(member.payment_status || "unknown");
}

function getMembershipStatus(member) {
  return titleCase(member.membership_status || member.status || "unknown");
}

async function getNewMembers({ start, end }) {
  const { data, error } = await supabaseAdmin
    .from("signups")
    .select("*")
    .gte("created_at", start.toISOString())
    .lte("created_at", end.toISOString())
    .order("created_at", { ascending: false });

  if (error) throw error;

  return Array.isArray(data) ? data : [];
}

function calculateSummary(members) {
  const total = members.length;

  const paid = members.filter((member) => {
    const payment = normalizeString(member.payment_status).toLowerCase();
    const status = normalizeString(member.status).toLowerCase();
    const membership = normalizeString(member.membership_status).toLowerCase();

    return (
      payment === "paid" ||
      payment === "active" ||
      payment === "current" ||
      payment === "succeeded" ||
      status === "active" ||
      membership === "active"
    );
  }).length;

  const pending = Math.max(total - paid, 0);

  const referred = members.filter((member) => getReferralDisplay(member) !== "—")
    .length;

  return {
    total,
    paid,
    pending,
    referred,
  };
}

function buildTextEmail({ members, summary, range }) {
  const lines = [];

  lines.push(`Card Leo Rewards - Nightly New Members Report`);
  lines.push(`Date: ${range.label}`);
  lines.push(`Window: ${formatDateTime(range.start)} - ${formatDateTime(range.end)}`);
  lines.push("");
  lines.push(`Total New Members: ${summary.total}`);
  lines.push(`Paid / Active: ${summary.paid}`);
  lines.push(`Pending: ${summary.pending}`);
  lines.push(`Referred Signups: ${summary.referred}`);
  lines.push("");

  if (!members.length) {
    lines.push("No new members signed up today.");
    return lines.join("\n");
  }

  members.forEach((member, index) => {
    lines.push(`${index + 1}. ${getFullName(member)}`);
    lines.push(`   Email: ${normalizeEmail(member.email) || "—"}`);
    lines.push(`   Phone: ${normalizeString(member.phone) || "—"}`);
    lines.push(`   Joined: ${formatDateTime(member.created_at)}`);
    lines.push(`   Payment Status: ${getPaymentStatus(member)}`);
    lines.push(`   Membership Status: ${getMembershipStatus(member)}`);
    lines.push(`   Referral: ${getReferralDisplay(member)}`);
    lines.push(`   Total Earnings: ${money(member.total_referral_earnings)}`);
    lines.push("");
  });

  return lines.join("\n");
}

function buildHtmlEmail({ members, summary, range }) {
  const memberRows = members.length
    ? members
        .map(
          (member) => `
            <tr>
              <td style="padding:12px;border-bottom:1px solid #2b2414;">
                <strong style="color:#f8f3e7;">${escapeHtml(getFullName(member))}</strong>
                <br />
                <span style="color:#b9b2a3;">${escapeHtml(
                  normalizeEmail(member.email) || "No email"
                )}</span>
              </td>

              <td style="padding:12px;border-bottom:1px solid #2b2414;color:#f8f3e7;">
                ${escapeHtml(normalizeString(member.phone) || "—")}
              </td>

              <td style="padding:12px;border-bottom:1px solid #2b2414;color:#f8f3e7;">
                ${escapeHtml(getPaymentStatus(member))}
              </td>

              <td style="padding:12px;border-bottom:1px solid #2b2414;color:#f8f3e7;">
                ${escapeHtml(getMembershipStatus(member))}
              </td>

              <td style="padding:12px;border-bottom:1px solid #2b2414;color:#f8f3e7;">
                ${escapeHtml(getReferralDisplay(member))}
              </td>

              <td style="padding:12px;border-bottom:1px solid #2b2414;color:#f8f3e7;">
                ${escapeHtml(formatDateTime(member.created_at))}
              </td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="6" style="padding:18px;color:#b9b2a3;text-align:center;">
          No new members signed up today.
        </td>
      </tr>
    `;

  return `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;background:#050505;color:#f8f3e7;font-family:Arial,Helvetica,sans-serif;">
        <div style="max-width:980px;margin:0 auto;padding:28px;">
          <div style="border:1px solid #3a2c12;border-radius:22px;background:#0d0d0d;overflow:hidden;">
            <div style="padding:24px;background:linear-gradient(135deg,#1b1406,#080808);border-bottom:1px solid #3a2c12;">
              <p style="margin:0 0 8px;color:#e7b64f;font-weight:800;letter-spacing:.12em;text-transform:uppercase;">
                Card Leo Rewards
              </p>

              <h1 style="margin:0;color:#f8f3e7;font-size:30px;line-height:1.1;">
                Nightly New Members Report
              </h1>

              <p style="margin:10px 0 0;color:#b9b2a3;">
                ${escapeHtml(range.label)} · ${escapeHtml(formatDateTime(range.start))} - ${escapeHtml(formatDateTime(range.end))}
              </p>
            </div>

            <div style="padding:22px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:22px;">
                <tr>
                  <td style="padding:14px;border:1px solid #3a2c12;border-radius:14px;background:#111;">
                    <span style="display:block;color:#b9b2a3;font-size:12px;text-transform:uppercase;font-weight:800;">
                      Total New Members
                    </span>
                    <strong style="display:block;margin-top:8px;color:#e7b64f;font-size:28px;">
                      ${escapeHtml(summary.total)}
                    </strong>
                  </td>

                  <td style="padding:14px;border:1px solid #3a2c12;border-radius:14px;background:#111;">
                    <span style="display:block;color:#b9b2a3;font-size:12px;text-transform:uppercase;font-weight:800;">
                      Paid / Active
                    </span>
                    <strong style="display:block;margin-top:8px;color:#48f06b;font-size:28px;">
                      ${escapeHtml(summary.paid)}
                    </strong>
                  </td>

                  <td style="padding:14px;border:1px solid #3a2c12;border-radius:14px;background:#111;">
                    <span style="display:block;color:#b9b2a3;font-size:12px;text-transform:uppercase;font-weight:800;">
                      Pending
                    </span>
                    <strong style="display:block;margin-top:8px;color:#ffd166;font-size:28px;">
                      ${escapeHtml(summary.pending)}
                    </strong>
                  </td>

                  <td style="padding:14px;border:1px solid #3a2c12;border-radius:14px;background:#111;">
                    <span style="display:block;color:#b9b2a3;font-size:12px;text-transform:uppercase;font-weight:800;">
                      Referred
                    </span>
                    <strong style="display:block;margin-top:8px;color:#7ec8ff;font-size:28px;">
                      ${escapeHtml(summary.referred)}
                    </strong>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #3a2c12;border-radius:16px;overflow:hidden;">
                <thead>
                  <tr style="background:#15120b;">
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Member</th>
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Phone</th>
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Payment</th>
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Membership</th>
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Referral</th>
                    <th align="left" style="padding:12px;color:#e7b64f;font-size:12px;text-transform:uppercase;">Joined</th>
                  </tr>
                </thead>

                <tbody>
                  ${memberRows}
                </tbody>
              </table>

              <p style="margin:20px 0 0;color:#b9b2a3;font-size:13px;line-height:1.6;">
                This report is generated automatically every night for Card Leo Rewards.
              </p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

async function sendEmailWithResend({ to, subject, html, text }) {
  const apiKey = normalizeString(process.env.RESEND_API_KEY);
  const from = normalizeString(process.env.EMAIL_FROM) || DEFAULT_FROM_EMAIL;

  if (!apiKey) {
    return {
      sent: false,
      provider: "resend",
      skipped: true,
      message: "Missing RESEND_API_KEY. Email was not sent.",
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      sent: false,
      provider: "resend",
      status: response.status,
      response: payload,
      message: payload?.message || "Resend email failed.",
    };
  }

  return {
    sent: true,
    provider: "resend",
    status: response.status,
    response: payload,
  };
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");

    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET or POST.",
    });
  }

  try {
    if (!isAuthorized(req)) {
      return sendJson(res, 401, {
        success: false,
        ok: false,
        message: "Unauthorized cron request.",
      });
    }

    const reportEmail =
      normalizeEmail(req.query?.to) ||
      normalizeEmail(process.env.ADMIN_REPORT_EMAIL) ||
      normalizeEmail(process.env.CARDLEO_ADMIN_EMAIL) ||
      normalizeEmail(process.env.SUPPORT_EMAIL);

    if (!reportEmail) {
      return sendJson(res, 500, {
        success: false,
        ok: false,
        message:
          "Missing ADMIN_REPORT_EMAIL, CARDLEO_ADMIN_EMAIL, or SUPPORT_EMAIL.",
      });
    }

    const range = getTodayRangeEastern();
    const members = await getNewMembers(range);
    const summary = calculateSummary(members);

    const subject = `Card Leo Rewards Nightly New Members Report - ${range.label}`;
    const text = buildTextEmail({ members, summary, range });
    const html = buildHtmlEmail({ members, summary, range });

    const emailResult = await sendEmailWithResend({
      to: reportEmail,
      subject,
      html,
      text,
    });

    return sendJson(res, 200, {
      success: true,
      ok: true,
      message: emailResult.sent
        ? "Nightly new members email sent."
        : "Nightly report generated, but email was not sent.",
      report_email: reportEmail,
      date_label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      summary,
      email: emailResult,
      members: members.map((member) => ({
        id: member.id,
        name: getFullName(member),
        email: normalizeEmail(member.email),
        phone: normalizeString(member.phone),
        payment_status: member.payment_status,
        membership_status: member.membership_status,
        status: member.status,
        referral: getReferralDisplay(member),
        created_at: member.created_at,
      })),
    });
  } catch (error) {
    console.error("Nightly new members email error:", error);

    return sendJson(res, 500, {
      success: false,
      ok: false,
      message:
        error?.message || "Unable to send nightly new members email report.",
    });
  }
}