import { loadBotConfig } from './config.js';
import { createBotPool } from './db.js';
import { makeCrypto } from './crypto.js';
import { makeFirebaseAuth } from './firebase.js';
import { makeApiClient } from './apiClient.js';
import { makeStore } from './store.js';
import { makeTokenManager } from './tokens.js';
import { makeBot } from './bot.js';
import { makeBroadcaster } from './broadcaster.js';
import { COMMANDS } from './i18n.js';

async function main() {
  const config = loadBotConfig();
  const pool = createBotPool(config);
  await pool.query('SELECT 1'); // fail fast and loudly if the database is unreachable

  const crypto = makeCrypto(config.encryptionKey);
  const firebaseAuth = makeFirebaseAuth({ apiKey: config.firebaseApiKey });
  const apiClient = makeApiClient({ baseUrl: config.apiBaseUrl });
  const store = makeStore(pool, crypto);
  const tokens = makeTokenManager({ store, firebaseAuth, apiClient });
  const bot = makeBot({ config, firebaseAuth, apiClient, tokens, store });
  const broadcaster = makeBroadcaster({ config, pool, store, bot });

  // Telegram's own "/" command menu - uz is the default (no language_code), ru/en shown instead
  // to clients set to those languages. Never fatal: a hiccup here just means the slash-menu is
  // stale until the next boot, not that the bot fails to start.
  await Promise.all([
    bot.telegram.setMyCommands(COMMANDS.uz),
    bot.telegram.setMyCommands(COMMANDS.ru, { language_code: 'ru' }),
    bot.telegram.setMyCommands(COMMANDS.en, { language_code: 'en' }),
  ]).catch((err) => console.warn(`setMyCommands failed: ${err.message}`));

  await broadcaster.start();
  const launched = bot.launch().then(() => console.log('sng-one telegram bot: polling stopped'));
  const chats = await store.countActiveChats();
  console.log(`sng-one telegram bot running - broadcasting to ${chats} chat(s)`);

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    bot.stop(signal);
    await launched.catch(() => {});
    await broadcaster.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start the Telegram bot:', err.message);
  process.exit(1);
});
