import { readFileSync } from "node:fs";
import { env } from "node:process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createNocoDBClient } from "../src/nocodb.js";
import { generateRefCode, isValidReferralCode, validateSignup } from "../src/domain.js";

function parseCSV(text) {
  const result = [];
  let row = [];
  let inQuotes = false;
  let currentVal = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentVal += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(currentVal);
        currentVal = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i++;
        }
        row.push(currentVal);
        // Only push non-empty rows
        if (row.length > 1 || row[0] !== '') {
            result.push(row);
        }
        row = [];
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
  }
  if (row.length > 0 || currentVal !== '') {
    row.push(currentVal);
    if (row.length > 1 || row[0] !== '') {
      result.push(row);
    }
  }
  
  if (result.length === 0) return [];
  
  const headers = result[0];
  const objects = [];
  for (let i = 1; i < result.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let val = result[i][j] || '';
      const lower = val.trim().toLowerCase();
      if (lower === 'null' || lower === 'undefined' || lower === 'none' || lower === 'n/a' || lower === 'na' || lower === '-') {
        val = '';
      }
      obj[headers[j]] = val;
    }
    objects.push(obj);
  }
  return objects;
}

async function main() {
  const db = createNocoDBClient({
    url: env.NOCODB_URL,
    apiToken: env.NOCODB_API_TOKEN,
    projectId: env.NOCODB_PROJECT_ID
  });

  const programs = await db.getAdminPrograms();
  
  if (!programs || programs.length === 0) {
    console.error("No programs found in NocoDB.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });

  console.log("\nAvailable programs:");
  programs.forEach((prog, index) => {
    console.log(`[${index + 1}] ${prog.name} (Slug: ${prog.public_slug})`);
  });

  let program = null;
  while (!program) {
    const answer = await rl.question("\nEnter the number of the program you want to import to: ");
    const choice = parseInt(answer, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= programs.length) {
      program = programs[choice - 1];
    } else {
      console.log(`Please enter a valid number between 1 and ${programs.length}.`);
    }
  }
  rl.close();
  
  console.log(`\nSelected program: ${program.name} (${program.public_slug})\n`);

  const fileArgs = process.argv.slice(2);
  const filePath = fileArgs[0] || 'scratch/sample.csv';
  
  const csvText = readFileSync(filePath, "utf-8");
  const records = parseCSV(csvText);
  
  console.log(`Found ${records.length} records to import.`);
  
  let successCount = 0;
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (record) => {
      const rawSignup = {
        firstName: record["First Name (legal)"],
        lastName: record["Last Name (legal)"],
        preferredName: record["Preferred Name"],
        email: record["Email Address"],
        referralCodeUsed: record["Referral Code"]
      };
      
      // We only import if they have an email address
      if (!rawSignup.email) {
         console.log(`Skipping record with no email`);
         return;
      }

      const validated = validateSignup(rawSignup);
      if (!validated.ok) {
        console.log(`Skipping invalid record: ${validated.errors.join(" ")}`);
        return;
      }
      const signup = validated.value;
      
      const existingOwnCode = String(record["Owned Referral Code"] || "").trim().toUpperCase();
      if (existingOwnCode && !isValidReferralCode(existingOwnCode)) {
        console.log("Skipping record with an invalid owned referral code");
        return;
      }
      const generatedRefCode = existingOwnCode ? existingOwnCode : generateRefCode(signup.firstName, signup.lastName, signup.email);
      
      try {
        const result = await db.acceptSignup(program, signup, generatedRefCode);
        if (result.accepted) {
          console.log(`Imported ${signup.email} with referral code ${generatedRefCode}`);
          successCount++;
        } else {
          console.log(`Skipped ${signup.email} (already exists)`);
        }
      } catch (err) {
        console.error(`Failed to import ${signup.email}:`, err.message);
      }
    }));
  }
  
  console.log(`Import complete. Successfully imported ${successCount} records.`);
}

main().catch(console.error);
