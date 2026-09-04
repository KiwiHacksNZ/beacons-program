function requiredUrl(name, value, { httpsInProduction = false, nodeEnv = "production", originOnly = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials.`);
  }
  if (parsed.search || parsed.hash) throw new Error(`${name} must not contain a query string or fragment.`);
  if (originOnly && parsed.pathname !== "/") throw new Error(`${name} must contain only an origin, without a path.`);
  if (httpsInProduction && nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function originList(name, value, { required = false } = {}) {
  const candidates = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (required && !candidates.length) throw new Error(`${name} must contain at least one origin.`);
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`${name} contains an invalid origin.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`${name} must contain comma-separated HTTP(S) origins without paths.`);
    }
  }
  return candidates.map((candidate) => new URL(candidate).origin).join(",");
}

export function readConfig(env = process.env) {
  // USE_MEMORY_DB swaps NocoDB for an in-process store (see src/memory-db.js)
  // so the service runs with no external accounts or API keys. Data does not
  // persist across restarts. Never enable this in production.
  const useMemoryDb = env.USE_MEMORY_DB === "true";
  const port = Number(env.PORT || 3000);
  const nodeEnv = env.NODE_ENV || (useMemoryDb ? "development" : "production");

  const required = useMemoryDb
    ? ["HEALTHCHECK_SECRET", "PUBLIC_BACKEND_URL"]
    : ["NOCODB_URL", "NOCODB_API_TOKEN", "NOCODB_PROJECT_ID", "HEALTHCHECK_SECRET", "PUBLIC_BACKEND_URL"];
  const healthcheckSecret = env.HEALTHCHECK_SECRET || (useMemoryDb ? "dev-only-secret-do-not-use-in-production-000" : "");
  const publicBackendUrlInput = env.PUBLIC_BACKEND_URL || (useMemoryDb ? `http://localhost:${port}` : "");
  const missing = required.filter((key) => {
    if (key === "HEALTHCHECK_SECRET") return !healthcheckSecret.trim();
    if (key === "PUBLIC_BACKEND_URL") return !publicBackendUrlInput.trim();
    return !String(env[key] || "").trim();
  });
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const leaderboardCacheTtlMs = Number(env.LEADERBOARD_CACHE_TTL_MS || 30_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  if (!Number.isInteger(leaderboardCacheTtlMs) || leaderboardCacheTtlMs < 1_000 || leaderboardCacheTtlMs > 300_000) {
    throw new Error("LEADERBOARD_CACHE_TTL_MS must be an integer from 1000 to 300000.");
  }
  if (String(healthcheckSecret).length < 32) throw new Error("HEALTHCHECK_SECRET must contain at least 32 characters.");
  if (!useMemoryDb && !/^[A-Za-z0-9_-]+$/.test(env.NOCODB_PROJECT_ID)) throw new Error("NOCODB_PROJECT_ID contains unsupported characters.");

  const publicBackendUrl = requiredUrl("PUBLIC_BACKEND_URL", publicBackendUrlInput, { httpsInProduction: true, nodeEnv, originOnly: true });
  const nocodbUrl = useMemoryDb ? "" : requiredUrl("NOCODB_URL", env.NOCODB_URL, { nodeEnv });
  const adminOrigins = originList("ADMIN_ORIGINS", env.ADMIN_ORIGINS || publicBackendUrl, { required: true });
  const publicSiteOrigins = originList("PUBLIC_SITE_ORIGINS", env.PUBLIC_SITE_ORIGINS || "");

  return {
    port,
    leaderboardCacheTtlMs,
    nodeEnv,
    useMemoryDb,
    nocodbUrl,
    nocodbApiToken: useMemoryDb ? "" : env.NOCODB_API_TOKEN,
    nocodbProjectId: useMemoryDb ? "" : env.NOCODB_PROJECT_ID,
    healthcheckSecret,
    publicBackendUrl,
    publicSiteOrigins,
    adminOrigins,
    adminTitle: env.ADMIN_TITLE || "KiwiHacks Beacons",
    debugLogs: env.DEBUG_LOGS === "true",
    loopsApiKey: env.LOOPS_API_KEY || "",
  };
}
