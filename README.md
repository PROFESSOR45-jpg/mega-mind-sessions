# MEGA MIND — Session Server

Standalone service that lets a person link their WhatsApp account (via QR code
or pairing code) and produces a `SESSION_ID` the MEGA MIND bot can use to log
in. It does **not** contain any bot/command logic — its only job is linking
and handing off sessions.

## Why it's separate from the bot

- You can redeploy or restart the bot without forcing every user to re-link.
- One session server can serve session-linking for any number of bot
  instances/deployments.
- Keeps the bot's dependency footprint (and attack surface) smaller.

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3000` (or your deployed URL) and link via QR or
pairing code. You'll be shown a `SESSION_ID` — this is the only thing the bot
needs from this service.

## How the bot links to this service

The bot reads `SESSION_SERVER_URL` (see the bot's `.env`) and, once a session
has been linked here, can fetch it via:

```
GET {SESSION_SERVER_URL}/session/:sessionId
```

Response once linked:

```json
{
  "status": "connected",
  "sessionId": "MM_xxxxxxxxxxxx",
  "session": "MEGA~<base64 creds>",
  "user": { "id": "2547...@s.whatsapp.net", "name": "..." },
  "connectedAt": 1719500000000
}
```

While still pending: `{ "status": "pending" }`. If the session has expired or
was never created: `404 { "status": "not_found" }` or
`410 { "status": "expired" }`.

In practice, most people will just **copy the `SESSION_ID` shown after
linking and paste it directly into the bot's `SESSION_ID` environment
variable** — the REST endpoint above exists for setups that want the bot to
fetch it automatically by session ID instead of pasting it by hand.

Sessions are kept on disk for **1 hour** after a successful link, then
auto-deleted. Link again any time to get a fresh one.

## Endpoints

| Method | Path                  | Purpose                                  |
|--------|-----------------------|-------------------------------------------|
| GET    | `/session/:id`        | Fetch a finished session (used by bot)    |
| GET    | `/status/:id`         | Lightweight status check                  |
| DELETE | `/session/:id`        | Revoke/remove a session early             |
| GET    | `/health`             | Liveness check                            |

## Deploying

Works on Render, Railway, or any standard Node host. Just needs:
- Node 18+
- A persistent disk if you want session records to survive restarts within
  the 1-hour TTL (not required — losing them just means users re-link)
