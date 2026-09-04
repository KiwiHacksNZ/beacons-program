import test from "node:test";
import assert from "node:assert/strict";
import { createNocoDBClient } from "../src/nocodb.js";

test("builds each leaderboard from the current NocoDB attendee records", async () => {
  const originalFetch = globalThis.fetch;
  const attendeeSnapshots = [
    [
      { first_name: "Ali", owned_referral_code: "ali-one", referral_code_used: null },
      { first_name: "Bea", owned_referral_code: "BEA-TWO", referral_code_used: "ALI-ONE" },
    ],
    [
      { first_name: "Ali", owned_referral_code: "ali-one", referral_code_used: null },
      { first_name: "Bea", owned_referral_code: "BEA-TWO", referral_code_used: "ALI-ONE" },
      { first_name: "Cal", owned_referral_code: "CAL-THREE", referral_code_used: "ALI-ONE" },
    ],
  ];
  let attendeeRead = 0;

  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const list = attendeeSnapshots[attendeeRead++];
      return jsonResponse({ list, pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const program = { public_slug: "bp_program" };

    assert.deepEqual(await client.getLeaderboard(program), [{ displayName: "Ali", referralCount: 1 }]);
    assert.deepEqual(await client.getLeaderboard(program), [{ displayName: "Ali", referralCount: 2 }]);
    assert.equal(attendeeRead, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips simultaneous case-variant emails within the same program", async () => {
  const originalFetch = globalThis.fetch;
  const records = [];

  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    // No additional_referral_codes column: simulates a base that hasn't added
    // it yet, to prove existing behavior is unaffected.
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "POST") {
      const record = { ...JSON.parse(options.body), Id: records.length + 1 };
      records.push(record);
      return jsonResponse(record);
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      return jsonResponse({ list: records.slice(0, 1), pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const program = { public_slug: "bp_program" };
    const signup = { firstName: "Seb", lastName: "Example", preferredName: "", referralCodeUsed: "" };
    const results = await Promise.all([
      client.acceptSignup(program, { ...signup, email: "SEB@x.com" }, "SEB-ONE"),
      client.acceptSignup(program, { ...signup, email: "seb@x.com" }, "SEB-TWO"),
    ]);

    assert.deepEqual(results.map((result) => result.accepted), [true, false]);
    assert.equal(records.length, 1);
    assert.equal(records[0].email, "seb@x.com");
    assert.equal(records[0].email_normalized, "seb@x.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("regenerates an owned referral code when it already exists in the program", async () => {
  const originalFetch = globalThis.fetch;
  let inserted;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    // No additional_referral_codes column here either: an existing base
    // should keep regenerating owned-code collisions exactly as before.
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "POST") {
      inserted = JSON.parse(options.body);
      return jsonResponse({ ...inserted, Id: 2 });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const where = parsed.searchParams.get("where") || "";
      if (where.includes("email_normalized")) return jsonResponse({ list: [] });
      if (where.includes("owned_referral_code,eq,SEB-AAAAA")) return jsonResponse({ list: [{ Id: 1 }] });
      if (where.includes("owned_referral_code")) return jsonResponse({ list: [] });
      if (where.includes("additional_referral_codes")) throw new Error(`Unexpected additional_referral_codes query: ${url}`);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const result = await client.acceptSignup(
      { public_slug: "bp_program" },
      { firstName: "Sebastian", lastName: "Example", preferredName: "", email: "seb@example.com", referralCodeUsed: "" },
      "SEB-AAAAA",
    );

    assert.equal(result.accepted, true);
    assert.match(result.owned_referral_code, /^SEB-[A-F0-9]{5}$/);
    assert.notEqual(result.owned_referral_code, "SEB-AAAAA");
    assert.equal(inserted.owned_referral_code, result.owned_referral_code);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("counts a referral made with an additional code toward the owning attendee's single total", async () => {
  const originalFetch = globalThis.fetch;
  const attendees = [
    { Id: 1, first_name: "Ali", owned_referral_code: "ALI-ONE", additional_referral_codes: "ALI-EXTRA", referral_code_used: null },
    { Id: 2, first_name: "Bea", owned_referral_code: "BEA-TWO", referral_code_used: "ALI-EXTRA" },
    { Id: 3, first_name: "Cal", owned_referral_code: "CAL-THREE", referral_code_used: "ALI-ONE" },
  ];

  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      return jsonResponse({ list: attendees, pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    assert.deepEqual(await client.getLeaderboard({ public_slug: "bp_program" }), [{ displayName: "Ali", referralCount: 2 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a signup that used someone's additional referral code", async () => {
  const originalFetch = globalThis.fetch;
  let inserted;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }, { title: "additional_referral_codes" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "POST") {
      inserted = JSON.parse(options.body);
      return jsonResponse({ ...inserted, Id: 99 });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const where = parsed.searchParams.get("where") || "";
      if (where.includes("email_normalized")) return jsonResponse({ list: [] });
      if (where.includes("owned_referral_code,eq,ALI-EXTRA")) return jsonResponse({ list: [] });
      // The full-program fetch used to find an additional-code owner (no
      // DB-level filter on additional_referral_codes at all, see below).
      if (where.includes("program_slug,eq,bp_program") && !where.includes("owned_referral_code")) {
        return jsonResponse({ list: [{ Id: 1, additional_referral_codes: "ALI-EXTRA" }], pageInfo: { isLastPage: true } });
      }
      if (where.includes("owned_referral_code")) return jsonResponse({ list: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const result = await client.acceptSignup(
      { public_slug: "bp_program" },
      { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "ali-extra" },
      "BEA-ONE",
    );

    assert.equal(result.accepted, true);
    assert.equal(result.referral_applied, true);
    assert.equal(inserted.referral_code_used, "ALI-EXTRA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matches an additional code case-insensitively no matter how it was typed into NocoDB", async () => {
  const originalFetch = globalThis.fetch;
  let inserted;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }, { title: "additional_referral_codes" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "POST") {
      inserted = JSON.parse(options.body);
      return jsonResponse({ ...inserted, Id: 99 });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const where = parsed.searchParams.get("where") || "";
      if (where.includes("email_normalized")) return jsonResponse({ list: [] });
      if (where.includes("owned_referral_code")) return jsonResponse({ list: [] });
      // additional_referral_codes stored lowercase, exactly as if an
      // organiser typed "skc" directly into NocoDB.
      return jsonResponse({ list: [{ Id: 1, additional_referral_codes: "skc" }], pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    // Fillout normalizes to uppercase before this reaches the client, but the
    // lookup itself must not depend on that - the stored value is lowercase.
    const result = await client.acceptSignup(
      { public_slug: "bp_program" },
      { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "SKC" },
      "BEA-ONE",
    );

    assert.equal(result.referral_applied, true);
    assert.equal(inserted.referral_code_used, "SKC");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matches a hand-edited lowercase owned code too, once the additional-codes column exists", async () => {
  const originalFetch = globalThis.fetch;
  let inserted;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }, { title: "additional_referral_codes" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "POST") {
      inserted = JSON.parse(options.body);
      return jsonResponse({ ...inserted, Id: 99 });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const where = parsed.searchParams.get("where") || "";
      if (where.includes("email_normalized")) return jsonResponse({ list: [] });
      // The `eq` fast path finds nothing because the stored value is
      // lowercase ("abc-ab123") and the query searches for uppercase.
      if (where.includes("owned_referral_code")) return jsonResponse({ list: [] });
      return jsonResponse({ list: [{ Id: 1, owned_referral_code: "abc-ab123" }], pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const result = await client.acceptSignup(
      { public_slug: "bp_program" },
      { firstName: "Bea", lastName: "Example", preferredName: "", email: "bea@example.com", referralCodeUsed: "ABC-AB123" },
      "BEA-ONE",
    );

    assert.equal(result.referral_applied, true);
    assert.equal(inserted.referral_code_used, "ABC-AB123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adds an auto-generated additional referral code to an attendee", async () => {
  const originalFetch = globalThis.fetch;
  let patched;

  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }, { title: "additional_referral_codes" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records" && options.method === "PATCH") {
      patched = JSON.parse(options.body);
      return jsonResponse(patched);
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      return jsonResponse({ list: [], pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const attendee = { Id: 5, program_slug: "bp_program", first_name: "Ali", last_name: "Example", email: "ali@example.com", owned_referral_code: "ALI-ONE", additional_referral_codes: "" };
    const code = await client.addReferralCode(attendee, null);

    assert.match(code, /^ALI-[A-F0-9]{5}$/);
    assert.equal(patched.Id, 5);
    assert.equal(patched.additional_referral_codes, code);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a custom referral code that's already used in the program", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }, { title: "additional_referral_codes" }] });
    }
    if (path === "/api/v2/tables/attendees-id/records") {
      const where = parsed.searchParams.get("where") || "";
      if (where.includes("owned_referral_code,eq,TAKEN")) return jsonResponse({ list: [{ Id: 9 }] });
      return jsonResponse({ list: [], pageInfo: { isLastPage: true } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const attendee = { Id: 5, program_slug: "bp_program", first_name: "Ali", last_name: "Example", email: "ali@example.com", owned_referral_code: "ALI-ONE", additional_referral_codes: "" };
    await assert.rejects(client.addReferralCode(attendee, "TAKEN"), /already used in this program/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin add-code fails clearly when the additional_referral_codes column hasn't been added yet", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "attendees", table_name: "attendees", id: "attendees-id" }] });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: [{ title: "Id" }, { title: "owned_referral_code" }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    const attendee = { Id: 5, program_slug: "bp_program", first_name: "Ali", last_name: "Example", email: "ali@example.com", owned_referral_code: "ALI-ONE" };
    await assert.rejects(client.addReferralCode(attendee, null), /Add the additional_referral_codes column/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("database failures do not expose filter values or upstream response bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [{ title: "programs", table_name: "programs", id: "programs-id" }] });
    }
    return new Response(JSON.stringify({ message: "private@example.com secret upstream detail" }), { status: 500 });
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    await assert.rejects(client.getProgramBySlug("bp_safe"), (error) => {
      assert.equal(error.message, "NocoDB request failed with status 500.");
      assert.doesNotMatch(error.message, /private@example|bp_safe|upstream detail/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("database health verifies both required tables are readable", async () => {
  const originalFetch = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (url) => {
    const path = `${new URL(url).pathname}${new URL(url).search}`;
    if (path === "/api/v2/meta/bases/base-id/tables") {
      return jsonResponse({ list: [
        { title: "programs", table_name: "programs", id: "programs-id" },
        { title: "attendees", table_name: "attendees", id: "attendees-id" },
      ] });
    }
    if (path === "/api/v2/meta/tables/programs-id") {
      return jsonResponse({ columns: ["Id", "name", "public_slug", "webhook_secret_hash", "loops_transactional_id", "active"].map((title) => ({ title })) });
    }
    if (path === "/api/v2/meta/tables/attendees-id") {
      return jsonResponse({ columns: ["Id", "program_slug", "first_name", "last_name", "preferred_name", "email", "email_normalized", "owned_referral_code", "referral_code_used", "additional_referral_codes"].map((title) => ({ title })) });
    }
    reads.push(path);
    return jsonResponse({ list: [], pageInfo: { isLastPage: true } });
  };

  try {
    const client = createNocoDBClient({ url: "https://database.example", apiToken: "server-key", projectId: "base-id" });
    assert.deepEqual(await client.healthCheck(), { ok: true });
    assert.deepEqual(reads.sort(), [
      "/api/v2/tables/attendees-id/records?limit=1",
      "/api/v2/tables/programs-id/records?limit=1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
