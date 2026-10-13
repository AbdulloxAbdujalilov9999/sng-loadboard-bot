// Bot-specific environment. Kept separate from server/src/config.js: the bot is a different
// process with different required secrets (it must never need OWNER_EMAILS, GEMINI_API_KEY, etc.).
import { LANGS, DEFAULT_LANG } from './i18n.js';

const truthy = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export function loadBotConfig(env = process.env) {
  const apiBaseUrl = (env.API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const cfg = {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    apiBaseUrl,
    // The address a person's browser can actually reach, used to build "view this load" links.
    // Defaults to apiBaseUrl (true for a self-hosted single-domain setup); on a platform where the
    // bot talks to the API over an internal address (e.g. Render), set this to the public URL.
    webBaseUrl: (env.PUBLIC_WEB_URL || apiBaseUrl).replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL,
    databaseSsl: truthy(env.DATABASE_SSL, false),
    firebaseApiKey: env.FIREBASE_WEB_API_KEY || '',
    firebaseProjectId: env.FIREBASE_PROJECT_ID || 'sng-pro',
    encryptionKey: env.BOT_ENCRYPTION_KEY || '',
    logLevel: env.LOG_LEVEL || 'info',
    // Spacing between consecutive Telegram sends while broadcasting one load to many chats
    // (Telegram's own limit is ~30 msg/s across all chats); keep this well under it.
    broadcastSpacingMs: Number(env.BOT_BROADCAST_SPACING_MS || 60),
    // Groups mix members of different languages, so broadcasts use one fixed language for everyone
    // (unlike DMs, which follow each person's own /language choice).
    broadcastLang: LANGS.includes(env.BOT_BROADCAST_LANG) ? env.BOT_BROADCAST_LANG : DEFAULT_LANG,
    // Our own official channel/group, invited in the welcome message, the /postload confirmation,
    // and every broadcast message (see format.js's joinLines) - optional, leave blank to omit.
    // Stored without the leading "@" (stripped if given) so there's never a double "@@".
    joinChannel: (env.BOT_JOIN_CHANNEL || '').replace(/^@/, ''),
    joinGroup: (env.BOT_JOIN_GROUP || '').replace(/^@/, ''),
    // /paste: how many /api/ai/parse-loads calls this process makes per minute at most, independent
    // of how many members paste at once - keeps it well under the server's per-member hourly AI
    // budget and Gemini's own rate limits even if several members paste in the same minute.
    aiMaxPerMin: Number(env.AI_PASTE_MAX_PER_MIN || 20),
    // /paste: how long (minutes) a parsed batch's Publish/Skip buttons stay valid before expiring.
    pendingTtlMin: Number(env.PASTE_PENDING_TTL_MIN || 15),
  };
  const problems = [];
  // Links in broadcasts are clicked by people on the internet. An internal/localhost address would be a dead
  // link for everyone, so in production we say so loudly (and the broadcaster omits the link, see format.js).
  cfg.webUrlIsPublic = !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^./:]+(:\d+)?(\/|$))/i.test(cfg.webBaseUrl);
  if (env.NODE_ENV === 'production' && !cfg.webUrlIsPublic) {
    console.warn(`PUBLIC_WEB_URL is not set to a public address (using ${cfg.webBaseUrl}): "view this load" links will be left out. Set PUBLIC_WEB_URL to your site's https:// address.`);
  }
  if (!cfg.botToken) problems.push('TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather and paste its token)');
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required (same database as the API)');
  if (!cfg.firebaseApiKey) problems.push('FIREBASE_WEB_API_KEY is required (the "apiKey" from web/js/config.js - it is public by design)');
  if (!cfg.encryptionKey) problems.push('BOT_ENCRYPTION_KEY is required: 32 random bytes, base64. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  else if (Buffer.from(cfg.encryptionKey, 'base64').length !== 32) problems.push('BOT_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes');
  if (problems.length) throw new Error('Invalid bot configuration:\n - ' + problems.join('\n - '));
  return cfg;
}
