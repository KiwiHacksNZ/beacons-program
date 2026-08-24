import { env } from "node:process";
import { createNocoDBClient } from "../src/nocodb.js";

// A quick script to check what programs exist

async function main() {
  const db = createNocoDBClient({
    url: env.NOCODB_URL,
    apiToken: env.NOCODB_API_TOKEN,
    projectId: env.NOCODB_PROJECT_ID
  });

  const programs = await db.getAdminPrograms();
  console.log(programs);
}

main().catch(console.error);
