import { AdminValidationError, formatReferralCodeList, generateRefCode, parseReferralCodeList, toPublicLeaderboard } from "./domain.js";

const REQUIRED_COLUMNS = {
  programs: ["Id", "name", "public_slug", "webhook_secret_hash", "loops_transactional_id", "active"],
  attendees: ["Id", "program_slug", "first_name", "last_name", "preferred_name", "email", "email_normalized", "owned_referral_code", "referral_code_used"],
};
const ADDITIONAL_CODES_COLUMN = "additional_referral_codes";

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
  const programSignupLocks = new Map();

  // Serializes referral-code allocation (new signups and admin-added codes)
  // against every other write for the same program in this process.
  async function withProgramLock(programSlug, fn) {
    const previous = programSignupLocks.get(programSlug) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    programSignupLocks.set(programSlug, current);

    await previous.catch(() => {});

    try {
      return await fn();
    } finally {
      release();
      if (programSignupLocks.get(programSlug) === current) programSignupLocks.delete(programSlug);
    }
  }

  // Multiple/custom referral codes are an optional upgrade: additional_referral_codes
  // is not in REQUIRED_COLUMNS, so a base that hasn't added it yet keeps working
  // exactly as before (one code per attendee). This checks once per process and
  // caches the result, so existing deployments never send a `where` filter for a
  // column NocoDB doesn't know about.
  let additionalCodesColumnPresent = null;
  async function hasAdditionalCodesColumn(attendeesTableId) {
    if (additionalCodesColumnPresent === null) {
      const metadata = await request(`/api/v2/meta/tables/${attendeesTableId}`);
      const columns = new Set();
      for (const column of metadata?.columns || []) {
        if (column.title) columns.add(column.title);
        if (column.column_name) columns.add(column.column_name);
      }
      additionalCodesColumnPresent = columns.has(ADDITIONAL_CODES_COLUMN);
    }
    return additionalCodesColumnPresent;
  }

  // additional_referral_codes is meant to be hand-edited directly in NocoDB
  // (unlike owned_referral_code, which the app always writes in uppercase
  // itself), so a stored code can be in any case. A `where...like` filter
  // would push that case comparison down to the database, and plain SQL
  // LIKE is case-sensitive on most backends NocoDB can run on - so instead
  // this fetches every attendee in the program once and matches case-
  // insensitively in JS via parseReferralCodeList, the same way owned/
  // additional codes are already compared everywhere else.
  async function programAttendees(programSlug) {
    const query = encodeURIComponent(`(program_slug,eq,${programSlug})`);
    return fetchAll("attendees", `?where=${query}`);
  }

  function ownsCode(candidate, code) {
    return String(candidate.owned_referral_code || "").toUpperCase() === code
      || parseReferralCodeList(candidate.additional_referral_codes).includes(code);
  }

  // A code is taken if it is anyone's owned code, or appears in anyone's
  // additional-codes list, within the same program. The initial `eq` query
  // is a fast path for the common case (the app always writes owned codes in
  // uppercase itself); once the additional-codes column exists, the full
  // program fetch below also re-checks owned codes case-insensitively, which
  // costs nothing extra and covers an owned code someone hand-edited in
  // NocoDB to a different case.
  async function isCodeTaken(attendeesTableId, programSlug, code) {
    const ownedQuery = encodeURIComponent(`(owned_referral_code,eq,${code})~and(program_slug,eq,${programSlug})`);
    const ownedRes = await request(`/api/v2/tables/${attendeesTableId}/records?where=${ownedQuery}&limit=1`);
    if (ownedRes.list && ownedRes.list.length > 0) return true;
    if (!(await hasAdditionalCodesColumn(attendeesTableId))) return false;

    const candidates = await programAttendees(programSlug);
    return candidates.some((candidate) => ownsCode(candidate, code));
  }

  // Finds the attendee (if any) who owns a given code, checking both their
  // owned code and their additional codes.
  async function findCodeOwner(attendeesTableId, programSlug, code) {
    const ownedQuery = encodeURIComponent(`(owned_referral_code,eq,${code})~and(program_slug,eq,${programSlug})`);
    const ownedRes = await request(`/api/v2/tables/${attendeesTableId}/records?where=${ownedQuery}&limit=1`);
    if (ownedRes.list && ownedRes.list.length > 0) return ownedRes.list[0];
    if (!(await hasAdditionalCodesColumn(attendeesTableId))) return null;

    const candidates = await programAttendees(programSlug);
    return candidates.find((candidate) => ownsCode(candidate, code)) || null;
  }

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
      // Keep code allocation plus insertion atomic relative to every other
      // signup for this program in the supported single-process deployment.
      return withProgramLock(program.public_slug, () => acceptSignupOnce(program, signup, generatedRefCode, normalizedEmail));
    },

    async getAttendeeById(id) {
      const attendeesTableId = await resolveTableId("attendees");
      const idQuery = encodeURIComponent(`(Id,eq,${id})`);
      const res = await request(`/api/v2/tables/${attendeesTableId}/records?where=${idQuery}&limit=1`);
      if (res.list && res.list.length > 0) return res.list[0];

      const id2Query = encodeURIComponent(`(id,eq,${id})`);
      const res2 = await request(`/api/v2/tables/${attendeesTableId}/records?where=${id2Query}&limit=1`);
      return res2.list && res2.list.length > 0 ? res2.list[0] : null;
    },

    // Adds one more code to an attendee: a validated custom code, or an
    // auto-generated one when customCode is null. Serialized per program
    // alongside signups so allocation never races a new signup's own check.
    async addReferralCode(attendee, customCode) {
      return withProgramLock(attendee.program_slug, () => addReferralCodeOnce(attendee, customCode));
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

      // Every code an attendee owns (their own plus any additional codes)
      // maps back to that attendee, so a referral counts toward one total
      // no matter which of their codes was used. Falls back to the owned
      // code itself when no record id is present.
      const attendeeKey = (attendee) => attendee.Id ?? attendee.id ?? String(attendee.owned_referral_code || "").toUpperCase();
      const codeOwnerIndex = new Map();
      for (const attendee of attendees) {
        const key = attendeeKey(attendee);
        const ownedCode = String(attendee.owned_referral_code || "").toUpperCase();
        if (ownedCode) codeOwnerIndex.set(ownedCode, key);
        for (const code of parseReferralCodeList(attendee.additional_referral_codes)) {
          codeOwnerIndex.set(code, key);
        }
      }

      // Calculate referrals
      const counts = new Map();
      for (const attendee of attendees) {
        if (!attendee.referral_code_used) continue;
        const ownerKey = codeOwnerIndex.get(attendee.referral_code_used.toUpperCase());
        if (ownerKey === undefined) continue;
        counts.set(ownerKey, (counts.get(ownerKey) || 0) + 1);
      }

      const leaderboard = attendees.map(a => {
        return {
          display_name: a.preferred_name || a.first_name,
          referral_count: counts.get(attendeeKey(a)) || 0
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

    // Check if a valid referral code was used (an owner's own code, or one
    // of their additional codes).
    let referrerId = null;
    let validReferralCode = null;
    if (signup.referralCodeUsed) {
      const code = signup.referralCodeUsed.toUpperCase();
      const referrer = await findCodeOwner(attendeesTableId, program.public_slug, code);
      if (referrer) {
        referrerId = referrer.Id || referrer.id;
        validReferralCode = code;
      }
    }

    let ownedReferralCode = generatedRefCode;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await isCodeTaken(attendeesTableId, program.public_slug, ownedReferralCode))) break;
      ownedReferralCode = generateRefCode(signup.firstName, signup.lastName, normalizedEmail);
      if (attempt === 99) throw new Error("Could not allocate a unique referral code.");
    }

    const payload = {
      program_slug: program.public_slug,
      first_name: signup.firstName,
      last_name: signup.lastName,
      preferred_name: signup.preferredName || null,
      email: normalizedEmail,
      email_normalized: normalizedEmail,
      owned_referral_code: ownedReferralCode,
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
      owned_referral_code: ownedReferralCode,
      referral_applied: referrerId !== null,
      loops_transactional_id: program.loops_transactional_id
    };
  }

  async function addReferralCodeOnce(attendee, customCode) {
    const attendeesTableId = await resolveTableId("attendees");
    if (!(await hasAdditionalCodesColumn(attendeesTableId))) {
      throw new AdminValidationError("Add the additional_referral_codes column to the attendees table in NocoDB before assigning extra codes.");
    }
    const programSlug = attendee.program_slug;
    const attendeeId = attendee.Id ?? attendee.id;
    const ownedCode = String(attendee.owned_referral_code || "").toUpperCase();
    const existingAdditional = parseReferralCodeList(attendee.additional_referral_codes);

    let code;
    if (customCode) {
      if (customCode === ownedCode || existingAdditional.includes(customCode)) {
        throw new AdminValidationError("This attendee already has that referral code.");
      }
      if (await isCodeTaken(attendeesTableId, programSlug, customCode)) {
        throw new AdminValidationError("That referral code is already used in this program.");
      }
      code = customCode;
    } else {
      code = generateRefCode(attendee.first_name, attendee.last_name, attendee.email);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await isCodeTaken(attendeesTableId, programSlug, code))) break;
        code = generateRefCode(attendee.first_name, attendee.last_name, attendee.email);
        if (attempt === 99) throw new Error("Could not allocate a unique referral code.");
      }
    }

    const updatedList = [...existingAdditional, code];
    await request(`/api/v2/tables/${attendeesTableId}/records`, {
      method: "PATCH",
      body: JSON.stringify({ Id: attendeeId, additional_referral_codes: formatReferralCodeList(updatedList) }),
    });

    return code;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: "NocoDB returned an unreadable response." };
  }
}
