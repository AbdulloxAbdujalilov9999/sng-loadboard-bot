// Everything the bot persists for itself: which Telegram user is which member (telegram_links),
// and which chats it should broadcast new loads to (telegram_chats). Separate from the API's own
// tables/queries - the bot never writes to `members` or `loads` directly, only reads loads for
// broadcasting (see broadcaster.js) and always posts through the real API (see apiClient.js) so
// every quota/validation rule still applies no matter which door a load came in through.

export function makeStore(pool, crypto) {
  // Re-linking can happen from either side (same Telegram account picks a different e-mail, or the
  // same member re-links from a new Telegram account after losing the old one) - a single INSERT
  // can only target one unique constraint, so clear both possible prior rows first, in one transaction.
  async function saveLink({ memberId, telegramUserId, telegramUsername, refreshToken }) {
    const enc = crypto.encrypt(refreshToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM telegram_links WHERE member_id = $1 OR telegram_user_id = $2', [memberId, telegramUserId]);
      await client.query(
        `INSERT INTO telegram_links (member_id, telegram_user_id, telegram_username, refresh_token_enc)
         VALUES ($1, $2, $3, $4)`,
        [memberId, telegramUserId, telegramUsername, enc],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function getLinkByTelegramUserId(telegramUserId) {
    const { rows: [row] } = await pool.query(
      `SELECT l.*, m.email, m.status AS member_status, m.role AS member_role,
              m.company, m.contact_name, m.phone, m.telegram, m.contact_email
         FROM telegram_links l JOIN members m ON m.id = l.member_id
        WHERE l.telegram_user_id = $1`,
      [telegramUserId],
    );
    if (!row) return null;
    return { ...row, refreshToken: crypto.decrypt(row.refresh_token_enc) };
  }

  async function updateRefreshToken(telegramUserId, refreshToken) {
    await pool.query(
      'UPDATE telegram_links SET refresh_token_enc = $2, updated_at = now() WHERE telegram_user_id = $1',
      [telegramUserId, crypto.encrypt(refreshToken)],
    );
  }

  async function removeLink(telegramUserId) {
    const { rowCount } = await pool.query('DELETE FROM telegram_links WHERE telegram_user_id = $1', [telegramUserId]);
    return rowCount > 0;
  }

  async function upsertChat({ chatId, chatType, title, addedBy }) {
    await pool.query(
      `INSERT INTO telegram_chats (chat_id, chat_type, title, added_by, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (chat_id) DO UPDATE SET chat_type = $2, title = $3, status = 'active', updated_at = now()`,
      [chatId, chatType, title.slice(0, 255), addedBy ?? null],
    );
  }

  async function markChatRemoved(chatId) {
    await pool.query(`UPDATE telegram_chats SET status = 'removed', updated_at = now() WHERE chat_id = $1`, [chatId]);
  }

  async function listActiveChatIds() {
    const { rows } = await pool.query(`SELECT chat_id FROM telegram_chats WHERE status = 'active' ORDER BY id`);
    return rows.map((r) => r.chat_id);
  }

  async function countActiveChats() {
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM telegram_chats WHERE status = 'active'`);
    return n;
  }

  // null means "never set" - the caller falls back to Telegram's own language_code.
  async function getLanguage(telegramUserId) {
    const { rows: [row] } = await pool.query('SELECT language FROM telegram_users WHERE telegram_user_id = $1', [telegramUserId]);
    return row?.language ?? null;
  }

  async function setLanguage(telegramUserId, language) {
    await pool.query(
      `INSERT INTO telegram_users (telegram_user_id, language) VALUES ($1, $2)
       ON CONFLICT (telegram_user_id) DO UPDATE SET language = $2, updated_at = now()`,
      [telegramUserId, language],
    );
  }

  return {
    saveLink, getLinkByTelegramUserId, updateRefreshToken, removeLink, upsertChat, markChatRemoved,
    listActiveChatIds, countActiveChats, getLanguage, setLanguage,
  };
}
