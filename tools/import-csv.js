import { readFile, stat } from "node:fs/promises";
import { env } from "node:process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { createNocoDBClient } from "../src/nocodb.js";
import { generateRefCode, isValidReferralCode, validateSignup } from "../src/domain.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 25_000;
const NULL_MARKERS = new Set(["null", "undefined", "none", "n/a", "na", "-"]);
const REQUIRED_HEADERS = ["First Name (legal)", "Last Name (legal)", "Email Address"];

export function parseCsv(text) {
  if (typeof text !== "string" || !text.length) throw new Error("The CSV file is empty.");

  const records = [];
  let fields = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;

  function finishField() {
    fields.push(normalizeCell(field));
    field = "";
    afterQuote = false;
  }

  function finishRecord() {
    finishField();
    if (fields.some((value) => value !== "")) records.push({ line: recordLine, fields });
    fields = [];
    recordLine = line + 1;
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += char;
        if (char === "\n") line++;
      }
      continue;
    }

    if (afterQuote && char !== "," && char !== "\n" && char !== "\r" && char !== " " && char !== "\t") {
      throw new Error(`CSV line ${line} has text after a closing quote.`);
    }
    if (afterQuote && (char === " " || char === "\t")) continue;

    if (char === '"') {
      if (field !== "") throw new Error(`CSV line ${line} has an unexpected quote.`);
      inQuotes = true;
    } else if (char === ",") {
      finishField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      finishRecord();
      line++;
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error(`CSV line ${recordLine} has an unterminated quoted value.`);
  if (field !== "" || fields.length) finishRecord();
  if (!records.length) throw new Error("The CSV file contains no header row.");

  const headers = records[0].fields.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim());
  if (headers.some((header) => !header)) throw new Error("The CSV contains an empty header.");
  if (new Set(headers).size !== headers.length) throw new Error("The CSV contains duplicate headers.");

  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`The CSV is missing required headers: ${missing.join(", ")}.`);

  const rows = records.slice(1).map((record) => {
    if (record.fields.length > headers.length) throw new Error(`CSV line ${record.line} has more fields than the header row.`);
    const values = Object.fromEntries(headers.map((header, index) => [header, record.fields[index] || ""]));
    return { line: record.line, values };
  });

  if (!rows.length) throw new Error("The CSV contains no data rows.");
  if (rows.length > MAX_ROWS) throw new Error(`The CSV exceeds the ${MAX_ROWS.toLocaleString()} row safety limit.`);
  return rows;
}

