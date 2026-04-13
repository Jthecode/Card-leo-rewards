// lib/email.js

import { getServerEnv, getSiteUrl } from "./env.js";
import { createLogger } from "./logger.js";

const logger = createLogger("email");

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueEmails(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }

  return result;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function validateEmailList(values, label = "recipient") {
  const emails = uniqueEmails(ensureArray(values));

  if (emails.length === 0) {
    throw new Error(`At least one ${label} email is required.`);
  }

  for (const email of emails) {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid ${label} email: ${email}`);
    }
  }

  return emails;
}

function baseStyles() {
  return `
    body {
      margin: 0;
      padding: 0;
      background: #0a0a0a;
      color: #f6f1e8;
      font-family: Inter, Arial, Helvetica, sans-serif;
    }
    .wrapper {
      width: 100%;
      padding: 32px 16px;
      background:
        radial-gradient(circle at top right, rgba(216,179,106,0.16), transparent 28%),
        linear-gradient(180deg, #050505 0%, #0c0c0c 100%);
    }
    .card {
      max-width: 680px;
      margin: 0 auto;
      background: rgba(18,18,18,0.96);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 22px;
      overflow: hidden;
      box-shadow: 0 24px 70px rgba(0,0,0,0.45);
    }
    .topbar {
      height: 6px;
      background: linear-gradient(90deg, #f2d58d 0%, #d8b36a 100%);
    }
    .inner {
      padding: 36px 28px;
    }
    .eyebrow {
      color: #d8b36a;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      margin: 0 0 14px;
    }
    h1 {
      margin: 0 0 14px;
      font-size: 32px;
      line-height: 1.1;
      color: #f8f5ee;
    }
    p {
      margin: 0 0 16px;
      color: #d1c4b0;
      line-height: 1.7;
      font-size: 15px;
    }
    .button-wrap {
      padding: 8px 0 18px;
    }
    .button {
      display: inline-block;
      padding: 14px 22px;
      border-radius: 999px;
      background: linear-gradient(135deg, #f2d58d 0%, #d8b36a 100%);
      color: #17120b !important;
      text-decoration: none;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .meta {
      margin-top: 22px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.08);
      color: #aa9b85;
      font-size: 13px;
      line-height: 1.7;
    }
    .footer {
      padding: 0 28px 28px;
      color: #907f67;
      font-size: 12px;
      line-height: 1.7;
    }
    .code {
      display: inline-block;
      padding: 10px 14px;
      border-radius: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      color: #f4e8cf;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    ul {
      margin: 0 0 18px 18px;
      padding: 0;
      color: #d1c4b0;
    }
    li {
      margin-bottom: 10px;
      line-height: 1.7;
    }
  `;
}

function wrapEmailTemplate({
  eyebrow = "Card Leo Rewards",
  title = "Card Leo Rewards",
  intro = "",
  body = "",
  ctaLabel = "",
  ctaUrl = "",
  footer = "This email was sent by Card Leo Rewards.",
}) {
  const safeEyebrow = escapeHtml(eyebrow);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeFooter = escapeHtml(footer);
  const safeCtaLabel = escapeHtml(ctaLabel);
  const safeCtaUrl = clean(ctaUrl);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <style>${baseStyles()}</style>
  </head>
  <body>
    <div class="wrapper">
      <div class="card">
        <div class="topbar"></div>
        <div class="inner">
          <p class="eyebrow">${safeEyebrow}</p>
          <h1>${safeTitle}</h1>
          ${safeIntro ? `<p>${safeIntro}</p>` : ""}
          ${body}
          ${
            safeCtaLabel && safeCtaUrl
              ? `<div class="button-wrap"><a class="button" href="${safeCtaUrl}">${safeCtaLabel}</a></div>`
              : ""
          }
        </div>
        <div class="footer">${safeFooter}</div>
      </div>
    </div>
  </body>
</html>`;
}

function buildTextFallback(lines = []) {
  return lines
    .map((line) => clean(line))
    .filter(Boolean)
    .join("\n\n");
}

export function buildWelcomeEmail({ fullName = "", dashboardUrl = "" } = {}) {
  const name = escapeHtml(fullName || "Member");
  const url = clean(dashboardUrl) || getSiteUrl("/portal/index.html");

  return {
    subject: "Welcome to Card Leo Rewards",
    html: wrapEmailTemplate({
      eyebrow: "Welcome",
      title: "Your Card Leo Rewards account is ready.",
      intro: `Welcome ${name}. Your premium membership experience starts now.`,
      body: `
        <p>We’re excited to have you inside the Card Leo Rewards platform.</p>
        <ul>
          <li>Access your member portal</li>
          <li>Manage your rewards and benefits</li>
          <li>Keep your profile and settings updated</li>
        </ul>
        <p class="meta">Use your portal to explore member benefits, profile controls, and exclusive reward opportunities.</p>
      `,
      ctaLabel: "Open Member Portal",
      ctaUrl: url,
      footer: "Welcome to Card Leo Rewards. Premium access starts here.",
    }),
    text: buildTextFallback([
      "Welcome to Card Leo Rewards.",
      `Hello ${clean(fullName || "Member")}, your account is ready.`,
      `Open your member portal: ${url}`,
    ]),
  };
}

export function buildResetPasswordEmail({
  fullName = "",
  resetUrl = "",
  code = "",
  expiresInMinutes = 30,
} = {}) {
  const name = escapeHtml(fullName || "Member");
  const url = clean(resetUrl) || getSiteUrl("/reset-password.html");
  const safeCode = clean(code);

  return {
    subject: "Reset your Card Leo Rewards password",
    html: wrapEmailTemplate({
      eyebrow: "Security",
      title: "Reset your password",
      intro: `Hello ${name}, we received a request to reset your password.`,
      body: `
        <p>If you made this request, use the secure button below to continue.</p>
        ${
          safeCode
            ? `<p>Your verification code:</p><p><span class="code">${escapeHtml(safeCode)}</span></p>`
            : ""
        }
        <p class="meta">This reset link expires in ${escapeHtml(expiresInMinutes)} minutes. If you did not request a password reset, you can safely ignore this email.</p>
      `,
      ctaLabel: "Reset Password",
      ctaUrl: url,
      footer: "For your security, never share your reset code or password with anyone.",
    }),
    text: buildTextFallback([
      "Reset your Card Leo Rewards password.",
      `Hello ${clean(fullName || "Member")}, we received a password reset request.`,
      safeCode ? `Verification code: ${safeCode}` : "",
      `Reset link: ${url}`,
      `This request expires in ${expiresInMinutes} minutes.`,
    ]),
  };
}

export function buildVerifyEmailMessage({
  fullName = "",
  verifyUrl = "",
  code = "",
} = {}) {
  const name = escapeHtml(fullName || "Member");
  const url = clean(verifyUrl) || getSiteUrl("/verify-email.html");
  const safeCode = clean(code);

  return {
    subject: "Verify your Card Leo Rewards email",
    html: wrapEmailTemplate({
      eyebrow: "Verification",
      title: "Confirm your email address",
      intro: `Hello ${name}, verify your email to complete your Card Leo Rewards setup.`,
      body: `
        <p>Confirm your email address to activate secure account access and important member notifications.</p>
        ${
          safeCode
            ? `<p>Your verification code:</p><p><span class="code">${escapeHtml(safeCode)}</span></p>`
            : ""
        }
        <p class="meta">Verifying your email helps protect your account and ensures you receive reward alerts and support updates.</p>
      `,
      ctaLabel: "Verify Email",
      ctaUrl: url,
      footer: "Card Leo Rewards uses email verification to help secure your account.",
    }),
    text: buildTextFallback([
      "Verify your Card Leo Rewards email.",
      `Hello ${clean(fullName || "Member")}, confirm your email to finish setup.`,
      safeCode ? `Verification code: ${safeCode}` : "",
      `Verification link: ${url}`,
    ]),
  };
}

export function buildSupportConfirmationEmail({
  fullName = "",
  ticketId = "",
  subjectLine = "",
} = {}) {
  const name = escapeHtml(fullName || "Member");
  const subjectSafe = escapeHtml(subjectLine || "Support Request");

  return {
    subject: "We received your Card Leo Rewards support request",
    html: wrapEmailTemplate({
      eyebrow: "Support",
      title: "Your request has been received.",
      intro: `Hello ${name}, our team has received your support message and will review it shortly.`,
      body: `
        <p><strong>Subject:</strong> ${subjectSafe}</p>
        ${
          ticketId
            ? `<p><strong>Reference ID:</strong> <span class="code">${escapeHtml(ticketId)}</span></p>`
            : ""
        }
        <p class="meta">Keep this confirmation for your records. Our support team will respond as soon as possible.</p>
      `,
      footer: "Thank you for contacting Card Leo Rewards support.",
    }),
    text: buildTextFallback([
      "We received your Card Leo Rewards support request.",
      `Hello ${clean(fullName || "Member")}, our team will review your message shortly.`,
      clean(subjectLine) ? `Subject: ${clean(subjectLine)}` : "",
      clean(ticketId) ? `Reference ID: ${clean(ticketId)}` : "",
    ]),
  };
}

export async function sendEmail({
  to,
  cc,
  bcc,
  subject,
  html,
  text = "",
  from,
  replyTo,
} = {}) {
  const env = getServerEnv();

  const recipients = validateEmailList(to, "recipient");
  const ccList = cc ? validateEmailList(cc, "cc") : [];
  const bccList = bcc ? validateEmailList(bcc, "bcc") : [];

  const finalFrom = normalizeEmail(from || env.fromEmail);
  if (!isValidEmail(finalFrom)) {
    throw new Error("A valid FROM_EMAIL is required to send email.");
  }

  const finalReplyTo = clean(replyTo || env.supportEmail);
  const useResend = clean(env.resendApiKey);

  if (!clean(subject)) {
    throw new Error("Email subject is required.");
  }

  if (!clean(html) && !clean(text)) {
    throw new Error("Email html or text content is required.");
  }

  const payload = {
    from: finalFrom,
    to: recipients,
    cc: ccList,
    bcc: bccList,
    subject: clean(subject),
    html: clean(html),
    text: clean(text),
    reply_to: finalReplyTo && isValidEmail(finalReplyTo) ? finalReplyTo : undefined,
  };

  if (!useResend) {
    logger.warn("RESEND_API_KEY not configured. Email send skipped.", {
      to: recipients,
      subject: payload.subject,
    });

    return {
      success: true,
      skipped: true,
      provider: "none",
      message: "Email sending skipped because RESEND_API_KEY is not configured.",
      payload,
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${useResend}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    logger.error("Email send failed.", {
      status: response.status,
      subject: payload.subject,
      to: recipients,
      response: data,
    });

    throw new Error(
      data?.message ||
        `Email provider request failed with status ${response.status}.`
    );
  }

  logger.info("Email sent successfully.", {
    subject: payload.subject,
    to: recipients,
    provider: "resend",
    id: data?.id || null,
  });

  return {
    success: true,
    skipped: false,
    provider: "resend",
    id: data?.id || null,
    data,
  };
}

export async function sendWelcomeEmail({ to, fullName, dashboardUrl } = {}) {
  const email = buildWelcomeEmail({ fullName, dashboardUrl });
  return sendEmail({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

export async function sendResetPasswordEmail({
  to,
  fullName,
  resetUrl,
  code,
  expiresInMinutes,
} = {}) {
  const email = buildResetPasswordEmail({
    fullName,
    resetUrl,
    code,
    expiresInMinutes,
  });

  return sendEmail({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

export async function sendVerifyEmail({
  to,
  fullName,
  verifyUrl,
  code,
} = {}) {
  const email = buildVerifyEmailMessage({
    fullName,
    verifyUrl,
    code,
  });

  return sendEmail({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

export async function sendSupportConfirmation({
  to,
  fullName,
  ticketId,
  subjectLine,
} = {}) {
  const email = buildSupportConfirmationEmail({
    fullName,
    ticketId,
    subjectLine,
  });

  return sendEmail({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

export default {
  buildWelcomeEmail,
  buildResetPasswordEmail,
  buildVerifyEmailMessage,
  buildSupportConfirmationEmail,
  sendEmail,
  sendWelcomeEmail,
  sendResetPasswordEmail,
  sendVerifyEmail,
  sendSupportConfirmation,
};