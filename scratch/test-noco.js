import { createNocoDBClient } from "../src/nocodb.js";

const db = createNocoDBClient({
  url: process.env.NOCODB_URL,
  apiToken: process.env.NOCODB_API_TOKEN,
  projectId: process.env.NOCODB_PROJECT_ID
});

async function run() {
  try {
    const program = await db.getProgramBySlug("test-program");
    console.log("Program:", program);
  } catch (e) {
    console.error("Error getProgramBySlug:", e.message);
  }
}

run();
