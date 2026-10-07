# SNG ONE — Telegram bot

A companion process for [SNG ONE](https://github.com/AbdulloxAbdujalilov9999/sng-loadboard), the
freight loadboard for CIS/Eurasia. It connects that app to Telegram and is not useful on its own:
it shares the loadboard's PostgreSQL database and talks to its HTTP API.

- **Link an account**: `/link your@email.com yourPassword` (DM only) signs in with the same e-mail +
  password the web app uses (Firebase Auth), so posting from Telegram obeys the exact same rules
  (quotas, required fields, approval status) as posting from the browser.
- **Post from Telegram**: `/postload` walks through a few questions and ends with the same
  `POST /api/loads` call the web app makes - the load shows up on the web board immediately.
- **Broadcast everywhere**: add the bot to any group/channel and it posts every new load there
  automatically, the moment it is created - whether that load came from the web app or from
  `/postload` here. One `loads` table, one event, one broadcaster: there is no special "Telegram
  path" for a load to take. Each broadcast message carries its own link back to that exact load on
  the web board (`https://.../?load=<id>` - works for anyone with board access, opens a read-only
  detail view; see "Deep links" below).
- **English, Russian, Uzbek**: the same three languages the web app offers (`src/i18n.js`).
  Auto-detected from Telegram's own client language on first contact; `/language` switches it.
  Groups get one fixed language for broadcasts (`BOT_BROADCAST_LANG`, since a group mixes people),
  while every DM follows that person's own choice.

## How it works

```
Telegram  ──/link, /postload──▶  this bot  ──HTTPS (member's own ID token)──▶  loadboard API ──▶ Postgres
                                     │                                                               │
                                     └────────────────── LISTEN sng_events (every insert) ◀──────────┘
                                     │
                                     ▼
                            every linked group/channel
```

The bot never duplicates the loadboard API's business logic. `/link` exchanges the member's
e-mail+password for a Firebase ID token exactly as the web sign-in form does, then stores the
*refresh token* (encrypted - see `src/crypto.js`) so it can mint a fresh ID token on demand.
`/postload` and the broadcaster both end up calling the real HTTP API or reading the real `loads`
table - the same source of truth the web app uses.

Broadcasting listens directly on the same Postgres `LISTEN sng_events` channel the API's own event
hub uses, but as its **own** connection: the API coalesces bursts into one "something changed"
frame per second for browsers (they just re-fetch), which would lose individual loads. This bot
instead reacts to every single insert and posts it.

### Deep links

`GET /api/loads/:id` on the loadboard API returns one load by id. The web app reads a `?load=<id>`
query parameter once on sign-in, fetches that load and shows it in a read-only modal - so every
link this bot sends is a real, working, load-specific URL, not just a link to the homepage. A
closed/removed load shows "no longer available" instead of an error. The link is built from
`PUBLIC_WEB_URL` + `/?load=` + the load's id - see `src/broadcaster.js` and the `confirm:post`
handler in `src/wizard.js` (the poster gets the same link as everyone else).

## Setup

This bot needs the [sng-loadboard](https://github.com/AbdulloxAbdujalilov9999/sng-loadboard) API
already running (it supplies the database schema, including the `006_telegram.sql` migration in
this repo's `migrations/` folder, applied automatically when that app boots).

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram → copy the token.
2. `cp .env.example .env` and fill it in (see `.env.example` for the full list) - at minimum:
   ```
   TELEGRAM_BOT_TOKEN=...
   DATABASE_URL=...                          # same database the loadboard API uses
   API_BASE_URL=http://127.0.0.1:8080        # or wherever that API is reachable from here
   PUBLIC_WEB_URL=                           # only if it differs from API_BASE_URL
   BOT_ENCRYPTION_KEY=...                    # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
3. `npm install && npm start` (or `npm run dev` to restart on file changes).
4. In Telegram: DM the bot `/link your@email.com yourPassword`, then try `/postload`. Add it to a
   group to start broadcasting there.

### Docker

```bash
docker build -t sng-loadboard-bot .
docker run --env-file .env sng-loadboard-bot
```

### Render

Two ways to deploy, both end up with the same thing (a Background Worker, since this process has
no HTTP server):

- **Blueprint** (easiest): New + → Blueprint → pick this repo → leave the Blueprint path as the
  default (`render.yaml`, already at the repo root). It will ask for the secrets marked
  `sync: false` in [`render.yaml`](render.yaml): `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`,
  `API_BASE_URL`, `PUBLIC_WEB_URL`, `BOT_ENCRYPTION_KEY`.
- **Manual**: New + → Background Worker → pick this repo, runtime **Docker**, and set the
  environment variables from `.env.example` yourself.

Either way: `DATABASE_URL` must be the same Postgres instance as the loadboard API's Render
service (copy its "External Database URL" from that service's database page), `API_BASE_URL` is
that API service's Render-internal address, and `PUBLIC_WEB_URL` is its **public** `https://`
address (not the internal one) - that's what makes the "view this load" links actually open.

## Security notes

- `/link` only works in a private chat; the bot deletes the message containing the password
  (best-effort - Telegram lets a bot delete its own chat's messages).
- Passwords are never stored or logged - only the Firebase refresh token, and only encrypted
  (AES-256-GCM, key from `BOT_ENCRYPTION_KEY`, never committed, never sent to Telegram).
- `/postload` is DM-only too, since it may ask for contact details.
- Broadcasting a load's contact phone/e-mail/Telegram to every group the bot is in is **by
  design** - it is exactly the public contact info a member already chose to publish on their
  load (the same fields the web board shows every approved member), broadcast the way freight
  groups already work. If you want a group that should NOT receive broadcasts, remove the bot
  from it.

## Things to know

- **Who can `/link`**: only members who have an e-mail **password** on the web app. Members who
  sign in with Google, or with a phone number, have none: they open *Account → Sign-in & Security
  → "Email me a link to set a password"* first (the bot's `/link` help says so, in all three
  languages). The e-mail must also be **confirmed** - an unconfirmed address gets its own "confirm
  your e-mail first" reply. The safer design for later is a one-time link code generated in the
  web app (*Account → Connect Telegram*) instead of a password - see the main repo.
- **Passwords travel through Telegram.** Telegram bot chats are not end-to-end encrypted, so
  `/link` sends the web password through Telegram's servers (the bot deletes the message and never
  stores or logs the password itself). Acceptable for a start, not for the long run.
- **Rate limits**: every bot user posts from this bot's one server address, so the loadboard API's
  write limit is counted **per member**, not per IP; the general per-IP limit still covers the bot
  as a whole - raise it on the API side if many people use the bot.
- **Telegram throttling**: Telegram allows ~20 messages a minute per group. When it answers `429`,
  the broadcaster waits the `retry_after` it is given and tries again (up to 4 times), so a 40-load
  AI import is delivered, just more slowly. Chats that no longer exist (`400 chat not found`) are
  dropped from the list.
- **`PUBLIC_WEB_URL`** must be your site's public `https://` address in production. If it is
  missing or internal (`localhost`, `http://sng-one:10000`), the broadcaster **leaves the "view
  this load" link out** instead of sending a dead one, and logs a warning at start-up.
- **Rate `0` / `-`** in `/postload` means "negotiable", like on the web board.

## Limitations

- One bot process = one Telegram "worker". If you need many thousands of broadcast chats, shard
  the chat list across multiple bot instances (the `LISTEN` fan-out already scales; only
  Telegram's own per-bot rate limit would need spreading across bots).
- `/postload` asks one field at a time in whichever of English/Russian/Uzbek the person has
  chosen; the web app's AI paste-import is not duplicated here on purpose - link, then use the
  richer web UI for anything beyond a quick post.
- No `/requestaccess` flow: a Telegram user must first sign up and request access on the web app;
  `/link` only works once an owner has approved them there.

## Tests

```bash
npm test
```

Pure unit tests only (crypto, i18n, message formatting, broadcaster retry/dead-chat logic) - no
database or live Telegram connection needed. The full integration tests (a real Postgres, a real
loadboard API, `/postload` end to end) live in the main
[sng-loadboard](https://github.com/AbdulloxAbdujalilov9999/sng-loadboard) repo's
`bot/test/integration.test.js`, since they need that repo's server test harness.