export function prepareImport(rows, existingAttendees, programSlug) {
  const errors = [];
  const candidates = [];
  const existingEmails = new Set();
  const reservedCodes = new Set();
  const inputEmails = new Set();
  let skippedExisting = 0;
  let ignoredReferralCodes = 0;
  let regeneratedOwnedCodes = 0;

  for (const attendee of existingAttendees) {
    if (attendee.program_slug !== programSlug) continue;
    const email = String(attendee.email_normalized || attendee.email || "").trim().toLowerCase();
    const code = String(attendee.owned_referral_code || "").trim().toUpperCase();
    if (email) existingEmails.add(email);
    if (code) reservedCodes.add(code);
  }

  for (const row of rows) {
    const suppliedReferralCode = normalizeOptionalCell(row.values["Referral Code"]);
    const referralCodeUsed = suppliedReferralCode && isValidReferralCode(suppliedReferralCode)
      ? suppliedReferralCode
      : "";
    if (suppliedReferralCode && !referralCodeUsed) ignoredReferralCodes++;

    const rawSignup = {
      firstName: row.values["First Name (legal)"],
      lastName: row.values["Last Name (legal)"],
      preferredName: normalizeOptionalCell(row.values["Preferred Name"]),
      email: row.values["Email Address"],
      referralCodeUsed,
    };
    const validated = validateSignup(rawSignup);
    if (!validated.ok) {
      errors.push({ line: row.line, message: validated.errors.join(" ") });
      continue;
    }

    const signup = validated.value;
    if (inputEmails.has(signup.email)) {
      errors.push({ line: row.line, message: "Duplicate normalized email within the CSV." });
      continue;
    }
    inputEmails.add(signup.email);

    if (existingEmails.has(signup.email)) {
      skippedExisting++;
      continue;
    }

    let suppliedCode = normalizeOptionalCell(row.values["Owned Referral Code"]).toUpperCase();
    if (suppliedCode && !isValidReferralCode(suppliedCode)) {
      suppliedCode = "";
      regeneratedOwnedCodes++;
    }
    if (suppliedCode && reservedCodes.has(suppliedCode)) {
      errors.push({ line: row.line, message: "Owned referral code is already in use." });
      continue;
    }

    let ownedReferralCode = suppliedCode;
    for (let attempt = 0; !ownedReferralCode && attempt < 100; attempt++) {
      const candidate = generateRefCode(signup.firstName, signup.lastName, signup.email, signup.preferredName);
      if (!reservedCodes.has(candidate)) ownedReferralCode = candidate;
    }
    if (!ownedReferralCode) {
      errors.push({ line: row.line, message: "Could not allocate a unique referral code." });
      continue;
    }

    reservedCodes.add(ownedReferralCode);
    candidates.push({ line: row.line, signup, ownedReferralCode });
  }

  for (const candidate of candidates) {
    if (candidate.signup.referralCodeUsed && !reservedCodes.has(candidate.signup.referralCodeUsed)) {
      candidate.signup.referralCodeUsed = "";
      ignoredReferralCodes++;
    }
  }

  const summary = { skippedExisting, ignoredReferralCodes, regeneratedOwnedCodes };
  if (errors.length) return { errors, ready: [], ...summary };
  return { errors: [], ready: orderByReferralDependency(candidates), ...summary };
}

