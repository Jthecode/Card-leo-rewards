// assets/js/portal-support.js
(function () {
  const CONFIG = {
    meEndpoint: "/api/auth/me",
    supportEndpoint: "/api/portal/support",
    logoutEndpoint: "/api/auth/logout",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      autoBindLogout: true,
      debug: false,
    },
  };

  const ACTIVE_STATUSES = new Set(["active", "approved", "invited"]);

  const state = {
    member: null,
    profile: null,
    support: null,
    summary: null,
    tickets: [],
    faqs: [],
    announcements: [],
    channels: [],
    guidance: [],
    raw: null,
    isLoading: false,
    isSubmitting: false,
    initialFormValues: null,
    authReady: false,
  };

  function normalizeText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function unwrapApiPayload(payload) {
    if (!isObject(payload)) return {};
    return isObject(payload.data) ? payload.data : payload;
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
    return String(value || "")
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "—";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "—";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));
    const data = unwrapApiPayload(payload);

    return {
      response,
      payload,
      data,
      message: normalizeText(payload?.message || data?.message),
    };
  }

  function redirectToLogin() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.loginPage}?next=${encodeURIComponent(next)}`;
  }

  function redirectToUnauthorized() {
    const next = `${window.location.pathname}${window.location.search || ""}`;
    window.location.href = `${CONFIG.unauthorizedPage}?next=${encodeURIComponent(next)}`;
  }

  function setText(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setValue(selector, value) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      if ("value" in node) {
        node.value = value ?? "";
      } else {
        node.textContent = normalizeText(value);
      }
    });
  }

  function setHidden(selector, hidden) {
    if (!selector) return;

    document.querySelectorAll(selector).forEach((node) => {
      node.hidden = Boolean(hidden);
    });
  }

  function setFormDisabled(form, disabled) {
    if (!form) return;

    Array.from(form.elements || []).forEach((node) => {
      if (node.dataset.keepEnabled === "true") return;
      node.disabled = Boolean(disabled);
    });
  }

  function getStatusNode(form = null) {
    return (
      form?.querySelector("[data-support-status]") ||
      document.querySelector("[data-support-status]") ||
      document.querySelector("[data-support-page-status]") ||
      document.querySelector("#support-status") ||
      document.querySelector("#support-page-status")
    );
  }

  function setStatus(target, type, message) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = false;
    el.textContent = normalizeText(message);
    el.dataset.state = type || "info";

    el.style.display = "block";
    el.style.padding = "14px 16px";
    el.style.borderRadius = "16px";
    el.style.marginTop = "12px";
    el.style.fontSize = "0.95rem";
    el.style.lineHeight = "1.5";
    el.style.border = "1px solid rgba(255,255,255,0.08)";

    if (type === "success") {
      el.style.background = "rgba(34, 197, 94, 0.10)";
      el.style.color = "#d9ffe8";
      el.style.borderColor = "rgba(34, 197, 94, 0.28)";
    } else if (type === "error") {
      el.style.background = "rgba(239, 68, 68, 0.10)";
      el.style.color = "#ffe2e2";
      el.style.borderColor = "rgba(239, 68, 68, 0.28)";
    } else {
      el.style.background = "rgba(216, 176, 94, 0.10)";
      el.style.color = "#f4ead3";
      el.style.borderColor = "rgba(216, 176, 94, 0.25)";
    }
  }

  function clearStatus(target) {
    const el = typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function getErrorMessage(result, fallback = "Something went wrong.") {
    const data = result?.data || {};
    const payload = result?.payload || {};

    const direct =
      normalizeText(payload.message) ||
      normalizeText(data.message) ||
      normalizeText(payload.error) ||
      normalizeText(data.error);

    if (direct) return direct;

    const errors = data.errors || payload.errors || data.details || payload.details;

    if (isObject(errors)) {
      const first = Object.values(errors).find(Boolean);
      if (first) return normalizeText(first, fallback);
    }

    return fallback;
  }

  function getFullName(member = {}, profile = {}) {
    const fullName =
      normalizeText(member.fullName) ||
      normalizeText(member.full_name) ||
      normalizeText(member.name) ||
      normalizeText(profile.fullName) ||
      normalizeText(profile.full_name) ||
      normalizeText(profile.name);

    if (fullName) return fullName;

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      normalizeText(profile.firstName || profile.first_name);

    const lastName =
      normalizeText(member.lastName || member.last_name) ||
      normalizeText(profile.lastName || profile.last_name);

    return [firstName, lastName].filter(Boolean).join(" ") || "Card Leo Member";
  }

  function getMemberStatus(member = {}, profile = {}) {
    return normalizeText(
      member.memberStatus ||
        member.member_status ||
        member.status ||
        profile.memberStatus ||
        profile.member_status ||
        profile.status ||
        "active"
    ).toLowerCase();
  }

  function getPortalAccess(member = {}, profile = {}) {
    if (typeof member.portalAccess === "boolean") return member.portalAccess;
    if (typeof member.portal_access === "boolean") return member.portal_access;

    return ACTIVE_STATUSES.has(getMemberStatus(member, profile));
  }

  function normalizeMember(member = {}, profile = {}) {
    const safeMember = isObject(member) ? member : {};
    const safeProfile = isObject(profile) ? profile : {};
    const fullName = getFullName(safeMember, safeProfile);
    const status = getMemberStatus(safeMember, safeProfile);
    const tier = normalizeText(
      safeMember.tier ||
        safeMember.accessLevel ||
        safeMember.access_level ||
        safeProfile.tier ||
        "core"
    ).toLowerCase();

    return {
      ...safeMember,
      id:
        safeMember.id ||
        safeMember.signupId ||
        safeMember.signup_id ||
        safeProfile.id ||
        "",
      signupId:
        safeMember.signupId ||
        safeMember.signup_id ||
        safeMember.id ||
        safeProfile.signupId ||
        safeProfile.signup_id ||
        safeProfile.id ||
        "",
      portalUserId: safeMember.portalUserId || safeMember.portal_user_id || "",
      firstName:
        safeMember.firstName ||
        safeMember.first_name ||
        safeProfile.firstName ||
        safeProfile.first_name ||
        fullName.split(/\s+/)[0] ||
        "Member",
      lastName:
        safeMember.lastName ||
        safeMember.last_name ||
        safeProfile.lastName ||
        safeProfile.last_name ||
        "",
      fullName,
      full_name: fullName,
      name: fullName,
      email: normalizeEmail(safeMember.email || safeProfile.email),
      phone: safeMember.phone || safeProfile.phone || "",
      city: safeMember.city || safeProfile.city || "",
      state: safeMember.state || safeProfile.state || "",
      status,
      memberStatus: status,
      member_status: status,
      tier,
      tierLabel: titleCase(tier),
      portalAccess: getPortalAccess({ ...safeMember, status }, safeProfile),
      accessLevel: safeMember.accessLevel || safeMember.access_level || tier || "member",
      joinedAt:
        safeMember.joinedAt ||
        safeMember.joined_at ||
        safeMember.createdAt ||
        safeMember.created_at ||
        null,
    };
  }

  function buildDefaultFaq() {
    return [
      {
        id: "faq-1",
        question: "How do I get help with rewards or benefits?",
        answer:
          "Use the support form in your member portal and choose the most relevant category so your request can be routed correctly.",
        category: "General",
      },
      {
        id: "faq-2",
        question: "Where will I receive support updates?",
        answer:
          "Updates are typically sent by email or through the response method you select when submitting your request.",
        category: "Account",
      },
      {
        id: "faq-3",
        question: "What should I include in my support request?",
        answer:
          "Include your issue, what page you were on, any error message you saw, and the best way to contact you.",
        category: "Support",
      },
    ];
  }

  function buildDefaultSupport(member = {}) {
    return {
      email: "support@cardleorewards.com",
      phone: "",
      hours: "Mon–Fri, 9:00 AM–6:00 PM",
      responseTime: "24–48 hours",
      defaultTopic: "general",
      priorityTier: titleCase(member.tier || member.accessLevel || "member"),
      primaryRoute: "Member Support",
      channels: [
        {
          label: "Email",
          value: "support@cardleorewards.com",
        },
        {
          label: "Portal",
          value: "Member Support Center",
        },
        {
          label: "Availability",
          value: "Mon–Fri, 9:00 AM–6:00 PM",
        },
      ],
      guidance: [
        "Use this page for account questions, rewards questions, benefit access, profile updates, and technical issues.",
        "Include screenshots or exact error messages when possible.",
      ],
      faq: buildDefaultFaq(),
      recentRequests: [],
    };
  }

  function inferSupportPayload(payload, fallback = {}) {
    const data = unwrapApiPayload(payload);

    const fallbackMember = isObject(fallback.member) ? fallback.member : {};
    const fallbackProfile = isObject(fallback.profile) ? fallback.profile : {};
    const fallbackSupport = isObject(fallback.support) ? fallback.support : {};

    const member = normalizeMember(
      {
        ...fallbackMember,
        ...(isObject(data.member) ? data.member : {}),
      },
      {
        ...fallbackProfile,
        ...(isObject(data.profile) ? data.profile : {}),
      }
    );

    const profile =
      (isObject(data.profile) && data.profile) ||
      fallbackProfile ||
      {};

    const defaultSupport = buildDefaultSupport(member);

    const support = {
      ...defaultSupport,
      ...fallbackSupport,
      ...(isObject(data.support) ? data.support : {}),
    };

    const request = isObject(data.request) ? data.request : null;

    const tickets = Array.isArray(data.tickets)
      ? data.tickets
      : Array.isArray(data.recentRequests)
        ? data.recentRequests
        : Array.isArray(support.recentRequests)
          ? support.recentRequests
          : Array.isArray(support.tickets)
            ? support.tickets
            : [];

    const nextTickets = request
      ? [request, ...tickets.filter((item) => item?.id !== request.id)]
      : tickets;

    const faqs = Array.isArray(data.faqs)
      ? data.faqs
      : Array.isArray(support.faq)
        ? support.faq
        : Array.isArray(support.faqs)
          ? support.faqs
          : buildDefaultFaq();

    const announcements = Array.isArray(data.announcements)
      ? data.announcements
      : Array.isArray(data.notices)
        ? data.notices
        : Array.isArray(support.announcements)
          ? support.announcements
          : [];

    const channels = Array.isArray(support.channels)
      ? support.channels
      : defaultSupport.channels;

    const guidance = Array.isArray(support.guidance)
      ? support.guidance
      : defaultSupport.guidance;

    const summary = isObject(data.summary) ? data.summary : {};

    return {
      member,
      profile,
      support,
      summary,
      tickets: nextTickets,
      faqs,
      announcements,
      channels,
      guidance,
      raw: data,
    };
  }

  function applyMember(member = {}) {
    state.member = normalizeMember(member, state.profile || {});

    const fullName = state.member.fullName || "Card Leo Member";
    const firstName = state.member.firstName || fullName.split(/\s+/)[0] || "Member";
    const statusLabel = titleCase(state.member.memberStatus || state.member.status || "active");
    const accessLevel = state.member.accessLevel || state.member.tier || "member";

    setText("[data-member-name]", fullName);
    setText("[data-member-full-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", state.member.email || "");
    setText("[data-member-status]", statusLabel);
    setText("[data-member-tier]", titleCase(state.member.tier || "core"));
    setText("[data-member-access-level]", titleCase(accessLevel));
    setText("[data-member-accesslevel]", titleCase(accessLevel));
    setText("[data-member-joined-at]", formatDate(state.member.joinedAt));

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = state.member.email || "";
    document.body.dataset.memberStatus = state.member.memberStatus || "";
    document.body.dataset.memberTier = state.member.tier || "";
    document.body.dataset.memberId = state.member.id || state.member.signupId || "";
  }

  function applySupport(support = {}) {
    state.support = isObject(support) ? support : buildDefaultSupport(state.member || {});

    const email = normalizeText(state.support.email, "support@cardleorewards.com");
    const phone = normalizeText(state.support.phone, "Not listed");
    const hours = normalizeText(state.support.hours, "Mon–Fri, 9:00 AM–6:00 PM");
    const responseTime = normalizeText(state.support.responseTime || state.support.response_time, "24–48 hours");
    const defaultTopic = normalizeText(state.support.defaultTopic || state.support.default_topic, "General Support");
    const priorityTier = normalizeText(state.support.priorityTier || state.support.priority, "Premium");
    const primaryRoute = normalizeText(state.support.primaryRoute || state.support.channel, "Member Support");

    setText("[data-support-email]", email);
    setText("[data-support-phone]", phone);
    setText("[data-support-hours]", hours);
    setText("[data-support-response-time]", responseTime);
    setText("[data-support-topic-default]", titleCase(defaultTopic));
    setText("[data-support-priority-tier]", titleCase(priorityTier));
    setText("[data-support-primary-route]", primaryRoute);

    document.querySelectorAll("[data-support-email-link]").forEach((node) => {
      node.textContent = email;
      node.href = `mailto:${email}`;
    });
  }

  function normalizeTicket(ticket = {}, index = 0) {
    const metadata = isObject(ticket.metadata) ? ticket.metadata : {};

    return {
      id: normalizeText(ticket.id || ticket.ticketId || metadata.ticketId || `ticket-${index + 1}`),
      subject:
        normalizeText(ticket.subject || ticket.title || metadata.subject || ticket.topic) ||
        `Support Request ${index + 1}`,
      message:
        normalizeText(ticket.message || ticket.description || ticket.summary || metadata.message) ||
        "Support request submitted.",
      category:
        normalizeText(ticket.category || metadata.category || ticket.topic || "general"),
      topic:
        normalizeText(ticket.topic || ticket.category || metadata.category || "General Support"),
      priority:
        normalizeText(ticket.priority || metadata.priority || "normal"),
      preferredResponse:
        normalizeText(
          ticket.preferredResponse ||
            ticket.preferred_response ||
            metadata.preferredResponse ||
            ""
        ),
      status: normalizeText(ticket.status || metadata.status || "open"),
      createdAt:
        ticket.createdAt ||
        ticket.created_at ||
        ticket.submittedAt ||
        ticket.submitted_at ||
        metadata.createdAt ||
        null,
      updatedAt:
        ticket.updatedAt ||
        ticket.updated_at ||
        ticket.lastReplyAt ||
        ticket.last_reply_at ||
        metadata.updatedAt ||
        null,
      resolution:
        normalizeText(ticket.resolution || ticket.response || ticket.note || metadata.latestNote) || "",
    };
  }

  function normalizeFaq(faq = {}, index = 0) {
    return {
      id: normalizeText(faq.id || `faq-${index + 1}`),
      question:
        normalizeText(faq.question || faq.title) || `Support question ${index + 1}`,
      answer:
        normalizeText(faq.answer || faq.description || faq.body) ||
        "Answer coming soon.",
      category: normalizeText(faq.category || "General"),
    };
  }

  function normalizeAnnouncement(item = {}, index = 0) {
    return {
      id: normalizeText(item.id || `announcement-${index + 1}`),
      title:
        normalizeText(item.title || item.label || item.name) ||
        `Announcement ${index + 1}`,
      message:
        normalizeText(item.message || item.description || item.summary || item.body) ||
        "Important support update.",
      createdAt:
        item.createdAt || item.created_at || item.date || item.publishedAt || null,
    };
  }

  function normalizeChannel(channel = {}, index = 0) {
    if (!isObject(channel)) {
      return {
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        value: normalizeText(channel, "Member Support"),
      };
    }

    return {
      id: normalizeText(channel.id || `channel-${index + 1}`),
      label: normalizeText(channel.label || channel.name || `Channel ${index + 1}`),
      value: normalizeText(channel.value || channel.description || channel.email || channel.phone || ""),
    };
  }

  function ticketTone(status) {
    const value = normalizeText(status).toLowerCase();

    if (["resolved", "closed", "completed", "done"].includes(value)) return "success";
    if (["pending", "in review", "awaiting reply", "waiting", "new"].includes(value)) return "warning";
    if (["open", "active", "submitted", "received"].includes(value)) return "primary";

    return "secondary";
  }

  function badgeStyles(tone) {
    if (tone === "success") {
      return {
        background: "rgba(34,197,94,0.12)",
        color: "#d8ffe6",
        border: "1px solid rgba(34,197,94,0.25)",
      };
    }

    if (tone === "warning") {
      return {
        background: "rgba(216,176,94,0.12)",
        color: "#f4ead3",
        border: "1px solid rgba(216,176,94,0.24)",
      };
    }

    if (tone === "secondary") {
      return {
        background: "rgba(255,255,255,0.06)",
        color: "#f8f3e8",
        border: "1px solid rgba(255,255,255,0.10)",
      };
    }

    return {
      background: "rgba(59,130,246,0.12)",
      color: "#dbeafe",
      border: "1px solid rgba(59,130,246,0.25)",
    };
  }

  function renderTickets(tickets = []) {
    const containers = document.querySelectorAll(
      "[data-support-tickets], #support-tickets, #portal-support-tickets"
    );

    if (!containers.length) return;

    const normalized = tickets.map(normalizeTicket);

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!normalized.length) {
        const empty = document.createElement("div");
        empty.style.padding = "18px";
        empty.style.borderRadius = "18px";
        empty.style.background = "rgba(255,255,255,0.03)";
        empty.style.border = "1px solid rgba(255,255,255,0.08)";
        empty.style.color = "rgba(244,234,211,0.76)";
        empty.innerHTML = `
          <strong style="display:block;color:#f8f3e8;font-size:1rem;margin-bottom:8px;">
            No support requests yet
          </strong>
          <span>Your recent support tickets will appear here after you submit one.</span>
        `;
        container.appendChild(empty);
        return;
      }

      normalized.forEach((ticket) => {
        const tone = ticketTone(ticket.status);
        const badge = badgeStyles(tone);

        const card = document.createElement("article");
        card.style.display = "grid";
        card.style.gap = "12px";
        card.style.padding = "18px";
        card.style.borderRadius = "18px";
        card.style.background =
          "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02))";
        card.style.border = "1px solid rgba(255,255,255,0.08)";

        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
            <div>
              <strong style="display:block;color:#f8f3e8;font-size:1rem;margin-bottom:5px;">
                ${escapeHtml(ticket.subject)}
              </strong>
              <span style="color:rgba(244,234,211,0.7);font-size:0.92rem;">
                ${escapeHtml(titleCase(ticket.category || ticket.topic))} • ${escapeHtml(ticket.id)}
              </span>
            </div>

            <span style="
              display:inline-flex;
              align-items:center;
              justify-content:center;
              padding:8px 12px;
              border-radius:999px;
              font-size:0.78rem;
              font-weight:700;
              letter-spacing:0.04em;
              background:${badge.background};
              color:${badge.color};
              border:${badge.border};
            ">
              ${escapeHtml(titleCase(ticket.status))}
            </span>
          </div>

          <div style="color:rgba(244,234,211,0.8);line-height:1.65;font-size:0.95rem;">
            ${escapeHtml(ticket.message)}
          </div>

          <div style="display:grid;gap:6px;color:rgba(244,234,211,0.7);font-size:0.9rem;">
            <div><strong style="color:#f4ead3;">Priority:</strong> ${escapeHtml(titleCase(ticket.priority))}</div>
            <div><strong style="color:#f4ead3;">Preferred response:</strong> ${escapeHtml(titleCase(ticket.preferredResponse || "Email"))}</div>
            <div><strong style="color:#f4ead3;">Submitted:</strong> ${escapeHtml(formatDateTime(ticket.createdAt))}</div>
            <div><strong style="color:#f4ead3;">Last update:</strong> ${escapeHtml(formatDateTime(ticket.updatedAt || ticket.createdAt))}</div>
            ${
              ticket.resolution
                ? `<div><strong style="color:#f4ead3;">Latest note:</strong> ${escapeHtml(ticket.resolution)}</div>`
                : ""
            }
          </div>
        `;

        container.appendChild(card);
      });
    });

    setText("[data-support-ticket-count]", String(normalized.length));
  }

  function renderFaqs(faqs = []) {
    const containers = document.querySelectorAll(
      "[data-support-faqs], #support-faqs, #portal-support-faqs"
    );

    if (!containers.length) return;

    const normalized = faqs.length ? faqs.map(normalizeFaq) : buildDefaultFaq();

    containers.forEach((container) => {
      container.innerHTML = "";

      normalized.forEach((faq) => {
        const item = document.createElement("details");
        item.style.padding = "16px 18px";
        item.style.borderRadius = "18px";
        item.style.background = "rgba(255,255,255,0.03)";
        item.style.border = "1px solid rgba(255,255,255,0.08)";

        item.innerHTML = `
          <summary style="cursor:pointer;color:#f8f3e8;font-weight:700;list-style:none;">
            <span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span>${escapeHtml(faq.question)}</span>
              <span style="
                padding:5px 9px;
                border-radius:999px;
                font-size:0.72rem;
                font-weight:700;
                letter-spacing:0.04em;
                background:rgba(216,176,94,0.12);
                color:#f4ead3;
                border:1px solid rgba(216,176,94,0.24);
              ">${escapeHtml(titleCase(faq.category))}</span>
            </span>
          </summary>
          <div style="margin-top:12px;color:rgba(244,234,211,0.78);line-height:1.7;">
            ${escapeHtml(faq.answer)}
          </div>
        `;

        container.appendChild(item);
      });
    });
  }

  function renderAnnouncements(items = []) {
    const containers = document.querySelectorAll(
      "[data-support-announcements], #support-announcements, #portal-support-announcements"
    );

    if (!containers.length) return;

    const normalized = items.map(normalizeAnnouncement);

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!normalized.length) {
        const empty = document.createElement("div");
        empty.style.padding = "18px";
        empty.style.borderRadius = "18px";
        empty.style.background = "rgba(255,255,255,0.03)";
        empty.style.border = "1px solid rgba(255,255,255,0.08)";
        empty.style.color = "rgba(244,234,211,0.76)";
        empty.textContent = "There are no new support announcements right now.";
        container.appendChild(empty);
        return;
      }

      normalized.forEach((item) => {
        const card = document.createElement("article");
        card.style.display = "grid";
        card.style.gap = "8px";
        card.style.padding = "18px";
        card.style.borderRadius = "18px";
        card.style.background =
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))";
        card.style.border = "1px solid rgba(255,255,255,0.08)";

        card.innerHTML = `
          <strong style="color:#f8f3e8;font-size:1rem;">
            ${escapeHtml(item.title)}
          </strong>
          <span style="color:rgba(244,234,211,0.78);line-height:1.65;">
            ${escapeHtml(item.message)}
          </span>
          <span style="color:rgba(244,234,211,0.62);font-size:0.88rem;">
            ${escapeHtml(formatDateTime(item.createdAt))}
          </span>
        `;

        container.appendChild(card);
      });
    });
  }

  function renderChannels(channels = []) {
    const containers = document.querySelectorAll(
      "[data-support-channels], #support-channels, #portal-support-channels"
    );

    if (!containers.length) return;

    const normalized = channels.map(normalizeChannel);

    containers.forEach((container) => {
      container.innerHTML = normalized
        .map(
          (channel) => `
            <div style="
              padding:16px;
              border-radius:18px;
              background:rgba(255,255,255,0.03);
              border:1px solid rgba(255,255,255,0.08);
            ">
              <strong style="display:block;color:#f8f3e8;margin-bottom:6px;">
                ${escapeHtml(channel.label)}
              </strong>
              <span style="color:rgba(244,234,211,0.75);line-height:1.6;">
                ${escapeHtml(channel.value)}
              </span>
            </div>
          `
        )
        .join("");
    });
  }

  function renderGuidance(guidance = []) {
    const containers = document.querySelectorAll(
      "[data-support-guidance], #support-guidance, #portal-support-guidance"
    );

    if (!containers.length) return;

    const list = Array.isArray(guidance) ? guidance : [];

    containers.forEach((container) => {
      container.innerHTML = list
        .map(
          (item) => `
            <li style="margin-bottom:8px;color:rgba(244,234,211,0.78);line-height:1.6;">
              ${escapeHtml(item)}
            </li>
          `
        )
        .join("");
    });
  }

  function getSupportForm() {
    return (
      document.querySelector("[data-support-form]") ||
      document.querySelector("#portal-support-form") ||
      document.querySelector("#support-form") ||
      null
    );
  }

  function buildInitialFormValues(member = {}, support = {}) {
    return {
      name: member.fullName || member.name || "",
      email: member.email || "",
      category: normalizeText(support.defaultTopic || support.default_topic || "general"),
      priority: "normal",
      preferredResponse: "email",
      subject: "",
      message: "",
    };
  }

  function applyFormDefaults(member = {}, support = {}) {
    const form = getSupportForm();
    if (!form) return;

    state.initialFormValues = buildInitialFormValues(member, support);

    setValue('[name="name"], [data-support-field="name"]', state.initialFormValues.name);
    setValue('[name="email"], [data-support-field="email"]', state.initialFormValues.email);

    setValue('[name="category"], [data-support-field="category"]', state.initialFormValues.category);
    setValue('[name="topic"], [data-support-field="topic"]', state.initialFormValues.category);

    setValue('[name="priority"], [data-support-field="priority"]', state.initialFormValues.priority);
    setValue(
      '[name="preferredResponse"], [data-support-field="preferredResponse"]',
      state.initialFormValues.preferredResponse
    );

    setValue('[name="subject"], [data-support-field="subject"]', "");
    setValue('[name="message"], [data-support-field="message"]', "");

    const emailField =
      form.querySelector('[name="email"]') ||
      form.querySelector('[data-support-field="email"]');

    if (emailField) {
      emailField.readOnly = true;
    }
  }

  function restoreInitialForm(form) {
    if (!form || !state.initialFormValues) return;

    setValue('[name="name"], [data-support-field="name"]', state.initialFormValues.name);
    setValue('[name="email"], [data-support-field="email"]', state.initialFormValues.email);

    setValue('[name="category"], [data-support-field="category"]', state.initialFormValues.category);
    setValue('[name="topic"], [data-support-field="topic"]', state.initialFormValues.category);

    setValue('[name="priority"], [data-support-field="priority"]', state.initialFormValues.priority);
    setValue(
      '[name="preferredResponse"], [data-support-field="preferredResponse"]',
      state.initialFormValues.preferredResponse
    );

    setValue('[name="subject"], [data-support-field="subject"]', "");
    setValue('[name="message"], [data-support-field="message"]', "");
  }

  function readField(form, ...names) {
    for (const name of names) {
      const field =
        form.querySelector(`[name="${name}"]`) ||
        form.querySelector(`[data-support-field="${name}"]`);

      if (field) {
        return normalizeText(field.value || "");
      }
    }

    return "";
  }

  function collectSupportPayload(form) {
    const category = readField(form, "category", "topic") || "general";

    return {
      name: readField(form, "name"),
      email: readField(form, "email"),
      topic: category,
      category,
      priority: readField(form, "priority") || "normal",
      preferredResponse: readField(form, "preferredResponse", "preferred_response") || "email",
      subject: readField(form, "subject"),
      message: readField(form, "message"),
    };
  }

  function validateSupportPayload(payload) {
    if (!payload.name) {
      return "Your name is required.";
    }

    if (!payload.email) {
      return "Your email is required.";
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return "Please enter a valid email address.";
    }

    if (!payload.category) {
      return "Please select a support category.";
    }

    if (!payload.subject) {
      return "Please enter a subject for your request.";
    }

    if (payload.subject.length < 3) {
      return "Your subject must be at least 3 characters long.";
    }

    if (payload.subject.length > 120) {
      return "Your subject must be 120 characters or fewer.";
    }

    if (!payload.message) {
      return "Please describe how we can help.";
    }

    if (payload.message.length < 10) {
      return "Please provide a little more detail in your message.";
    }

    if (payload.message.length > 2500) {
      return "Support message must be 2500 characters or fewer.";
    }

    return "";
  }

  function renderPayload(payload, fallback = {}) {
    const parsed = inferSupportPayload(payload, fallback);

    state.raw = parsed.raw;
    state.profile = parsed.profile;
    state.summary = parsed.summary;
    state.tickets = parsed.tickets;
    state.faqs = parsed.faqs;
    state.announcements = parsed.announcements;
    state.channels = parsed.channels;
    state.guidance = parsed.guidance;

    applyMember(parsed.member);
    applySupport(parsed.support);
    applyFormDefaults(parsed.member, parsed.support);
    renderTickets(parsed.tickets);
    renderFaqs(parsed.faqs);
    renderAnnouncements(parsed.announcements);
    renderChannels(parsed.channels);
    renderGuidance(parsed.guidance);

    setHidden("[data-support-loading]", true);
    setHidden("[data-support-ready]", false);

    return parsed;
  }

  async function loadSessionFirst() {
    const result = await fetchJson(CONFIG.meEndpoint, {
      method: "GET",
    });

    if (!result.response.ok) {
      throw new Error(getErrorMessage(result, "Unable to verify your session."));
    }

    if (result.data.authenticated !== true) {
      redirectToLogin();
      return null;
    }

    if (!isObject(result.data.member) && !isObject(result.data.profile)) {
      throw new Error("Your session is active, but your member details were not returned.");
    }

    const member = normalizeMember(
      result.data.member || result.data.profile || {},
      result.data.profile || {}
    );

    const support = buildDefaultSupport(member);

    return renderPayload({
      success: true,
      data: {
        member,
        profile: result.data.profile || null,
        summary: {
          accessLevel: member.accessLevel || member.tier || "member",
          statusLabel: member.memberStatus || member.status || "active",
          recentRequestCount: 0,
        },
        support,
      },
    });
  }

  async function loadSupportEnhancement(fallbackPayload) {
    try {
      const result = await fetchJson(CONFIG.supportEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return null;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return null;
      }

      if (!result.response.ok) {
        return fallbackPayload || null;
      }

      return renderPayload(result.payload, fallbackPayload || {});
    } catch (error) {
      console.warn("[portal-support] enhancement skipped:", error);
      return fallbackPayload || null;
    }
  }

  async function loadSupport() {
    if (state.isLoading) return false;

    state.isLoading = true;

    const pageStatus = getStatusNode();
    clearStatus(pageStatus);
    setHidden("[data-support-loading]", false);

    try {
      const sessionPayload = await loadSessionFirst();

      if (!sessionPayload) return false;

      await loadSupportEnhancement(sessionPayload);

      return true;
    } catch (error) {
      renderTickets([]);
      renderFaqs(buildDefaultFaq());
      renderAnnouncements([]);

      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal support page."
      );

      return false;
    } finally {
      state.isLoading = false;
      setHidden("[data-support-loading]", true);
    }
  }

  async function submitSupport(form) {
    if (state.isSubmitting || !form) return;

    const statusNode = getStatusNode(form);
    clearStatus(statusNode);

    const payload = collectSupportPayload(form);
    const validationError = validateSupportPayload(payload);

    if (validationError) {
      setStatus(statusNode, "error", validationError);
      return;
    }

    state.isSubmitting = true;

    const submitButton =
      form.querySelector('[type="submit"]') ||
      form.querySelector("[data-support-submit]");

    const originalSubmitText = submitButton?.textContent || "Submit Request";

    setFormDisabled(form, true);

    if (submitButton) {
      submitButton.textContent = "Submitting...";
      submitButton.disabled = true;
    }

    try {
      const result = await fetchJson(CONFIG.supportEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        redirectToLogin();
        return;
      }

      if (result.response.status === 403) {
        redirectToUnauthorized();
        return;
      }

      if (!result.response.ok) {
        throw new Error(getErrorMessage(result, "Unable to submit your support request."));
      }

      const parsed = renderPayload(result.payload, {
        member: state.member || {},
        profile: state.profile || {},
        support: state.support || {},
        tickets: state.tickets || [],
        faqs: state.faqs || [],
        announcements: state.announcements || [],
      });

      restoreInitialForm(form);

      const event = new CustomEvent("cardleo:support-submitted", {
        detail: {
          member: parsed.member,
          support: parsed.support,
          tickets: parsed.tickets,
          payload: result.payload,
        },
      });

      window.dispatchEvent(event);

      setStatus(
        statusNode,
        "success",
        result.message || "Your support request has been submitted successfully."
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not submit your support request right now."
      );
    } finally {
      state.isSubmitting = false;
      setFormDisabled(form, false);

      const emailField =
        form.querySelector('[name="email"]') ||
        form.querySelector('[data-support-field="email"]');

      if (emailField) {
        emailField.readOnly = true;
      }

      if (submitButton) {
        submitButton.textContent = originalSubmitText;
        submitButton.disabled = false;
      }
    }
  }

  function styleActionButton(button, tone = "primary") {
    button.style.border = "0";
    button.style.borderRadius = "14px";
    button.style.padding = "11px 14px";
    button.style.fontWeight = "700";
    button.style.cursor = "pointer";
    button.style.transition = "transform 0.18s ease, opacity 0.18s ease";

    if (tone === "secondary") {
      button.style.background = "rgba(255,255,255,0.05)";
      button.style.color = "#f4ead3";
      button.style.border = "1px solid rgba(255,255,255,0.1)";
    } else {
      button.style.background =
        "linear-gradient(135deg, rgba(216,176,94,0.95), rgba(162,124,48,0.96))";
      button.style.color = "#140f07";
      button.style.boxShadow = "0 14px 30px rgba(216,176,94,0.18)";
    }
  }

  function bindSupportForm() {
    const form = getSupportForm();

    if (!form || form.dataset.supportBound === "true") return;

    form.dataset.supportBound = "true";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitSupport(form);
    });

    form.addEventListener("reset", (event) => {
      event.preventDefault();
      restoreInitialForm(form);
      clearStatus(getStatusNode(form));
    });
  }

  function bindLogoutButtons() {
    if (window.CardLeoAuthGuard?.bindLogoutButtons) {
      window.CardLeoAuthGuard.bindLogoutButtons(CONFIG.authGuardOptions);
      return;
    }

    document.querySelectorAll("[data-logout], [data-member-logout]").forEach((button) => {
      if (button.dataset.supportLogoutBound === "true") return;

      button.dataset.supportLogoutBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        try {
          await fetch(CONFIG.logoutEndpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json",
            },
          });
        } catch {
          // Still redirect.
        }

        window.location.href = CONFIG.loginPage;
      });
    });
  }

  function bindRefreshButtons() {
    document.querySelectorAll("[data-support-refresh]").forEach((button) => {
      if (button.dataset.supportRefreshBound === "true") return;

      button.dataset.supportRefreshBound = "true";

      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const originalText = "value" in button ? button.value : button.textContent;

        try {
          if ("disabled" in button) button.disabled = true;

          if ("value" in button) {
            button.value = "Refreshing...";
          } else {
            button.textContent = "Refreshing...";
          }

          await loadSupport();
        } finally {
          if ("disabled" in button) button.disabled = false;

          if ("value" in button) {
            button.value = originalText;
          } else {
            button.textContent = originalText;
          }
        }
      });
    });
  }

  function styleStaticButtons() {
    document
      .querySelectorAll(
        "[data-support-submit], [data-support-reset], [data-support-refresh]"
      )
      .forEach((button) => {
        styleActionButton(
          button,
          button.matches("[data-support-reset]") ? "secondary" : "primary"
        );
      });
  }

  async function init() {
    const pageStatus = getStatusNode();

    try {
      bindSupportForm();
      bindLogoutButtons();
      bindRefreshButtons();
      styleStaticButtons();

      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      await loadSupport();
    } catch (error) {
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal support page."
      );
    }
  }

  window.addEventListener("cardleo:auth-ready", (event) => {
    const detail = event?.detail || {};

    if (detail.member && !state.authReady) {
      state.authReady = true;

      const member = normalizeMember(detail.member, detail.profile || {});
      const support = buildDefaultSupport(member);

      renderPayload({
        success: true,
        data: {
          member,
          profile: detail.profile || null,
          summary: {
            accessLevel: member.accessLevel || member.tier || "member",
            statusLabel: member.memberStatus || member.status || "active",
            recentRequestCount: 0,
          },
          support,
        },
      });
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalSupport = {
    init,
    reload: loadSupport,
    submitSupport,
    render: renderPayload,
    getState: function () {
      return { ...state };
    },
  };
})();