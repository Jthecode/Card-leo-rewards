// lib/validation.js

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;
const LETTERS_ONLY_REGEX = /^[a-zA-Z\s'.-]+$/;
const HAS_LOWER_REGEX = /[a-z]/;
const HAS_UPPER_REGEX = /[A-Z]/;
const HAS_NUMBER_REGEX = /\d/;
const HAS_SPECIAL_REGEX = /[^A-Za-z0-9]/;

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function onlyDigits(value) {
  return clean(value).replace(/\D/g, "");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeText(value, fallback = "") {
  const normalized = clean(value);
  return normalized || fallback;
}

export function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

export function normalizePhone(value) {
  const digits = onlyDigits(value);

  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  return clean(value);
}

export function normalizeName(value) {
  return clean(value).replace(/\s{2,}/g, " ");
}

export function isValidEmail(value) {
  return EMAIL_REGEX.test(normalizeEmail(value));
}

export function isValidPhone(value) {
  const normalized = normalizePhone(value);
  return E164_PHONE_REGEX.test(normalized);
}

export function isValidName(value, { min = 2, max = 80 } = {}) {
  const normalized = normalizeName(value);
  if (!normalized) return false;
  if (normalized.length < min || normalized.length > max) return false;
  return LETTERS_ONLY_REGEX.test(normalized);
}

export function isStrongPassword(
  value,
  {
    min = 8,
    max = 128,
    requireLower = true,
    requireUpper = true,
    requireNumber = true,
    requireSpecial = false,
  } = {}
) {
  const password = String(value || "");

  if (password.length < min || password.length > max) return false;
  if (requireLower && !HAS_LOWER_REGEX.test(password)) return false;
  if (requireUpper && !HAS_UPPER_REGEX.test(password)) return false;
  if (requireNumber && !HAS_NUMBER_REGEX.test(password)) return false;
  if (requireSpecial && !HAS_SPECIAL_REGEX.test(password)) return false;

  return true;
}

export function isValidPassword(value, options = {}) {
  return isStrongPassword(value, options);
}

export function validateRequiredFields(payload = {}, fields = []) {
  const errors = {};

  for (const field of fields) {
    const value = payload?.[field];
    if (value === undefined || value === null || clean(value) === "") {
      errors[field] = `${field} is required.`;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateLoginInput(payload = {}) {
  const errors = {};
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");

  if (!email) {
    errors.email = "Email is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!password) {
    errors.password = "Password is required.";
  } else if (password.length < 8) {
    errors.password = "Password must be at least 8 characters.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: { email, password },
    errors,
  };
}

export function validateForgotPasswordInput(payload = {}) {
  const errors = {};
  const email = normalizeEmail(payload.email);

  if (!email) {
    errors.email = "Email is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: { email },
    errors,
  };
}

export function validateResetPasswordInput(payload = {}) {
  const errors = {};
  const token = clean(payload.token);
  const password = String(payload.password || "");
  const confirmPassword = String(payload.confirmPassword || "");

  if (!token) {
    errors.token = "Reset token is required.";
  }

  if (!password) {
    errors.password = "New password is required.";
  } else if (
    !isStrongPassword(password, {
      min: 8,
      requireLower: true,
      requireUpper: true,
      requireNumber: true,
      requireSpecial: false,
    })
  ) {
    errors.password =
      "Password must be at least 8 characters and include uppercase, lowercase, and a number.";
  }

  if (!confirmPassword) {
    errors.confirmPassword = "Please confirm your new password.";
  } else if (password !== confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: { token, password, confirmPassword },
    errors,
  };
}

export function validateChangePasswordInput(payload = {}) {
  const errors = {};
  const currentPassword = String(payload.currentPassword || "");
  const newPassword = String(payload.newPassword || "");
  const confirmPassword = String(payload.confirmPassword || "");

  if (!currentPassword) {
    errors.currentPassword = "Current password is required.";
  }

  if (!newPassword) {
    errors.newPassword = "New password is required.";
  } else if (
    !isStrongPassword(newPassword, {
      min: 8,
      requireLower: true,
      requireUpper: true,
      requireNumber: true,
      requireSpecial: false,
    })
  ) {
    errors.newPassword =
      "New password must be at least 8 characters and include uppercase, lowercase, and a number.";
  }

  if (!confirmPassword) {
    errors.confirmPassword = "Please confirm your new password.";
  } else if (newPassword !== confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  if (currentPassword && newPassword && currentPassword === newPassword) {
    errors.newPassword =
      "New password must be different from your current password.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      currentPassword,
      newPassword,
      confirmPassword,
    },
    errors,
  };
}

export function validateProfileInput(payload = {}) {
  const errors = {};

  const fullName = normalizeName(
    payload.fullName ||
      [payload.firstName, payload.lastName].filter(Boolean).join(" ")
  );
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const city = clean(payload.city);
  const state = clean(payload.state);
  const timezone = clean(payload.timezone);
  const language = clean(payload.language);
  const theme = clean(payload.theme);

  if (!fullName) {
    errors.fullName = "Full name is required.";
  } else if (!isValidName(fullName, { min: 2, max: 80 })) {
    errors.fullName = "Enter a valid full name.";
  }

  if (email && !isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (phone && !isValidPhone(phone)) {
    errors.phone = "Enter a valid phone number.";
  }

  if (city && city.length > 80) {
    errors.city = "City is too long.";
  }

  if (state && state.length > 80) {
    errors.state = "State is too long.";
  }

  if (timezone && timezone.length > 80) {
    errors.timezone = "Timezone is too long.";
  }

  if (language && language.length > 20) {
    errors.language = "Language value is too long.";
  }

  if (theme && theme.length > 40) {
    errors.theme = "Theme value is too long.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      fullName,
      email,
      phone,
      city,
      state,
      timezone,
      language,
      theme,
    },
    errors,
  };
}

export function validatePortalSettingsInput(payload = {}) {
  const errors = {};

  const timezone = clean(payload.timezone);
  const theme = clean(payload.theme);
  const language = clean(payload.language);
  const preferredContactMethod = clean(payload.preferredContactMethod);

  const marketingEmailOptIn = Boolean(payload.marketingEmailOptIn ?? payload.notifPartners);
  const smsOptIn = Boolean(payload.smsOptIn ?? payload.notifSms);
  const rewardReminders = Boolean(payload.rewardReminders ?? payload.notifRewards);
  const securityAlerts = Boolean(payload.securityAlerts ?? payload.securityLoginAlerts);
  const supportNotifications = Boolean(payload.supportNotifications ?? payload.notifAlerts);
  const darkMode = Boolean(payload.darkMode ?? payload.theme === "luxury-dark");

  const allowedThemes = new Set([
    "luxury-dark",
    "classic-gold",
    "minimal-night",
  ]);

  const allowedLanguages = new Set(["en", "es"]);
  const allowedTimezones = new Set([
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
  ]);

  const allowedContactMethods = new Set(["email", "sms", "phone"]);

  if (timezone && !allowedTimezones.has(timezone)) {
    errors.timezone = "Invalid timezone selected.";
  }

  if (theme && !allowedThemes.has(theme)) {
    errors.theme = "Invalid theme selected.";
  }

  if (language && !allowedLanguages.has(language)) {
    errors.language = "Invalid language selected.";
  }

  if (
    preferredContactMethod &&
    !allowedContactMethods.has(preferredContactMethod)
  ) {
    errors.preferredContactMethod = "Invalid preferred contact method selected.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      timezone,
      theme,
      language,
      preferredContactMethod,
      marketingEmailOptIn,
      smsOptIn,
      rewardReminders,
      securityAlerts,
      supportNotifications,
      darkMode,
    },
    errors,
  };
}

export function validateSupportInput(payload = {}) {
  const errors = {};

  const fullName = normalizeName(payload.fullName || payload.name);
  const email = normalizeEmail(payload.email);
  const subject = clean(payload.subject);
  const message = clean(payload.message);
  const category = clean(payload.category || "general");
  const priority = clean(payload.priority || "normal");

  const allowedCategories = new Set([
    "general",
    "account",
    "rewards",
    "billing",
    "technical",
    "verification",
    "referral",
    "other",
  ]);

  const allowedPriorities = new Set(["low", "normal", "high", "urgent"]);

  if (!fullName) {
    errors.fullName = "Full name is required.";
  } else if (!isValidName(fullName, { min: 2, max: 80 })) {
    errors.fullName = "Enter a valid full name.";
  }

  if (!email) {
    errors.email = "Email is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!subject) {
    errors.subject = "Subject is required.";
  } else if (subject.length < 3 || subject.length > 120) {
    errors.subject = "Subject must be between 3 and 120 characters.";
  }

  if (!message) {
    errors.message = "Message is required.";
  } else if (message.length < 10 || message.length > 5000) {
    errors.message = "Message must be between 10 and 5000 characters.";
  }

  if (category && !allowedCategories.has(category)) {
    errors.category = "Invalid support category selected.";
  }

  if (priority && !allowedPriorities.has(priority)) {
    errors.priority = "Invalid priority selected.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      fullName,
      email,
      subject,
      message,
      category,
      priority,
    },
    errors,
  };
}

export function validateContactInput(payload = {}) {
  const errors = {};

  const name = normalizeName(payload.name || payload.fullName);
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const topic = clean(payload.topic || "general");
  const message = clean(payload.message);

  if (!name) {
    errors.name = "Name is required.";
  } else if (!isValidName(name, { min: 2, max: 100 })) {
    errors.name = "Enter a valid name.";
  }

  if (!email) {
    errors.email = "Email is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (phone && !isValidPhone(phone)) {
    errors.phone = "Enter a valid phone number.";
  }

  if (!topic) {
    errors.topic = "Topic is required.";
  } else if (topic.length > 80) {
    errors.topic = "Topic is too long.";
  }

  if (!message) {
    errors.message = "Message is required.";
  } else if (message.length < 10 || message.length > 5000) {
    errors.message = "Message must be between 10 and 5000 characters.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      name,
      email,
      phone,
      topic,
      message,
    },
    errors,
  };
}

export function validateSignupInput(payload = {}) {
  const errors = {};

  const firstName = normalizeName(payload.firstName);
  const lastName = normalizeName(payload.lastName);
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const city = clean(payload.city);
  const state = clean(payload.state);
  const referralName = clean(payload.referralName);
  const interest = clean(payload.interest);
  const goals = clean(payload.goals);
  const agreed = Boolean(payload.agreed);

  if (!firstName) {
    errors.firstName = "First name is required.";
  } else if (!isValidName(firstName, { min: 1, max: 100 })) {
    errors.firstName = "Enter a valid first name.";
  }

  if (!lastName) {
    errors.lastName = "Last name is required.";
  } else if (!isValidName(lastName, { min: 1, max: 100 })) {
    errors.lastName = "Enter a valid last name.";
  }

  if (!email) {
    errors.email = "Email is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (phone && !isValidPhone(phone)) {
    errors.phone = "Enter a valid phone number.";
  }

  if (city && city.length > 100) {
    errors.city = "City is too long.";
  }

  if (state && state.length > 100) {
    errors.state = "State is too long.";
  }

  if (referralName && referralName.length > 150) {
    errors.referralName = "Referral name is too long.";
  }

  if (interest && interest.length > 150) {
    errors.interest = "Interest value is too long.";
  }

  if (goals && goals.length > 2000) {
    errors.goals = "Goals are too long.";
  }

  if (!agreed) {
    errors.agreed = "You must agree before continuing.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    values: {
      firstName,
      lastName,
      email,
      phone,
      city,
      state,
      referralName,
      interest,
      goals,
      agreed,
    },
    errors,
  };
}

export function safeObject(value, fallback = {}) {
  return isObject(value) ? value : fallback;
}

export default {
  normalizeText,
  normalizeEmail,
  normalizePhone,
  normalizeName,
  isValidEmail,
  isValidPhone,
  isValidName,
  isStrongPassword,
  isValidPassword,
  validateRequiredFields,
  validateLoginInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
  validateChangePasswordInput,
  validateProfileInput,
  validatePortalSettingsInput,
  validateSupportInput,
  validateContactInput,
  validateSignupInput,
  safeObject,
};