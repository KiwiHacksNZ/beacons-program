import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_NAME_LENGTH = 100;
const MAX_CODE_LENGTH = 64;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstPresent(payload, keys) {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) return payload[key];
  }
  return undefined;
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
  else if (!EMAIL_PATTERN.test(value.email)) errors.push("email must be valid.");

  for (const [key, input] of Object.entries({
    firstName: value.firstName,
    lastName: value.lastName,
    preferredName: value.preferredName,
  })) {
    if (input.length > MAX_NAME_LENGTH) errors.push(`${key} must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  if (value.referralCodeUsed.length > MAX_CODE_LENGTH) {
    errors.push(`referralCodeUsed must be ${MAX_CODE_LENGTH} characters or fewer.`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateProgramName(value) {
  const name = cleanText(value);
  if (!name) return { ok: false, error: "Program name is required." };
  if (name.length > 120) return { ok: false, error: "Program name must be 120 characters or fewer." };
  return { ok: true, value: name };
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
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
