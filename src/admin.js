import { escapeHtml } from "./domain.js";

function text(value) {
  return value ? escapeHtml(value) : '<span class="muted">—</span>';
}

export function renderAdmin({ title, backendUrl, programs, attendees, leaderboardsByProgram }) {
  const programMap = new Map();
  for (const p of programs) {
    programMap.set(p.id, p);
    programMap.set(String(p.id), p);
    if (p.public_slug) programMap.set(p.public_slug, p);
  }
  const attendeeRows = attendees.length
    ? attendees.map((attendee) => {
      const program = programMap.get(attendee.program_slug);
      return `<tr>
        <td>${text(program?.name || "Unknown program")}</td><td>${text(attendee.first_name)}</td><td>${text(attendee.last_name)}</td>
        <td><a href="mailto:${escapeHtml(attendee.email)}">${text(attendee.email)}</a></td><td>${text(attendee.preferred_name)}</td>
        <td><code>${text(attendee.owned_referral_code)}</code></td><td><code>${text(attendee.referral_code_used)}</code></td>
        <td><time datetime="${escapeHtml(attendee.created_at)}">${escapeHtml(formatDate(attendee.created_at))}</time></td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="8" class="empty">No accepted signups yet.</td></tr>';

  const programCards = programs.length
    ? programs.map((program) => {
      const leaders = leaderboardsByProgram.get(program.public_slug) || [];
      const publicUrl = `${backendUrl}/api/public/programs/${encodeURIComponent(program.public_slug)}/leaderboard`;
      const webhookUrl = `${backendUrl}/api/webhooks/fillout/${encodeURIComponent(program.public_slug)}`;
      return `<article class="program-card">
        <div class="program-topline"><div><p class="kicker">${program.active ? "ACTIVE PROGRAM" : "PAUSED PROGRAM"}</p><h3>${escapeHtml(program.name)}</h3></div><span class="chip">${leaders.length} ranked</span></div>
        <dl>
          <div><dt>Public identifier</dt><dd><code>${escapeHtml(program.public_slug)}</code></dd></div>
          <div><dt>Fillout webhook</dt><dd><code>${escapeHtml(webhookUrl)}</code></dd></div>
          <div><dt>Loops ID</dt><dd><code>${escapeHtml(program.loops_transactional_id || "None")}</code></dd></div>
          <div><dt>Public leaderboard API</dt><dd><code>${escapeHtml(publicUrl)}</code></dd></div>
        </dl>
        ${renderLeaders(leaders)}
        <form method="post" action="/admin/programs/${encodeURIComponent(program.id)}/rotate-key"><button class="quiet-button" type="submit">Rotate webhook key</button></form>
      </article>`;
    }).join("")
    : '<div class="empty-card"><strong>No programs yet.</strong><p>Create the first event to get its Fillout webhook and one-time API key.</p></div>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} organiser dashboard</title><link rel="stylesheet" href="/admin/styles.css"></head>
<body><a class="skip" href="#main">Skip to dashboard</a>
<header><div><p class="kicker">PRIVATE · ORGANISERS ONLY</p><h1>${escapeHtml(title)} dashboard</h1><p>Create programs, connect Fillout, and review referrals.</p></div><div class="stamp" aria-hidden="true">secrets show<br>once only</div></header>
<main id="main">
  <section class="create-program" aria-labelledby="create-title"><div><p class="kicker">NEW EVENT</p><h2 id="create-title">Create a Beacons program</h2><p>We’ll generate an unguessable public identifier and a separate webhook key.</p></div>
    <form method="post" action="/admin/programs"><label for="program-name">Program or event name</label><div class="form-row"><input id="program-name" name="name" maxlength="120" required placeholder="e.g. KiwiHacks Nova 2027"></div><label for="loops-id">Loops Transactional ID (Optional)</label><div class="form-row"><input id="loops-id" name="loopsTransactionalId" placeholder="e.g. cm1152..."></div><div class="form-row"><button type="submit">Create program</button></div></form>
  </section>
  <section aria-labelledby="programs-title"><div class="section-heading"><div><p class="kicker">PROGRAM-SCOPED</p><h2 id="programs-title">Programs & leaderboards</h2></div><span class="chip">${programs.length} total</span></div><div class="program-grid">${programCards}</div></section>
  <section class="attendees" aria-labelledby="attendees-title"><div class="section-heading"><div><p class="kicker">PRIVATE DETAILS</p><h2 id="attendees-title">Accepted signups</h2></div><span class="chip">${attendees.length} total</span></div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Accepted signups table"><table><thead><tr><th>Program</th><th>First name</th><th>Last name</th><th>Email</th><th>Preferred name</th><th>Owned code</th><th>Code used</th><th>Joined</th></tr></thead><tbody>${attendeeRows}</tbody></table></div>
  </section>
</main><footer>Personal details and program management stay behind Cloudflare Access.</footer></body></html>`;
}

export function renderProgramSecret({ mode, programName, webhookUrl, publicLeaderboardUrl, secret }) {
  const action = mode === "rotated" ? "Webhook key rotated" : "Program created";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(action)}</title><link rel="stylesheet" href="/admin/styles.css"></head>
  <body><main class="secret-page" id="main"><section class="secret-card"><p class="kicker">SHOWING ONCE</p><h1>${escapeHtml(action)}</h1><p><strong>${escapeHtml(programName)}</strong> is ready. Save the webhook key now—it is stored only as a hash and cannot be recovered later.</p>
  <dl class="setup-values"><div><dt>Fillout webhook URL</dt><dd><code>${escapeHtml(webhookUrl)}</code></dd></div><div class="secret-value"><dt>Authorization bearer key</dt><dd><code>${escapeHtml(secret)}</code></dd></div><div><dt>Public leaderboard API</dt><dd><code>${escapeHtml(publicLeaderboardUrl)}</code></dd></div></dl>
  <p class="notice"><strong>Fillout header:</strong> Authorization: Bearer [the key above]</p><a class="button-link" href="/admin">I’ve saved it — return to dashboard</a></section></main></body></html>`;
}

export function renderAdminError({ title, message, status = 400 }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${status} · ${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/styles.css"></head><body><main class="secret-page"><section class="secret-card"><p class="kicker">COULDN'T SAVE</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button-link" href="/admin">Return to dashboard</a></section></main></body></html>`;
}

function renderLeaders(leaders) {
  if (!leaders.length) return '<p class="empty">No confirmed referrals yet.</p>';
  return `<ol class="mini-leaders">${leaders.map((person, index) => `<li><span>${index + 1}</span><strong>${escapeHtml(person.displayName)}</strong><small>${person.referralCount} referral${person.referralCount === 1 ? "" : "s"}</small></li>`).join("")}</ol>`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-NZ", { dateStyle: "medium", timeStyle: "short", timeZone: "Pacific/Auckland" }).format(date);
}
