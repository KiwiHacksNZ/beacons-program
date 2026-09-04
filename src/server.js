import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { renderAdmin, renderAdminError, renderProgramSecret } from "./admin.js";
import { readConfig } from "./config.js";
import { AdminValidationError, bearerToken, createProgramCredentials, generateRefCode, hashSecret, isBearerAuthorized, isValidPublicSlug, isValidRecordId, isValidReferralCode, parseAllowedOrigins, securelyMatches, validateLoopsTransactionalId, validateProgramName, validateSignup } from "./domain.js";
import { createLeaderboardCache } from "./leaderboard-cache.js";
import { createMemoryDbClient } from "./memory-db.js";
import { createNocoDBClient } from "./nocodb.js";

const config = readConfig();
const allowedOrigins = parseAllowedOrigins(config.publicSiteOrigins);
const allowedAdminOrigins = parseAllowedOrigins(config.adminOrigins);
const db = config.useMemoryDb
  ? createMemoryDbClient()
  : createNocoDBClient({ url: config.nocodbUrl, apiToken: config.nocodbApiToken, projectId: config.nocodbProjectId });
const adminCss = await readFile(fileURLToPath(new URL("./admin.css", import.meta.url)), "utf8");
const leaderboardCache = createLeaderboardCache({ loadLeaderboard: (program) => db.getLeaderboard(program) });
const backgroundTasks = new Set();

async function refreshLeaderboard(program) {
  return leaderboardCache.refresh(program);
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

  return false;
}

