// The "any load, the moment it's posted, goes to every group" half of the bot. Opens its OWN
// Postgres LISTEN connection on the same channel the API's EventHub uses (server/src/events.js),
// but does NOT go through EventHub: that hub coalesces bursts into one "something changed, refetch"
// frame per second for browsers, which would lose individual loads. The bot instead reacts to every
// single insert notification, fetches that one row, and posts it - whether it was created from the
// web app or from /postload here, since both go through the same `loads` table and the same
// `publish()` call in server/src/events.js.
import pg from 'pg';
import { formatLoadMessage } from './format.js';

const CHANNEL = 'sng_events';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeBroadcaster({ config, pool, store, bot, log = console, sleep = defaultSleep }) {
  let listener = null; // the currently-live LISTEN client, or null while reconnecting
  let closed = false;
  let retryMs = 500;
  let queue = Promise.resolve(); // serialises sends so a slow broadcast can't overlap the next one

  async function fetchLoad(id) {
    const { rows: [row] } = await pool.query('SELECT * FROM loads WHERE id = $1', [id]);
    return row ?? null;
  }

  // Telegram caps a bot at ~20 messages a minute per group. Past that it answers 429 with how long to wait;
  // we wait exactly that long and try again (a member posting 40 loads in one go must not lose broadcasts).
  async function sendWithRetry(chatId, text) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        if (err?.response?.error_code !== 429 || attempt >= 4) throw err;
        const waitS = Number(err.response.parameters?.retry_after ?? 5);
        await sleep(Math.min(waitS, 60) * 1000 + 250);
      }
    }
  }

  async function sendToAllChats(text) {
    const chatIds = await store.listActiveChatIds();
    for (const chatId of chatIds) {
      try {
        await sendWithRetry(chatId, text);
      } catch (err) {
        const code = err?.response?.error_code;
        const gone = /chat not found|kicked|not a member|deactivated/i.test(err?.response?.description ?? err.message ?? '');
        // 403 = bot was removed/blocked without us hearing a my_chat_member update; stop posting there.
        if (code === 403 || (code === 400 && gone)) await store.markChatRemoved(chatId).catch(() => {});
        else log.warn?.(`broadcast to ${chatId} failed: ${err.message}`) ?? console.warn(`broadcast to ${chatId} failed: ${err.message}`);
      }
      if (config.broadcastSpacingMs > 0) await sleep(config.broadcastSpacingMs);
    }
  }

  async function handleEvent(evt) {
    if (evt?.entity !== 'loads' || evt.op !== 'insert' || !evt.id) return;
    const row = await fetchLoad(evt.id);
    if (!row || row.status !== 'active') return; // closed/edited away again before we got to it
    // Each load gets its own link back to this exact load on the web board (GET /api/loads/:id
    // backs it, see server/src/routes/loads.js); clicking it works for anyone with board access,
    // independent of whoever posted it or whichever group it landed in.
    const linkUrl = config.webUrlIsPublic === false ? null : `${config.webBaseUrl}/?load=${row.id}`; // never broadcast a dead (internal) address
    const text = formatLoadMessage(row, config.broadcastLang, linkUrl);
    queue = queue.then(() => sendToAllChats(text));
    await queue.catch((err) => log.error?.(`broadcast failed: ${err.message}`) ?? console.error(`broadcast failed: ${err.message}`));
  }

  async function connect() {
    if (closed) return;
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      application_name: 'sng-one-telegram-bot-listener',
    });
    const reconnect = (why) => {
      if (closed || listener !== client) return; // already superseded by a newer connection attempt
      listener = null;
      log.warn?.(`event listener lost (${why}); reconnecting`) ?? console.warn(`event listener lost (${why}); reconnecting`);
      client.removeAllListeners();
      client.end().catch(() => {});
      setTimeout(() => connect().catch((e) => reconnect(e.message)), retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
    client.on('error', (e) => reconnect(e.message));
    client.on('end', () => reconnect('connection ended'));
    client.on('notification', (msg) => {
      try { handleEvent(JSON.parse(msg.payload)); } catch (e) { log.warn?.(`bad event payload: ${e.message}`) ?? console.warn(`bad event payload: ${e.message}`); }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
      retryMs = 500;
    } catch (err) {
      client.removeAllListeners();
      client.end().catch(() => {});
      if (closed) return;
      setTimeout(() => connect().catch(() => {}), retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  }

  return {
    async start() { await connect(); },
    async stop() {
      closed = true;
      if (listener) { listener.removeAllListeners(); await listener.end().catch(() => {}); listener = null; }
    },
    // Exposed so bot/test can drive the "a load was inserted" path without a real LISTEN connection.
    _handleEvent: handleEvent,
  };
}
