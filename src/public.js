export function renderPublicLeaderboard(programSlug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Program Leaderboard</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <header>
    <p class="kicker">Top Referrers</p>
    <h1>Leaderboard</h1>
    <p class="subtitle">The top ambassadors bringing the most people to our program. Will you claim the number one spot?</p>
  </header>

  <main>
    <div class="leaderboard-container">
      <div id="loading" class="empty-state">
        <div class="loading-spinner"></div>
        <p>Loading leaderboard...</p>
      </div>
      
      <div id="error" class="empty-state" style="display: none;">
        <p>Could not load leaderboard data. Please try again later.</p>
      </div>

      <div id="empty" class="empty-state" style="display: none;">
        <p>No referrals yet! Be the first to invite someone.</p>
      </div>

      <ul id="leaderboard-list" class="leaders-list">
        <!-- Rendered via JS -->
      </ul>
    </div>
  </main>

  <script>
    const slug = ${JSON.stringify(programSlug)};
    
    async function loadLeaderboard() {
      const listEl = document.getElementById('leaderboard-list');
      const loadingEl = document.getElementById('loading');
      const errorEl = document.getElementById('error');
      const emptyEl = document.getElementById('empty');

      try {
        const response = await fetch('/api/public/programs/' + encodeURIComponent(slug) + '/leaderboard');
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        const data = await response.json();
        
        loadingEl.style.display = 'none';

        if (!data || data.length === 0) {
          emptyEl.style.display = 'block';
          return;
        }

        data.forEach((person, index) => {
          const rank = index + 1;
          const li = document.createElement('li');
          li.className = 'leader-row';
          li.setAttribute('data-rank', rank);
          li.style.animationDelay = (index * 0.1) + 's';

          li.innerHTML = \`
            <div class="rank">#\${rank}</div>
            <div class="name">\${escapeHtml(person.displayName)}</div>
            <div class="score-container">
              <span class="score">\${person.referralCount}</span>
              <span class="score-label">pts</span>
            </div>
          \`;

          listEl.appendChild(li);
        });

      } catch (err) {
        console.error(err);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.innerText = str;
      return div.innerHTML;
    }

    // Initialize
    loadLeaderboard();
  </script>
</body>
</html>`;
}
