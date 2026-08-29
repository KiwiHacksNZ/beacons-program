# Nova website integration guide

This is the Nova-specific handoff for the Beacons public leaderboard and Fillout webhook. Agents implementing the leaderboard should first follow the complete UI and verification checklist in [AGENTS.md](AGENTS.md), then use the Nova values below.

## 1. Fetching the Leaderboard

To display the leaderboard on the Nova website, you need to make a `GET` request to the Beacons public API.

Copy the exact **Public leaderboard API** URL from the program card in the Beacons admin dashboard. Its production shape is:

```http
GET https://beacons-infra.kiwihacks.com/api/public/programs/:program-slug/leaderboard
```

Replace `:program-slug` with the program's `bp_...` identifier. Do not use a webhook URL or webhook key in the frontend.

**Example Response (200 OK):**
The API returns a JSON array of attendees, already sorted by `referralCount` (descending). Attendees with zero referrals are automatically excluded for privacy.
```json
[
  {
    "displayName": "Ali",
    "referralCount": 5
  },
  {
    "displayName": "John",
    "referralCount": 2
  }
]
```

**Notes for frontend developers:**
- You do **not** need to send any Authorization headers for this endpoint.
- Ensure Nova's exact production origin is present in the backend's `PUBLIC_SITE_ORIGINS`; the browser can then `fetch()` this endpoint directly.
- **Privacy:** Only `displayName` and `referralCount` are exposed. No emails or raw referral codes are ever returned by this endpoint.
- An empty array is a successful response: show an intentional “no referrals yet” state.
- Handle loading and failure states as well as the populated list. Preserve the order returned by the API and render `displayName` as text, never HTML.

---

## 2. Fillout Webhook Configuration

When a user submits the signup form, Fillout must be configured to send a webhook to the Beacons backend.

**Webhook URL:**
```http
POST https://beacons-infra.kiwihacks.com/api/webhooks/fillout/:program-slug
```

**Authentication:**
In Fillout's Webhook settings (Advanced mode), add the following Header:
```http
Authorization: Bearer <the-webhook-secret-key-from-admin-dashboard>
```

**JSON Payload Body:**
Map your Fillout form fields to construct this exact JSON body:
```json
{
  "firstName": "Alice",
  "lastName": "Example",
  "preferredName": "Ali",
  "email": "alice@example.com",
  "referralCodeUsed": "KIWI-A1B2C3D4E5F6"
}
```

**Field Details:**
- `firstName` (String, required)
- `lastName` (String, required)
- `email` (String, required)
- `preferredName` (String, optional)
- `referralCodeUsed` (String, optional) - The code they entered in the "Who referred you?" box.

Once Fillout sends this payload, the backend will verify the token, create the NocoDB record, assign a newly generated referral code, and trigger the Loops welcome email!
