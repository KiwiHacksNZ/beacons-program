import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_NAME_LENGTH = 100;
const MAX_CODE_LENGTH = 64;
const MAX_EMAIL_LENGTH = 254;
// Deliberately excludes NocoDB filter delimiters such as commas, parentheses,
// and tildes. The service supports normal unquoted mailbox addresses rather
// than every address permitted by the email RFCs.
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const REFERRAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const PUBLIC_SLUG_PATTERN = /^bp_[A-Za-z0-9_-]{24}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstPresent(payload, keys) {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) return payload[key];
  }
  return undefined;
}

export function isValidReferralCode(value) {
  const code = cleanText(value).toUpperCase();
  return code.length > 0 && code.length <= MAX_CODE_LENGTH && REFERRAL_CODE_PATTERN.test(code);
}

export function validateSignup(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const value = {
    firstName: cleanText(firstPresent(payload, ["firstName", "first_name"])),
    lastName: cleanText(firstPresent(payload, ["lastName", "last_name"])),
    preferredName: cleanText(firstPresent(payload, ["preferredName", "preferred_name"])),
    email: cleanText(payload.email).toLowerCase(),
    referralCodeUsed: cleanText(
      firstPresent(payload, ["referralCodeUsed", "referral_code_used", "referralCode"]),
    ).toUpperCase(),
  };

  const errors = [];
  if (!value.firstName) errors.push("firstName is required.");
  if (!value.lastName) errors.push("lastName is required.");
  if (!value.email) errors.push("email is required.");
  else if (value.email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value.email)) errors.push("email must be valid.");

  for (const [key, input] of Object.entries({
    firstName: value.firstName,
    lastName: value.lastName,
    preferredName: value.preferredName,
  })) {
    if (input.length > MAX_NAME_LENGTH) errors.push(`${key} must be ${MAX_NAME_LENGTH} characters or fewer.`);
    else if (CONTROL_CHARACTER_PATTERN.test(input)) errors.push(`${key} must not contain control characters.`);
  }
  if (value.referralCodeUsed.length > MAX_CODE_LENGTH) {
    errors.push(`referralCodeUsed must be ${MAX_CODE_LENGTH} characters or fewer.`);
  } else if (value.referralCodeUsed && !isValidReferralCode(value.referralCodeUsed)) {
    errors.push("referralCodeUsed contains unsupported characters.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateProgramName(value) {
  const name = cleanText(value);
  if (!name) return { ok: false, error: "Program name is required." };
  if (name.length > 120) return { ok: false, error: "Program name must be 120 characters or fewer." };
  if (CONTROL_CHARACTER_PATTERN.test(name)) return { ok: false, error: "Program name must not contain control characters." };
  return { ok: true, value: name };
}

export function validateLoopsTransactionalId(value) {
  const id = cleanText(value);
  if (!id) return { ok: true, value: null };
  if (id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return { ok: false, error: "Loops Transactional ID must use only letters, numbers, hyphens, and underscores." };
  }
  return { ok: true, value: id };
}

export function isValidPublicSlug(value) {
  return PUBLIC_SLUG_PATTERN.test(String(value || ""));
}

export function isValidRecordId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(value || ""));
}

export function createProgramCredentials() {
  return {
    publicSlug: `bp_${randomBytes(18).toString("base64url")}`,
    webhookSecret: `bk_${randomBytes(32).toString("base64url")}`,
  };
}

export function hashSecret(secret) {
  return createHash("sha256").update(String(secret)).digest("hex");
}

export function generateRefCode(firstName, lastName = "", email = "") {
  const normalizedName = String(firstName || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const prefix = (normalizedName || "JOIN").slice(0, 3).padEnd(3, "X");
  const hashInput = [
    String(firstName || "").trim().toLowerCase(),
    String(lastName || "").trim().toLowerCase(),
    String(email || "").trim().toLowerCase(),
    randomBytes(16).toString("hex"),
  ].join("\u0000");
  const suffix = createHash("sha256").update(hashInput).digest("hex").slice(0, 5).toUpperCase();
  return `${prefix}-${suffix}`;
}

export function bearerToken(headerValue) {
  if (typeof headerValue !== "string") return "";
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function securelyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function isBearerAuthorized(headerValue, expectedSecret) {
  return securelyMatches(bearerToken(headerValue), expectedSecret);
}

export function isSameOrigin(originHeader, expectedBaseUrl) {
  if (!originHeader || !expectedBaseUrl) return false;
  try {
    return new URL(originHeader).origin === new URL(expectedBaseUrl).origin;
  } catch {
    return false;
  }
}

export function toPublicLeaderboard(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Number.isInteger(Number(row.referral_count)) && Number(row.referral_count) > 0)
    .map((row) => ({
      displayName: cleanText(row.display_name),
      referralCount: Number(row.referral_count),
    }))
    .filter((row) => row.displayName)
    .sort((a, b) => b.referralCount - a.referralCount || a.displayName.localeCompare(b.displayName));
}

export function parseAllowedOrigins(value) {
  const origins = new Set();
  for (const item of String(value || "").split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) origins.add(url.origin);
    } catch {}
  }
  return origins;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
