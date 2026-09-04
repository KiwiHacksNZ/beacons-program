import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDbClient } from "../src/memory-db.js";

test("accepts a signup, applies a referral, and ignores a duplicate email", async () => {
  const db = createMemoryDbClient();
  const program = await db.createProgram({ name: "Nova", publicSlug: "bp_nova", webhookSecretHash: "hash", loopsTransactionalId: null });

  const first = await db.acceptSignup(program, { firstName: "Ali", lastName: "Example", preferredName: "", email: "ali@example.com", referralCodeUsed: "" }, "ALI-ONE");
  assert.equal(first.accepted, true);
  assert.equal(first.owned_referral_code, "ALI-ONE");

  const second = await db.acceptSignup(program, { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "ali-one" }, "BEA-ONE");
  assert.equal(second.accepted, true);
  assert.equal(second.referral_applied, true);

  const duplicate = await db.acceptSignup(program, { firstName: "Ali", lastName: "Example", preferredName: "", email: "ALI@example.com", referralCodeUsed: "" }, "ALI-TWO");
  assert.equal(duplicate.accepted, false);

  assert.deepEqual(await db.getLeaderboard(program), [{ displayName: "Ali", referralCount: 1 }]);
});

test("adds an additional referral code and counts a referral made with it toward the same total", async () => {
  const db = createMemoryDbClient();
  const program = await db.createProgram({ name: "Nova", publicSlug: "bp_nova", webhookSecretHash: "hash", loopsTransactionalId: null });
  await db.acceptSignup(program, { firstName: "Ali", lastName: "Example", preferredName: "", email: "ali@example.com", referralCodeUsed: "" }, "ALI-ONE");

  const attendee = (await db.getAdminAttendees())[0];
  const customCode = await db.addReferralCode(attendee, "FRIEND-CODE");
  assert.equal(customCode, "FRIEND-CODE");
  await assert.rejects(db.addReferralCode(attendee, "FRIEND-CODE"), /already has that referral code/);

  await db.acceptSignup(program, { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "friend-code" }, "BEA-ONE");
  assert.deepEqual(await db.getLeaderboard(program), [{ displayName: "Ali", referralCount: 1 }]);
});

test("removes an additional referral code so it stops working for future referrals", async () => {
  const db = createMemoryDbClient();
  const program = await db.createProgram({ name: "Nova", publicSlug: "bp_nova", webhookSecretHash: "hash", loopsTransactionalId: null });
  await db.acceptSignup(program, { firstName: "Ali", lastName: "Example", preferredName: "", email: "ali@example.com", referralCodeUsed: "" }, "ALI-ONE");

  const attendee = (await db.getAdminAttendees())[0];
  await db.addReferralCode(attendee, "FRIEND-CODE");
  await db.removeReferralCode(attendee, "friend-code");

  await assert.rejects(db.removeReferralCode(attendee, "FRIEND-CODE"), /isn't assigned to this attendee/);

  await db.acceptSignup(program, { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "friend-code" }, "BEA-ONE");
  assert.deepEqual(await db.getLeaderboard(program), []);
});

test("rejects a custom code already used elsewhere in the program and rotates a program secret", async () => {
  const db = createMemoryDbClient();
  const program = await db.createProgram({ name: "Nova", publicSlug: "bp_nova", webhookSecretHash: "hash", loopsTransactionalId: null });
  await db.acceptSignup(program, { firstName: "Ali", lastName: "Example", preferredName: "", email: "ali@example.com", referralCodeUsed: "" }, "ALI-ONE");
  const bea = await db.acceptSignup(program, { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "" }, "BEA-ONE");
  const beaAttendee = await db.getAttendeeById(bea.attendee_id);

  await assert.rejects(db.addReferralCode(beaAttendee, "ALI-ONE"), /already used in this program/);

  const rotated = await db.rotateProgramSecret({ programId: program.Id, webhookSecretHash: "new-hash" });
  assert.equal(rotated.webhook_secret_hash, "new-hash");
  assert.equal((await db.getAdminPrograms())[0].webhook_secret_hash, "new-hash");
});
