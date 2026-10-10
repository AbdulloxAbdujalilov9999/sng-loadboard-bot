import { loadIngestConfig } from './ingestConfig.js';
import { createBotPool } from './db.js';
import { makeFirebaseAuth } from './firebase.js';
import { makeApiClient } from './apiClient.js';
import { makeIngestStore } from './ingestStore.js';
import { makeServiceAuth } from './ingestAuth.js';
import { makeIngestPipeline, makeRateLimiter } from './ingestPipeline.js';
import { makeIngestBot } from './ingestBot.js';

async function main() {
  const config = loadIngestConfig();
  const pool = createBotPool(config);
  await pool.query('SELECT 1'); // fail fast and loudly if the database is unreachable

  const firebaseAuth = makeFirebaseAuth({ apiKey: config.firebaseApiKey });
  const apiClient = makeApiClient({ baseUrl: config.apiBaseUrl });
  const store = makeIngestStore(pool);
  const auth = makeServiceAuth({ firebaseAuth, email: config.serviceEmail, password: config.servicePassword });

  // The service account's profile supplies fallback contact details for any load whose AI draft
  // didn't carry its own (see ingestPipeline.js toLoadBody) - cached and refreshed occasionally so
  // an owner edit (e.g. swapping in the real business Telegram handle) takes effect without a restart.
  let profile = null;
  let profileAt = 0;
  async function getProfile() {
    if (profile && Date.now() - profileAt < 10 * 60_000) return profile;
    const idToken = await auth.getIdToken();
    const me = await apiClient.getMe(idToken);
    if (!me.profile || me.profile.status !== 'approved') {
      throw new Error(`service account ${config.serviceEmail} is not an approved member yet (status: ${me.profile?.status ?? me.status}) - sign it up on the web app and approve it from the owner account first`);
    }
    profile = me.profile;
    profileAt = Date.now();
    return profile;
  }

  // Fail fast at startup if the service account can't sign in or isn't approved yet, rather than
  // discovering it message-by-message once the bot is already live in a 10k-member group.
  await getProfile();

  const rateLimiter = makeRateLimiter(config.maxAiPerMinute);
  const pipeline = makeIngestPipeline({ config, apiClient, store, getIdToken: auth.getIdToken, getProfile, rateLimiter });
  const bot = makeIngestBot({ config, store, pipeline });

  await bot.launch();
  const chats = await store.listChats();
  console.log(`sng-one telegram ingest bot running as ${config.serviceEmail} - watching ${chats.filter((c) => c.status === 'active').length} active source group(s)`);

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    bot.stop(signal);
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start the Telegram ingest bot:', err.message);
  process.exit(1);
});
