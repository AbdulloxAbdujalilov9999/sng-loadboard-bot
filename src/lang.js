// Resolves and caches each Telegram user's bot language: their own /language choice if they ever
// set one, otherwise auto-detected from Telegram's own language_code. Independent of account
// linking (store.telegram_users), so even /start and /link itself are in the right language.
import { pickLang } from './i18n.js';

export function makeLangManager({ store }) {
  const cache = new Map(); // telegram_user_id -> lang

  async function getLang(ctx) {
    const from = ctx.from;
    if (!from) return pickLang();
    if (cache.has(from.id)) return cache.get(from.id);
    const stored = await store.getLanguage(from.id);
    const lang = stored || pickLang(from.language_code);
    cache.set(from.id, lang);
    return lang;
  }

  async function setLang(telegramUserId, lang) {
    await store.setLanguage(telegramUserId, lang);
    cache.set(telegramUserId, lang);
  }

  return { getLang, setLang };
}
