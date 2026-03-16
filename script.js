/* =====================================
   CARD LEO REWARDS — ELITE INTERACTIONS
   mobile nav + smooth scroll + reveal
   + active section link + multi-form UX
===================================== */

(() => {
  const onReady = (callback) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  };

  onReady(() => {
    const doc = document;
    const body = doc.body;
    const header = doc.querySelector(".site-header");
    const menuToggle = doc.querySelector(".menu-toggle");
    const siteNav = doc.querySelector(".site-nav");
    const navLinks = siteNav
      ? [...siteNav.querySelectorAll('a[href]:not([target="_blank"])')]
      : [];
    const revealItems = [...doc.querySelectorAll(".reveal")];
    const allYearTargets = [...doc.querySelectorAll("[data-year]")];
    const allForms = [...doc.querySelectorAll("form")];
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    /* ---------------------------------
       Helpers
    ---------------------------------- */
    const getHeaderOffset = () => {
      if (!header) return 0;
      return Math.round(header.getBoundingClientRect().height) + 12;
    };

    const isMobileNav = () =>
      window.matchMedia("(max-width: 940px)").matches;

    const setBodyLock = (locked) => {
      body.style.overflow = locked ? "hidden" : "";
    };

    const openMenu = () => {
      if (!menuToggle || !siteNav) return;
      menuToggle.setAttribute("aria-expanded", "true");
      siteNav.classList.add("is-open");
      setBodyLock(true);
    };

    const closeMenu = () => {
      if (!menuToggle || !siteNav) return;
      menuToggle.setAttribute("aria-expanded", "false");
      siteNav.classList.remove("is-open");
      setBodyLock(false);
    };

    const toggleMenu = () => {
      if (!menuToggle || !siteNav) return;
      const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
      if (isOpen) {
        closeMenu();
      } else {
        openMenu();
      }
    };

    const getHashTarget = (hash) => {
      if (!hash || hash === "#") return null;
      try {
        return doc.querySelector(hash);
      } catch {
        return null;
      }
    };

    const smoothScrollTo = (target) => {
      if (!target) return;

      const top =
        window.scrollY +
        target.getBoundingClientRect().top -
        getHeaderOffset();

      window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    };

    const createStatusNode = (form) => {
      let status = form.querySelector(".form-status");

      if (!status) {
        status = doc.createElement("div");
        status.className = "form-status";
        status.setAttribute("aria-live", "polite");
        status.style.marginTop = "0.85rem";
        status.style.fontSize = "0.95rem";
        status.style.lineHeight = "1.5";
        status.style.color = "rgba(245, 247, 255, 0.78)";
        form.appendChild(status);
      }

      return status;
    };

    const setStatus = (statusNode, message, tone = "default") => {
      if (!statusNode) return;

      statusNode.textContent = message;

      if (tone === "error") {
        statusNode.style.color = "#ffb3b3";
        return;
      }

      if (tone === "success") {
        statusNode.style.color = "#9ae6c1";
        return;
      }

      statusNode.style.color = "rgba(245, 247, 255, 0.78)";
    };

    const setButtonLoading = (button, loadingText) => {
      if (!button) return () => {};

      const previousText = button.textContent;
      const previousOpacity = button.style.opacity;

      button.disabled = true;
      button.style.opacity = "0.7";
      button.textContent = loadingText;

      return () => {
        button.disabled = false;
        button.style.opacity = previousOpacity || "1";
        button.textContent = previousText;
      };
    };

    const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

    const isValidPhone = (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 10;
    };

    const pageHas = (selector) => Boolean(doc.querySelector(selector));

    /* ---------------------------------
       Dynamic year
    ---------------------------------- */
    if (allYearTargets.length) {
      const currentYear = new Date().getFullYear();
      allYearTargets.forEach((node) => {
        node.textContent = String(currentYear);
      });
    }

    /* ---------------------------------
       Mobile navigation
    ---------------------------------- */
    if (menuToggle && siteNav) {
      menuToggle.addEventListener("click", toggleMenu);

      doc.addEventListener("click", (event) => {
        if (!isMobileNav()) return;
        const target = event.target;
        if (!(target instanceof Node)) return;

        const clickedInsideNav = siteNav.contains(target);
        const clickedToggle = menuToggle.contains(target);

        if (!clickedInsideNav && !clickedToggle) {
          closeMenu();
        }
      });

      doc.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeMenu();
        }
      });

      window.addEventListener("resize", () => {
        if (!isMobileNav()) {
          closeMenu();
          setBodyLock(false);
        }
      });
    }

    /* ---------------------------------
       Smooth scrolling for same-page hashes
    ---------------------------------- */
    doc.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener("click", (event) => {
        const href = anchor.getAttribute("href");
        const target = getHashTarget(href);

        if (!target) return;

        event.preventDefault();
        smoothScrollTo(target);

        if (history.pushState) {
          history.pushState(null, "", href);
        } else {
          window.location.hash = href;
        }

        if (isMobileNav()) {
          closeMenu();
        }
      });
    });

    /* ---------------------------------
       Reveal on scroll
    ---------------------------------- */
    if (revealItems.length) {
      if (!prefersReducedMotion) {
        revealItems.forEach((item, index) => {
          item.classList.add("is-hidden");
          item.style.transitionDelay = `${Math.min(index * 40, 220)}ms`;
        });
      }

      if ("IntersectionObserver" in window && !prefersReducedMotion) {
        const revealObserver = new IntersectionObserver(
          (entries, observer) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;

              entry.target.classList.remove("is-hidden");
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            });
          },
          {
            threshold: 0.12,
            rootMargin: "0px 0px -40px 0px",
          }
        );

        revealItems.forEach((item) => revealObserver.observe(item));
      } else {
        revealItems.forEach((item) => {
          item.classList.remove("is-hidden");
          item.classList.add("is-visible");
        });
      }
    }

    /* ---------------------------------
       Active nav link on scroll
       Uses current page's section links
    ---------------------------------- */
    const internalNavLinks = navLinks.filter((link) => {
      const href = link.getAttribute("href");
      return href && href.startsWith("#") && getHashTarget(href);
    });

    const setActiveNavLink = () => {
      if (!internalNavLinks.length) return;

      const sections = internalNavLinks
        .map((link) => {
          const id = link.getAttribute("href");
          return {
            id,
            el: id ? doc.querySelector(id) : null,
          };
        })
        .filter((item) => item.el);

      if (!sections.length) return;

      const scrollMarker = window.scrollY + getHeaderOffset() + 120;
      let currentId = sections[0].id || "";

      sections.forEach((section) => {
        if (section.el && section.el.offsetTop <= scrollMarker) {
          currentId = section.id || currentId;
        }
      });

      internalNavLinks.forEach((link) => {
        const href = link.getAttribute("href");
        link.classList.toggle("is-active", href === currentId);
      });
    };

    /* ---------------------------------
       Header scrolled state
    ---------------------------------- */
    const updateHeaderState = () => {
      if (!header) return;
      header.classList.toggle("is-scrolled", window.scrollY > 12);
    };

    updateHeaderState();
    setActiveNavLink();

    window.addEventListener("scroll", updateHeaderState, { passive: true });
    window.addEventListener("scroll", setActiveNavLink, { passive: true });

    /* ---------------------------------
       Contact form UX
       Works for pages with:
       name + email + message
    ---------------------------------- */
    const contactForm = allForms.find(
      (form) =>
        form.querySelector('[name="name"]') &&
        form.querySelector('[name="email"]') &&
        form.querySelector('[name="message"]')
    );

    if (contactForm) {
      const submitButton = contactForm.querySelector('button[type="submit"]');
      const status = createStatusNode(contactForm);

      contactForm.addEventListener("submit", (event) => {
        event.preventDefault();

        const formData = new FormData(contactForm);
        const name = String(formData.get("name") || "").trim();
        const email = String(formData.get("email") || "").trim();
        const message = String(formData.get("message") || "").trim();

        if (!name || !email || !message) {
          setStatus(
            status,
            "Please fill out your name, email, and message.",
            "error"
          );
          return;
        }

        if (!isValidEmail(email)) {
          setStatus(status, "Please enter a valid email address.", "error");
          return;
        }

        const resetButton = setButtonLoading(submitButton, "Sending...");
        setStatus(status, "");

        window.setTimeout(() => {
          setStatus(
            status,
            "Thank you — your message has been captured on the page. Connect this form to Formspree, Netlify Forms, EmailJS, or your own backend next.",
            "success"
          );
          contactForm.reset();
          resetButton();
        }, 700);
      });
    }

    /* ---------------------------------
       Signup form UX
       Works for pages with:
       firstName + lastName + email
    ---------------------------------- */
    const signupForm = allForms.find(
      (form) =>
        form.querySelector('[name="firstName"]') &&
        form.querySelector('[name="lastName"]') &&
        form.querySelector('[name="email"]')
    );

    if (signupForm) {
      const submitButton = signupForm.querySelector('button[type="submit"]');
      const status = createStatusNode(signupForm);

      signupForm.addEventListener("submit", (event) => {
        event.preventDefault();

        const formData = new FormData(signupForm);
        const firstName = String(formData.get("firstName") || "").trim();
        const lastName = String(formData.get("lastName") || "").trim();
        const email = String(formData.get("email") || "").trim();
        const phone = String(formData.get("phone") || "").trim();
        const interest = String(formData.get("interest") || "").trim();
        const agreed = signupForm.querySelector('[name="agree"]')?.checked;

        if (!firstName || !lastName || !email || !phone || !interest) {
          setStatus(
            status,
            "Please complete all required signup fields before continuing.",
            "error"
          );
          return;
        }

        if (!isValidEmail(email)) {
          setStatus(status, "Please enter a valid email address.", "error");
          return;
        }

        if (!isValidPhone(phone)) {
          setStatus(
            status,
            "Please enter a valid phone number with at least 10 digits.",
            "error"
          );
          return;
        }

        if (!agreed) {
          setStatus(
            status,
            "Please agree to the registration terms before continuing.",
            "error"
          );
          return;
        }

        const resetButton = setButtonLoading(submitButton, "Creating...");
        setStatus(status, "Creating your account experience...");

        window.setTimeout(() => {
          const action =
            signupForm.getAttribute("action")?.trim() || "./thank-you.html";

          setStatus(
            status,
            "Signup details look good. Redirecting you to the next step...",
            "success"
          );

          resetButton();

          window.setTimeout(() => {
            if (
              action.startsWith("http://") ||
              action.startsWith("https://") ||
              action.startsWith("./") ||
              action.endsWith(".html")
            ) {
              window.location.href = action;
            } else {
              signupForm.submit();
            }
          }, 500);
        }, 900);
      });
    }

    /* ---------------------------------
       Smart CTA helpers
       Optional support for future buttons:
       [data-scroll-to="#id"]
    ---------------------------------- */
    doc.querySelectorAll("[data-scroll-to]").forEach((button) => {
      button.addEventListener("click", () => {
        const selector = button.getAttribute("data-scroll-to");
        if (!selector) return;
        const target = getHashTarget(selector);
        if (!target) return;

        smoothScrollTo(target);

        if (isMobileNav()) {
          closeMenu();
        }
      });
    });

    /* ---------------------------------
       Initial load hash correction
    ---------------------------------- */
    if (window.location.hash) {
      const initialTarget = getHashTarget(window.location.hash);
      if (initialTarget) {
        window.setTimeout(() => {
          smoothScrollTo(initialTarget);
          setActiveNavLink();
        }, 80);
      }
    }

    /* ---------------------------------
       Safety cleanup for pages without
       internal section nav
    ---------------------------------- */
    if (!internalNavLinks.length && pageHas(".site-nav")) {
      navLinks.forEach((link) => link.classList.remove("is-active"));
    }
  });
})();