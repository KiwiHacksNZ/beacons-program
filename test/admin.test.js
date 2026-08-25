import test from "node:test";
import assert from "node:assert/strict";
import { renderAdmin } from "../src/admin.js";

test("admin dashboard escapes private database values", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Nova <2027>", public_slug: "bp_safe_slug_123456789012", active: true }],
    attendees: [
      {
        program_id: "11111111-1111-4111-8111-111111111111",
        first_name: "<Alice>",
        last_name: "Example",
        email: 'alice@example.com\" onmouseover=\"alert(1)',
        preferred_name: "Ali",
        owned_referral_code: "ALIC-ABC123",
        referral_code_used: null,
        created_at: "2026-08-23T00:00:00Z",
      },
    ],
    leaderboardsByProgram: new Map([["bp_safe_slug_123456789012", [{ displayName: "<Ali>", referralCount: 1 }]]]),
  });

  assert.match(html, /&lt;Alice&gt;/);
  assert.match(html, /&lt;Ali&gt;/);
  assert.match(html, /Nova &lt;2027&gt;/);
  assert.match(html, /<!--email_off--><a href="mailto:alice@example\.com&quot; onmouseover=&quot;alert\(1\)">/);
  assert.doesNotMatch(html, /<Alice>|<Ali>|onmouseover="alert/);
});

test("Joined displays NocoDB's automatic CreatedAt timestamp", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [{ id: 1, name: "Nova", public_slug: "bp_program", active: true }],
    attendees: [{
      program_slug: "bp_program",
      first_name: "Alice",
      last_name: "Example",
      email: "alice@example.com",
      CreatedAt: "2026-08-25T01:30:00.000Z",
    }],
    leaderboardsByProgram: new Map([["bp_program", []]]),
  });

  assert.match(html, /datetime="2026-08-25T01:30:00\.000Z"/);
  assert.doesNotMatch(html, />Unknown</);
});
