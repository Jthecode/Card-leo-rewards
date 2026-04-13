// lib/passwords.js
import crypto from "crypto";

const DEFAULT_MIN_LENGTH = 10;
const DEFAULT_MAX_LENGTH = 128;
const DEFAULT_RESET_TOKEN_BYTES = 32;
const DEFAULT_HASH_SALT_BYTES = 16;
const DEFAULT_SCRYPT_KEYLEN = 64;

function normalizeText(value) {
  return String(value || "").trim();
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return fallback;
}

function toPositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function getPasswordPolicy() {
  return {
    minLength: toPositiveInteger(
      process.env.PASSWORD_MIN_LENGTH,
      DEFAULT_MIN_LENGTH
    ),
    maxLength: toPositiveInteger(
      process.env.PASSWORD_MAX_LENGTH,
      DEFAULT_MAX_LENGTH
    ),
    requireUppercase: parseBooleanEnv(
      process.env.PASSWORD_REQUIRE_UPPERCASE,
      true
    ),
    requireLowercase: parseBooleanEnv(
      process.env.PASSWORD_REQUIRE_LOWERCASE,
      true
    ),
    requireNumber: parseBooleanEnv(
      process.env.PASSWORD_REQUIRE_NUMBER,
      true
    ),
    requireSpecial: parseBooleanEnv(
      process.env.PASSWORD_REQUIRE_SPECIAL,
      false
    ),
    forbidSpaces: parseBooleanEnv(
      process.env.PASSWORD_FORBID_SPACES,
      true
    ),
    maxRepeatingChars: toPositiveInteger(
      process.env.PASSWORD_MAX_REPEATING_CHARS,
      3
    ),
    forbidCommonPatterns: parseBooleanEnv(
      process.env.PASSWORD_FORBID_COMMON_PATTERNS,
      true
    ),
  };
}

function getHashConfig() {
  return {
    saltBytes: toPositiveInteger(
      process.env.PASSWORD_HASH_SALT_BYTES,
      DEFAULT_HASH_SALT_BYTES
    ),
    keylen: toPositiveInteger(
      process.env.PASSWORD_HASH_KEYLEN,
      DEFAULT_SCRYPT_KEYLEN
    ),
    cost: toPositiveInteger(process.env.PASSWORD_SCRYPT_N, 16384),
    blockSize: toPositiveInteger(process.env.PASSWORD_SCRYPT_R, 8),
    parallelization: toPositiveInteger(process.env.PASSWORD_SCRYPT_P, 1),
  };
}

function getResetTokenBytes() {
  return toPositiveInteger(
    process.env.PASSWORD_RESET_TOKEN_BYTES,
    DEFAULT_RESET_TOKEN_BYTES
  );
}

function isString(value) {
  return typeof value === "string";
}

function hasUppercase(value) {
  return /[A-Z]/.test(value);
}

function hasLowercase(value) {
  return /[a-z]/.test(value);
}

function hasNumber(value) {
  return /\d/.test(value);
}

function hasSpecial(value) {
  return /[^A-Za-z0-9]/.test(value);
}

function hasWhitespace(value) {
  return /\s/.test(value);
}

function getLongestRepeatingRun(value) {
  let longest = 0;
  let current = 0;
  let previous = "";

  for (const char of String(value || "")) {
    if (char === previous) {
      current += 1;
    } else {
      current = 1;
      previous = char;
    }

    if (current > longest) longest = current;
  }

  return longest;
}

function findCommonPattern(value) {
  const normalized = String(value || "").toLowerCase();

  const patterns = [
    "password",
    "123456",
    "12345678",
    "qwerty",
    "abc123",
    "letmein",
    "welcome",
    "admin",
    "cardleo",
    "reward",
    "rewards",
  ];

  return patterns.find((pattern) => normalized.includes(pattern)) || "";
}

function getPasswordChecks(password, policy = getPasswordPolicy()) {
  const value = isString(password) ? password : String(password || "");
  const length = value.length;

  return {
    length,
    minLengthMet: length >= policy.minLength,
    maxLengthMet: length <= policy.maxLength,
    hasUppercase: hasUppercase(value),
    hasLowercase: hasLowercase(value),
    hasNumber: hasNumber(value),
    hasSpecial: hasSpecial(value),
    hasWhitespace: hasWhitespace(value),
    longestRepeatingRun: getLongestRepeatingRun(value),
    commonPattern: policy.forbidCommonPatterns ? findCommonPattern(value) : "",
  };
}

function getPasswordValidationErrors(password, policy = getPasswordPolicy()) {
  const checks = getPasswordChecks(password, policy);
  const errors = [];

  if (!checks.minLengthMet) {
    errors.push(`Password must be at least ${policy.minLength} characters.`);
  }

  if (!checks.maxLengthMet) {
    errors.push(`Password must be no more than ${policy.maxLength} characters.`);
  }

  if (policy.requireUppercase && !checks.hasUppercase) {
    errors.push("Password must include at least one uppercase letter.");
  }

  if (policy.requireLowercase && !checks.hasLowercase) {
    errors.push("Password must include at least one lowercase letter.");
  }

  if (policy.requireNumber && !checks.hasNumber) {
    errors.push("Password must include at least one number.");
  }

  if (policy.requireSpecial && !checks.hasSpecial) {
    errors.push("Password must include at least one special character.");
  }

  if (policy.forbidSpaces && checks.hasWhitespace) {
    errors.push("Password cannot contain spaces.");
  }

  if (
    Number.isFinite(policy.maxRepeatingChars) &&
    policy.maxRepeatingChars > 0 &&
    checks.longestRepeatingRun > policy.maxRepeatingChars
  ) {
    errors.push(
      `Password cannot repeat the same character more than ${policy.maxRepeatingChars} times in a row.`
    );
  }

  if (policy.forbidCommonPatterns && checks.commonPattern) {
    errors.push("Password contains a weak or common pattern.");
  }

  return errors;
}

