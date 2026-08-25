# KiwiHacks Beacons MVP

A multi-program referral service with one clear security boundary: only the VPS backend can reach the dedicated Supabase database.

This MVP intentionally does **not** read, import, or migrate `currentdb-DO_NOT_COMMIT.sql`. That file is a retired legacy dump and may contain personal data.

## Architecture

```text
Fillout program A ──program URL + key──┐
Fillout program B ──program URL + key──┼──▶ VPS Node backend ──service role──▶ dedicated Supabase
                                      │         │
                                      │         ├── program-scoped public leaderboard API
                                      │         ├── /admin ◀── Cloudflare Access
                                      │         └── daily database health hook
                                      │
                                      └── each webhook key is stored only as a SHA-256 hash
```

- `src/`: dependency-free Node 22 backend and server-rendered organiser dashboard.
- `supabase/migrations/`: fresh multi-program Beacons schema and atomic database functions.
- `Dockerfile` and `docker-compose.yml`: VPS/Portainer deployment.
- `test/`: validation, credential generation, origin checks, output filtering, and escaping tests.

## Program isolation

Every event/program has:

- a database UUID used only on the private/server side;
- an unguessable public identifier generated from 144 random bits;
- one active webhook bearer key generated from 256 random bits;
- a SHA-256 hash of that key in the database—the original key is never stored;
- its own attendees, referral-code namespace, referral relationships, leaderboard snapshot, webhook URL, and public leaderboard URL.

Email uniqueness and owned-referral-code uniqueness are composite constraints scoped to one program. The same email or readable code may therefore exist independently in two programs. A composite foreign key prevents a referral relationship crossing program boundaries.

The public program identifier is a capability-like locator, not an authentication secret. It avoids guessable event names and accidental discovery, while the separate webhook key authenticates writes. Rotating the webhook key immediately invalidates the old key without changing the public identifier or URLs.

## Privacy and trust boundaries

- Supabase URL and service-role key exist only in the VPS container environment.
- Any future public client must never import a Supabase client or receive database credentials.
- Each public endpoint returns an array whose attendee objects contain **only** `displayName` and `referralCount`.
- Only attendees with at least one confirmed referral in that program appear.
- No public response contains emails, codes, internal IDs, webhook hashes, or referring relationships.
- The organiser dashboard at `/admin` contains personal data and program-management forms. Protect `/admin*` with Cloudflare Access.
- The backend does not implement another identity/login system; Cloudflare Access is the admin authentication layer.
- Prefer a Cloudflare Tunnel or firewall rules so visitors cannot bypass Cloudflare and reach the VPS origin directly.
- Admin create/rotate forms reject browser POSTs whose `Origin` is not listed in `ADMIN_ORIGINS`; privacy layers that send `Origin: null` are accepted only when the `Referer` is an explicitly allowed admin origin.
- Logs deliberately omit attendee names, emails, program identifiers, credentials, and database IDs.

## Organiser workflow

After deployment, an authorised organiser visits `/admin` and enters an event name. The backend:

1. creates an unguessable public program identifier;
2. creates an independent webhook bearer key;
3. hashes the key before sending it to Supabase;
4. creates an empty program-scoped leaderboard snapshot;
5. shows the exact Fillout webhook URL, bearer key, and public leaderboard URL once.

The organiser saves the key into Fillout. Returning to the dashboard cannot reveal it. If it is lost or exposed, “Rotate webhook key” creates a replacement, stores only its hash, and shows the replacement once.

## Signup behaviour

Each generated Fillout endpoint looks like:

```text
POST https://YOUR-BACKEND/api/webhooks/fillout/UNGUESSABLE_PROGRAM_IDENTIFIER
Authorization: Bearer ONE_TIME_PROGRAM_KEY
```

Body:

```json
{
  "firstName": "Alice",
  "lastName": "Example",
  "preferredName": "Ali",
  "email": "alice@example.com",
  "referralCodeUsed": "MIA-80A1C7DD2F10"
}
```

The backend hashes the presented key and calls one PostgreSQL function. That function authenticates the program/hash pair, then:

1. trims and lowercases the email, then checks its uniqueness inside that program (`SEB@x.com` and `seb@x.com` are the same attendee);
2. ignores the complete later submission if that email already exists in the same program;
3. resolves the submitted code through the indexed `(program_id, owned_referral_code)` constraint;
4. creates the attendee and same-program referral relationship atomically;
5. gives the attendee a code made from up to the first four sanitized first-name characters plus a 12-character random hexadecimal suffix;
6. retries if the scoped unique constraint ever detects a suffix collision;
7. regenerates the program's safe JSON leaderboard snapshot in the same transaction.

The random suffix is collision-resistant and database-checked. It is not derived cryptographically from personal data.

Counts are calculated from the attendee records currently in NocoDB, using each attendee's validated `referral_code_used`; there is no mutable referral counter. Every public leaderboard request reads NocoDB again, and every accepted webhook also refreshes that program's in-memory public response cache before returning success. Public responses use `max-age=0, must-revalidate`, so browsers and intermediary caches must check the backend rather than serving an aging response.

## 1. Create the dedicated Supabase data store

Use a clean Supabase project, or a database explicitly isolated for Beacons. In the Supabase SQL editor, run only:

```text
supabase/migrations/202608230001_beacons.sql
```

Do not run the legacy SQL dump.

The migration creates:

- `beacons_programs`, including hashed current webhook key;
- `beacons_attendees`, with program-scoped email/code constraints and same-program referral FK;
- `beacons_leaderboard_snapshots`, one safe JSON response per program;
- a diagnostic `beacons_leaderboard` view;
- `beacons_create_program(...)` and `beacons_rotate_program_secret(...)`;
- `beacons_get_leaderboard_snapshot(...)`, which returns only an active program's safe cached JSON;
- `beacons_accept_signup(...)`, with program authentication, duplicate handling, referral assignment, and snapshot refresh in one transaction;
- `beacons_health_check()`.

