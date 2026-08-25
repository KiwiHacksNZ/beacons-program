import { toPublicLeaderboard } from "./domain.js";

const REQUIRED_COLUMNS = {
  programs: ["Id", "name", "public_slug", "webhook_secret_hash", "loops_transactional_id", "active"],
  attendees: ["Id", "program_slug", "first_name", "last_name", "preferred_name", "email", "email_normalized", "owned_referral_code", "referral_code_used"],
};

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
      // Do not log the path or upstream body here: filter paths can contain
      // attendee email addresses and NocoDB errors may echo private fields.
      throw new Error(`NocoDB request failed with status ${response.status}.`);
    }
    return body;
  }

  let tableIdMap = null;
  const signupLocks = new Map();

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

  async function verifyTableSchema(tableName, tableId) {
    const metadata = await request(`/api/v2/meta/tables/${tableId}`);
    const columns = new Set();
    for (const column of metadata?.columns || []) {
      if (column.title) columns.add(column.title);
      if (column.column_name) columns.add(column.column_name);
    }
    if (!REQUIRED_COLUMNS[tableName].every((column) => columns.has(column))) {
      throw new Error(`NocoDB table ${tableName} does not match the required schema.`);
    }
  }

  return {
    async acceptSignup(program, signup, generatedRefCode) {
      const normalizedEmail = String(signup.email || "").trim().toLowerCase();
      const lockKey = `${program.public_slug}\n${normalizedEmail}`;
      const previous = signupLocks.get(lockKey) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      signupLocks.set(lockKey, current);

      await previous.catch(() => {});

      try {
        return await acceptSignupOnce(program, signup, generatedRefCode, normalizedEmail);
      } finally {
        release();
        if (signupLocks.get(lockKey) === current) signupLocks.delete(lockKey);
      }
    },

    async getProgramBySlug(programSlug) {
      const programsTableId = await resolveTableId("programs");
      const slugQuery = encodeURIComponent(`(public_slug,eq,${programSlug})~and(active,eq,true)`);
      const res = await request(`/api/v2/tables/${programsTableId}/records?where=${slugQuery}&limit=1`);
      return res.list && res.list.length > 0 ? res.list[0] : null;
    },

    async getLeaderboard(program) {
      if (!program) return null;
      const programSlug = program.public_slug;
      // Fetch all attendees for this program
      const query = encodeURIComponent(`(program_slug,eq,${programSlug})`);
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
        const ownedCode = String(a.owned_referral_code || "").toUpperCase();
        const count = counts[ownedCode] || 0;
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
      return { ...payload, Id: res.Id || res.id };
    },

    async rotateProgramSecret({ programId, webhookSecretHash }) {
      const payload = {
        Id: programId,
        webhook_secret_hash: webhookSecretHash
      };
      const programsTableId = await resolveTableId("programs");
      
      // Update the record
      await request(`/api/v2/tables/${programsTableId}/records`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });

      // Fetch and return the updated record so we have its name and slug
      const idQuery = encodeURIComponent(`(Id,eq,${programId})`);
      const getRes = await request(`/api/v2/tables/${programsTableId}/records?where=${idQuery}&limit=1`);
      if (getRes.list && getRes.list.length > 0) {
        return getRes.list[0];
      }
      
      // Fallback if Id doesn't match, try lowercase id
      const id2Query = encodeURIComponent(`(id,eq,${programId})`);
      const getRes2 = await request(`/api/v2/tables/${programsTableId}/records?where=${id2Query}&limit=1`);
      return getRes2.list && getRes2.list.length > 0 ? getRes2.list[0] : null;
    },

    async healthCheck() {
      try {
        const programsTableId = await resolveTableId("programs");
        const attendeesTableId = await resolveTableId("attendees");
        await Promise.all([
          verifyTableSchema("programs", programsTableId),
          verifyTableSchema("attendees", attendeesTableId),
          request(`/api/v2/tables/${programsTableId}/records?limit=1`),
          request(`/api/v2/tables/${attendeesTableId}/records?limit=1`),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };

  async function acceptSignupOnce(program, signup, generatedRefCode, normalizedEmail) {
    const attendeesTableId = await resolveTableId("attendees");
    // Email identity is case-insensitive and scoped to one program.
    const emailQuery = encodeURIComponent(`(email_normalized,eq,${normalizedEmail})~and(program_slug,eq,${program.public_slug})`);
    const existing = await request(`/api/v2/tables/${attendeesTableId}/records?where=${emailQuery}&limit=1`);

    if (existing.list && existing.list.length > 0) {
      return { authorized: true, accepted: false, referral_applied: false };
    }

    // Check if a valid referral code was used.
    let referrerId = null;
    let validReferralCode = null;
    if (signup.referralCodeUsed) {
      const codeQuery = encodeURIComponent(`(owned_referral_code,eq,${signup.referralCodeUsed.toUpperCase()})~and(program_slug,eq,${program.public_slug})`);
      const referrerRes = await request(`/api/v2/tables/${attendeesTableId}/records?where=${codeQuery}&limit=1`);
      if (referrerRes.list && referrerRes.list.length > 0) {
        referrerId = referrerRes.list[0].Id || referrerRes.list[0].id;
        validReferralCode = signup.referralCodeUsed.toUpperCase();
      }
    }

    const payload = {
      program_slug: program.public_slug,
      first_name: signup.firstName,
      last_name: signup.lastName,
      preferred_name: signup.preferredName || null,
      email: normalizedEmail,
      email_normalized: normalizedEmail,
      owned_referral_code: generatedRefCode,
      referral_code_used: validReferralCode
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
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: "NocoDB returned an unreadable response." };
  }
}
