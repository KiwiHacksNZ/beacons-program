import { AdminValidationError, formatReferralCodeList, generateRefCode, parseReferralCodeList, toPublicLeaderboard } from "./domain.js";

// An in-process stand-in for NocoDB with the same client shape as
// createNocoDBClient (src/nocodb.js), so the server can run with no external
// accounts or API keys. Data lives only in memory and is lost on restart.
// There is no concurrent I/O here, so unlike the NocoDB client this needs no
// locking: nothing else can run between two synchronous statements.
export function createMemoryDbClient() {
  let nextId = 1;
  const programs = [];
  const attendees = [];

  function isCodeTaken(programSlug, code) {
    return attendees.some((attendee) => {
      if (attendee.program_slug !== programSlug) return false;
      if (String(attendee.owned_referral_code || "").toUpperCase() === code) return true;
      return parseReferralCodeList(attendee.additional_referral_codes).includes(code);
    });
  }

  function findCodeOwner(programSlug, code) {
    return attendees.find((attendee) => {
      if (attendee.program_slug !== programSlug) return false;
      if (String(attendee.owned_referral_code || "").toUpperCase() === code) return true;
      return parseReferralCodeList(attendee.additional_referral_codes).includes(code);
    }) || null;
  }

  return {
    async acceptSignup(program, signup, generatedRefCode) {
      const normalizedEmail = String(signup.email || "").trim().toLowerCase();
      const existing = attendees.find((attendee) => attendee.program_slug === program.public_slug && attendee.email_normalized === normalizedEmail);
      if (existing) return { authorized: true, accepted: false, referral_applied: false };

      let referrerId = null;
      let validReferralCode = null;
      if (signup.referralCodeUsed) {
        const code = signup.referralCodeUsed.toUpperCase();
        const referrer = findCodeOwner(program.public_slug, code);
        if (referrer) {
          referrerId = referrer.Id;
          validReferralCode = code;
        }
      }

      let ownedReferralCode = generatedRefCode;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!isCodeTaken(program.public_slug, ownedReferralCode)) break;
        ownedReferralCode = generateRefCode(signup.firstName, signup.lastName, normalizedEmail, signup.preferredName);
        if (attempt === 99) throw new Error("Could not allocate a unique referral code.");
      }

      const record = {
        Id: nextId++,
        program_slug: program.public_slug,
        first_name: signup.firstName,
        last_name: signup.lastName,
        preferred_name: signup.preferredName || null,
        email: normalizedEmail,
        email_normalized: normalizedEmail,
        owned_referral_code: ownedReferralCode,
        referral_code_used: validReferralCode,
        additional_referral_codes: "",
        CreatedAt: new Date().toISOString(),
      };
      attendees.push(record);

      return {
        authorized: true,
        accepted: true,
        attendee_id: record.Id,
        owned_referral_code: ownedReferralCode,
        referral_applied: referrerId !== null,
        loops_transactional_id: program.loops_transactional_id,
      };
    },

    async getAttendeeById(id) {
      return attendees.find((attendee) => String(attendee.Id) === String(id)) || null;
    },

    async addReferralCode(attendee, customCode) {
      const current = attendees.find((candidate) => candidate.Id === attendee.Id);
      if (!current) throw new Error("Attendee not found.");
      const ownedCode = String(current.owned_referral_code || "").toUpperCase();
      const existingAdditional = parseReferralCodeList(current.additional_referral_codes);

      let code;
      if (customCode) {
        if (customCode === ownedCode || existingAdditional.includes(customCode)) {
          throw new AdminValidationError("This attendee already has that referral code.");
        }
        if (isCodeTaken(current.program_slug, customCode)) {
          throw new AdminValidationError("That referral code is already used in this program.");
        }
        code = customCode;
      } else {
        code = generateRefCode(current.first_name, current.last_name, current.email, current.preferred_name);
        for (let attempt = 0; attempt < 100; attempt++) {
          if (!isCodeTaken(current.program_slug, code)) break;
          code = generateRefCode(current.first_name, current.last_name, current.email, current.preferred_name);
          if (attempt === 99) throw new Error("Could not allocate a unique referral code.");
        }
      }

      current.additional_referral_codes = formatReferralCodeList([...existingAdditional, code]);
      return code;
    },

    async removeReferralCode(attendee, code) {
      const current = attendees.find((candidate) => candidate.Id === attendee.Id);
      if (!current) throw new Error("Attendee not found.");
      const normalizedCode = String(code || "").trim().toUpperCase();
      const existing = parseReferralCodeList(current.additional_referral_codes);
      const updatedList = existing.filter((existingCode) => existingCode !== normalizedCode);
      if (updatedList.length === existing.length) {
        throw new AdminValidationError("That code isn't assigned to this attendee.");
      }
      current.additional_referral_codes = formatReferralCodeList(updatedList);
    },

    async getProgramBySlug(programSlug) {
      return programs.find((program) => program.public_slug === programSlug && program.active) || null;
    },

    async getLeaderboard(program) {
      if (!program) return null;
      const programAttendees = attendees.filter((attendee) => attendee.program_slug === program.public_slug);

      const attendeeKey = (attendee) => attendee.Id ?? String(attendee.owned_referral_code || "").toUpperCase();
      const codeOwnerIndex = new Map();
      for (const attendee of programAttendees) {
        const key = attendeeKey(attendee);
        const ownedCode = String(attendee.owned_referral_code || "").toUpperCase();
        if (ownedCode) codeOwnerIndex.set(ownedCode, key);
        for (const code of parseReferralCodeList(attendee.additional_referral_codes)) {
          codeOwnerIndex.set(code, key);
        }
      }

      const counts = new Map();
      for (const attendee of programAttendees) {
        if (!attendee.referral_code_used) continue;
        const ownerKey = codeOwnerIndex.get(attendee.referral_code_used.toUpperCase());
        if (ownerKey === undefined) continue;
        counts.set(ownerKey, (counts.get(ownerKey) || 0) + 1);
      }

      const leaderboard = programAttendees.map((attendee) => ({
        display_name: attendee.preferred_name || attendee.first_name,
        referral_count: counts.get(attendeeKey(attendee)) || 0,
      }));

      return toPublicLeaderboard(leaderboard);
    },

    async getAdminAttendees() {
      return [...attendees].sort((a, b) => b.Id - a.Id);
    },

    async getAdminPrograms() {
      return [...programs].sort((a, b) => b.Id - a.Id);
    },

    async createProgram({ name, publicSlug, webhookSecretHash, loopsTransactionalId }) {
      const record = {
        Id: nextId++,
        name,
        public_slug: publicSlug,
        webhook_secret_hash: webhookSecretHash,
        loops_transactional_id: loopsTransactionalId || null,
        active: true,
        CreatedAt: new Date().toISOString(),
      };
      programs.push(record);
      return record;
    },

    async rotateProgramSecret({ programId, webhookSecretHash }) {
      const program = programs.find((candidate) => String(candidate.Id) === String(programId));
      if (!program) return null;
      program.webhook_secret_hash = webhookSecretHash;
      return program;
    },

    async healthCheck() {
      return { ok: true };
    },
  };
}
