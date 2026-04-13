// assets/js/portal-support.js

(function () {
  const CONFIG = {
    supportEndpoint: "/api/portal/support",
    loginPage: "/login.html",
    unauthorizedPage: "/unauthorized.html",
    authGuardOptions: {
      meEndpoint: "/api/auth/me",
      logoutEndpoint: "/api/auth/logout",
      loginPage: "/login.html",
      unauthorizedPage: "/unauthorized.html",
      fallbackPortalOverviewEndpoint: "/api/portal/overview",
      redirectOnFail: true,
      requirePortalAccess: true,
      showLoader: true,
      debug: false,
    },
  };

  const state = {
    member: null,
    support: null,
    tickets: [],
    faqs: [],
    announcements: [],
    isLoading: false,
    isSubmitting: false,
    initialFormValues: null,
  };

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = normalizeText(value);
    });
  }

  function setValue(selector, value) {
    document.querySelectorAll(selector).forEach((node) => {
      node.value = value ?? "";
    });
  }

  function setDisabled(selectors, disabled) {
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        node.disabled = !!disabled;
      });
    });
  }

  function setStatus(target, type, message) {
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

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
    const el =
      typeof target === "string" ? document.querySelector(target) : target;

    if (!el) return;

    el.hidden = true;
    el.textContent = "";
    el.dataset.state = "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "—";

    try {
      return new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "—";
    }
  }

  function formatDateTime(value) {
    if (!value) return "—";

    try {
      return new Date(value).toLocaleString();
    } catch {
      return "—";
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

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...options,
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { response, data };
  }

  function inferSupportPayload(payload) {
    const data = isObject(payload?.data) ? payload.data : payload;

    return {
      member: isObject(data?.member) ? data.member : {},
      support: isObject(data?.support) ? data.support : {},
      tickets: Array.isArray(data?.tickets) ? data.tickets : [],
      faqs: Array.isArray(data?.faqs) ? data.faqs : [],
      announcements: Array.isArray(data?.announcements)
        ? data.announcements
        : [],
    };
  }

  function applyMember(member = {}) {
    state.member = member;

    const fullName =
      normalizeText(member.name) ||
      [
        normalizeText(member.firstName || member.first_name),
        normalizeText(member.lastName || member.last_name),
      ]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      "Card Leo Member";

    const firstName =
      normalizeText(member.firstName || member.first_name) ||
      fullName.split(" ")[0] ||
      "Member";

    setText("[data-member-name]", fullName);
    setText("[data-member-first-name]", firstName);
    setText("[data-member-email]", member.email || "");
    setText("[data-member-status]", member.status || "member");
    setText(
      "[data-member-access-level]",
      member.accessLevel || member.access_level || "member"
    );
    setText(
      "[data-member-joined-at]",
      member.joinedAt ? formatDate(member.joinedAt) : "—"
    );

    document.body.dataset.memberName = fullName;
    document.body.dataset.memberEmail = normalizeText(member.email || "");
    document.body.dataset.memberStatus = normalizeText(member.status || "");
  }

  function applySupport(support = {}) {
    state.support = support;

    setText("[data-support-email]", support.email || "support@cardleorewards.com");
    setText("[data-support-phone]", support.phone || "");
    setText("[data-support-hours]", support.hours || "Mon–Fri, 9:00 AM–6:00 PM");
    setText("[data-support-response-time]", support.responseTime || "24–48 hours");
    setText("[data-support-topic-default]", support.defaultTopic || "General Support");
  }

  function normalizeTicket(ticket = {}, index = 0) {
    return {
      id: normalizeText(ticket.id || ticket.ticketId || `ticket-${index + 1}`),
      subject:
        normalizeText(ticket.subject || ticket.title || ticket.topic) ||
        `Support Request ${index + 1}`,
      message:
        normalizeText(ticket.message || ticket.description || ticket.summary) ||
        "Support request submitted.",
      topic: normalizeText(ticket.topic || "General Support"),
      status: normalizeText(ticket.status || "Open"),
      createdAt:
        ticket.createdAt ||
        ticket.created_at ||
        ticket.submittedAt ||
        ticket.submitted_at ||
        null,
      updatedAt:
        ticket.updatedAt ||
        ticket.updated_at ||
        ticket.lastReplyAt ||
        ticket.last_reply_at ||
        null,
      resolution:
        normalizeText(ticket.resolution || ticket.response || ticket.note) || "",
    };
  }

  function normalizeFaq(faq = {}, index = 0) {
    return {
      id: normalizeText(faq.id || `faq-${index + 1}`),
      question:
        normalizeText(faq.question || faq.title) || `Support question ${index + 1}`,
      answer:
        normalizeText(faq.answer || faq.description) ||
        "Answer coming soon.",
      category: normalizeText(faq.category || "General"),
    };
  }

  function normalizeAnnouncement(item = {}, index = 0) {
    return {
      id: normalizeText(item.id || `announcement-${index + 1}`),
      title:
        normalizeText(item.title || item.label) || `Announcement ${index + 1}`,
      message:
        normalizeText(item.message || item.description || item.summary) ||
        "Important support update.",
      createdAt:
        item.createdAt || item.created_at || item.date || item.publishedAt || null,
    };
  }

  function ticketTone(status) {
    const value = normalizeText(status).toLowerCase();

    if (["resolved", "closed", "completed"].includes(value)) return "success";
    if (["pending", "in review", "awaiting reply"].includes(value)) return "warning";
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

        const top = document.createElement("div");
        top.style.display = "flex";
        top.style.justifyContent = "space-between";
        top.style.alignItems = "flex-start";
        top.style.gap = "12px";
        top.style.flexWrap = "wrap";

        const title = document.createElement("div");
        title.innerHTML = `
          <strong style="display:block;color:#f8f3e8;font-size:1rem;margin-bottom:5px;">
            ${escapeHtml(ticket.subject)}
          </strong>
          <span style="color:rgba(244,234,211,0.7);font-size:0.92rem;">
            ${escapeHtml(ticket.topic)} • ${escapeHtml(ticket.id)}
          </span>
        `;

        const status = document.createElement("span");
        status.textContent = ticket.status;
        status.style.display = "inline-flex";
        status.style.alignItems = "center";
        status.style.justifyContent = "center";
        status.style.padding = "8px 12px";
        status.style.borderRadius = "999px";
        status.style.fontSize = "0.78rem";
        status.style.fontWeight = "700";
        status.style.letterSpacing = "0.04em";
        status.style.background = badge.background;
        status.style.color = badge.color;
        status.style.border = badge.border;

        const body = document.createElement("div");
        body.style.color = "rgba(244,234,211,0.8)";
        body.style.lineHeight = "1.65";
        body.style.fontSize = "0.95rem";
        body.textContent = ticket.message;

        const meta = document.createElement("div");
        meta.style.display = "grid";
        meta.style.gap = "6px";
        meta.style.color = "rgba(244,234,211,0.7)";
        meta.style.fontSize = "0.9rem";
        meta.innerHTML = `
          <div><strong style="color:#f4ead3;">Submitted:</strong> ${escapeHtml(
            formatDateTime(ticket.createdAt)
          )}</div>
          <div><strong style="color:#f4ead3;">Last update:</strong> ${escapeHtml(
            formatDateTime(ticket.updatedAt || ticket.createdAt)
          )}</div>
          ${
            ticket.resolution
              ? `<div><strong style="color:#f4ead3;">Latest note:</strong> ${escapeHtml(
                  ticket.resolution
                )}</div>`
              : ""
          }
        `;

        top.appendChild(title);
        top.appendChild(status);
        card.appendChild(top);
        card.appendChild(body);
        card.appendChild(meta);

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

    const normalized = faqs.map(normalizeFaq);

    containers.forEach((container) => {
      container.innerHTML = "";

      if (!normalized.length) {
        const empty = document.createElement("div");
        empty.style.padding = "18px";
        empty.style.borderRadius = "18px";
        empty.style.background = "rgba(255,255,255,0.03)";
        empty.style.border = "1px solid rgba(255,255,255,0.08)";
        empty.style.color = "rgba(244,234,211,0.76)";
        empty.textContent = "FAQ content will appear here soon.";
        container.appendChild(empty);
        return;
      }

      normalized.forEach((faq) => {
        const item = document.createElement("details");
        item.style.padding = "16px 18px";
        item.style.borderRadius = "18px";
        item.style.background = "rgba(255,255,255,0.03)";
        item.style.border = "1px solid rgba(255,255,255,0.08)";

        const summary = document.createElement("summary");
        summary.style.cursor = "pointer";
        summary.style.color = "#f8f3e8";
        summary.style.fontWeight = "700";
        summary.style.listStyle = "none";
        summary.innerHTML = `
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
            ">${escapeHtml(faq.category)}</span>
          </span>
        `;

        const body = document.createElement("div");
        body.style.marginTop = "12px";
        body.style.color = "rgba(244,234,211,0.78)";
        body.style.lineHeight = "1.7";
        body.textContent = faq.answer;

        item.appendChild(summary);
        item.appendChild(body);
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
      name:
        normalizeText(member.name) ||
        [
          normalizeText(member.firstName || member.first_name),
          normalizeText(member.lastName || member.last_name),
        ]
          .filter(Boolean)
          .join(" ")
          .trim(),
      email: normalizeText(member.email || ""),
      topic: normalizeText(support.defaultTopic || "General Support"),
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
    setValue('[name="topic"], [data-support-field="topic"]', state.initialFormValues.topic);
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
    if (!state.initialFormValues) return;

    setValue('[name="name"], [data-support-field="name"]', state.initialFormValues.name);
    setValue('[name="email"], [data-support-field="email"]', state.initialFormValues.email);
    setValue('[name="topic"], [data-support-field="topic"]', state.initialFormValues.topic);
    setValue('[name="subject"], [data-support-field="subject"]', "");
    setValue('[name="message"], [data-support-field="message"]', "");
  }

  function readField(form, name) {
    const field =
      form.querySelector(`[name="${name}"]`) ||
      form.querySelector(`[data-support-field="${name}"]`);

    return normalizeText(field?.value || "");
  }

  function collectSupportPayload(form) {
    return {
      name: readField(form, "name"),
      email: readField(form, "email"),
      topic: readField(form, "topic"),
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

    if (!payload.topic) {
      return "Please select a support topic.";
    }

    if (!payload.subject) {
      return "Please enter a subject for your request.";
    }

    if (payload.subject.length < 3) {
      return "Your subject must be at least 3 characters long.";
    }

    if (!payload.message) {
      return "Please describe how we can help.";
    }

    if (payload.message.length < 10) {
      return "Please provide a little more detail in your message.";
    }

    return null;
  }

  async function loadSupport() {
    state.isLoading = true;

    const pageStatus =
      document.querySelector("[data-support-page-status]") ||
      document.querySelector("#support-page-status") ||
      document.querySelector("[data-support-status]");

    clearStatus(pageStatus);

    try {
      const result = await fetchJson(CONFIG.supportEndpoint, {
        method: "GET",
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return false;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return false;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to load support resources."
        );
      }

      const payload = inferSupportPayload(result.data);

      state.tickets = payload.tickets;
      state.faqs = payload.faqs;
      state.announcements = payload.announcements;

      applyMember(payload.member);
      applySupport(payload.support);
      applyFormDefaults(payload.member, payload.support);
      renderTickets(payload.tickets);
      renderFaqs(payload.faqs);
      renderAnnouncements(payload.announcements);

      return true;
    } catch (error) {
      renderTickets([]);
      renderFaqs([]);
      renderAnnouncements([]);
      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal support page."
      );
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function submitSupport(form) {
    if (state.isSubmitting) return;

    const statusNode =
      form.querySelector("[data-support-status]") ||
      document.querySelector("[data-support-status]") ||
      document.querySelector("#support-status");

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

    const resetButton =
      form.querySelector('[type="reset"]') ||
      form.querySelector("[data-support-reset]");

    setDisabled(
      [
        '[data-support-form] button',
        '[data-support-form] input',
        '[data-support-form] textarea',
        '[data-support-form] select',
      ],
      true
    );

    if (submitButton) {
      submitButton.dataset.originalText =
        submitButton.dataset.originalText || submitButton.textContent;
      submitButton.textContent = "Submitting...";
    }

    try {
      const result = await fetchJson(CONFIG.supportEndpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (result.response.status === 401) {
        window.location.href = CONFIG.loginPage;
        return;
      }

      if (result.response.status === 403) {
        window.location.href = CONFIG.unauthorizedPage;
        return;
      }

      if (!result.response.ok) {
        throw new Error(
          normalizeText(result.data?.message) || "Unable to submit your support request."
        );
      }

      const parsed = inferSupportPayload(result.data);

      if (parsed.member && Object.keys(parsed.member).length) {
        applyMember(parsed.member);
      }

      if (parsed.support && Object.keys(parsed.support).length) {
        applySupport(parsed.support);
      }

      if (Array.isArray(parsed.tickets)) {
        state.tickets = parsed.tickets;
        renderTickets(parsed.tickets);
      }

      restoreInitialForm(form);

      setStatus(
        statusNode,
        "success",
        normalizeText(result.data?.message) ||
          "Your support request has been submitted successfully."
      );
    } catch (error) {
      setStatus(
        statusNode,
        "error",
        error?.message || "We could not submit your support request right now."
      );
    } finally {
      state.isSubmitting = false;

      setDisabled(
        [
          '[data-support-form] button',
          '[data-support-form] input',
          '[data-support-form] textarea',
          '[data-support-form] select',
        ],
        false
      );

      const emailField =
        form.querySelector('[name="email"]') ||
        form.querySelector('[data-support-field="email"]');

      if (emailField) {
        emailField.readOnly = true;
      }

      if (submitButton) {
        submitButton.textContent =
          submitButton.dataset.originalText || "Submit Request";
      }

      if (resetButton) {
        resetButton.disabled = false;
      }
    }
  }

  function bindSupportForm() {
    const form = getSupportForm();
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitSupport(form);
    });

    form.addEventListener("reset", (event) => {
      event.preventDefault();
      restoreInitialForm(form);

      const statusNode =
        form.querySelector("[data-support-status]") ||
        document.querySelector("[data-support-status]") ||
        document.querySelector("#support-status");

      clearStatus(statusNode);
    });
  }

  function bindLogoutButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-logout]");
      if (!trigger) return;

      event.preventDefault();

      if (window.CardLeoAuthGuard?.logout) {
        await window.CardLeoAuthGuard.logout(CONFIG.authGuardOptions);
      } else {
        window.location.href = CONFIG.loginPage;
      }
    });
  }

  function bindRefreshButtons() {
    document.addEventListener("click", async (event) => {
      const trigger = event.target.closest("[data-support-refresh]");
      if (!trigger) return;

      event.preventDefault();
      await loadSupport();
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
    try {
      if (window.CardLeoAuthGuard?.init) {
        await window.CardLeoAuthGuard.init(CONFIG.authGuardOptions);
      }

      bindSupportForm();
      bindLogoutButtons();
      bindRefreshButtons();
      styleStaticButtons();

      await loadSupport();
    } catch (error) {
      const pageStatus =
        document.querySelector("[data-support-page-status]") ||
        document.querySelector("#support-page-status") ||
        document.querySelector("[data-support-status]");

      setStatus(
        pageStatus,
        "error",
        error?.message || "We could not load your portal support page."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CardLeoPortalSupport = {
    init,
    reload: loadSupport,
    submitSupport,
    getState: function () {
      return {
        member: state.member,
        support: state.support,
        tickets: state.tickets,
        faqs: state.faqs,
        announcements: state.announcements,
        isLoading: state.isLoading,
        isSubmitting: state.isSubmitting,
      };
    },
  };
})();