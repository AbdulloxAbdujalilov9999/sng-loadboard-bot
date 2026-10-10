# SNG ONE — Telegram bots

Companion processes for [SNG ONE](https://github.com/AbdulloxAbdujalilov9999/sng-loadboard), the
freight loadboard for CIS/Eurasia. Neither is useful on its own: both share the loadboard's
PostgreSQL database and talk to its HTTP API. This repo holds **two separate bots**:

1. **Broadcast bot** (`src/index.js`) - lets your own members link their account, post loads from
   a chat, and broadcasts every new load to every group/channel the bot has been added to.
2. **Ingest bot** (`src/ingestIndex.js`) - a second, independent process that joins big *public*
   freight-posting groups you don't control and auto-imports loads it reads there. See
   "Ingestion bot" below.

They are kept as two processes (two `@BotFather` tokens, two deploy targets) on purpose - see "Why
a second bot" below.

## Broadcast bot

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

### How it works

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

### Setup

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

## Ingestion bot: auto-importing loads from source groups

A **second, separate process** (`src/ingestIndex.js`, `npm run ingest`) that joins the big public
Telegram groups where loads actually get posted in the SNG freight world - the ones with thousands
of members - reads every message, and turns the ones that look like loads into real board listings
automatically, no human in the loop. It reuses everything the "paste from Telegram/WhatsApp"
AI-import screen on the web app already does (Gemini parser, then `POST /api/loads`): there is no
second, parallel way a load gets built or validated. The only new thing is *what triggers it* - a
bot reading a group instead of a person pasting text.

```
source group  ──message──▶  ingest bot  ──filter──▶  AI parse (/api/ai/parse-loads)  ──▶  dedupe
  (10k members)                                                                              │
                                                                                              ▼
                                                                          POST /api/loads (real API, real quotas)
```

### Why a second bot, and what it needs that the first one doesn't

- **Telegram privacy mode.** By default a Bot API bot in a group only sees `@mentions` and
  commands - not ordinary chat. This bot needs to see every message, so it needs its own
  `@BotFather` bot with privacy mode **disabled** (message `@BotFather` → `/mybots` → pick the bot
  → *Bot Settings* → *Group Privacy* → **Turn off**, or `/setprivacy` → *Disable*). Doing this on
  the broadcast bot above would be harmless but pointless - keeping them separate means one bot's
  job (post-to-your-own-groups) and the other's (read-other-people's-groups) never share a token, a
  rate limit, or a crash.
- **Someone has to be able to add it to the group.** This only works for groups where you (or
  whoever runs the group) can add a bot - either because you admin it yourself, or the group's
  admins allow it. Many informal trading groups don't allow bots at all; there is no way around
  that short of running a personal Telegram account as an automated listener instead of a bot,
  which is a materially different (and riskier - against Telegram's ToS for automated accounts,
  and can get the *personal* account limited) approach this project deliberately does not implement.
  Where you can't add a bot, the practical fallback is still a human member using the existing
  AI-import screen on the web app to paste messages by hand.