function validatePassword(password, policy = getPasswordPolicy()) {
  const value = isString(password) ? password : String(password || "");
  const errors = getPasswordValidationErrors(value, policy);

  return {
    valid: errors.length === 0,
    errors,
    policy,
    checks: getPasswordChecks(value, policy),
  };
}

function passwordsMatch(password, confirmPassword) {
  return String(password || "") === String(confirmPassword || "");
}

function assertValidPassword(password, policy = getPasswordPolicy()) {
  const result = validatePassword(password, policy);

  if (!result.valid) {
    const error = new Error(result.errors[0] || "Password validation failed.");
    error.code = "PASSWORD_VALIDATION_FAILED";
    error.status = 400;
    error.details = result;
    throw error;
  }

  return result;
}

function scorePassword(password, policy = getPasswordPolicy()) {
  const value = isString(password) ? password : String(password || "");
  const checks = getPasswordChecks(value, policy);
  let score = 0;

  if (checks.minLengthMet) score += 20;
  if (checks.length >= Math.max(policy.minLength + 2, 12)) score += 10;
  if (checks.length >= Math.max(policy.minLength + 6, 16)) score += 10;
  if (checks.hasUppercase) score += 15;
  if (checks.hasLowercase) score += 15;
  if (checks.hasNumber) score += 15;
  if (checks.hasSpecial) score += 10;
  if (!checks.hasWhitespace) score += 5;

  if (
    Number.isFinite(policy.maxRepeatingChars) &&
    checks.longestRepeatingRun > policy.maxRepeatingChars
  ) {
    score -= 20;
  }

  if (checks.commonPattern) {
    score -= 25;
  }

  score = Math.max(0, Math.min(100, score));

  let label = "weak";
  if (score >= 80) label = "strong";
  else if (score >= 60) label = "good";
  else if (score >= 40) label = "fair";

  return {
    score,
    label,
    checks,
    policy,
  };
}

function generateResetToken(bytes = getResetTokenBytes()) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashResetToken(token) {
  return sha256(token);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length === 0 || right.length === 0) return false;
  if (left.length !== right.length) return false;

  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function hashPassword(password, config = getHashConfig()) {
  const value = isString(password) ? password : String(password || "");
  const salt = crypto.randomBytes(config.saltBytes).toString("hex");

  const derivedKey = crypto.scryptSync(value, salt, config.keylen, {
    N: config.cost,
    r: config.blockSize,
    p: config.parallelization,
  });

  return [
    "scrypt",
    config.cost,
    config.blockSize,
    config.parallelization,
    config.keylen,
    salt,
    derivedKey.toString("hex"),
  ].join("$");
}

function verifyPassword(password, storedHash) {
  const value = isString(password) ? password : String(password || "");
  const encoded = normalizeText(storedHash);

  if (!encoded) return false;

  const parts = encoded.split("$");
  if (parts.length !== 7) return false;

  const [
    algorithm,
    costRaw,
    blockSizeRaw,
    parallelizationRaw,
    keylenRaw,
    salt,
    hashHex,
  ] = parts;

  if (algorithm !== "scrypt") return false;

  const cost = toPositiveInteger(costRaw, 16384);
  const blockSize = toPositiveInteger(blockSizeRaw, 8);
  const parallelization = toPositiveInteger(parallelizationRaw, 1);
  const keylen = toPositiveInteger(keylenRaw, DEFAULT_SCRYPT_KEYLEN);

  try {
    const derivedKey = crypto.scryptSync(value, salt, keylen, {
      N: cost,
      r: blockSize,
      p: parallelization,
    });

    return safeEqual(derivedKey.toString("hex"), hashHex);
  } catch {
    return false;
  }
}

function compareResetToken(token, tokenHash) {
  return safeEqual(hashResetToken(token), tokenHash);
}

function sanitizePasswordInput(password) {
  return isString(password) ? password : String(password || "");
}

function getPasswordHelpText(policy = getPasswordPolicy()) {
  const lines = [`Use at least ${policy.minLength} characters.`];

  if (policy.requireUppercase) lines.push("Include an uppercase letter.");
  if (policy.requireLowercase) lines.push("Include a lowercase letter.");
  if (policy.requireNumber) lines.push("Include a number.");
  if (policy.requireSpecial) lines.push("Include a special character.");
  if (policy.forbidSpaces) lines.push("Do not use spaces.");

  return lines;
}

const PASSWORD_POLICY = getPasswordPolicy();

export { PASSWORD_POLICY };

export {
  getPasswordPolicy,
  getHashConfig,
  getResetTokenBytes,
  getPasswordChecks,
  getPasswordValidationErrors,
  validatePassword,
  passwordsMatch,
  assertValidPassword,
  scorePassword,
  generateResetToken,
  hashResetToken,
  compareResetToken,
  sha256,
  hashPassword,
  verifyPassword,
  sanitizePasswordInput,
  getPasswordHelpText,
};

export default {
  PASSWORD_POLICY,
  getPasswordPolicy,
  getHashConfig,
  getResetTokenBytes,
  getPasswordChecks,
  getPasswordValidationErrors,
  validatePassword,
  passwordsMatch,
  assertValidPassword,
  scorePassword,
  generateResetToken,
  hashResetToken,
  compareResetToken,
  sha256,
  hashPassword,
  verifyPassword,
  sanitizePasswordInput,
  getPasswordHelpText,
};