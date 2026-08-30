import test from "node:test";
import assert from "node:assert/strict";
import {
  createProgramCredentials,
  escapeHtml,
  generateRefCode,
  hashSecret,
  isBearerAuthorized,
  isSameOrigin,
  isValidReferralCode,
  isValidPublicSlug,
  parseAllowedOrigins,
  toPublicLeaderboard,
  validateProgramName,
  validateSignup,
} from "../src/domain.js";

test("normalizes a valid signup", () => {
  const result = validateSignup({
    firstName: "  Alice ",
    lastName: " Example ",
    preferredName: "  Ali ",
    email: " ALICE@EXAMPLE.COM ",
    referralCodeUsed: " kiwi-abc123 ",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    firstName: "Alice",
    lastName: "Example",
    preferredName: "Ali",
    email: "alice@example.com",
    referralCodeUsed: "KIWI-ABC123",
  });
});

test("rejects missing and invalid fields", () => {
  const result = validateSignup({ firstName: "", lastName: "Example", email: "not-an-email" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["firstName is required.", "email must be valid."]);
});

test("rejects values that could alter a NocoDB filter", () => {
  const email = validateSignup({ firstName: "A", lastName: "B", email: "a)~or(active,eq,true)@example.com" });
  const code = validateSignup({ firstName: "A", lastName: "B", email: "a@example.com", referralCodeUsed: "OK)~OR(X" });
  assert.equal(email.ok, false);
  assert.equal(code.ok, false);
});

test("rejects control characters in human-readable fields", () => {
  const signup = validateSignup({ firstName: "Ali\nInjected", lastName: "Example", email: "a@example.com" });
  assert.equal(signup.ok, false);
  assert.match(signup.errors.join(" "), /control characters/);
  assert.match(validateProgramName("Nova\u0000Hidden").error, /control characters/);
});

test("bearer authorization requires an exact secret", () => {
  assert.equal(isBearerAuthorized("Bearer correct-horse", "correct-horse"), true);
  assert.equal(isBearerAuthorized("Bearer incorrect", "correct-horse"), false);
  assert.equal(isBearerAuthorized(undefined, "correct-horse"), false);
});

test("creates separate unguessable program and webhook credentials", () => {
  const first = createProgramCredentials();
  const second = createProgramCredentials();
  assert.match(first.publicSlug, /^bp_[A-Za-z0-9_-]{24}$/);
  assert.match(first.webhookSecret, /^bk_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.publicSlug, second.publicSlug);
  assert.notEqual(first.webhookSecret, second.webhookSecret);
  assert.match(hashSecret(first.webhookSecret), /^[a-f0-9]{64}$/);
  assert.equal(hashSecret(first.webhookSecret), hashSecret(first.webhookSecret));
  assert.equal(isValidPublicSlug(first.publicSlug), true);
  assert.equal(isValidPublicSlug("bp_invalid)~or(active,eq,true)"), false);
});

test("creates sanitized referral codes with independent random suffixes", () => {
  const first = generateRefCode("Émi<script>", "Example", "emi@example.com");
  const second = generateRefCode("Émi<script>", "Example", "emi@example.com");
  assert.match(first, /^EMI-[A-F0-9]{5}$/);
  assert.match(second, /^EMI-[A-F0-9]{5}$/);
  assert.notEqual(first, second);
  assert.equal(isValidReferralCode(first), true);
  assert.equal(isValidReferralCode("BAD)~OR(X"), false);
});

test("validates program names and admin request origins", () => {
  assert.deepEqual(validateProgramName("  Nova 2027 "), { ok: true, value: "Nova 2027" });
  assert.equal(validateProgramName(" ").ok, false);
  assert.equal(isSameOrigin("https://admin.example.com", "https://admin.example.com/path"), true);
  assert.equal(isSameOrigin("https://evil.example", "https://admin.example.com"), false);
});

test("public leaderboard strips private fields and excludes zero counts", () => {
  const result = toPublicLeaderboard([
    { display_name: "Mia", referral_count: 2, email: "private@example.com", owned_referral_code: "NOPE" },
    { display_name: "Ari", referral_count: 3, referrer_id: "private" },
    { display_name: "Zoe", referral_count: 0 },
  ]);
  assert.deepEqual(result, [
    { displayName: "Ari", referralCount: 3 },
    { displayName: "Mia", referralCount: 2 },
  ]);
});

test("escapes admin values", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("normalizes configured browser origins and ignores invalid values", () => {
  assert.deepEqual([...parseAllowedOrigins("https://example.com/, http://localhost:8080/path, nope")], [
    "https://example.com",
    "http://localhost:8080",
  ]);
});
