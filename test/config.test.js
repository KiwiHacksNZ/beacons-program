import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";

const validEnv = {
  NODE_ENV: "production",
  PORT: "3000",
  NOCODB_URL: "http://nocodb.internal:8080",
  NOCODB_API_TOKEN: "server-token",
  NOCODB_PROJECT_ID: "base_123",
  HEALTHCHECK_SECRET: "a".repeat(32),
  PUBLIC_BACKEND_URL: "https://beacons.example.com",
  ADMIN_ORIGINS: "https://beacons.example.com/",
  PUBLIC_SITE_ORIGINS: "https://www.example.com",
};

test("validates and normalizes production configuration", () => {
  const config = readConfig(validEnv);
  assert.equal(config.port, 3000);
  assert.equal(config.publicBackendUrl, "https://beacons.example.com");
  assert.equal(config.adminOrigins, "https://beacons.example.com");
  assert.equal(config.leaderboardCacheTtlMs, 30_000);
});

test("rejects insecure or malformed production configuration", () => {
  assert.throws(() => readConfig({ ...validEnv, PUBLIC_BACKEND_URL: "http://beacons.example.com" }), /HTTPS/);
  assert.throws(() => readConfig({ ...validEnv, PUBLIC_BACKEND_URL: "https://beacons.example.com/path" }), /without a path/);
  assert.throws(() => readConfig({ ...validEnv, HEALTHCHECK_SECRET: "short" }), /at least 32/);
  assert.throws(() => readConfig({ ...validEnv, ADMIN_ORIGINS: "not-an-origin" }), /invalid origin/);
  assert.throws(() => readConfig({ ...validEnv, LEADERBOARD_CACHE_TTL_MS: "5" }), /1000 to 300000/);
});