- **A dedicated account to post as.** Every load needs an `owner_id` (a real member) and a
  `contactEmail`/`contactPhone`/`contactTelegram` (all required fields). There is no human pasting
  here to supply those, so you create one ordinary member account for this purpose - sign up on the
  web app with an e-mail you control (e.g. `telegram-import@yourdomain.com`), verify the e-mail,
  fill in its profile (**company** = something recognizable like "SNG ONE — Telegram Import",
  **phone**/**telegram** = a real line you monitor, since these become the contact shown on any
  auto-imported load whose source message didn't carry its own), and approve it from the owner
  account like any other member. Set `INGEST_SERVICE_EMAIL` / `INGEST_SERVICE_PASSWORD` to its
  login. It otherwise behaves like any member: the same active-loads cap and posts-per-hour quota
  apply - raise them on the loadboard API if this account hits the ceiling before a human would.

### What happens to each message

1. **Filter** (`ingestFilter.js`, no AI spent): too short, or - by default - no phone number/@handle
   anywhere in it, is dropped. This is most of the traffic in a big group (greetings, questions,
   "anyone going to Moscow?") and costs nothing to skip.
2. **Claim** (`telegram_ingest_messages`): the (chat id, message id) pair is recorded *before*
   anything else happens, so a Telegram-redelivered update or a bot restart mid-processing can never
   process - and therefore never post - the same message twice.
3. **Parse**: the message text goes to `POST /api/ai/parse-loads` on the loadboard API (same Gemini
   prompt, same city resolution, same per-account hourly AI budget as a human's paste) and comes
   back as zero or more structured load drafts, one per load mentioned (a single message is often
   several loads).
4. **Per-draft dedupe** (`telegram_ingest_fingerprints`): a fingerprint of
   `origin city + dest city + pickup date + phone (or @handle)` blocks the same load from becoming a
   second listing - whether the same group reposts it an hour later (constant in these groups) or a
   dispatcher cross-posts the identical load to three different groups. The block lasts
   `INGEST_DEDUPE_WINDOW_HOURS` (default 72h) and keeps refreshing itself while the repost continues.
5. **Post**: a draft with no resolvable origin/destination city is skipped outright (the API would
   reject it anyway - there is nothing useful to post). Everything else is posted through the exact
   same `POST /api/loads` call `/postload` and the web app use, as the service account. If the AI
   had to estimate a field (weight defaulted to 20t, pickup date defaulted to today, rate defaulted
   to $0/negotiable - the same defaults the web import screen flags for a human to check), the load's
   notes get a short `auto-import: weight, rate estimated - confirm by phone` suffix instead of
   silently presenting a guess as fact.

A message that mentions several loads posts the ones that resolve and skips the ones that don't,
independently - one bad line in a message never blocks the good ones next to it.

### Setup

This bot needs the same running loadboard API as the broadcast bot above, plus migration
`007_telegram_ingest.sql` in this repo's `migrations/` folder (applied automatically when that app
boots).

1. Create a **second** bot with `@BotFather`, disable its privacy mode (see above), and put its
   token in `TELEGRAM_INGEST_BOT_TOKEN`.
2. Sign up, verify, and approve a dedicated member account on the web app (see above); put its
   login in `INGEST_SERVICE_EMAIL` / `INGEST_SERVICE_PASSWORD`.
3. Get your own Telegram user id from `@userinfobot` and put it in `INGEST_ADMIN_TG_IDS` (comma
   separated if more than one person should be able to run the admin commands below).
4. Run it: `npm run ingest` (or `npm run ingest:dev` to restart on file changes).
5. In Telegram, add that bot to each source group you have access to - you (or that group's admins)
   add it exactly like any other bot. It starts ingesting the moment it joins; nothing else to
   configure per group.

### Admin commands (DM only, `INGEST_ADMIN_TG_IDS` only)

- `/ingeststatus` — every source chat the bot is in, with message/load counts.
- `/pausesource <chatId>` — stop ingesting a noisy or low-quality group without removing the bot or
  redeploying (e.g. it turns out to be mostly spam, or a group where the AI keeps mis-reading the
  local dialect). `/ingeststatus` shows each chat's id.
- `/resumesource <chatId>` — undo a pause.

### Limitations / things you'd add for a bigger deployment

- One message = one AI call at most (`INGEST_AI_MAX_PER_MIN` throttles the rate, it doesn't batch).
  A poster who splits one load across two or three separate messages is read as separate, usually
  incomplete, drafts rather than merged - the common "flag/flag/cargo/truck/terms/phone in one
  message" layout (the actual norm in these groups) is unaffected.
- No human review step by design (the request this was built for is "fully automatic"). The safety
  net is entirely mechanical: the API's own field validation (bad data literally cannot be inserted)
  plus the transparency note on estimated fields. If you'd rather hold low-confidence drafts (any
  non-empty `flags` from the AI) for a person to confirm instead of auto-posting them with a caveat,
  that is a small change to `ingestPipeline.js`'s `toLoadBody`/posting step - route flagged drafts to
  a Telegram message to the admins instead of straight to `createLoad`.
- One ingest bot process = one Telegram "worker" for however many source groups you add it to, same
  constraint as the broadcast bot (see its own Limitations below) - shard across multiple ingest
  bots if you outgrow one.
- Content/ToS consideration worth knowing about rather than a code limitation: this republishes
  third-party freight posts (scraped from a group you don't control) onto your own commercial board,
  attributed to the service account rather than the original poster by name. That's normal practice
  among SNG freight aggregators, but it is your call per source group - whatever that group's own
  rules and your relationship with its admins actually allow - not something this code decides for you.

## Docker

```bash
docker build -t sng-loadboard-bot .
docker run --env-file .env sng-loadboard-bot                              # broadcast bot (default CMD)
docker run --env-file .env sng-loadboard-bot node src/ingestIndex.js      # ingest bot (override CMD)
```

## Render

Two ways to deploy, both end up with the same thing (background workers, since neither process has
an HTTP server):

- **Blueprint** (easiest): New + → Blueprint → pick this repo → leave the Blueprint path as the
  default (`render.yaml`, already at the repo root). It defines both the broadcast bot
  (`sng-loadboard-bot`) and the ingest bot (`sng-loadboard-ingest-bot`) as separate workers; it will
  ask for the secrets marked `sync: false` in [`render.yaml`](render.yaml) for whichever ones you
  enable.
- **Manual**: New + → Background Worker → pick this repo, runtime **Docker**, and set the
  environment variables from `.env.example` yourself. Use the default command for the broadcast
  bot, or override it to `node src/ingestIndex.js` for the ingest bot.

Either way: `DATABASE_URL` must be the same Postgres instance as the loadboard API's Render
service (copy its "External Database URL" from that service's database page), `API_BASE_URL` is
that API service's Render-internal address, and `PUBLIC_WEB_URL` (broadcast bot only) is its
**public** `https://` address (not the internal one) - that's what makes the "view this load"
links actually open.

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

## Limitations (broadcast bot)

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

Pure unit tests only (crypto, i18n, message formatting, broadcaster retry/dead-chat logic, ingest
filter, ingest pipeline/dedupe) - no database or live Telegram connection needed. The full
integration tests (a real Postgres, a real loadboard API, `/postload` end to end) live in the main
[sng-loadboard](https://github.com/AbdulloxAbdujalilov9999/sng-loadboard) repo's
`bot/test/integration.test.js`, since they need that repo's server test harness.
