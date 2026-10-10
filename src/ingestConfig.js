// Ingestion-specific environment: a SECOND Telegram bot, added to source groups (the big public
// freight-posting chats, not the user's own broadcast chats - see config.js for that bot), which
// reads ordinary group messages and needs Telegram privacy mode OFF to see them (@BotFather ->
// /setprivacy -> Disable - see bot/README.md "Ingestion bot"). Kept separate from config.js: a
// different token, a different Telegram requirement, and a different failure mode if misconfigured
// (this one posts loads with no human in the loop, so it fails loudly rather than guessing).
const truthy = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export function loadIngestConfig(env = process.env) {
  const apiBaseUrl = (env.API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const cfg = {
    botToken: env.TELEGRAM_INGEST_BOT_TOKEN || '',
    apiBaseUrl,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: truthy(env.DATABASE_SSL, false),
    firebaseApiKey: env.FIREBASE_WEB_API_KEY || '',
    // The dedicated, owner-approved member account every auto-imported load is posted as (its
    // profile phone/telegram/email become the contact details shown for loads the AI draft itself
    // didn't carry one for - see ingestPipeline.js toLoadBody). A normal email+password member,
    // nothing special about it except that a human never signs into it.
    serviceEmail: (env.INGEST_SERVICE_EMAIL || '').toLowerCase(),
    servicePassword: env.INGEST_SERVICE_PASSWORD || '',
    // Cheap pre-filter before any AI call: skip short messages, and (by default) messages with no
    // phone number or @handle at all - greetings/questions/"anyone going to Moscow?" chatter, which
    // is most of the traffic in a big group, never reaches the AI.
    minChars: Number(env.INGEST_MIN_CHARS || 25),
    requireContact: truthy(env.INGEST_REQUIRE_CONTACT, true),
    // How long the same route+date+contact blocks a repost from becoming a second load (hours).
    dedupeWindowHours: Number(env.INGEST_DEDUPE_WINDOW_HOURS || 72),
    // Throttles AI calls well under the per-account hourly budget (AI_RATE_PER_HOUR, server/src/config.js)
    // and under Gemini's own rate limits, no matter how bursty a group gets.
    maxAiPerMinute: Number(env.INGEST_AI_MAX_PER_MIN || 6),
    // Telegram user ids allowed to DM this bot /ingeststatus, /pausesource, /resumesource.
    adminTelegramIds: new Set(String(env.INGEST_ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)),
    logLevel: env.LOG_LEVEL || 'info',
  };
  const problems = [];
  if (!cfg.botToken) problems.push('TELEGRAM_INGEST_BOT_TOKEN is required (a SECOND @BotFather bot, with privacy mode disabled - see bot/README.md)');
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required (same database as the API)');
  if (!cfg.firebaseApiKey) problems.push('FIREBASE_WEB_API_KEY is required');
  if (!cfg.serviceEmail || !cfg.servicePassword) problems.push('INGEST_SERVICE_EMAIL and INGEST_SERVICE_PASSWORD are required (a dedicated, owner-approved member account - see bot/README.md "Ingestion bot")');
  if (problems.length) throw new Error('Invalid ingest configuration:\n - ' + problems.join('\n - '));
  return cfg;
}
