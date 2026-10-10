// Everything the ingester persists for itself (see server/migrations/007_telegram_ingest.sql).
// Like store.js, this never writes to `loads`/`members` directly - every load still goes through
// the real API (apiClient.js), so quotas/validation/CHECK constraints apply exactly as they do to
// a human posting from the browser or from /postload.

export function makeIngestStore(pool) {
  // Registers a chat the bot was just added to, or just confirms one it already knows (title can
  // change). Also self-heals: see bumpChatSeen, which upserts too, in case a chat's `my_chat_member`
  // update was never delivered (it happens) but messages are flowing anyway.
  async function upsertChat({ chatId, chatType, title, addedBy }) {
    await pool.query(
      `INSERT INTO telegram_ingest_chats (chat_id, chat_type, title, added_by, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (chat_id) DO UPDATE SET chat_type = $2, title = $3, status = 'active', updated_at = now()`,
      [chatId, chatType, title.slice(0, 255), addedBy ?? null],
    );
  }

  async function markChatRemoved(chatId) {
    await pool.query(`UPDATE telegram_ingest_chats SET status = 'removed', updated_at = now() WHERE chat_id = $1`, [chatId]);
  }

  // Admin-only pause/resume (see ingestBot.js /pausesource, /resumesource). Never resurrects a
  // chat the bot was actually removed from - only an explicit re-add (upsertChat) can do that.
  async function setChatStatus(chatId, status) {
    const { rowCount } = await pool.query(
      `UPDATE telegram_ingest_chats SET status = $2, updated_at = now() WHERE chat_id = $1 AND status != 'removed'`,
      [chatId, status],
    );
    return rowCount > 0;
  }

  // Bumps the per-message counter and returns the chat's current status in one round trip - the
  // hot path for every single incoming group message. Upserts as active on first sight so a chat
  // whose join event never arrived still gets ingested the moment the operator adds the bot to it.
  async function bumpChatSeen({ chatId, chatType, title }) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO telegram_ingest_chats (chat_id, chat_type, title, status, messages_seen, last_message_at)
       VALUES ($1, $2, $3, 'active', 1, now())
       ON CONFLICT (chat_id) DO UPDATE SET
         messages_seen = telegram_ingest_chats.messages_seen + 1, last_message_at = now(), updated_at = now()
       RETURNING status`,
      [chatId, chatType, title.slice(0, 255)],
    );
    return row.status;
  }

  async function bumpChatPosted(chatId, n) {
    if (n > 0) await pool.query(`UPDATE telegram_ingest_chats SET loads_posted = loads_posted + $2 WHERE chat_id = $1`, [chatId, n]);
  }

  async function listChats() {
    const { rows } = await pool.query(
      `SELECT chat_id, chat_type, title, status, messages_seen, loads_posted, last_message_at
         FROM telegram_ingest_chats ORDER BY id`);
    return rows;
  }

  // Claims a message: returns false (and does nothing else) if this exact (chat, message) was
  // already recorded, so a Telegram-redelivered update or a restart mid-processing can never
  // double-post. The placeholder 'error' row is overwritten by finalizeMessage once the real
  // outcome is known; if the process crashes in between, the message simply stays unprocessed
  // (never silently double-posted) - the acceptable failure mode for a first version.
  async function claimMessage(chatId, messageId) {
    const { rowCount } = await pool.query(
      `INSERT INTO telegram_ingest_messages (source_chat_id, source_message_id, status)
       VALUES ($1, $2, 'error') ON CONFLICT DO NOTHING`,
      [chatId, messageId],
    );
    return rowCount > 0;
  }

  async function finalizeMessage(chatId, messageId, { status, loadIds = [], detail = '' }) {
    await pool.query(
      `UPDATE telegram_ingest_messages SET status = $3, load_ids = $4, detail = $5
        WHERE source_chat_id = $1 AND source_message_id = $2`,
      [chatId, messageId, status, loadIds, detail.slice(0, 2000)],
    );
  }

  // Dedupe: a fingerprint "taken" within the window blocks a new post and returns the load id it
  // already became; otherwise it is (re)claimed for the caller (last_seen_at refreshes either way,
  // so a load that keeps getting reposted keeps extending its own block window).
  async function claimFingerprint(fingerprint, windowHours) {
    const { rows: [row] } = await pool.query(
      `SELECT load_id, now() - last_seen_at < $2::interval AS fresh
         FROM telegram_ingest_fingerprints WHERE fingerprint = $1`,
      [fingerprint, `${windowHours} hours`],
    );
    const blocked = row?.fresh && row.load_id != null;
    await pool.query(
      `INSERT INTO telegram_ingest_fingerprints (fingerprint, last_seen_at) VALUES ($1, now())
       ON CONFLICT (fingerprint) DO UPDATE SET last_seen_at = now()`,
      [fingerprint],
    );
    return blocked ? row.load_id : null;
  }

  async function attachFingerprintLoad(fingerprint, loadId) {
    await pool.query(`UPDATE telegram_ingest_fingerprints SET load_id = $2 WHERE fingerprint = $1`, [fingerprint, loadId]);
  }

  return {
    upsertChat, markChatRemoved, setChatStatus, bumpChatSeen, bumpChatPosted, listChats,
    claimMessage, finalizeMessage, claimFingerprint, attachFingerprintLoad,
  };
}
