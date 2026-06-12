// script.js
// Public site script for Card Leo Rewards
// Safe for index.html, about.html, get-started.html, signup.html, contact.html, and public pages.

(() => {
  "use strict";

  function $(selector, scope = document) {
    return scope.querySelector(selector);
  }

  function $$(selector, scope = document) {
    return Array.from(scope.querySelectorAll(selector));
  }

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }

    callback();
  }

  function setCurrentYear() {
    $$("[data-year]").forEach((node) => {
      node.textContent = String(new Date().getFullYear());
    });
  }

  function setupMobileMenu() {
    const toggle = $(".menu-toggle");
    const nav = $("#site-nav");

    if (!toggle || !nav) return;

    function closeMenu() {
      toggle.setAttribute("aria-expanded", "false");
      document.body.classList.remove("nav-open");
    }

    function openMenu() {
      toggle.setAttribute("aria-expanded", "true");
      document.body.classList.add("nav-open");
    }

    function isOpen() {
      return toggle.getAttribute("aria-expanded") === "true";
    }

    toggle.addEventListener("click", () => {
      if (isOpen()) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    nav.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link) return;

      closeMenu();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) {
        closeMenu();
      }
    });
  }

  function setupSmoothAnchors() {
    $$('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", (event) => {
        const hash = link.getAttribute("href");

        if (!hash || hash === "#") return;

        const target = $(hash);

        if (!target) return;

        event.preventDefault();

        target.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });

        history.pushState(null, "", hash);
      });
    });
  }

  function setupRevealAnimations() {
    const revealNodes = $$(".reveal");

    if (!revealNodes.length) return;

    if (!("IntersectionObserver" in window)) {
      revealNodes.forEach((node) => {
        node.classList.add("is-visible");
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;

          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        threshold: 0.12,
        rootMargin: "0px 0px -60px 0px",
      }
    );

    revealNodes.forEach((node) => {
      observer.observe(node);
    });
  }

  function setupHeaderScrollState() {
    const header = $(".site-header");

    if (!header) return;

    function updateHeader() {
      if (window.scrollY > 10) {
        header.classList.add("is-scrolled");
      } else {
        header.classList.remove("is-scrolled");
      }
    }

    updateHeader();

    window.addEventListener("scroll", updateHeader, {
      passive: true,
    });
  }

  function getFormPayload(form) {
    const formData = new FormData(form);
    const payload = {};

    formData.forEach((value, key) => {
      payload[key] = typeof value === "string" ? value.trim() : value;
    });

    return payload;
  }

  function getOrCreateFormMessage(form) {
    let message = form.querySelector("[data-form-message]");

    if (message) return message;

    message = document.createElement("p");
    message.setAttribute("data-form-message", "");
    message.className = "form-message";
    message.setAttribute("role", "status");

    form.appendChild(message);

    return message;
  }

  function setFormMessage(form, message, type = "info") {
    const messageNode = getOrCreateFormMessage(form);

    messageNode.textContent = message;
    messageNode.dataset.type = type;
    messageNode.classList.remove("success", "error", "info");
    messageNode.classList.add(type);
  }

  async function submitJsonForm(form) {
    const action = form.getAttribute("action");
    const method = form.getAttribute("method") || "POST";

    if (!action) return;

    const button = form.querySelector('button[type="submit"], input[type="submit"]');
    const originalText = button ? button.textContent : "";

    try {
      if (button) {
        button.disabled = true;
        button.textContent = "Sending...";
      }

      setFormMessage(form, "Sending your message...", "info");

      const response = await fetch(action, {
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(getFormPayload(form)),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || result?.success === false || result?.ok === false) {
        throw new Error(
          result?.message ||
            result?.error ||
            "We couldn't send your message right now."
        );
      }

      setFormMessage(
        form,
        result?.message || "Message sent successfully. We’ll follow up soon.",
        "success"
      );

      form.reset();
    } catch (error) {
      console.error("Form submit error:", error);

      setFormMessage(
        form,
        error?.message || "We couldn't send your message right now.",
        "error"
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText || "Submit";
      }
    }
  }

  function setupContactForms() {
    const forms = $$("form");

    forms.forEach((form) => {
      const action = form.getAttribute("action") || "";

      // Only enhance contact forms on public pages.
      // Do not touch signup forms here because signup should have its own signup page logic.
      const isContactForm =
        action === "/api/contact" ||
        form.classList.contains("contact-form") ||
        form.dataset.form === "contact";

      if (!isContactForm) return;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitJsonForm(form);
      });
    });
  }

  function markActiveNavLink() {
    const currentPath = window.location.pathname || "/";

    $$(".site-nav a, .footer-links a").forEach((link) => {
      const href = link.getAttribute("href");

      if (!href || href.startsWith("#")) return;

      try {
        const url = new URL(href, window.location.origin);

        if (url.pathname === currentPath) {
          link.classList.add("is-active");
          link.setAttribute("aria-current", "page");
        }
      } catch {
        // Ignore invalid links.
      }
    });
  }

  function init() {
    setCurrentYear();
    setupMobileMenu();
    setupSmoothAnchors();
    setupRevealAnimations();
    setupHeaderScrollState();
    setupContactForms();
    markActiveNavLink();
  }

  ready(init);
})();