const server = createServer(async (request, response) => {
  // Route only on the origin-form request target. The externally configured
  // canonical URL is used for generated links, never the untrusted Host header.
  const url = new URL(request.url || "/", "http://localhost");
  const publicMatch = url.pathname.match(/^\/api\/public\/programs\/([^/]+)\/leaderboard$/);
  const webhookMatch = url.pathname.match(/^\/api\/webhooks\/fillout\/([^/]+)$/);
  const rotateMatch = url.pathname.match(/^\/admin\/programs\/([^/]+)\/rotate-key$/i);
  const addCodeMatch = url.pathname.match(/^\/admin\/attendees\/([^/]+)\/referral-codes$/i);
  const removeCodeMatch = url.pathname.match(/^\/admin\/attendees\/([^/]+)\/referral-codes\/remove$/i);
  const routeName = publicMatch
    ? "/api/public/programs/:program/leaderboard"
    : webhookMatch
      ? "/api/webhooks/fillout/:program"
      : rotateMatch
        ? "/admin/programs/:program/rotate-key"
        : removeCodeMatch
          ? "/admin/attendees/:attendee/referral-codes/remove"
          : addCodeMatch
            ? "/admin/attendees/:attendee/referral-codes"
            : ["/admin", "/admin/", "/admin/programs", "/admin/styles.css", "/internal/health/db", "/health/live"].includes(url.pathname)
              ? url.pathname
              : "unmatched";

  debug("request_start", { method: request.method, route: routeName, origin: request.headers.origin || null, host: request.headers.host || null });

  try {
    if (request.method === "OPTIONS" && publicMatch) {
      applyCors(request, response);
      response.writeHead(204).end();
      return;
    }

    if (request.method === "GET" && publicMatch) {
      debug("public_leaderboard", { method: request.method });
      applyCors(request, response);
      const programSlug = publicMatch[1];
      if (!isValidPublicSlug(programSlug)) { sendJson(response, 404, { error: "Program not found" }); return; }
      let cached = leaderboardCache.getFresh(programSlug, config.leaderboardCacheTtlMs);
      if (!cached) {
        const program = await db.getProgramBySlug(programSlug);
        cached = await leaderboardCache.getOrRefresh(program, config.leaderboardCacheTtlMs);
      }
      if (!cached) { sendJson(response, 404, { error: "Program not found" }); return; }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      response.end(cached.body);
      return;
    }

    if (request.method === "POST" && webhookMatch) {
      if (!hasContentType(request, "application/json")) { sendJson(response, 415, { error: "Content-Type must be application/json" }); return; }
      const secret = bearerToken(request.headers.authorization);
      debug("webhook_received", { method: request.method, hasAuthorization: Boolean(secret), authorizationLength: secret.length });
      if (secret.length < 32) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      const programSlug = webhookMatch[1];
      if (!isValidPublicSlug(programSlug)) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      const payload = await readJsonBody(request, 128 * 1024);
      const validated = validateSignup(payload);
      if (!validated.ok) { sendJson(response, 400, { error: "Invalid submission", details: validated.errors }); return; }
      const program = await db.getProgramBySlug(programSlug);
      if (!program || !securelyMatches(hashSecret(secret), program.webhook_secret_hash)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const generatedRefCode = generateRefCode(validated.value.firstName, validated.value.lastName, validated.value.email, validated.value.preferredName);
      const result = await db.acceptSignup(program, validated.value, generatedRefCode);
      debug("webhook_database_result", { authorized: Boolean(result?.authorized), accepted: Boolean(result?.accepted), referralApplied: Boolean(result?.referral_applied) });
      if (!result?.authorized) { sendJson(response, 401, { error: "Unauthorized" }); return; }
      try {
        await refreshLeaderboard(program);
      } catch {
        // The signup is already durable. A public read will retry the refresh;
        // do not make Fillout retry a successfully created attendee.
        log("error", "leaderboard_refresh_failed");
      }
      if (!result.accepted) {
        log("info", "signup_duplicate_ignored");
        sendJson(response, 200, { accepted: false, status: "duplicate_ignored" });
        return;
      }
      log("info", "signup_accepted", { referralApplied: Boolean(result.referral_applied) });
      
      if (result.loops_transactional_id && config.loopsApiKey) {
        const firstName = validated.value.preferredName || validated.value.firstName;
        runInBackground(
          sendLoopsEmail(validated.value.email, firstName, result.owned_referral_code, result.loops_transactional_id)
            .then(() => log("info", "loops_email_sent"))
            .catch(() => log("error", "loops_email_failed")),
        );
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
      sendAdminHtml(response, 200, renderAdmin({
        title: config.adminTitle,
        backendUrl: config.publicBackendUrl,
        programs,
        attendees,
        leaderboardsByProgram: new Map(entries),
        sort: url.searchParams.get("sort"),
        dir: url.searchParams.get("dir"),
        programFilter: url.searchParams.get("program"),
        search: url.searchParams.get("q"),
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/programs") {
      debug("admin_create_origin_check", { receivedOrigin: request.headers.origin || null, referer: request.headers.referer || null, fetchSite: request.headers["sec-fetch-site"] || null, allowed: isAllowedAdminRequest(request), allowedAdminOrigins: [...allowedAdminOrigins] });
      if (!isAllowedAdminRequest(request)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      if (!hasContentType(request, "application/x-www-form-urlencoded")) { sendAdminHtml(response, 415, renderAdminError({ title: "Program not created", message: "Unsupported form content type.", status: 415 })); return; }
      const form = await readFormBody(request, 16 * 1024);
      const validated = validateProgramName(form.get("name"));
      const loopsId = validateLoopsTransactionalId(form.get("loopsTransactionalId"));
      if (!validated.ok) { sendAdminHtml(response, 400, renderAdminError({ title: "Program not created", message: validated.error })); return; }
      if (!loopsId.ok) { sendAdminHtml(response, 400, renderAdminError({ title: "Program not created", message: loopsId.error })); return; }
      if (loopsId.value && !config.loopsApiKey) { sendAdminHtml(response, 400, renderAdminError({ title: "Program not created", message: "Configure LOOPS_API_KEY before enabling a Loops template." })); return; }
      const credentials = createProgramCredentials();
      const program = await db.createProgram({ name: validated.value, publicSlug: credentials.publicSlug, webhookSecretHash: hashSecret(credentials.webhookSecret), loopsTransactionalId: loopsId.value });
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
      if (!isValidRecordId(rotateMatch[1])) { sendAdminHtml(response, 404, renderAdminError({ title: "Program not found", message: "The webhook key was not changed.", status: 404 })); return; }
      if (!hasContentType(request, "application/x-www-form-urlencoded")) { sendAdminHtml(response, 415, renderAdminError({ title: "Webhook key not changed", message: "Unsupported form content type.", status: 415 })); return; }
      await readFormBody(request, 1024);
      const credentials = createProgramCredentials();
      const program = await db.rotateProgramSecret({ programId: rotateMatch[1], webhookSecretHash: hashSecret(credentials.webhookSecret) });
      if (!program) { sendAdminHtml(response, 404, renderAdminError({ title: "Program not found", message: "The webhook key was not changed.", status: 404 })); return; }
      sendAdminHtml(response, 200, renderProgramSecret({ mode: "rotated", programName: program.name, ...programUrls(program.public_slug), secret: credentials.webhookSecret }));
      return;
    }

    if (request.method === "POST" && addCodeMatch) {
      debug("admin_add_code_origin_check", { receivedOrigin: request.headers.origin || null, referer: request.headers.referer || null, fetchSite: request.headers["sec-fetch-site"] || null, allowed: isAllowedAdminRequest(request), allowedAdminOrigins: [...allowedAdminOrigins] });
      if (!isAllowedAdminRequest(request)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      if (!isValidRecordId(addCodeMatch[1])) { sendAdminHtml(response, 404, renderAdminError({ title: "Attendee not found", message: "No referral code was added.", status: 404 })); return; }
      if (!hasContentType(request, "application/x-www-form-urlencoded")) { sendAdminHtml(response, 415, renderAdminError({ title: "Code not added", message: "Unsupported form content type.", status: 415 })); return; }
      const form = await readFormBody(request, 1024);
      const rawCode = String(form.get("code") || "").trim();
      if (rawCode && !isValidReferralCode(rawCode)) {
        sendAdminHtml(response, 400, renderAdminError({ title: "Code not added", message: "Custom codes must start with a letter or number and use only letters, numbers, hyphens, and underscores (max 64 characters)." }));
        return;
      }
      const attendee = await db.getAttendeeById(addCodeMatch[1]);
      if (!attendee) { sendAdminHtml(response, 404, renderAdminError({ title: "Attendee not found", message: "That signup no longer exists.", status: 404 })); return; }
      await db.addReferralCode(attendee, rawCode ? rawCode.toUpperCase() : null);
      response.writeHead(303, { location: "/admin" }).end();
      return;
    }

    if (request.method === "POST" && removeCodeMatch) {
      debug("admin_remove_code_origin_check", { receivedOrigin: request.headers.origin || null, referer: request.headers.referer || null, fetchSite: request.headers["sec-fetch-site"] || null, allowed: isAllowedAdminRequest(request), allowedAdminOrigins: [...allowedAdminOrigins] });
      if (!isAllowedAdminRequest(request)) {
        sendAdminHtml(response, 403, renderAdminError({ title: "Request blocked", message: "The request origin did not match the admin site.", status: 403 }));
        return;
      }
      if (!isValidRecordId(removeCodeMatch[1])) { sendAdminHtml(response, 404, renderAdminError({ title: "Attendee not found", message: "No referral code was removed.", status: 404 })); return; }
      if (!hasContentType(request, "application/x-www-form-urlencoded")) { sendAdminHtml(response, 415, renderAdminError({ title: "Code not removed", message: "Unsupported form content type.", status: 415 })); return; }
      const form = await readFormBody(request, 1024);
      const rawCode = String(form.get("code") || "").trim();
      const attendee = await db.getAttendeeById(removeCodeMatch[1]);
      if (!attendee) { sendAdminHtml(response, 404, renderAdminError({ title: "Attendee not found", message: "That signup no longer exists.", status: 404 })); return; }
      await db.removeReferralCode(attendee, rawCode);
      response.writeHead(303, { location: "/admin" }).end();
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
    log("error", "request_failed", { route: routeName, message: error.message, method: request.method, origin: request.headers.origin || null });
    const status = error.statusCode || 503;
    // AdminValidationError (409) messages are static strings we author ourselves
    // (e.g. "code already in use"), so they are safe to show, unlike raw DB errors.
    const revealMessage = status === 413 || error instanceof AdminValidationError;
    if (url.pathname.startsWith("/admin")) sendAdminHtml(response, status, renderAdminError({ title: revealMessage ? "Referral code not saved" : "Service unavailable", message: revealMessage ? error.message : "The database request did not complete. Please try again.", status }));
    else sendJson(response, status, { error: status === 413 || status === 400 ? error.message : "Service temporarily unavailable" });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  log("info", "server_listening", { port: config.port, publicBackendUrl: config.publicBackendUrl, adminOrigins: [...allowedAdminOrigins], publicSiteOrigins: [...allowedOrigins], debugLogs: config.debugLogs, useMemoryDb: config.useMemoryDb });
  if (config.useMemoryDb) log("info", "memory_db_active", { warning: "Data is in-memory only and is lost on restart. Do not use this mode in production." });
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
server.on("error", (error) => {
  log("error", "server_error", { message: error.message });
  if (!server.listening) process.exitCode = 1;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => shutdown(signal));
}

function programUrls(programSlug) {
  const slug = encodeURIComponent(programSlug);
  return { webhookUrl: `${config.publicBackendUrl}/api/webhooks/fillout/${slug}`, publicLeaderboardUrl: `${config.publicBackendUrl}/api/public/programs/${slug}/leaderboard` };
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  response.setHeader("vary", "Origin");
  if (origin && allowedOrigins.has(origin)) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function sendAdminHtml(response, status, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store, no-transform", "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
  response.end(body);
}

async function readJsonBody(request, maxBytes) {
  const value = await readBody(request, maxBytes);
  try { return JSON.parse(value); } catch { const error = new Error("Request body must contain valid JSON."); error.statusCode = 400; throw error; }
}

async function readFormBody(request, maxBytes) { return new URLSearchParams(await readBody(request, maxBytes)); }

function hasContentType(request, expected) {
  return String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() === expected;
}

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
    await response.body?.cancel();
    throw new Error(`Loops request failed with status ${response.status}.`);
  }
}

function runInBackground(promise) {
  backgroundTasks.add(promise);
  promise.finally(() => backgroundTasks.delete(promise));
}

function shutdown(signal) {
  log("info", "server_shutdown_started", { signal });
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async (error) => {
    await Promise.allSettled([...backgroundTasks]);
    clearTimeout(forceExit);
    if (error) log("error", "server_shutdown_failed", { message: error.message });
    process.exitCode = error ? 1 : 0;
  });
}
