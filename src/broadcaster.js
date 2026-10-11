// The "any load, the moment it's posted, goes to every group" half of the bot. Opens its OWN
// Postgres LISTEN connection on the same channel the API's EventHub uses (server/src/events.js),
// but does NOT go through EventHub: that hub coalesces bursts into one "something changed, refetch"
// frame per second for browsers, which would lose individual loads. The bot instead reacts to every
// single insert notification, fetches that one row, and posts it - whether it was created from the
// web app or from /postload here, since both go through the same `loads` table and the same
// `publish()` call in server/src/events.js.
import pg from 'pg';
import { formatLoadMessage, escapeHtml, joinLines } from './format.js';
import { t } from './i18n.js';

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

  // Shared error handling for a send to any chat (group or DM): Telegram throttling is already
  // retried inside sendWithRetry; this only deals with the chat having gone away entirely.
  async function handleSendError(err, chatId) {
    const code = err?.response?.error_code;
    const gone = /chat not found|kicked|not a member|deactivated/i.test(err?.response?.description ?? err.message ?? '');
    // 403 = bot was removed/blocked without us hearing a my_chat_member update; stop posting there.
    if (code === 403 || (code === 400 && gone)) await store.markChatRemoved(chatId).catch(() => {});
    else log.warn?.(`broadcast to ${chatId} failed: ${err.message}`) ?? console.warn(`broadcast to ${chatId} failed: ${err.message}`);
  }

  // Broadcasts to a group/channel are fire-and-forget - deliberately NOT remembered in
  // telegram_load_messages, so closing/removing the load later never reaches back into a group or
  // channel to delete anything there (members may already be relying on seeing it, even once it's
  // no longer active - unlike the poster's own chat, see sendToOwner below).
  async function sendToAllChats(text) {
    const chatIds = await store.listActiveChatIds();
    for (const chatId of chatIds) {
      try { await sendWithRetry(chatId, text); } catch (err) { await handleSendError(err, chatId); }
      if (config.broadcastSpacingMs > 0) await sleep(config.broadcastSpacingMs);
    }
  }

  // The poster gets their own load in their own chat too, same message every group gets - only if
  // they've ever linked their Telegram account (store.getTelegramUserIdByMemberId returns null
  // otherwise). This one IS tracked: it's the poster's own chat, so pulling it back out when they
  // close/remove the load (see handleDelete) is tidying up after them, not touching anyone else's chat.
  async function sendToOwner(loadId, ownerMemberId, text) {
    const chatId = await store.getTelegramUserIdByMemberId(ownerMemberId);
    if (!chatId) return;
    try {
      const sent = await sendWithRetry(chatId, text);
      if (sent?.message_id != null) {
        await store.saveSentMessage({ loadId, chatId, messageId: sent.message_id })
          .catch((err) => log.warn?.(`tracking message for load ${loadId} in ${chatId} failed: ${err.message}`));
      }
    } catch (err) {
      await handleSendError(err, chatId);
    }
  }

  // The load was closed/removed (DELETE /api/loads/:id, from the web app, /postload... or /myloads
  // below): pull it back out of the poster's own chat (see sendToOwner - groups/channels are never
  // tracked here, so this never touches them). Telegram refuses to delete a message once it's more
  // than 48h old (or already gone) - nothing more to do there, but the row is forgotten regardless
  // so this never retries forever.
  async function handleDelete(loadId) {
    const sent = await store.listSentMessages(loadId);
    for (const { chat_id: chatId, message_id: messageId } of sent) {
      await bot.telegram.deleteMessage(chatId, messageId)
        .catch((err) => log.warn?.(`could not delete message ${messageId} in ${chatId} for load ${loadId}: ${err.message}`));
    }
    await store.deleteSentMessages(loadId);
  }

  // A new member signed up: tell the platform owner(s) on Telegram (the web app tells them too, while it is open).
  async function notifyOwners(memberId) {
    const { rows: [m] } = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (!m || m.role === 'owner') return;
    const owners = await store.listOwnerTelegramIds?.() ?? [];
    if (!owners.length) return;
    const login = /^p\d+@phone\.sng$/.test(m.email) ? `+${m.email.slice(1, -'@phone.sng'.length)}` : m.email;
    const name = m.company && m.company !== m.contact_name ? `${m.company} (${m.contact_name})` : (m.contact_name || m.company);
    const contact = [...new Set([m.phone, m.telegram, m.contact_email, login].filter(Boolean))].join(' · ');
    for (const id of owners) {
      const lang = (await store.getLanguage?.(id)) ?? config.broadcastLang;
      await bot.telegram.sendMessage(id, t(lang, 'owner_new_member', { name: escapeHtml(name), contact: escapeHtml(contact) }), { parse_mode: 'HTML' })
        .catch((err) => log.warn?.(`owner notice to ${id} failed: ${err.message}`));
    }
  }

  // Each branch below catches its OWN errors inside the function handed to queue.then(), so the
  // promise that .then() returns - and therefore `queue` itself - never rejects. A rejected `queue`
  // would otherwise poison every later call forever: queue.then(fn) on an already-rejected promise
  // skips fn and just re-rejects, so one bad event would silently stop all future broadcasts until
  // the process restarts.
  async function handleEvent(evt) {
    if (evt?.entity === 'members' && evt.op === 'insert' && evt.id) {
      queue = queue.then(() => notifyOwners(evt.id)
        .catch((err) => log.error?.(`owner notice failed: ${err.message}`) ?? console.error(`owner notice failed: ${err.message}`)));
      await queue;
      return;
    }
    if (evt?.entity !== 'loads' || !evt.id) return;
    if (evt.op === 'delete') {
      queue = queue.then(() => handleDelete(evt.id)
        .catch((err) => log.error?.(`un-broadcasting load ${evt.id} failed: ${err.message}`) ?? console.error(`un-broadcasting load ${evt.id} failed: ${err.message}`)));
      await queue;
      return;
    }
    if (evt.op !== 'insert') return;
    const row = await fetchLoad(evt.id);
    if (!row || row.status !== 'active') return; // closed/edited away again before we got to it
    // Each load gets its own link back to this exact load on the web board (GET /api/loads/:id
    // backs it, see server/src/routes/loads.js); clicking it works for anyone with board access,
    // independent of whoever posted it or whichever group it landed in.
    const linkUrl = config.webUrlIsPublic === false ? null : `${config.webBaseUrl}/?load=${row.id}`; // never broadcast a dead (internal) address
    const join = joinLines(config, config.broadcastLang);
    const text = formatLoadMessage(row, config.broadcastLang, linkUrl) + (join ? `\n\n${join}` : '');
    queue = queue.then(async () => {
      try {
        await sendToAllChats(text);
        await sendToOwner(row.id, row.owner_id, text);
      } catch (err) {
        log.error?.(`broadcast failed: ${err.message}`) ?? console.error(`broadcast failed: ${err.message}`);
      }
    });
    await queue;
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
