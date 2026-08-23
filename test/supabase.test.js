import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseClient } from "../src/supabase.js";

test("scopes signup RPC to a program and sends only the secret hash", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify([{ authorized: true, accepted: true, referral_applied: false }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = createSupabaseClient({ url: "https://database.example", serviceRoleKey: "server-key" });
    await client.acceptSignup("bp_program", "abc123hash", {
      firstName: "Ali",
      lastName: "Example",
      preferredName: "",
      email: "ali@example.com",
      referralCodeUsed: "",
    });
    const body = JSON.parse(captured.options.body);
    assert.equal(captured.url, "https://database.example/rest/v1/rpc/beacons_accept_signup");
    assert.equal(body.p_program_public_slug, "bp_program");
    assert.equal(body.p_webhook_secret_hash, "abc123hash");
    assert.equal(JSON.stringify(body).includes("bk_"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads a program snapshot and strips any unexpected private fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    response_json: [{ displayName: "Ali", referralCount: 2, email: "private@example.com" }],
  }]), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const client = createSupabaseClient({ url: "https://database.example", serviceRoleKey: "server-key" });
    assert.deepEqual(await client.getLeaderboard("bp_program"), [{ displayName: "Ali", referralCount: 2 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
