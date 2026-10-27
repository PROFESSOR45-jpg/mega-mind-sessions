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
npm start      # Node 18+
npm test       # linking-flow tests (fake Baileys, no WhatsApp needed)
```

Optional env vars: `PORT`, `BOT_TITLE`, `BOT_TAGLINE`, `OWNER_NAME`,
`DATA_DIR` (where `sessions/` and `records/` live), `MAX_LIVE_SOCKETS`.

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

## What changed in 3.1 (why linking used to fail)

- **DM copy button.** After linking, the plain-text session DM is followed by a
  *Copy SESSION_ID* button (`cta_copy`). If the client doesn't render buttons,
  a `MEGA-MIND-SESSION.txt` attachment is sent instead — the session is always
  copyable from the chat.
- **Pairing codes were rejected instantly ("Couldn't link device").** The
  Baileys `browser` tuple is `[OS, browser, version]`, and the old code put
  `MEGA MIND` in the OS slot. WhatsApp rejects companion registration from an
  unknown platform even though QR linking still works. The tuple is now
  `['Ubuntu', 'Chrome', '22.04.4']` and must stay identical in the bot's
  `index.js` / `lib/getSessionLocal.js`.

- **QR never linked.** The server waited for `creds.registered === true` after
  the connection opened. Baileys 7 only ever sets that flag on the
  pairing-code path, so QR sessions timed out with "never finished confirming".
  A finished link is now detected through `creds.account` (set on
  `pair-success`), and the exported session is marked `registered: true`.
- **Pairing retries reused half-registered creds.** After a dropped connection
  the next attempt reused keys that already had the phone number written in by
  `requestPairingCode`, which WhatsApp rejects. Retries before pairing now start
  from clean keys and issue a fresh code.
- **Post-scan restart (code 515)** is the normal next step after a successful
  link; it is now handled as such and no longer eats into the retry budget.
- **Duplicate sockets.** The `companion_reg_refresh` handler and "Get a new
  code" could leave two live sockets racing; superseded sockets are now
  retired so their close events can't restart anything.
- **Baileys 7 is ESM-only.** It's loaded with `import()` so the server starts
  on Node 18/20, not just very recent Node versions.
- **Leaks.** Closing/refreshing the browser mid-link now frees the WhatsApp
  socket and pending record; generator keys are wiped from disk after hand-off.
- Per-IP start throttle and a global live-socket cap.
