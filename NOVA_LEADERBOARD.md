# Nova Website Leaderboard Integration Guide

This guide is for any developer or AI agent working on the frontend of the Nova website to integrate the Beacons public leaderboard, as well as instructions on configuring the Fillout webhook.

## 1. Fetching the Leaderboard

To display the leaderboard on the Nova website, you need to make a `GET` request to the Beacons public API.

**Endpoint:**
```http
GET https://beacons-infra.kiwihacks.com/api/public/programs/:program-slug/leaderboard
```
*(Replace `:program-slug` with the unguessable public identifier generated in the Beacons Admin dashboard).*

**Example Response (200 OK):**
The API returns a JSON array of attendees, already sorted by `referral_count` (descending). Attendees with zero referrals are automatically excluded for privacy.
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

**Notes for Frontend Developers:**
- You do **not** need to send any Authorization headers for this endpoint.
- CORS is explicitly allowed for `https://beacons.kiwihacks.com`, so you can `fetch()` this directly from the browser without running into cross-origin blocks.
- **Privacy:** Only `displayName` and `referralCount` are exposed. No emails or raw referral codes are ever returned by this endpoint.

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
  "referralCodeUsed": "KIWI-A1B2C"
}
```

**Field Details:**
- `firstName` (String, required)
- `lastName` (String, required)
- `email` (String, required)
- `preferredName` (String, optional)
- `referralCodeUsed` (String, optional) - The code they entered in the "Who referred you?" box.

Once Fillout sends this payload, the backend will verify the token, create the NocoDB record, assign a newly generated referral code, and trigger the Loops welcome email!
