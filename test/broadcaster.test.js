import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBroadcaster } from '../src/broadcaster.js';

const ROW = {
  id: 1, status: 'active', origin_city: 'Tashkent, UZ', dest_city: 'Moscow, RU', equip: 'T', fp: 'Full',
  weight_t: '20.00', volume_m3: null, pickup_date: '2026-03-15', delivery_date: null, distance_km: 3200,
  rate_usd: '1500.00', commodity: 'Furniture', notes: '', company_name: 'Acme', contact_name: 'Bek',
  contact_phone: '+998901234567', contact_email: 'bek@example.com', contact_tg: '@bek',
};

function makeFixture({ listRow = ROW } = {}) {
  const pool = { query: async (sql) => (sql.includes('FROM loads') ? { rows: listRow ? [listRow] : [] } : { rows: [] }) };
  const sent = [];
  const removed = [];
  const store = {
    listActiveChatIds: async () => [111, 222, 333],
    markChatRemoved: async (id) => removed.push(id),
  };
  const bot = {
    telegram: {
      sendMessage: async (chatId, text) => {
        if (chatId === 222) { const e = new Error('bot was blocked'); e.response = { error_code: 403 }; throw e; }
        sent.push({ chatId, text });
      },
    },
  };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: 'x', broadcastSpacingMs: 0, broadcastLang: 'en', webBaseUrl: 'https://sng.example' },
    pool, store, bot, log: { warn() {}, error() {} },
  });
  return { broadcaster, sent, removed };
}

test('a new load is sent to every active chat, with its own link to the web board', async () => {
  const { broadcaster, sent, removed } = makeFixture();
  await broadcaster._handleEvent({ entity: 'loads', op: 'insert', id: 1, ownerId: 7 });
  assert.deepEqual(sent.map((s) => s.chatId), [111, 333]); // 222 "failed" with 403
  assert.match(sent[0].text, /Tashkent, UZ → Moscow, RU/);
  assert.match(sent[0].text, /href="https:\/\/sng\.example\/\?load=1"/);
  assert.deepEqual(removed, [222]); // and was dropped from the chat list
});

test('ignores events that are not a load insert', async () => {
  const { broadcaster, sent } = makeFixture();
  await broadcaster._handleEvent({ entity: 'loads', op: 'update', id: 1 });
  await broadcaster._handleEvent({ entity: 'trucks', op: 'insert', id: 1 });
  await broadcaster._handleEvent({ entity: 'resync' });
  assert.equal(sent.length, 0);
});

test('skips a load that was already closed again by the time it fetches it', async () => {
  const { broadcaster, sent } = makeFixture({ listRow: { ...ROW, status: 'closed' } });
  await broadcaster._handleEvent({ entity: 'loads', op: 'insert', id: 1 });
  assert.equal(sent.length, 0);
});

test('skips silently if the row is gone (race with a delete)', async () => {
  const { broadcaster, sent } = makeFixture({ listRow: null });
  await broadcaster._handleEvent({ entity: 'loads', op: 'insert', id: 999 });
  assert.equal(sent.length, 0);
});