function orderByReferralDependency(candidates) {
  const byCode = new Map(candidates.map((candidate) => [candidate.ownedReferralCode, candidate]));
  const indegree = new Map(candidates.map((candidate) => [candidate, 0]));
  const dependents = new Map(candidates.map((candidate) => [candidate, []]));

  for (const candidate of candidates) {
    const referrer = byCode.get(candidate.signup.referralCodeUsed);
    if (!referrer) continue;
    indegree.set(candidate, indegree.get(candidate) + 1);
    dependents.get(referrer).push(candidate);
  }

  const queue = candidates.filter((candidate) => indegree.get(candidate) === 0);
  const ordered = [];
  for (let index = 0; index < queue.length; index++) {
    const candidate = queue[index];
    ordered.push(candidate);
    for (const dependent of dependents.get(candidate)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== candidates.length) {
    const cycle = candidates.find((candidate) => indegree.get(candidate) > 0);
    throw new Error(`CSV line ${cycle.line} is part of a circular referral chain.`);
  }
  return ordered;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const commit = args.includes("--commit");
  const fileArgs = args.filter((argument) => argument !== "--commit");
  if (fileArgs.length !== 1 || fileArgs[0].startsWith("-")) {
    printUsage();
    throw new Error("Provide exactly one CSV file path.");
  }
  if (commit && (!input.isTTY || !output.isTTY)) throw new Error("--commit requires an interactive terminal.");

  for (const name of ["NOCODB_URL", "NOCODB_API_TOKEN", "NOCODB_PROJECT_ID"]) {
    if (!String(env[name] || "").trim()) throw new Error(`${name} is required.`);
  }

  let fileInfo;
  let csvText;
  try {
    fileInfo = await stat(fileArgs[0]);
    if (fileInfo.isFile() && fileInfo.size <= MAX_FILE_BYTES) csvText = await readFile(fileArgs[0], "utf8");
  } catch {
    throw new Error("The CSV file could not be read.");
  }
  if (!fileInfo.isFile()) throw new Error("The supplied CSV path is not a regular file.");
  if (fileInfo.size > MAX_FILE_BYTES) throw new Error("The CSV exceeds the 10 MiB safety limit.");
  if (Buffer.byteLength(csvText, "utf8") > MAX_FILE_BYTES) throw new Error("The CSV exceeds the 10 MiB safety limit.");
  const rows = parseCsv(csvText);

  const db = createNocoDBClient({
    url: env.NOCODB_URL,
    apiToken: env.NOCODB_API_TOKEN,
    projectId: env.NOCODB_PROJECT_ID,
  });
  const programs = (await db.getAdminPrograms()).filter((program) => program.active === true);
  if (!programs.length) throw new Error("No active programs were found.");

  const terminal = readline.createInterface({ input, output });
  try {
    console.log("\nActive programs:");
    programs.forEach((program, index) => console.log(`[${index + 1}] ${safeLabel(program.name)}`));
    const answer = await terminal.question("\nSelect the destination program number: ");
    const choice = Number(answer);
    if (!Number.isInteger(choice) || choice < 1 || choice > programs.length) throw new Error("Invalid program selection.");
    const program = programs[choice - 1];

    const attendees = await db.getAdminAttendees();
    const prepared = prepareImport(rows, attendees, program.public_slug);
    if (prepared.errors.length) {
      console.error(`\nPreflight failed with ${prepared.errors.length} invalid row(s). No records were written.`);
      for (const error of prepared.errors.slice(0, 20)) console.error(`- CSV line ${error.line}: ${error.message}`);
      if (prepared.errors.length > 20) console.error(`- ${prepared.errors.length - 20} additional error(s) omitted.`);
      console.error(`Referral codes that would be ignored: ${prepared.ignoredReferralCodes}`);
      console.error(`Owned referral codes that would be regenerated: ${prepared.regeneratedOwnedCodes}`);
      process.exitCode = 1;
      return;
    }

    console.log("\nPreflight passed.");
    console.log(`CSV data rows: ${rows.length}`);
    console.log(`Already present: ${prepared.skippedExisting}`);
    console.log(`Ready to import: ${prepared.ready.length}`);
    console.log(`Ignored referral codes: ${prepared.ignoredReferralCodes}`);
    console.log(`Regenerated owned referral codes: ${prepared.regeneratedOwnedCodes}`);

    if (!commit) {
      console.log("\nDry run only; no records were written. Re-run with --commit to enable writes.");
      return;
    }
    if (!prepared.ready.length) {
      console.log("\nNothing needs to be imported.");
      return;
    }

    console.log("\nStop the Beacons service before continuing so this importer is the only database writer.");
    console.log("The import writes attendees directly and does not send Loops emails.");
    const confirmation = await terminal.question(`Type IMPORT ${prepared.ready.length} to continue: `);
    if (confirmation !== `IMPORT ${prepared.ready.length}`) throw new Error("Import cancelled; confirmation did not match.");

    let imported = 0;
    let skippedDuringWrite = 0;
    for (const candidate of prepared.ready) {
      try {
        const result = await db.acceptSignup(program, candidate.signup, candidate.ownedReferralCode);
        if (result.accepted) imported++;
        else skippedDuringWrite++;
      } catch {
        throw new Error(`Import stopped at CSV line ${candidate.line}. Re-run safely after resolving the database problem; completed emails will be skipped.`);
      }
      if ((imported + skippedDuringWrite) % 100 === 0) console.log(`Processed ${imported + skippedDuringWrite} rows...`);
    }

    console.log("\nImport complete.");
    console.log(`Imported: ${imported}`);
    console.log(`Skipped during write: ${skippedDuringWrite}`);
  } finally {
    terminal.close();
  }
}

function normalizeCell(value) {
  return String(value).trim();
}

function normalizeOptionalCell(value) {
  const trimmed = normalizeCell(value || "");
  return NULL_MARKERS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

function safeLabel(value) {
  return String(value || "Unnamed program").replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 120);
}

function printUsage() {
  console.log("Usage: npm run import:csv -- path/to/attendees.csv [--commit]");
  console.log("Without --commit, the command performs a read-only preflight.");
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  });
}
