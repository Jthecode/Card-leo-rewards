// assets/js/signup.js

(() => {
  const API = {
    signup: "/api/signup",
    checkout: "/api/billing/create-checkout-session",
  };

  const CONFIG = {
    activationFee: 25,
    monthlyFee: 20,
    billingDay: 10,
    successUrl:
      window.location.origin +
      "/thank-you.html?payment=success&membership=activated",
    cancelUrl: window.location.origin + "/signup.html?payment=cancelled",
  };

  const selectors = {
    form: "#signupForm",
    submitButton:
      "#signupSubmit, #submitSignup, [data-signup-submit], button[type='submit']",
    paymentBox: "#paymentBox, [data-payment-box]",
    statusBox: "#signupStatus, [data-signup-status]",
    referralInput:
      "#referralName, #referral_name, input[name='referralName'], input[name='referral_name']",
    referralCodeInput:
      "#referralCode, #referral_code, input[name='referralCode'], input[name='referral_code']",
  };

  const state = {
    isSubmitting: false,
    lastSignup: null,
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function getForm() {
    return $(selectors.form) || document.querySelector("form[data-signup-form]");
  }

  function clean(value) {
    return String(value || "").trim();
  }

  function lower(value) {
    return clean(value).toLowerCase();
  }

  function getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function getReferralFromUrl() {
    return (
      clean(getParam("ref")) ||
      clean(getParam("referral")) ||
      clean(getParam("sponsor")) ||
      clean(getParam("code"))
    );
  }

  function showStatus(message, type = "info") {
    const box = $(selectors.statusBox);

    if (!box) {
      if (message && type === "error") {
        alert(message);
      }
      return;
    }

    box.hidden = false;
    box.textContent = message;
    box.className = "signup-status";

    box.dataset.status = type;

    if (type === "success") {
      box.classList.add("success");
    }

    if (type === "error") {
      box.classList.add("error");
    }

    if (type === "warning") {
      box.classList.add("warning");
    }
  }

  function clearStatus() {
    const box = $(selectors.statusBox);

    if (!box) return;

    box.hidden = true;
    box.textContent = "";
    box.className = "signup-status";
    delete box.dataset.status;
  }

  function setSubmitting(isSubmitting) {
    state.isSubmitting = isSubmitting;

    const form = getForm();
    const button = form?.querySelector(selectors.submitButton) || $(selectors.submitButton);

    if (!button) return;

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent || "Continue";
    }

    button.disabled = isSubmitting;
    button.textContent = isSubmitting
      ? "Creating account..."
      : button.dataset.originalText;
  }

  function setCheckoutLoading(isLoading) {
    const form = getForm();
    const button = form?.querySelector(selectors.submitButton) || $(selectors.submitButton);

    if (!button) return;

    button.disabled = isLoading;
    button.textContent = isLoading ? "Opening secure checkout..." : "Activate Membership";
  }

  function getInputValue(form, names) {
    for (const name of names) {
      const input =
        form.querySelector(`[name='${name}']`) ||
        form.querySelector(`#${name}`);

      if (input) {
        if (input.type === "checkbox") {
          return input.checked;
        }

        return clean(input.value);
      }
    }

    return "";
  }

  function setInputValue(input, value) {
    if (!input || !value) return;

    if (!clean(input.value)) {
      input.value = value;
    }
  }

  function getSignupData(form) {
    const firstName = getInputValue(form, ["firstName", "first_name", "first-name"]);
    const lastName = getInputValue(form, ["lastName", "last_name", "last-name"]);
    const email = lower(getInputValue(form, ["email", "emailAddress", "email_address"]));
    const phone = getInputValue(form, ["phone", "phoneNumber", "phone_number"]);
    const city = getInputValue(form, ["city"]);
    const stateValue = getInputValue(form, ["state"]);
    const referralName = getInputValue(form, [
      "referralName",
      "referral_name",
      "sponsor",
      "sponsorName",
      "sponsor_name",
    ]);
    const referralCode =
      getInputValue(form, ["referralCode", "referral_code"]) || getReferralFromUrl();

    const interest = getInputValue(form, ["interest", "primaryInterest", "primary_interest"]);
    const goals = getInputValue(form, ["goals", "goal", "message"]);
    const password = getInputValue(form, ["password"]);
    const confirmPassword = getInputValue(form, [
      "confirmPassword",
      "confirm_password",
      "passwordConfirm",
      "password_confirm",
    ]);

    const agreed =
      Boolean(getInputValue(form, ["agreed", "agree", "terms", "termsAccepted"])) ||
      Boolean(form.querySelector("[name='agreed']")?.checked) ||
      Boolean(form.querySelector("[name='terms']")?.checked);

    const fullName = [firstName, lastName].filter(Boolean).join(" ");

    return {
      firstName,
      first_name: firstName,

      lastName,
      last_name: lastName,

      fullName,
      full_name: fullName,

      email,
      phone,
      city,
      state: stateValue,

      referralName,
      referral_name: referralName,

      referralCode,
      referral_code: referralCode,

      interest,
      goals,

      password,
      confirmPassword,
      confirm_password: confirmPassword,

      agreed,

      source: "cardleo_rewards_signup",
      signup_page: window.location.pathname,

      activation_fee_amount: CONFIG.activationFee,
      monthly_fee_amount: CONFIG.monthlyFee,
      billing_day: CONFIG.billingDay,

      payment_status: "payment_pending",
      membership_status: "payment_pending",
      approval_status: "payment_pending",
    };
  }

  function validateSignup(data) {
    if (!data.firstName) {
      return "Please enter your first name.";
    }

    if (!data.lastName) {
      return "Please enter your last name.";
    }

    if (!data.email) {
      return "Please enter your email address.";
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return "Please enter a valid email address.";
    }

    if (!data.phone) {
      return "Please enter your phone number.";
    }

    if (!data.password) {
      return "Please create a password.";
    }

    if (data.password.length < 8) {
      return "Your password must be at least 8 characters.";
    }

    if (data.confirmPassword && data.password !== data.confirmPassword) {
      return "Your passwords do not match.";
    }

    if (!data.agreed) {
      return "Please agree to the terms before continuing.";
    }

    return "";
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload?.success === false || payload?.ok === false) {
      const error = new Error(
        payload?.message || payload?.error || "Request failed."
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload?.data && typeof payload.data === "object" ? payload.data : payload;
  }

  function getSignupId(payload) {
    return (
      clean(payload?.signup?.id) ||
      clean(payload?.member?.id) ||
      clean(payload?.profile?.id) ||
      clean(payload?.id) ||
      clean(payload?.signup_id) ||
      clean(payload?.signupId)
    );
  }

  function getCheckoutUrl(payload) {
    return (
      clean(payload?.url) ||
      clean(payload?.checkout_url) ||
      clean(payload?.checkoutUrl) ||
      clean(payload?.payment_url) ||
      clean(payload?.paymentUrl) ||
      clean(payload?.redirectTo)
    );
  }

  async function createSignup(data) {
    return fetchJson(API.signup, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async function createCheckoutSession(signupPayload, originalData) {
    const signup = signupPayload?.signup || signupPayload?.member || signupPayload || {};
    const signupId = getSignupId(signupPayload) || getSignupId(signup);

    return fetchJson(API.checkout, {
      method: "POST",
      body: JSON.stringify({
        signup_id: signupId,
        signupId,

        email: originalData.email || signup.email,

        firstName: originalData.firstName || signup.firstName || signup.first_name,
        first_name: originalData.firstName || signup.firstName || signup.first_name,

        lastName: originalData.lastName || signup.lastName || signup.last_name,
        last_name: originalData.lastName || signup.lastName || signup.last_name,

        fullName: originalData.fullName || signup.fullName || signup.full_name,
        full_name: originalData.fullName || signup.fullName || signup.full_name,

        phone: originalData.phone || signup.phone,

        activation_fee_amount: CONFIG.activationFee,
        monthly_fee_amount: CONFIG.monthlyFee,
        billing_day: CONFIG.billingDay,

        success_url:
          CONFIG.successUrl +
          "&signup_id=" +
          encodeURIComponent(signupId || "") +
          "&session_id={CHECKOUT_SESSION_ID}",

        cancel_url:
          CONFIG.cancelUrl +
          "&signup_id=" +
          encodeURIComponent(signupId || ""),
      }),
    });
  }

  function renderPaymentBox() {
    const box = $(selectors.paymentBox);

    if (!box) return;

    box.innerHTML = `
      <div class="payment-box-inner">
        <div class="payment-box-header">
          <span class="payment-eyebrow">Membership Activation</span>
          <strong>$25 today + $20/month</strong>
        </div>

        <div class="payment-box-grid">
          <div>
            <span>Activation Fee</span>
            <strong>$25 one time</strong>
          </div>

          <div>
            <span>Monthly Membership</span>
            <strong>$20/month</strong>
          </div>

          <div>
            <span>Billing Date</span>
            <strong>10th monthly</strong>
          </div>

          <div>
            <span>Approval</span>
            <strong>Automatic after payment</strong>
          </div>
        </div>

        <p>
          After successful payment, your account is automatically approved and
          your member portal access is unlocked.
        </p>
      </div>
    `;
  }

  function addPaymentBoxIfMissing() {
    const form = getForm();

    if (!form || $(selectors.paymentBox)) return;

    const box = document.createElement("div");
    box.id = "paymentBox";
    box.setAttribute("data-payment-box", "true");

    const submitButton = form.querySelector(selectors.submitButton);

    if (submitButton?.parentElement) {
      submitButton.parentElement.insertAdjacentElement("beforebegin", box);
    } else {
      form.appendChild(box);
    }

    renderPaymentBox();
  }

  function addStatusBoxIfMissing() {
    const form = getForm();

    if (!form || $(selectors.statusBox)) return;

    const box = document.createElement("div");
    box.id = "signupStatus";
    box.setAttribute("data-signup-status", "true");
    box.className = "signup-status";
    box.hidden = true;

    form.prepend(box);
  }

  function applyReferralFromUrl() {
    const referral = getReferralFromUrl();

    if (!referral) return;

    const referralInput = $(selectors.referralInput);
    const referralCodeInput = $(selectors.referralCodeInput);

    setInputValue(referralInput, referral);
    setInputValue(referralCodeInput, referral);
  }

  function handlePaymentCancelledNotice() {
    const payment = lower(getParam("payment"));
    const status = lower(getParam("status"));

    if (payment === "cancelled" || payment === "canceled") {
      showStatus(
        "Payment was cancelled. You can complete your Card Leo Rewards activation below.",
        "warning"
      );
      return;
    }

    if (status === "payment_required" || status === "payment_pending") {
      showStatus(
        "Complete payment to activate your membership and unlock portal access.",
        "warning"
      );
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (state.isSubmitting) return;

    const form = getForm();

    if (!form) return;

    clearStatus();

    const data = getSignupData(form);
    const validationError = validateSignup(data);

    if (validationError) {
      showStatus(validationError, "error");
      return;
    }

    setSubmitting(true);

    try {
      showStatus("Creating your Card Leo Rewards account...", "info");

      const signupPayload = await createSignup(data);
      state.lastSignup = signupPayload;

      showStatus(
        "Account created. Opening secure payment for your $25 activation and $20 monthly membership...",
        "success"
      );

      setCheckoutLoading(true);

      const checkoutPayload = await createCheckoutSession(signupPayload, data);
      const checkoutUrl = getCheckoutUrl(checkoutPayload);

      if (!checkoutUrl) {
        throw new Error(
          "Signup was saved, but checkout did not return a payment link."
        );
      }

      window.location.href = checkoutUrl;
    } catch (error) {
      console.error("[signup] error:", error);

      showStatus(
        error?.message ||
          "We could not complete signup right now. Please try again.",
        "error"
      );

      setSubmitting(false);
      setCheckoutLoading(false);
    }
  }

  function enhanceSubmitButtonText() {
    const form = getForm();
    const button = form?.querySelector(selectors.submitButton) || $(selectors.submitButton);

    if (!button) return;

    const current = clean(button.textContent).toLowerCase();

    if (
      !current ||
      current === "submit" ||
      current === "sign up" ||
      current === "join now" ||
      current === "create account"
    ) {
      button.textContent = "Activate Membership";
    }

    button.dataset.originalText = button.textContent;
  }

  function injectSignupStyles() {
    if (document.getElementById("cardleo-signup-js-styles")) return;

    const style = document.createElement("style");
    style.id = "cardleo-signup-js-styles";
    style.textContent = `
      .signup-status {
        margin-bottom: 1rem;
        padding: 1rem;
        border-radius: 16px;
        border: 1px solid rgba(231, 182, 79, 0.22);
        background: rgba(255, 255, 255, 0.045);
        color: rgba(248, 243, 231, 0.78);
        line-height: 1.55;
      }

      .signup-status.success {
        border-color: rgba(72, 240, 107, 0.25);
        background: rgba(72, 240, 107, 0.1);
        color: #bfffe5;
      }

      .signup-status.error {
        border-color: rgba(255, 118, 118, 0.25);
        background: rgba(255, 118, 118, 0.1);
        color: #ffd2d8;
      }

      .signup-status.warning {
        border-color: rgba(255, 209, 102, 0.28);
        background: rgba(255, 209, 102, 0.1);
        color: #ffeaa6;
      }

      #paymentBox,
      [data-payment-box] {
        margin: 1.25rem 0;
      }

      .payment-box-inner {
        padding: 1.1rem;
        border-radius: 20px;
        border: 1px solid rgba(231, 182, 79, 0.24);
        background:
          radial-gradient(circle at top right, rgba(231, 182, 79, 0.13), transparent 34%),
          rgba(255, 255, 255, 0.04);
        color: rgba(248, 243, 231, 0.78);
      }

      .payment-box-header {
        display: grid;
        gap: 0.35rem;
        margin-bottom: 1rem;
      }

      .payment-box-header .payment-eyebrow {
        color: #e7b64f;
        font-size: 0.76rem;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .payment-box-header strong {
        color: #f8f3e7;
        font-size: 1.35rem;
      }

      .payment-box-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }

      .payment-box-grid div {
        padding: 0.85rem;
        border-radius: 16px;
        border: 1px solid rgba(231, 182, 79, 0.14);
        background: rgba(255, 255, 255, 0.035);
      }

      .payment-box-grid span {
        display: block;
        margin-bottom: 0.3rem;
        color: rgba(248, 243, 231, 0.6);
        font-size: 0.82rem;
      }

      .payment-box-grid strong {
        color: #f7d98b;
      }

      .payment-box-inner p {
        margin: 1rem 0 0;
        color: rgba(248, 243, 231, 0.68);
        line-height: 1.6;
      }

      @media (max-width: 640px) {
        .payment-box-grid {
          grid-template-columns: 1fr;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    const form = getForm();

    if (!form) return;

    injectSignupStyles();
    addStatusBoxIfMissing();
    addPaymentBoxIfMissing();
    renderPaymentBox();
    applyReferralFromUrl();
    enhanceSubmitButtonText();
    handlePaymentCancelledNotice();

    form.addEventListener("submit", handleSubmit);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();