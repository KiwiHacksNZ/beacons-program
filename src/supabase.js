import { toPublicLeaderboard } from "./domain.js";

export function createSupabaseClient({ url, serviceRoleKey }) {
  const baseUrl = String(url || "").replace(/\/$/, "");

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      const detail = body?.message || body?.error || `Supabase returned ${response.status}`;
      throw new Error(detail);
    }
    return body;
  }

  return {
    async acceptSignup(programSlug, webhookSecretHash, signup) {
      const rows = await request("/rest/v1/rpc/beacons_accept_signup", {
        method: "POST",
        body: JSON.stringify({
          p_program_public_slug: programSlug,
          p_webhook_secret_hash: webhookSecretHash,
          p_first_name: signup.firstName,
          p_last_name: signup.lastName,
          p_preferred_name: signup.preferredName || null,
          p_email: signup.email,
          p_referral_code_used: signup.referralCodeUsed || null,
        }),
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async getLeaderboard(programSlug) {
      const rows = await request("/rest/v1/rpc/beacons_get_leaderboard_snapshot", {
        method: "POST",
        body: JSON.stringify({ p_program_public_slug: programSlug }),
      });
      if (!rows?.[0]) return null;
      const snapshot = Array.isArray(rows[0].response_json) ? rows[0].response_json : [];
      return toPublicLeaderboard(snapshot.map((row) => ({
        display_name: row.displayName,
        referral_count: row.referralCount,
      })));
    },

    async getAdminAttendees() {
      return request(
        "/rest/v1/beacons_attendees?select=program_id,first_name,last_name,email,preferred_name,owned_referral_code,referral_code_used,created_at&order=created_at.desc",
      );
    },

    async getAdminPrograms() {
      return request("/rest/v1/beacons_programs?select=id,name,public_slug,active,created_at&order=created_at.desc");
    },

    async createProgram({ name, publicSlug, webhookSecretHash }) {
      const rows = await request("/rest/v1/rpc/beacons_create_program", {
        method: "POST",
        body: JSON.stringify({ p_name: name, p_public_slug: publicSlug, p_webhook_secret_hash: webhookSecretHash }),
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async rotateProgramSecret({ programId, webhookSecretHash }) {
      const rows = await request("/rest/v1/rpc/beacons_rotate_program_secret", {
        method: "POST",
        body: JSON.stringify({ p_program_id: programId, p_webhook_secret_hash: webhookSecretHash }),
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async healthCheck() {
      const rows = await request("/rest/v1/rpc/beacons_health_check", {
        method: "POST",
        body: "{}",
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: "Supabase returned an unreadable response." };
  }
}
