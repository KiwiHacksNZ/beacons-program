import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { renderAdmin, renderAdminError, renderProgramSecret } from "./admin.js";
import { bearerToken, createProgramCredentials, hashSecret, isBearerAuthorized, parseAllowedOrigins, validateProgramName, validateSignup } from "./domain.js";
import { createSupabaseClient } from "./supabase.js";

const config = readConfig();
const allowedOrigins = parseAllowedOrigins(config.publicSiteOrigins);
const allowedAdminOrigins = parseAllowedOrigins(config.adminOrigins);
const supabase = createSupabaseClient({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey });
const adminCss = await readFile(fileURLToPath(new URL("./admin.css", import.meta.url)), "utf8");
const leaderboardCache = new Map();

async function refreshLeaderboard(programSlug) {
  const leaderboard = await supabase.getLeaderboard(programSlug);
  if (leaderboard === null) return null;
  const cached = { body: JSON.stringify(leaderboard), refreshedAt: Date.now() };
  leaderboardCache.set(programSlug, cached);
  return cached;
}

function log(level, event, details = {}) {
  const safeDetails = { ...details };
  delete safeDetails.email;
  delete safeDetails.secret;
  delete safeDetails.programSlug;
  console[level](JSON.stringify({ time: new Date().toISOString(), event, ...safeDetails }));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const publicMatch = url.pathname.match(/^\/api\/public\/programs\/([^/]+)\/leaderboard$/);
  const webhookMatch = url.pathname.match(/^\/api\/webhooks\/fillout\/([^/]+)$/);
  const rotateMatch = url.pathname.match(/^\/admin\/programs\/([0-9a-f-]{36})\/rotate-key$/i);
  const routeName = publicMatch
    ? "/api/public/programs/:program/leaderboard"
    : webhookMatch
      ? "/api/webhooks/fillout/:program"
      : rotateMatch
        ? "/admin/programs/:program/rotate-key"
        : url.pathname;

  try {
    if (request.method === "OPTIONS" && publicMatch) {
      applyCors(request, response);
      response.writeHead(204).end();
      return;
    }

    if (request.method === "GET" && publicMatch) {
      applyCors(request, response);
      const programSlug = decodeURIComponent(publicMatch[1]);
      const cached = leaderboardCache.get(programSlug) || (await refreshLeaderboard(programSlug));
      if (!cached) { sendJson(response, 404, { error: "Program not found" }); return; }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      response.end(cached.body);
      return;
    }

    if (request.method === "POST" && webhookMatch) {
      const secret = bearerToken(request.headers.authorization);
      if (secret.length < 32) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      const programSlug = decodeURIComponent(webhookMatch[1]);
      const payload = await readJsonBody(request, 128 * 1024);
      const validated = validateSignup(payload);
      if (!validated.ok) { sendJson(response, 400, { error: "Invalid submission", details: validated.errors }); return; }
      const result = await supabase.acceptSignup(programSlug, hashSecret(secret), validated.value);
      if (!result?.authorized) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      await refreshLeaderboard(programSlug);
      if (!result.accepted) {
        log("info", "signup_duplicate_ignored");
        sendJson(response, 200, { accepted: false, status: "duplicate_ignored" });
        return;
      }
      log("info", "signup_accepted", { referralApplied: Boolean(result.referral_applied) });
      sendJson(response, 201, { accepted: true, status: "created", referralApplied: Boolean(result.referral_applied) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
      response.end(adminCss);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      const [attendees, programs] = await Promise.all([supabase.getAdminAttendees(), supabase.getAdminPrograms()]);
      const entries = await Promise.all(programs.map(async (program) => [program.public_slug, (await supabase.getLeaderboard(program.public_slug)) || []]));
      sendAdminHtml(response, 200, renderAdmin({ title: config.adminTitle, backendUrl: config.publicBackendUrl, programs, attendees, leaderboardsByProgram: new Map(entries) }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/programs") {
      if (!allowedAdminOrigins.has(request.headers.origin)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      const form = await readFormBody(request, 16 * 1024);
      const validated = validateProgramName(form.get("name"));
      if (!validated.ok) { sendAdminHtml(response, 400, renderAdminError({ title: "Program not created", message: validated.error })); return; }
      const credentials = createProgramCredentials();
      const program = await supabase.createProgram({ name: validated.value, publicSlug: credentials.publicSlug, webhookSecretHash: hashSecret(credentials.webhookSecret) });
      sendAdminHtml(response, 201, renderProgramSecret({ mode: "created", programName: program.name, ...programUrls(program.public_slug), secret: credentials.webhookSecret }));
      return;
    }

    if (request.method === "POST" && rotateMatch) {
      if (!allowedAdminOrigins.has(request.headers.origin)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      await readFormBody(request, 1024);
      const credentials = createProgramCredentials();
      const program = await supabase.rotateProgramSecret({ programId: rotateMatch[1], webhookSecretHash: hashSecret(credentials.webhookSecret) });
      if (!program) { sendAdminHtml(response, 404, renderAdminError({ title: "Program not found", message: "The webhook key was not changed.", status: 404 })); return; }
      sendAdminHtml(response, 200, renderProgramSecret({ mode: "rotated", programName: program.name, ...programUrls(program.public_slug), secret: credentials.webhookSecret }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/health/db") {
      if (!isBearerAuthorized(request.headers.authorization, config.healthcheckSecret)) { sendJson(response, 401, { ok: false }); return; }
      const result = await supabase.healthCheck();
      sendJson(response, result?.ok ? 200 : 503, { ok: Boolean(result?.ok) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/live") { sendJson(response, 200, { ok: true }); return; }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    log("error", "request_failed", { path: routeName, message: error.message });
    const status = error.statusCode || 503;
    if (url.pathname.startsWith("/admin")) sendAdminHtml(response, status, renderAdminError({ title: "Service unavailable", message: status === 413 ? error.message : "The database request did not complete. Please try again.", status }));
    else sendJson(response, status, { error: status === 413 || status === 400 ? error.message : "Service temporarily unavailable" });
  }
});

server.listen(config.port, "0.0.0.0", () => log("info", "server_listening", { port: config.port }));

function readConfig() {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HEALTHCHECK_SECRET", "PUBLIC_BACKEND_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return { port: Number(process.env.PORT || 3000), supabaseUrl: process.env.SUPABASE_URL, supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, healthcheckSecret: process.env.HEALTHCHECK_SECRET, publicBackendUrl: process.env.PUBLIC_BACKEND_URL.replace(/\/$/, ""), publicSiteOrigins: process.env.PUBLIC_SITE_ORIGINS || "", adminOrigins: process.env.ADMIN_ORIGINS || process.env.PUBLIC_BACKEND_URL, adminTitle: process.env.ADMIN_TITLE || "KiwiHacks Beacons" };
}

function programUrls(programSlug) {
  const slug = encodeURIComponent(programSlug);
  return { webhookUrl: `${config.publicBackendUrl}/api/webhooks/fillout/${slug}`, publicLeaderboardUrl: `${config.publicBackendUrl}/api/public/programs/${slug}/leaderboard` };
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function sendAdminHtml(response, status, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
  response.end(body);
}

async function readJsonBody(request, maxBytes) {
  const value = await readBody(request, maxBytes);
  try { return JSON.parse(value); } catch { const error = new Error("Request body must contain valid JSON."); error.statusCode = 400; throw error; }
}

async function readFormBody(request, maxBytes) { return new URLSearchParams(await readBody(request, maxBytes)); }

async function readBody(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error("Request body is too large."); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
