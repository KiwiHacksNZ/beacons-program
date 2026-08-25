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
      return jsonResponse({ columns: ["Id", "program_slug", "first_name", "last_name", "preferred_name", "email", "email_normalized", "owned_referral_code", "referral_code_used"].map((title) => ({ title })) });
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
