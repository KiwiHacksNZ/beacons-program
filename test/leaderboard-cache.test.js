import test from "node:test";
import assert from "node:assert/strict";
import { createLeaderboardCache } from "../src/leaderboard-cache.js";

test("refresh reads the database every time and updates the public cache", async () => {
  const snapshots = [
    [{ displayName: "Ali", referralCount: 1 }],
    [{ displayName: "Ali", referralCount: 2 }],
  ];
  let reads = 0;
  const cache = createLeaderboardCache({
    loadLeaderboard: async () => snapshots[reads++],
    now: () => 123,
  });
  const program = { public_slug: "bp_program" };

  assert.deepEqual(JSON.parse((await cache.refresh(program)).body), snapshots[0]);
  assert.deepEqual(JSON.parse((await cache.refresh(program)).body), snapshots[1]);
  assert.deepEqual(JSON.parse(cache.get("bp_program").body), snapshots[1]);
  assert.equal(cache.get("bp_program").refreshedAt, 123);
  assert.equal(reads, 2);
});

test("an older slow read cannot overwrite a newer refresh", async () => {
  let finishOldRead;
  let reads = 0;
  const oldRead = new Promise((resolve) => { finishOldRead = resolve; });
  const newest = [{ displayName: "Ali", referralCount: 2 }];
  const cache = createLeaderboardCache({
    loadLeaderboard: async () => reads++ === 0 ? oldRead : newest,
  });
  const program = { public_slug: "bp_program" };

  const firstRefresh = cache.refresh(program);
  await cache.refresh(program);
  finishOldRead([{ displayName: "Ali", referralCount: 1 }]);
  await firstRefresh;

  assert.deepEqual(JSON.parse(cache.get("bp_program").body), newest);
});

test("getOrRefresh serves fresh data and coalesces expired concurrent reads", async () => {
  let currentTime = 100;
  let reads = 0;
  let finishRead;
  const delayedRead = new Promise((resolve) => { finishRead = resolve; });
  const cache = createLeaderboardCache({
    loadLeaderboard: async () => {
      reads += 1;
      return reads === 1 ? [{ displayName: "Ali", referralCount: 1 }] : delayedRead;
    },
    now: () => currentTime,
  });
  const program = { public_slug: "bp_program" };

  await cache.getOrRefresh(program, 1_000);
  await cache.getOrRefresh(program, 1_000);
  assert.equal(reads, 1);

  currentTime = 1_101;
  const first = cache.getOrRefresh(program, 1_000);
  const second = cache.getOrRefresh(program, 1_000);
  assert.equal(reads, 2);
  finishRead([{ displayName: "Ali", referralCount: 2 }]);
  assert.equal(await first, await second);
});
