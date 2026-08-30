import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, prepareImport } from "../tools/import-csv.js";

test("CSV parser handles quoted values and a byte-order mark without rewriting data", () => {
  const rows = parseCsv('\uFEFFFirst Name (legal),Last Name (legal),Email Address,Preferred Name\r\n"Ali, Jr",Example,ALI@example.com,N/A\r\n');
  assert.deepEqual(rows, [{
    line: 2,
    values: {
      "First Name (legal)": "Ali, Jr",
      "Last Name (legal)": "Example",
      "Email Address": "ALI@example.com",
      "Preferred Name": "N/A",
    },
  }]);
});

test("CSV parser rejects malformed files and missing required headers", () => {
  assert.throws(() => parseCsv('First Name (legal),Last Name (legal),Email Address\n"Ali,Example,a@example.com'), /unterminated/);
  assert.throws(() => parseCsv("First Name (legal),Email Address\nAli,a@example.com"), /Last Name/);
});

test("import preflight skips existing attendees and orders new referral dependencies", () => {
  const rows = parseCsv([
    "First Name (legal),Last Name (legal),Email Address,Referral Code,Owned Referral Code",
    "Child,Example,child@example.com,PARENT-1,CHILD-1",
    "Existing,Example,EXISTING@example.com,,EXISTING-NEW",
    "Parent,Example,parent@example.com,,PARENT-1",
  ].join("\n"));
  const existing = [{ program_slug: "bp_one", email_normalized: "existing@example.com", owned_referral_code: "OLD-1" }];
  const result = prepareImport(rows, existing, "bp_one");

  assert.deepEqual(result.errors, []);
  assert.equal(result.skippedExisting, 1);
  assert.deepEqual(result.ready.map((item) => item.signup.email), ["parent@example.com", "child@example.com"]);
});

test("import preflight clears malformed and unresolved referral codes", () => {
  const rows = parseCsv([
    "First Name (legal),Last Name (legal),Email Address,Referral Code,Owned Referral Code",
    "Ali,Example,private@example.com,UNKNOWN,ALI-1",
    "Mia,Example,mia@example.com,not a code,invalid owner code",
  ].join("\n"));
  const result = prepareImport(rows, [], "bp_one");

  assert.deepEqual(result.errors, []);
  assert.equal(result.ready.length, 2);
  assert.deepEqual(result.ready.map((item) => item.signup.referralCodeUsed), ["", ""]);
  assert.equal(result.ignoredReferralCodes, 2);
  assert.equal(result.regeneratedOwnedCodes, 1);
  assert.equal(result.ready[0].ownedReferralCode, "ALI-1");
  assert.match(result.ready[1].ownedReferralCode, /^MIA-[A-F0-9]{5}$/);
});

test("import preflight keeps duplicate emails as hard errors without echoing private values", () => {
  const rows = parseCsv([
    "First Name (legal),Last Name (legal),Email Address",
    "Ali,Example,private@example.com",
    "Ali,Example,PRIVATE@example.com",
  ].join("\n"));
  const result = prepareImport(rows, [], "bp_one");
  const report = JSON.stringify(result.errors);

  assert.equal(result.ready.length, 0);
  assert.match(report, /Duplicate normalized email/);
  assert.doesNotMatch(report, /private@example/);
});