Database tables/functions are revoked from Supabase `anon` and `authenticated`. Only the server-side `service_role` can use the Beacons interfaces.

Because this MVP has not been deployed yet, the migration is a clean initial schema rather than an alteration of the earlier single-program draft.

## 2. Configure the backend

On the VPS, copy the example file and fill in real values:

```sh
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Dedicated Beacons Supabase project URL. Server only. |
| `SUPABASE_SERVICE_ROLE_KEY` | Dedicated project service-role key. Server only. |
| `HEALTHCHECK_SECRET` | Independent bearer secret used by Docker/daily scheduler. |
| `PUBLIC_BACKEND_URL` | Canonical HTTPS backend origin used for generated Fillout and leaderboard URLs. |
| `ADMIN_ORIGINS` | Comma-separated exact browser origins allowed to submit admin forms, such as `http://localhost:6969` for an SSH tunnel. |
| `PUBLIC_SITE_ORIGINS` | Optional comma-separated browser origins allowed to read public endpoints. |
| `ADMIN_TITLE` | Optional dashboard heading. |
| `DEBUG_LOGS` | Set to `true` temporarily for secret-free request/origin diagnostics; turn it off after debugging. |

Webhook keys are not environment variables. They are generated per program from the protected dashboard and saved only in that program's Fillout setup.

### Run locally

Node 22 has everything the backend needs; there are no runtime packages to install.

```sh
npm test
npm run check
npm start
```

For local admin form testing, set `PUBLIC_BACKEND_URL=http://localhost:3000`. Without real Supabase credentials, unit and syntax checks run, but database-backed routes correctly report unavailable.

## 3. Deploy with Portainer

The Compose stack binds the container only to VPS loopback at port 3000. Publish it through a reverse proxy or Cloudflare Tunnel.

1. Create a Portainer Stack from `docker-compose.yml`.
2. Enter the `.env.example` values through Portainer's stack environment UI. Docker Compose CLI loads a local `.env` automatically.
3. Deploy and confirm container health becomes green.
4. Route `PUBLIC_BACKEND_URL` to `http://127.0.0.1:3000`.
5. In Cloudflare Zero Trust, create a self-hosted Access application covering `YOUR-BACKEND/admin*`, limited to the organiser identity group.
6. Do not broadly publish `/internal/*`. If proxied, retain the secret requirement and add an allowlist where possible.

The service needs one persistent database, not container storage, so the stack has no volume.

## 4. Create a program and connect Fillout

Visit the Cloudflare-protected dashboard:

```text
GET https://YOUR-BACKEND/admin
```

Create the event and immediately save the one-time key. Fillout's [official webhook guide](https://www.fillout.com/help/webhook) supports custom bodies and verification headers in Advanced view.

Use the generated program-specific webhook URL, then set:

```text
Authorization: Bearer [the generated key]
```

Map the JSON body to the five exact keys shown above. `preferredName` and `referralCodeUsed` may be empty; first name, last name, and email are required.

Expected responses:

- `201` / `created`: new email accepted in that program;
- `200` / `duplicate_ignored`: later submission for that normalized email in the same program;
- `400`: invalid body;
- `401`: unknown/inactive program or incorrect key;
- `503`: temporary database/cache problem, safe to retry.

## 5. Public leaderboard API

The backend exposes a program-scoped public leaderboard endpoint. A future public client can request the program's unguessable public identifier and receive only display names and referral counts. Keep any future client separate from Supabase and do not place database credentials in it.

Review states work without a backend:

- `/?demo=loading`
- `/?demo=empty`
- `/?demo=error`

All attendee content is inserted using `textContent`, never HTML.

## 6. Schedule the daily database health check

Docker checks the database every 30 seconds. Add one independent daily monitor:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer YOUR_HEALTHCHECK_SECRET" \
  https://YOUR-BACKEND/internal/health/db
```

Success is `{"ok":true}`. Schedule it in cron, Uptime Kuma, Better Stack, or another monitor and alert on non-200. Store the key in the scheduler's protected secret field when available.

## Route summary

| Route | Audience | Protection | Scope/output |
| --- | --- | --- | --- |
| `GET /api/public/programs/:publicId/leaderboard` | Everyone with program URL | Unguessable program identifier + origin-aware CORS | That program; only `displayName`, `referralCount` |
| `POST /api/webhooks/fillout/:publicId` | Fillout | Program identifier + program bearer key | One program's five signup fields |
| `GET /admin` | Organisers | Cloudflare Access | All programs, private attendees, scoped leaderboards |
| `POST /admin/programs` | Organisers | Cloudflare Access + same-origin check | Create program; show key once |
| `POST /admin/programs/:id/rotate-key` | Organisers | Cloudflare Access + same-origin check | Replace hash; show new key once |
| `GET /internal/health/db` | Scheduler/container | `HEALTHCHECK_SECRET` | Database readiness only |
| `GET /health/live` | Local infrastructure | None; do not publicly route | Process liveness only |

## Before launch

- Apply the migration to a dedicated project and create two test programs through `/admin`.
- Confirm the same test email can join each program once but cannot join either program twice.
- Confirm a referral code from one program is ignored in the other.
- Rotate one webhook key and confirm the old key receives `401`.
- Verify public JSON contains exactly the two safe attendee fields.
- Confirm the VPS origin cannot bypass Cloudflare Access for `/admin*`.
- Add daily health monitoring and privately save each Fillout key.
- Decide how organisers will privately distribute newly owned referral codes; the MVP creates them and shows them in the organiser dashboard but does not email them.
