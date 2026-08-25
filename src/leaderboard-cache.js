export function createLeaderboardCache({ loadLeaderboard, now = Date.now }) {
  const entries = new Map();
  const refreshVersions = new Map();

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

  return {
    refresh,
    get(programSlug) {
      return entries.get(programSlug) || null;
    },
  };
}
