import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBroadcaster } from '../src/broadcaster.js';
import { loadBotConfig } from '../src/config.js';

const ROW = {
  id: 7, status: 'active', origin_city: 'Tomsk, RU', dest_city: 'Tashkent, UZ', equip: 'T', fp: 'Full', weight_t: '20', volume_m3: null,
  pickup_date: '2026-10-10', delivery_date: null, distance_km: 3200, rate_usd: '0', commodity: 'MDF', notes: '', company_name: 'Acme',
  contact_name: 'Bek', contact_phone: '+998901234567', contact_email: 'b@example.com', contact_tg: '@bek',
};
const pool = { query: async () => ({ rows: [ROW] }) };

function run({ send, config = {} }) {
  const sent = []; const removed = []; const slept = [];
  const bot = { telegram: { sendMessage: async (chatId, text) => { const r = await send(chatId, sent.length); sent.push({ chatId, text }); return r; } } };
  const store = { listActiveChatIds: async () => [1], markChatRemoved: async (id) => removed.push(id) };
  const b = makeBroadcaster({ config: { databaseUrl: 'x', broadcastSpacingMs: 0, broadcastLang: 'en', webBaseUrl: 'https://sng.example', ...config }, pool, store, bot, log: { warn() {}, error() {} }, sleep: async (ms) => { slept.push(ms); } });
  return { b, sent, removed, slept };
}
const tg = (code, extra = {}) => Object.assign(new Error(`telegram ${code}`), { response: { error_code: code, ...extra } });

test('waits exactly as long as Telegram says (retry_after) and then delivers', async () => {
  let calls = 0;
  const { b, slept } = run({ send: async () => { calls += 1; if (calls < 3) throw tg(429, { parameters: { retry_after: 7 } }); } });
  await b._handleEvent({ entity: 'loads', op: 'insert', id: 7 });
  assert.equal(calls, 3);
  assert.deepEqual(slept.filter((ms) => ms > 1000), [7250, 7250]);
});

test('gives up after a few throttles instead of looping forever, and does not drop the chat', async () => {
  let calls = 0;
  const { b, removed } = run({ send: async () => { calls += 1; throw tg(429, { parameters: { retry_after: 1 } }); } });
  await b._handleEvent({ entity: 'loads', op: 'insert', id: 7 });
  assert.equal(calls, 5);
  assert.deepEqual(removed, []);
});

test('a chat that no longer exists (400 chat not found) is dropped from the list', async () => {
  const { b, removed } = run({ send: async () => { throw tg(400, { description: 'Bad Request: chat not found' }); } });
  await b._handleEvent({ entity: 'loads', op: 'insert', id: 7 });
  assert.deepEqual(removed, [1]);
});

test('an unreachable (internal) public address is never broadcast as a dead link', async () => {
  const { b, sent } = run({ send: async () => {}, config: { webBaseUrl: 'http://sng-one:10000', webUrlIsPublic: false } });
  await b._handleEvent({ entity: 'loads', op: 'insert', id: 7 });
  assert.ok(!sent[0].text.includes('?load='), 'no link rather than a broken one');
});

test('config: PUBLIC_WEB_URL is classified public vs internal', () => {
  const base = { TELEGRAM_BOT_TOKEN: 't', DATABASE_URL: 'postgres://x', FIREBASE_WEB_API_KEY: 'k', BOT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
  const pub = (extra) => loadBotConfig({ ...base, ...extra }).webUrlIsPublic;
  assert.equal(pub({ PUBLIC_WEB_URL: 'https://sng-one.onrender.com' }), true);
  assert.equal(pub({ PUBLIC_WEB_URL: 'https://loads.example.uz/' }), true);
  assert.equal(pub({ API_BASE_URL: 'http://127.0.0.1:8080' }), false);
  assert.equal(pub({ API_BASE_URL: 'http://sng-one:10000' }), false);
  assert.equal(pub({ API_BASE_URL: 'http://sng-one:10000', PUBLIC_WEB_URL: 'https://sng.uz' }), true);
});
