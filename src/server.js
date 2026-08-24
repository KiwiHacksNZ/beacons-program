import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { renderAdmin, renderAdminError, renderProgramSecret } from "./admin.js";
import { renderPublicLeaderboard } from "./public.js";
import { bearerToken, createProgramCredentials, hashSecret, isBearerAuthorized, parseAllowedOrigins, validateProgramName, validateSignup, generateRefCode } from "./domain.js";
import { createNocoDBClient } from "./nocodb.js";

const config = readConfig();
const allowedOrigins = parseAllowedOrigins(config.publicSiteOrigins);
const allowedAdminOrigins = parseAllowedOrigins(config.adminOrigins);
const db = createNocoDBClient({ url: config.nocodbUrl, apiToken: config.nocodbApiToken, projectId: config.nocodbProjectId });
const adminCss = await readFile(fileURLToPath(new URL("./admin.css", import.meta.url)), "utf8");
const publicCss = await readFile(fileURLToPath(new URL("./public.css", import.meta.url)), "utf8");
const leaderboardCache = new Map();

async function refreshLeaderboard(program) {
  if (!program) return null;
  const programSlug = program.public_slug;
  const leaderboard = await db.getLeaderboard(program);
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

function debug(event, details = {}) {
  if (!config.debugLogs) return;
  log("info", `debug_${event}`, details);
}

function isAllowedAdminRequest(request) {
  const origin = request.headers.origin;
  if (allowedAdminOrigins.has(origin)) return true;
  if (origin !== undefined && origin !== "null") return false;

  // Some privacy layers/proxies turn same-origin form POSTs into Origin: null,
  // or strip the Origin header entirely (making it undefined).
  // Accept that only when the referrer is an explicitly allowed admin origin.
  const referer = request.headers.referer;
  if (referer) {
    try {
      if (allowedAdminOrigins.has(new URL(referer).origin)) return true;
    } catch {}
  }

  // Modern browsers send Sec-Fetch-Site: same-origin for same-site requests
  if (request.headers["sec-fetch-site"] === "same-origin") return true;

  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const publicMatch = url.pathname.match(/^\/api\/public\/programs\/([^/]+)\/leaderboard$/);
  const uiMatch = url.pathname.match(/^\/leaderboard\/([^/]+)$/);
  const webhookMatch = url.pathname.match(/^\/api\/webhooks\/fillout\/([^/]+)$/);
  const rotateMatch = url.pathname.match(/^\/admin\/programs\/([^/]+)\/rotate-key$/i);
  const routeName = publicMatch
    ? "/api/public/programs/:program/leaderboard"
    : uiMatch
      ? "/leaderboard/:program"
      : webhookMatch
      ? "/api/webhooks/fillout/:program"
      : rotateMatch
        ? "/admin/programs/:program/rotate-key"
        : url.pathname;

  debug("request_start", { method: request.method, path: url.pathname, route: routeName, origin: request.headers.origin || null, host: request.headers.host || null });

  try {
    if (request.method === "OPTIONS" && publicMatch) {
      applyCors(request, response);
      response.writeHead(204).end();
      return;
    }

    if (request.method === "GET" && publicMatch) {
      debug("public_leaderboard", { method: request.method });
      applyCors(request, response);
      const programSlug = decodeURIComponent(publicMatch[1]);
      const program = await db.getProgramBySlug(programSlug);
      const cached = leaderboardCache.get(programSlug) || (await refreshLeaderboard(program));
      if (!cached) { sendJson(response, 404, { error: "Program not found" }); return; }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      response.end(cached.body);
      return;
    }

    if (request.method === "GET" && uiMatch) {
      debug("public_ui", { method: request.method });
      const programSlug = decodeURIComponent(uiMatch[1]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" });
      response.end(renderPublicLeaderboard(programSlug));
      return;
    }

    if (request.method === "GET" && url.pathname === "/public/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
      response.end(publicCss);
      return;
    }

    if (request.method === "POST" && webhookMatch) {
      const secret = bearerToken(request.headers.authorization);
      debug("webhook_received", { method: request.method, hasAuthorization: Boolean(secret), authorizationLength: secret.length });
      if (secret.length < 32) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      const programSlug = decodeURIComponent(webhookMatch[1]);
      const payload = await readJsonBody(request, 128 * 1024);
      const validated = validateSignup(payload);
      if (!validated.ok) { sendJson(response, 400, { error: "Invalid submission", details: validated.errors }); return; }
      const program = await db.getProgramBySlug(programSlug);
      if (!program || program.webhook_secret_hash !== hashSecret(secret)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const generatedRefCode = generateRefCode(validated.value.firstName, validated.value.lastName, validated.value.email);
      const result = await db.acceptSignup(program, validated.value, generatedRefCode);
      debug("webhook_database_result", { authorized: Boolean(result?.authorized), accepted: Boolean(result?.accepted), referralApplied: Boolean(result?.referral_applied) });
      if (!result?.authorized) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      await refreshLeaderboard(program);
      if (!result.accepted) {
        log("info", "signup_duplicate_ignored");
        sendJson(response, 200, { accepted: false, status: "duplicate_ignored" });
        return;
      }
      log("info", "signup_accepted", { referralApplied: Boolean(result.referral_applied) });
      
      if (result.loops_transactional_id && config.loopsApiKey) {
        const firstName = validated.value.preferredName || validated.value.firstName;
        sendLoopsEmail(validated.value.email, firstName, result.owned_referral_code, result.loops_transactional_id)
          .then(() => log("info", "loops_email_sent", { email: validated.value.email }))
          .catch(err => log("error", "loops_email_failed", { email: validated.value.email, error: err.message }));
      }

      sendJson(response, 201, { accepted: true, status: "created", referralApplied: Boolean(result.referral_applied) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
      response.end(adminCss);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      debug("admin_page", { method: request.method });
      const [attendees, programs] = await Promise.all([db.getAdminAttendees(), db.getAdminPrograms()]);
      const entries = await Promise.all(programs.map(async (program) => [program.public_slug, (await db.getLeaderboard(program)) || []]));
      sendAdminHtml(response, 200, renderAdmin({ title: config.adminTitle, backendUrl: config.publicBackendUrl, programs, attendees, leaderboardsByProgram: new Map(entries) }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/programs") {
      debug("admin_create_origin_check", { receivedOrigin: request.headers.origin || null, referer: request.headers.referer || null, fetchSite: request.headers["sec-fetch-site"] || null, allowed: isAllowedAdminRequest(request), allowedAdminOrigins: [...allowedAdminOrigins] });
      if (!isAllowedAdminRequest(request)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      const form = await readFormBody(request, 16 * 1024);
      const validated = validateProgramName(form.get("name"));
      const loopsTransactionalId = form.get("loopsTransactionalId") || null;
      if (!validated.ok) { sendAdminHtml(response, 400, renderAdminError({ title: "Program not created", message: validated.error })); return; }
      const credentials = createProgramCredentials();
      const program = await db.createProgram({ name: validated.value, publicSlug: credentials.publicSlug, webhookSecretHash: hashSecret(credentials.webhookSecret), loopsTransactionalId });
      debug("admin_program_created", { databaseAccepted: Boolean(program?.Id || program?.id) });
      sendAdminHtml(response, 201, renderProgramSecret({ mode: "created", programName: program.name, ...programUrls(program.public_slug), secret: credentials.webhookSecret }));
      return;
    }

    if (request.method === "POST" && rotateMatch) {
      debug("admin_rotate_origin_check", { receivedOrigin: request.headers.origin || null, referer: request.headers.referer || null, fetchSite: request.headers["sec-fetch-site"] || null, allowed: isAllowedAdminRequest(request), allowedAdminOrigins: [...allowedAdminOrigins] });
      if (!isAllowedAdminRequest(request)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      await readFormBody(request, 1024);
      const credentials = createProgramCredentials();
      const program = await db.rotateProgramSecret({ programId: rotateMatch[1], webhookSecretHash: hashSecret(credentials.webhookSecret) });
      if (!program) { sendAdminHtml(response, 404, renderAdminError({ title: "Program not found", message: "The webhook key was not changed.", status: 404 })); return; }
      sendAdminHtml(response, 200, renderProgramSecret({ mode: "rotated", programName: program.name, ...programUrls(program.public_slug), secret: credentials.webhookSecret }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/health/db") {
      debug("health_request", { authorized: isBearerAuthorized(request.headers.authorization, config.healthcheckSecret) });
      if (!isBearerAuthorized(request.headers.authorization, config.healthcheckSecret)) { sendJson(response, 401, { ok: false }); return; }
      const result = await db.healthCheck();
      sendJson(response, result?.ok ? 200 : 503, { ok: Boolean(result?.ok) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/live") { sendJson(response, 200, { ok: true }); return; }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
  log("error", "request_failed", { path: routeName, message: error.message, method: request.method, origin: request.headers.origin || null });
    const status = error.statusCode || 503;
    if (url.pathname.startsWith("/admin")) sendAdminHtml(response, status, renderAdminError({ title: "Service unavailable", message: status === 413 ? error.message : "The database request did not complete. Please try again.", status }));
    else sendJson(response, status, { error: status === 413 || status === 400 ? error.message : "Service temporarily unavailable" });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  log("info", "server_listening", { port: config.port, publicBackendUrl: config.publicBackendUrl, adminOrigins: [...allowedAdminOrigins], publicSiteOrigins: [...allowedOrigins], debugLogs: config.debugLogs });
});

function readConfig() {
  const required = ["NOCODB_URL", "NOCODB_API_TOKEN", "NOCODB_PROJECT_ID", "HEALTHCHECK_SECRET", "PUBLIC_BACKEND_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return { port: Number(process.env.PORT || 3000), nocodbUrl: process.env.NOCODB_URL, nocodbApiToken: process.env.NOCODB_API_TOKEN, nocodbProjectId: process.env.NOCODB_PROJECT_ID, healthcheckSecret: process.env.HEALTHCHECK_SECRET, publicBackendUrl: process.env.PUBLIC_BACKEND_URL.replace(/\/$/, ""), publicSiteOrigins: process.env.PUBLIC_SITE_ORIGINS || "", adminOrigins: process.env.ADMIN_ORIGINS || process.env.PUBLIC_BACKEND_URL, adminTitle: process.env.ADMIN_TITLE || "KiwiHacks Beacons", debugLogs: process.env.DEBUG_LOGS === "true", loopsApiKey: process.env.LOOPS_API_KEY || "" };
}

function programUrls(programSlug) {
  const slug = encodeURIComponent(programSlug);
  return { webhookUrl: `${config.publicBackendUrl}/api/webhooks/fillout/${slug}`, publicLeaderboardUrl: `${config.publicBackendUrl}/api/public/programs/${slug}/leaderboard`, uiUrl: `${config.publicBackendUrl}/leaderboard/${slug}` };
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
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
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

async function sendLoopsEmail(email, firstName, refCode, transactionalId) {
  const response = await fetch("https://app.loops.so/api/v1/transactional", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.loopsApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transactionalId: transactionalId,
      email: email,
      dataVariables: {
        refCode: refCode,
        ref: refCode,
        name: firstName,
        firstName: firstName
      }
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`Loops returned ${response.status}: ${await response.text()}`);
  }
}
