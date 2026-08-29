# Agent guide: adding a public leaderboard to a website

This repository is the Beacons backend. It does not contain the Nova/public-site frontend. When asked to add a leaderboard to a site, make the UI change in that site's repository and use the public API documented here. Do not recreate referral counting in the browser or query NocoDB directly.

## Source of truth

1. Ask an organiser for the program's **Public leaderboard API** URL from the Beacons admin dashboard. It has this shape:

   ```text
   https://YOUR-BEACONS-BACKEND/api/public/programs/bp_PROGRAM_IDENTIFIER/leaderboard
   ```

2. Confirm the site's exact browser origin (scheme, hostname, and port) is listed in the backend's `PUBLIC_SITE_ORIGINS`. This is required for browser CORS. Never work around a missing CORS entry with `no-cors` or a public proxy.

3. Fetch the URL with `GET`. It is public and must not receive an authorization header, webhook key, NocoDB token, or other secret.

The successful response is already sorted by referral count descending, with display name as the tie-breaker:

```json
[
  { "displayName": "Ali", "referralCount": 3 },
  { "displayName": "Mia", "referralCount": 1 }
]
```

Only people with at least one valid, same-program referral appear. Treat the response as an untrusted network payload: render names as text, never as HTML. Do not expose or attempt to obtain email addresses, referral codes, database IDs, or signup data.

## Recommended implementation

Follow the target site's existing framework, data-fetching, component, and styling conventions. A framework-neutral fetch helper can be as small as:

```js
export async function getLeaderboard(leaderboardUrl, signal) {
  const response = await fetch(leaderboardUrl, { signal });
  if (!response.ok) throw new Error(`Leaderboard request failed (${response.status})`);

  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("Invalid leaderboard response");

  return value.filter(
    (entry) =>
      entry &&
      typeof entry.displayName === "string" &&
      Number.isInteger(entry.referralCount) &&
      entry.referralCount > 0,
  );
}
```

Pass the URL from the site's public environment/config system when one exists. A public API URL is safe to expose; credentials are not. If the framework supports server-side fetching, it is also valid to fetch there, but do not add private credentials.

The component must have four explicit states:

- **Loading:** use the site's normal loading treatment and avoid a large layout shift.
- **Success:** show an ordered list or table with rank, display name, and referral count. Use “1 referral” and “2 referrals”. Preserve the API order.
- **Empty:** explain that nobody has a referral yet; an empty array is a valid response.
- **Error:** show a friendly unavailable message and, where appropriate, a retry control. Do not show raw stack traces or configuration values.

Use semantic markup (`ol`, or a table with headers), keep keyboard focus visible, and ensure loading/error text is announced with the target site's established accessible status pattern. On component teardown or a superseding request, abort the in-flight fetch when the framework makes that practical.

## Verification before handoff

- Test loading, populated, empty, and failed-request states.
- Confirm names containing `<`, `&`, quotes, and non-ASCII characters render as plain text.
- Confirm a count of `1` uses the singular label and larger counts use the plural.
- Confirm the production site's exact origin receives `Access-Control-Allow-Origin` from the API.
- Confirm the browser request sends no authorization header and the rendered page contains only `displayName` and `referralCount` from the response.
- Confirm the layout works at the site's narrowest supported viewport.
- Run the target site's formatter, typecheck, tests, and build.

For backend behavior, operations, and privacy details, see [README.md](README.md#public-leaderboard-integration). For the Nova handoff, see [NOVA_LEADERBOARD.md](NOVA_LEADERBOARD.md).
