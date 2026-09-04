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

test("renders additional codes and an add-code form scoped to the attendee", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [{ Id: 1, name: "Nova", public_slug: "bp_program", active: true }],
    attendees: [{
      Id: 7,
      program_slug: "bp_program",
      first_name: "Alice",
      last_name: "Example",
      email: "alice@example.com",
      owned_referral_code: "ALIC-ABC123",
      additional_referral_codes: "FRIEND-CODE,<script>",
    }],
    leaderboardsByProgram: new Map([["bp_program", []]]),
  });

  assert.match(html, /<code>FRIEND-CODE<\/code>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /action="\/admin\/attendees\/7\/referral-codes"/);
  assert.match(html, /action="\/admin\/attendees\/7\/referral-codes\/remove"/);
  assert.match(html, /<input type="hidden" name="code" value="FRIEND-CODE">/);
});

test("searches attendees by name or email across programs", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [{ Id: 1, name: "Nova", public_slug: "bp_nova", active: true }],
    attendees: [
      { Id: 1, program_slug: "bp_nova", first_name: "Zed", last_name: "Example", preferred_name: "", email: "zed@example.com" },
      { Id: 2, program_slug: "bp_nova", first_name: "Amy", last_name: "Example", preferred_name: "Bash", email: "amy@example.com" },
      { Id: 3, program_slug: "bp_nova", first_name: "Ana", last_name: "Example", preferred_name: "", email: "ana@somewhereelse.com" },
    ],
    leaderboardsByProgram: new Map([["bp_nova", []]]),
    search: "bash",
  });

  assert.match(html, />Amy</);
  assert.doesNotMatch(html, />Zed</);
  assert.doesNotMatch(html, />Ana</);
  assert.match(html, /value="bash"/);
});

test("filters and sorts attendees by the requested program and field", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [
      { Id: 1, name: "Nova", public_slug: "bp_nova", active: true },
      { Id: 2, name: "Kiwi", public_slug: "bp_kiwi", active: true },
    ],
    attendees: [
      { Id: 1, program_slug: "bp_nova", first_name: "Zed", last_name: "Example", email: "zed@example.com" },
      { Id: 2, program_slug: "bp_kiwi", first_name: "Amy", last_name: "Example", email: "amy@example.com" },
      { Id: 3, program_slug: "bp_nova", first_name: "Ana", last_name: "Example", email: "ana@example.com" },
    ],
    leaderboardsByProgram: new Map([["bp_nova", []], ["bp_kiwi", []]]),
    sort: "first_name",
    dir: "asc",
    programFilter: "bp_nova",
  });

  const zedIndex = html.indexOf(">Zed<");
  const anaIndex = html.indexOf(">Ana<");
  assert.doesNotMatch(html, />Amy</);
  assert.ok(anaIndex > 0 && zedIndex > anaIndex, "Ana should sort before Zed");
  assert.match(html, /<option value="bp_nova" selected>/);
});

test("rotation forms use NocoDB's uppercase Id field", () => {
  const html = renderAdmin({
    title: "Beacons",
    backendUrl: "https://beacons.example.com",
    programs: [{ Id: 42, name: "Nova", public_slug: "bp_program", active: true }],
    attendees: [],
    leaderboardsByProgram: new Map([["bp_program", []]]),
  });

  assert.match(html, /action="\/admin\/programs\/42\/rotate-key"/);
  assert.doesNotMatch(html, /programs\/undefined/);
});
