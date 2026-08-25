export function createLeaderboardCache({ loadLeaderboard, now = Date.now }) {
  const entries = new Map();
  const refreshVersions = new Map();
  const inFlight = new Map();

  async function refresh(program) {
    if (!program) return null;

    const programSlug = program.public_slug;
    const version = (refreshVersions.get(programSlug) || 0) + 1;
    refreshVersions.set(programSlug, version);

    const leaderboard = await loadLeaderboard(program);
    if (leaderboard === null) return null;

    const entry = { body: JSON.stringify(leaderboard), refreshedAt: now() };

    // A slower, older database read must not replace a refresh which started
    // later (for example, the refresh triggered by a newly accepted signup).
    if (refreshVersions.get(programSlug) === version) {
      entries.set(programSlug, entry);
    }

    return entry;
  }

  function getFresh(programSlug, maxAgeMs) {
    const cached = entries.get(programSlug);
    return cached && now() - cached.refreshedAt < maxAgeMs ? cached : null;
  }

  function getOrRefresh(program, maxAgeMs) {
    if (!program) return Promise.resolve(null);
    const programSlug = program.public_slug;
    const cached = getFresh(programSlug, maxAgeMs);
    if (cached) return Promise.resolve(cached);
    if (inFlight.has(programSlug)) return inFlight.get(programSlug);

    const pending = refresh(program).finally(() => {
      if (inFlight.get(programSlug) === pending) inFlight.delete(programSlug);
    });
    inFlight.set(programSlug, pending);
    return pending;
  }

  return {
    refresh,
    getFresh,
    getOrRefresh,
    get(programSlug) {
      return entries.get(programSlug) || null;
    },
  };
}
