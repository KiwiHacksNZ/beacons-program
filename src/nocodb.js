import { toPublicLeaderboard } from "./domain.js";

export function createNocoDBClient({ url, apiToken, projectId }) {
  const baseUrl = String(url || "").replace(/\/$/, "");

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "xc-token": apiToken,
        "content-type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      if (!body || body.message === "NocoDB returned an unreadable response.") {
        console.error(`NocoDB Error Text for ${path}:`, text);
      }
      const detail = body?.message || body?.msg || body?.error || `NocoDB returned ${response.status}`;
      throw new Error(detail);
    }
    return body;
  }

  let tableIdMap = null;

  async function resolveTableId(tableName) {
    if (!projectId) throw new Error("NOCODB_PROJECT_ID is required to resolve tables");
    if (!tableIdMap) {
      const res = await request(`/api/v2/meta/bases/${projectId}/tables`);
      tableIdMap = {};
      for (const table of (res.list || [])) {
        tableIdMap[table.title] = table.id;
        tableIdMap[table.table_name] = table.id;
      }
    }
    const id = tableIdMap[tableName];
    if (!id) throw new Error(`Table ${tableName} not found in NocoDB project ${projectId}`);
    return id;
  }

  // Helper to fetch all records handling pagination
  async function fetchAll(table, queryParams = "") {
    let offset = 0;
    const limit = 1000;
    const records = [];
    const tableId = await resolveTableId(table);
    while (true) {
      const qs = queryParams ? `${queryParams}&limit=${limit}&offset=${offset}` : `?limit=${limit}&offset=${offset}`;
      const res = await request(`/api/v2/tables/${tableId}/records${qs}`);
      const list = res.list || [];
      records.push(...list);
      if (res.pageInfo.isLastPage || list.length < limit) break;
      offset += limit;
    }
    return records;
  }

  return {
    async acceptSignup(program, signup, generatedRefCode) {
      const attendeesTableId = await resolveTableId("attendees");
      // 1. Check if email already exists in this program
      const emailQuery = encodeURIComponent(`(email_normalized,eq,${signup.email.toLowerCase()})~and(program_id,eq,${program.Id || program.id})`);
      const existing = await request(`/api/v2/tables/${attendeesTableId}/records?where=${emailQuery}&limit=1`);
      
      if (existing.list && existing.list.length > 0) {
        return { authorized: true, accepted: false, referral_applied: false };
      }

      // 2. Check if a valid referral code was used
      let referrerId = null;
      if (signup.referralCodeUsed) {
        const codeQuery = encodeURIComponent(`(owned_referral_code,eq,${signup.referralCodeUsed.toUpperCase()})~and(program_id,eq,${program.Id || program.id})`);
        const referrerRes = await request(`/api/v2/tables/${attendeesTableId}/records?where=${codeQuery}&limit=1`);
        if (referrerRes.list && referrerRes.list.length > 0) {
          referrerId = referrerRes.list[0].Id || referrerRes.list[0].id;
        }
      }

      // 3. Insert the new attendee
      const payload = {
        program_id: program.Id || program.id,
        first_name: signup.firstName,
        last_name: signup.lastName,
        preferred_name: signup.preferredName || null,
        email: signup.email,
        email_normalized: signup.email.toLowerCase(),
        owned_referral_code: generatedRefCode,
        referral_code_used: signup.referralCodeUsed || null
      };

      const res = await request(`/api/v2/tables/${attendeesTableId}/records`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return {
        authorized: true,
        accepted: true,
        attendee_id: res.Id || res.id,
        owned_referral_code: generatedRefCode,
        referral_applied: referrerId !== null,
        loops_transactional_id: program.loops_transactional_id
      };
    },

    async getProgramBySlug(programSlug) {
      const programsTableId = await resolveTableId("programs");
      const slugQuery = encodeURIComponent(`(public_slug,eq,${programSlug})~and(active,eq,true)`);
      const res = await request(`/api/v2/tables/${programsTableId}/records?where=${slugQuery}&limit=1`);
      return res.list && res.list.length > 0 ? res.list[0] : null;
    },

    async getLeaderboard(program) {
      if (!program) return null;
      const programId = program.Id || program.id;
      // Fetch all attendees for this program
      const query = encodeURIComponent(`(program_id,eq,${programId})`);
      const attendees = await fetchAll("attendees", `?where=${query}`);
      
      // Calculate referrals
      const counts = {};
      for (const attendee of attendees) {
        if (attendee.referral_code_used) {
          const usedCode = attendee.referral_code_used.toUpperCase();
          counts[usedCode] = (counts[usedCode] || 0) + 1;
        }
      }

      const leaderboard = attendees.map(a => {
        const count = counts[a.owned_referral_code] || 0;
        return {
          display_name: a.preferred_name || a.first_name,
          referral_count: count
        };
      });

      return toPublicLeaderboard(leaderboard);
    },

    async getAdminAttendees() {
      return fetchAll("attendees", "?sort=-CreatedAt");
    },

    async getAdminPrograms() {
      return fetchAll("programs", "?sort=-CreatedAt");
    },

    async createProgram({ name, publicSlug, webhookSecretHash, loopsTransactionalId }) {
      const payload = {
        name,
        public_slug: publicSlug,
        webhook_secret_hash: webhookSecretHash,
        loops_transactional_id: loopsTransactionalId || null,
        active: true
      };
      
      const programsTableId = await resolveTableId("programs");
      const res = await request(`/api/v2/tables/${programsTableId}/records`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return res;
    },

    async rotateProgramSecret({ programId, webhookSecretHash }) {
      const payload = {
        Id: programId,
        webhook_secret_hash: webhookSecretHash
      };
      const programsTableId = await resolveTableId("programs");
      const res = await request(`/api/v2/tables/${programsTableId}/records`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      return res;
    },

    async healthCheck() {
      try {
        const res = await request(`/api/v2/meta/bases`);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: "NocoDB returned an unreadable response." };
  }
}
