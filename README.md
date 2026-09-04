# KiwiHacks Beacons

[![CI](https://github.com/KiwiHacksNZ/beacons-program/actions/workflows/ci.yml/badge.svg)](https://github.com/KiwiHacksNZ/beacons-program/actions/workflows/ci.yml)

Beacons is a small backend for event signups, referral codes, and privacy-conscious public leaderboards. It was built for KiwiHacks, but the program-scoped API and NocoDB data model can be reused by other event sites.

Fillout sends authenticated signups to Beacons, Beacons stores them in NocoDB, and Loops can email each accepted attendee their referral code. Organisers manage programs and rotate webhook keys through a protected dashboard. The service runs on Node.js 22, has no npm runtime dependencies, and ships as a locked-down Docker container.

## Features

- Program-scoped signup webhooks and referral codes
- Duplicate-signup protection within a single server process
- Public leaderboards that expose only display names and referral counts
- Optional Loops transactional emails
- A private organiser dashboard for programs and webhook-key rotation
- Liveness and authenticated database-readiness endpoints
- Safe, preflighted CSV imports
- Dependency-free Node.js runtime and hardened Docker/Compose configuration

## How it fits together

```text
Fillout ── authenticated webhook ──▶ Beacons ── server token ──▶ NocoDB
                                         │
Nova/public site ◀── leaderboard JSON ───┤
                                         ├──▶ Loops email
Organisers ── Cloudflare Access ────────▶ /admin
Monitor ── independent bearer token ───▶ /internal/health/db
```

Only Beacons should write to the two NocoDB tables. Database credentials, Loops credentials, and webhook-key hashes remain server-side. Public leaderboard responses contain only a display name and referral count.

## Quick start

Prerequisites:

- Node.js 22 or Docker with Compose
- A NocoDB base containing the tables in **NocoDB setup**
- A dedicated NocoDB API token for that base

Clone the repository, create a local configuration, and start the server:

```sh
git clone https://github.com/KiwiHacksNZ/beacons-program.git
cd beacons-program
cp .env.example .env
# Edit .env: use NODE_ENV=development and local HTTP origins where needed.
npm start
```

The npm scripts automatically load `.env` when it exists. Open `http://localhost:3000/health/live` to confirm the service is running. NocoDB-backed routes will not work until the database schema and credentials are configured.

For live reload during development, use `npm run dev`. To run the container instead, complete the configuration and follow **Deployment** below.

### Running with no external services

`npm run dev:memory` starts the server with an in-process store instead of NocoDB, so there is nothing to sign up for and no API keys to set: no `.env` file, no NocoDB base, no Loops key. It picks safe localhost defaults for every other required setting.

```sh
npm run dev:memory
```

Open `http://localhost:3000/admin` to create a program and try signups against its webhook URL. Data lives only in the running process and is gone on restart; Loops emails are skipped since no `LOOPS_API_KEY` is set. This mode is for local development only — `USE_MEMORY_DB=true` must never be set in a deployed environment.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/server.js` | HTTP routes, CORS, health checks, and Loops delivery |
| `src/nocodb.js` | NocoDB access, signup writes, and leaderboard calculation |
| `src/memory-db.js` | In-process store used only by `npm run dev:memory` |
| `src/domain.js` | Validation, credential generation, privacy filtering, and escaping |
| `src/leaderboard-cache.js` | In-memory leaderboard cache and refresh coordination |
| `src/admin.js`, `src/admin.css` | Private organiser dashboard |
| `tools/import-csv.js` | Interactive CSV preflight and importer |
| `test/` | Node.js test suite |
| `AGENTS.md` | Frontend-agent guide for adding a leaderboard to a website |

## Supported deployment model

Beacons is designed for a limited, small-event deployment with one container, one Node.js process, and no other writers to its tables. Its default integrity model is intentionally server-side rather than database-enforced.

Keep these constraints in place:

- do not configure multiple replicas or Node cluster workers;
- do not create or edit program and attendee records directly in NocoDB;
- route every mutation through this service;
- protect `/admin*` at the edge and prevent direct access to the origin; and
- store secrets outside Git and use a base-scoped NocoDB token.

Within one process, signups are serialized per program before referral-code allocation and the NocoDB insert. The service also validates names, email addresses, referral formats, program scope, and webhook credentials.

Known limitations accepted by this deployment profile:

- database `NOT NULL`, composite uniqueness, checks, and foreign keys are not relied upon;
- the readiness endpoint verifies schema shape and connectivity, not indexes or relational constraints;
- Loops email delivery has no durable retry queue; and
- the application trusts Cloudflare Access for admin authentication and must not have a bypassable origin.

If the service is ever horizontally scaled or another writer is introduced, first add PostgreSQL composite unique indexes on:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS attendees_program_email_uidx
  ON attendees (program_slug, email_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS attendees_program_owned_code_uidx
  ON attendees (program_slug, owned_referral_code);
```

Database foreign keys and format checks are also worthwhile defence in depth, but they are not required for the documented single-writer deployment.

## Route exposure

Use these paths when configuring the reverse proxy, Cloudflare Access, rate limits, and monitoring:

| Route | Methods | Audience | Authentication |
| --- | --- | --- | --- |
| `/health/live` | `GET` | Public monitor/container | None; liveness only |
| `/internal/health/db` | `GET` | Private monitor | Independent bearer secret |
| `/api/public/programs/:slug/leaderboard` | `GET`, `OPTIONS` | Public sites | None; browser origins are restricted by CORS |
| `/api/webhooks/fillout/:slug` | `POST` | Fillout | Program-specific bearer key |
| `/admin*` | `GET`, `POST` | Organisers | Cloudflare Access at the edge; same-origin checks on mutations |
| `/admin/attendees/:id/referral-codes` | `POST` | Organisers | Cloudflare Access at the edge; same-origin checks on mutations |

Every other route returns `404`. The CORS allowlist controls which browser pages may read the leaderboard; it does not make the endpoint private to non-browser clients. Do not put Cloudflare Access in front of the Fillout webhook or public leaderboard. Do not expose the admin or internal routes through an alternate hostname that bypasses the protected ingress.

## NocoDB setup

Create a base containing the following tables. Field names are case-sensitive to the API.

### `programs`

| Field | NocoDB type | Application requirement | Default and rules |
| --- | --- | --- | --- |
| `Id` | ID | Yes | NocoDB primary key |
| `name` | Single line text | Yes | Maximum 120 characters |
| `public_slug` | Single line text | Yes | Enable **Unique values only** |
| `webhook_secret_hash` | Single line text | Yes | Written by the service |
| `loops_transactional_id` | Single line text | No | Leave the default blank |
| `active` | Checkbox | Yes | Default `true` |

### `attendees`

| Field | NocoDB type | Application requirement | Default and rules |
| --- | --- | --- | --- |
| `Id` | ID | Yes | NocoDB primary key |
| `program_slug` | Single line text | Yes | Program scope |
| `first_name` | Single line text | Yes | Maximum 100 characters |
| `last_name` | Single line text | Yes | Maximum 100 characters |
| `preferred_name` | Single line text | No | Leave the default blank |
| `email` | Email or single line text | Yes | Stored lowercase |
| `email_normalized` | Single line text | Yes | Duplicate-check value |
| `owned_referral_code` | Single line text | Yes | Generated by the service |
| `referral_code_used` | Single line text | No | Leave the default blank |
| `additional_referral_codes` | Long text | No | Leave the default blank |

In NocoDB, a blank default means “no default”; optional values sent by the service are stored as database `NULL`. Do not enter the literal text `NULL` as a default. Do not mark `email_normalized` or `owned_referral_code` individually unique: their intended uniqueness is scoped to one program.

`additional_referral_codes` holds every extra code an attendee owns beyond `owned_referral_code`, as a comma-separated list (e.g. `FRIEND-CODE,VIP-INFLUENCER`). Organisers can add a code from the admin dashboard (auto-generated, or a custom one they type in) or edit this column directly in NocoDB — the service treats both the same way. A referral made with any of an attendee's codes, owned or additional, counts toward that attendee's single leaderboard total. Codes must be unique within a program across both columns; the admin dashboard and signup path both enforce this.

Matching is always case-insensitive, no matter which case a code is stored or submitted in — this includes a code hand-typed directly into NocoDB in lowercase. This is compared in application code rather than left to the database, since a `where`-clause filter would push the comparison down to NocoDB's underlying SQL engine, and plain case-sensitive equality/`LIKE` is the default on most of the databases NocoDB can run on.

This column is optional and additive: it is not in the schema check the health endpoint runs, and the service detects its presence once per process and caches the result. An existing base that hasn't added it yet keeps working exactly as before (one code per attendee, no extra requests sent); the admin dashboard just shows a clear error if you try to add a second code before the column exists. Add the column in NocoDB whenever you're ready, then restart the service once so it picks up the change.

Marking the required fields as **Not Null** and enabling **Unique values only** for `public_slug` are recommended defence in depth. They are not a substitute for the composite indexes required before multiple writers or replicas are allowed.

Use a dedicated NocoDB API token restricted to this base. The service needs table metadata plus record read/write access.

## Configuration

Copy `.env.example` to `.env` for local Compose deployment, or add the same values as protected stack variables in Portainer. Never commit `.env`.

| Variable | Required | Description |
| --- | --- | --- |
| `NOCODB_URL` | Yes | NocoDB HTTP(S) origin |
| `NOCODB_API_TOKEN` | Yes | Dedicated server-side API token |
| `NOCODB_PROJECT_ID` | Yes | Base ID containing both tables |
| `HEALTHCHECK_SECRET` | Yes | Independent random secret of at least 32 characters |
| `PUBLIC_BACKEND_URL` | Yes | Canonical public origin; HTTPS is required in production |
| `ADMIN_ORIGINS` | No | Comma-separated origins allowed to submit admin forms; defaults to the backend origin |
| `PUBLIC_SITE_ORIGINS` | No | Comma-separated browser origins allowed to call the leaderboard API |
| `LOOPS_API_KEY` | No | Required only when a program has a Loops transactional ID |
| `LEADERBOARD_CACHE_TTL_MS` | No | Cache duration from 1–300 seconds; default `30000` |
| `ADMIN_TITLE` | No | Private dashboard heading |
| `DEBUG_LOGS` | No | Secret-free diagnostic events; normally `false` |
| `PORT` | No | Listening port; default `3000` |
| `USE_MEMORY_DB` | No | Local development only; `true` replaces NocoDB with an in-memory store (see **Running with no external services**) and makes `NOCODB_*` unnecessary. Never set in production. |

Generate secrets with a cryptographically secure password manager or secret generator. Startup fails when required variables are missing, a URL is invalid, the health secret is too short, or production is configured without HTTPS.

For an actual browser leaderboard, `PUBLIC_SITE_ORIGINS` is operationally required even though the server can start without it. For Loops delivery, both `LOOPS_API_KEY` and a program-level transactional ID are required. Use exact origins such as `https://beacons.kiwihacks.com`, without paths or wildcards.

Keep production values in the host or deployment platform's protected secret store. Restrict read access, exclude them from support bundles and screenshots, and never reuse the health secret as a webhook key. Before the first deployment, record an owner and rotation process for the NocoDB token, Loops key, health secret, and Cloudflare configuration.

## Development and verification

Node.js 22 is required when running outside Docker.

```sh
npm test
npm run check
docker compose --env-file .env.example config --quiet
docker build --tag beacons:local .
```

The GitHub Actions workflow runs these checks on every push and pull request.

When changing behavior, add or update tests in `test/`. Keep the runtime dependency-free unless a dependency provides a clear security or maintenance benefit.

## Deployment

The included Compose service builds the application, runs it as the unprivileged `node` user, drops Linux capabilities, uses a read-only filesystem, rotates container logs, and binds the host port only on `127.0.0.1`.

Before deploying:

1. Back up NocoDB/PostgreSQL and confirm the latest restore rehearsal is still valid.
2. Deploy a reviewed commit or protected release tag; record its commit SHA in the change log.
3. Confirm the production `.env` or Portainer variables match the configuration table above.
4. Run every command in **Development and verification** on that exact commit.

For Docker Compose:

```sh
cp .env.example .env
# Fill in .env with production values.
docker compose config --quiet
docker compose build --pull
docker compose up --detach
docker compose ps
docker compose images
```

Run `cp` only during first-time setup: never overwrite an existing production `.env`. Inspect the rendered `docker compose config` securely and do not paste its output into tickets or logs because it contains secrets. Record the deployed image ID from `docker compose images` so the release can be identified during an incident.

For Portainer, deploy the repository as a Git-backed stack and enter the `.env.example` keys in the stack environment editor. Do not paste secrets into the Compose file or repository. Keep the replica count at one, deploy a reviewed commit or release tag, and disable uncontrolled automatic updates.

Route the hostname to `http://127.0.0.1:3000` through a host reverse proxy or an appropriately configured Cloudflare Tunnel. If the tunnel runs in another container, give it an explicit route to the host-bound service rather than publishing Beacons on all interfaces.

Configure Cloudflare to:

1. protect `/admin*` with an Access application restricted to organisers;
2. prevent public traffic from bypassing the tunnel and reaching the VPS origin;
3. preserve `Origin` and `Referer` headers for admin CSRF checks;
4. rate-limit `/api/webhooks/*`, `/api/public/*`, and `/admin/*`; and
5. restrict `/internal/*` to the monitoring path that needs it.

Allow `OPTIONS` requests to the leaderboard route and do not cache admin, webhook, health, or error responses at the edge. Forward the original `Origin` and `Referer` headers unchanged. Terminate TLS only at trusted infrastructure, keep the origin private, and use the canonical external HTTPS origin for `PUBLIC_BACKEND_URL` and `ADMIN_ORIGINS`.

After each deployment:

1. Confirm `docker compose ps` reports the service as healthy.
2. Call public liveness and authenticated database readiness as shown below.
3. Open `/admin` through Cloudflare Access and confirm direct-origin access is impossible.
4. From an allowed site origin, fetch one known program's leaderboard and inspect the CORS response.
5. Submit a synthetic signup to a dedicated non-production program, then submit the same normalized email again. Expect `201` followed by `200`.
6. Confirm a referral code from another program is ignored, the leaderboard contains no private fields, and any configured Loops message arrives.
7. Review `docker compose logs --tail=100 beacons` for the alert events below without enabling debug logs.

Do not direct production traffic to a new release until all seven checks pass.

For an application rollback, redeploy the previous reviewed commit or release tag and repeat the health checks. Application rollback does not reverse database records; recover data only through the tested NocoDB/PostgreSQL backup procedure.

## Health checks and operations

Container liveness is available without authentication:

```sh
curl --fail --silent --show-error \
  https://YOUR-BACKEND/health/live
```

Expected response: `{"ok":true}`. Liveness proves only that the Node.js HTTP process can answer; do not use it as database readiness.

Database readiness requires the independent health secret:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer YOUR_HEALTHCHECK_SECRET" \
  https://YOUR-BACKEND/internal/health/db
```

Expected response:

```json
{"ok":true}
```

The readiness check confirms that both tables have the expected columns and can be read. It does not validate PostgreSQL indexes or constraints. Alert after repeated readiness failures, but keep liveness and readiness as separate monitors so a temporary NocoDB outage does not cause a container restart loop.

During an active event, take automated database backups at least daily and before a deployment, schema change, CSV import, or bulk operation. Store backups outside the application host, encrypt them, restrict access, define retention and deletion periods for attendee data, and test a restoration on a separate instance. The event owner must choose and document an acceptable recovery point objective (RPO) and recovery time objective (RTO).

Alert on these structured log events:

- `request_failed`
- `leaderboard_refresh_failed`
- `loops_email_failed`
- `server_shutdown_failed`

Loops delivery happens after the attendee is saved. A Loops failure does not cause Fillout to retry the signup, and there is no durable email outbox, so `loops_email_failed` needs an organiser recovery process.

| Signal | First response |
| --- | --- |
| Readiness failure or `request_failed` | Check NocoDB reachability, token validity, and schema; pause imports and avoid retries that could amplify an outage. |
| `leaderboard_refresh_failed` | Verify NocoDB, then request the public leaderboard; the next uncached read retries the refresh. |
| `loops_email_failed` | Confirm the Loops key and transactional ID, then use the organiser's approved manual resend process. The signup is already stored. |
| `server_shutdown_failed` or unhealthy container | Preserve logs, inspect the termination cause, and roll back to the last known-good release if the current release is implicated. |

Logs go to standard output as structured JSON and are rotated by Compose. Ship them to durable central logging if the host is ephemeral. Never enable `DEBUG_LOGS` routinely in production.

## Secret rotation

- **Program webhook key:** rotate it from `/admin`, save the new key immediately, update Fillout, and send a test submission. The previous key stops working as soon as rotation completes.
- **NocoDB or Loops token:** issue a new token, update the protected deployment variable, redeploy, verify readiness and the affected integration, then revoke the old token.
- **Health-check secret:** update the service and private monitor in a coordinated maintenance window, redeploy, verify the monitor, then remove the old value from the secret store.
- **Suspected compromise:** rotate the affected credential immediately, preserve audit evidence, review access and application logs, and check stored data for unauthorized changes. A public program slug is an identifier, not an authentication secret.

## Safe CSV imports

The tracked importer accepts Fillout-style CSV exports without logging attendee names, emails, or referral codes. It performs a read-only preflight by default, validates every row before writing, detects duplicate emails and owned referral codes, and orders rows so an imported referrer exists before a referred attendee. Malformed or unresolved used referral codes are imported as blank. A malformed owned referral code is replaced with a newly generated valid code; the preflight summary reports both kinds of cleanup.

Required CSV headers are `First Name (legal)`, `Last Name (legal)`, and `Email Address`. Optional headers are `Preferred Name`, `Referral Code`, and `Owned Referral Code`; unrelated export columns are ignored.

Run the preflight from a secured workstation. The command loads `.env` when present, while already-exported environment variables take precedence:

```sh
npm run import:csv -- path/to/attendees.csv
```

If preflight passes, stop the Beacons container so the importer becomes the only database writer, then run:

```sh
npm run import:csv -- path/to/attendees.csv --commit
```

The write requires an exact interactive confirmation. It is sequential, does not send Loops emails, and stops on the first database failure. A retry is safe: attendees already written are skipped by normalized email. CSV files remain ignored by Git and should be deleted securely after the import and backup window.

The importer is intentionally excluded from the production container. Run it from a secured operator workstation, and restart Beacons only after the import reports completion.

## Organiser workflow

Open `/admin` through Cloudflare Access. Create a program with an optional Loops Transactional ID and immediately save the generated webhook key; only its SHA-256 hash is stored, so the original key cannot be recovered. Rotating the key invalidates the previous key without changing the program URLs.

Configure Fillout to send:

```http
POST https://YOUR-BACKEND/api/webhooks/fillout/bp_PROGRAM_IDENTIFIER
Authorization: Bearer bk_PROGRAM_KEY
Content-Type: application/json
```

```json
{
  "firstName": "Alice",
  "lastName": "Example",
  "preferredName": "Ali",
  "email": "alice@example.com",
  "referralCodeUsed": "MIA-80A1C"
}
```

`firstName`, `lastName`, and `email` are required. `preferredName` and `referralCodeUsed` may be empty. Referral codes accept ASCII letters, numbers, `_`, and `-` and are normalized to uppercase. The webhook always auto-generates the signup's own code; to assign a custom one, use the admin dashboard or NocoDB directly after the signup lands (see **Organiser workflow** and the `additional_referral_codes` notes above).

New owned referral codes use three normalized characters from the legal first name followed by a five-character hash fragment, for example `SEB-9DDE1`. Code allocation is serialized per program and regenerates the hash fragment when an existing code is found.

Webhook outcomes:

| Status | Meaning |
| --- | --- |
| `201` | Signup created |
| `200` | Duplicate normalized email ignored within this program |
| `400` | Invalid JSON or field value |
| `401` | Unknown/inactive program or incorrect webhook key |
| `415` | Incorrect content type |
| `503` | Temporary NocoDB failure; the webhook may be retried |

Fillout retries must be bounded and use backoff. A retry after a stored signup returns `200` with `duplicate_ignored`, so normal retries do not create a second attendee in the supported single-process deployment.

## Public leaderboard integration

Agents and frontend developers should follow the implementation and verification checklist in [`AGENTS.md`](AGENTS.md). The API contract is summarized below.

Nova or another allowed browser origin can request:

```http
GET https://YOUR-BACKEND/api/public/programs/:program-slug/leaderboard
```

No authorization header is required. Add the frontend origin to `PUBLIC_SITE_ORIGINS` so the browser receives the correct CORS header.

```js
const response = await fetch(
  "https://YOUR-BACKEND/api/public/programs/bp_PROGRAM_IDENTIFIER/leaderboard",
);

if (!response.ok) throw new Error("Leaderboard unavailable");
const leaderboard = await response.json();
```

Example response:

```json
[
  { "displayName": "Ali", "referralCount": 3 },
  { "displayName": "Mia", "referralCount": 1 }
]
```

Only attendees with at least one valid same-program referral appear. The response never includes email addresses, raw referral codes, program secrets, or database IDs. Results are cached for `LEADERBOARD_CACHE_TTL_MS` and refreshed after an accepted signup.

Leaderboard outcomes are `200` for an array, `404` for an invalid, unknown, or inactive program, and `503` when NocoDB is temporarily unavailable. Clients must treat an empty `200` array as a valid empty state.

## Contributing

Issues and pull requests are welcome. For a substantial change, open an issue first so the approach and data-model impact can be discussed.

Before submitting a pull request:

1. Keep the change focused and preserve the single-writer deployment model unless the proposal explicitly replaces it.
2. Add tests for new behavior and regression tests for bug fixes.
3. Run `npm test`, `npm run check`, Compose validation, and the container build.
4. Describe any privacy, authentication, database-schema, migration, or deployment impact in the pull request.
5. Never include real attendee data, API tokens, webhook keys, database dumps, or `.env` files in issues, fixtures, commits, or logs.

The codebase intentionally favors small platform APIs over dependencies. Please explain why a new runtime dependency is preferable to a short, maintainable local implementation.

## Security

- Program URLs use random 144-bit identifiers; webhook keys use independent 256-bit secrets.
- Only webhook-key hashes are stored.
- Logs intentionally omit names, emails, program identifiers, credentials, upstream response bodies, and NocoDB filter paths.
- Admin authentication is delegated to Cloudflare Access; do not expose `/admin` through an unprotected origin.
- CSV exports, database dumps, diagnostic scratch scripts, and local handoff notes are intentionally ignored by Git. The reviewed importer is tracked separately under `tools/`.

Do not report an undisclosed vulnerability in a public issue. Use GitHub's private vulnerability reporting for this repository when it is available, or contact a KiwiHacks maintainer privately. Include the affected commit, reproduction steps, impact, and any suggested mitigation, but do not include real attendee data or production credentials.

## License

No license file is currently included. Until the maintainers choose and add an [OSI-approved license](https://opensource.org/licenses), default copyright rules apply and this repository should not be described as open source. Selecting a license is the remaining legal step before an open-source release.
