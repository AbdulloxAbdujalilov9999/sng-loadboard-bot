import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintFor, toLoadBody, makeRateLimiter, makeIngestPipeline } from '../src/ingestPipeline.js';

const DRAFT = {
  originCityId: 1, destCityId: 2, equip: 'T', fp: 'Full', weightT: 20, pickupDate: '2026-03-15',
  rateUsd: 1500, commodity: 'General cargo', notes: '', contactName: '', contactPhone: '+998901234567',
  contactTelegram: '', flags: [],
};
const PROFILE = { company: 'SNG ONE Auto-Import', contactName: 'Dispatch', phone: '+998900000000', telegram: '@sngone', contactEmail: 'ingest@sng-one.app', email: 'ingest@sng-one.app' };

test('fingerprint is stable for the same route/date/phone regardless of phone formatting', () => {
  const a = fingerprintFor(DRAFT);
  const b = fingerprintFor({ ...DRAFT, contactPhone: '998901234567' });
  const c = fingerprintFor({ ...DRAFT, contactPhone: '8 (90) 123-45-67' });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('fingerprint differs when the route or date differs', () => {
  const a = fingerprintFor(DRAFT);
  assert.notEqual(a, fingerprintFor({ ...DRAFT, destCityId: 3 }));
  assert.notEqual(a, fingerprintFor({ ...DRAFT, pickupDate: '2026-03-16' }));
});

test('fingerprint falls back to the telegram handle when there is no phone', () => {
  const a = fingerprintFor({ ...DRAFT, contactPhone: '', contactTelegram: '@BekDispatch' });
  const b = fingerprintFor({ ...DRAFT, contactPhone: '', contactTelegram: 'bekdispatch' });
  assert.equal(a, b);
});

test('toLoadBody fills missing contact fields from the service account profile', () => {
  const body = toLoadBody({ ...DRAFT, contactTelegram: '' }, PROFILE);
  assert.equal(body.contactPhone, DRAFT.contactPhone); // draft's own phone wins
  assert.equal(body.contactTelegram, PROFILE.telegram); // profile fills the gap
  assert.equal(body.contactEmail, PROFILE.contactEmail); // always the service account's own e-mail
  assert.equal(body.contactName, PROFILE.contactName);
});

test('toLoadBody appends a transparency note when fields were estimated, and clips to 500 chars', () => {
  const longNotes = 'x'.repeat(480);
  const body = toLoadBody({ ...DRAFT, notes: longNotes, flags: ['weight', 'date'] }, PROFILE);
  assert.ok(body.notes.includes('auto-import'));
  assert.ok(body.notes.length <= 500);
});

test('toLoadBody omits notes entirely when there is nothing to say', () => {
  const body = toLoadBody({ ...DRAFT, notes: '', flags: [] }, PROFILE);
  assert.equal(body.notes, undefined);
});

test('rate limiter spaces out calls to roughly the configured rate', async () => {
  const throttle = makeRateLimiter(120); // one every 500ms
  const start = Date.now();
  await throttle();
  await throttle();
  await throttle();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 900, `expected ~1000ms for 2 gaps, got ${elapsed}ms`);
});

test('pipeline never processes the same (chat, message) twice', async () => {
  let claimAttempts = 0;
  let parseCalls = 0;
  const store = {
    claimMessage: async () => (claimAttempts += 1) === 1, // true once, then false (already claimed)
    finalizeMessage: async () => {},
  };
  const apiClient = { parseLoads: async () => { parseCalls += 1; return { loads: [] }; } };
  const pipeline = makeIngestPipeline({
    config: { minChars: 1, requireContact: false, dedupeWindowHours: 1 },
    apiClient, store, getIdToken: async () => 'tok', getProfile: async () => PROFILE,
    rateLimiter: async () => {}, log: { error: () => {} },
  });
  const text = '🇷🇺 A 🇰🇿 B ТЕНТ ОПЛАТА НАХТ +998901234567';
  await pipeline.handleMessage({ chatId: 1, messageId: 1, text });
  await pipeline.handleMessage({ chatId: 1, messageId: 1, text }); // Telegram redelivered the same update
  assert.equal(claimAttempts, 2); // both tried to claim
  assert.equal(parseCalls, 1); // only the first ever reached the AI
});

test('pipeline skips drafts with no resolvable city and does not post them', async () => {
  const finalized = [];
  const store = {
    claimMessage: async () => true,
    finalizeMessage: async (chatId, messageId, info) => finalized.push(info),
    claimFingerprint: async () => null,
    attachFingerprintLoad: async () => {},
    bumpChatPosted: async () => {},
  };
  const apiClient = {
    parseLoads: async () => ({ loads: [{ ...DRAFT, originCityId: null }] }),
    createLoad: async () => { throw new Error('should not post an unresolved draft'); },
  };
  const pipeline = makeIngestPipeline({
    config: { minChars: 1, requireContact: false, dedupeWindowHours: 1 },
    apiClient, store, getIdToken: async () => 'tok', getProfile: async () => PROFILE,
    rateLimiter: async () => {}, log: { error: () => {} },
  });
  await pipeline.handleMessage({ chatId: 1, messageId: 1, text: '🇷🇺 МОСКВА 🇰🇿 АЛМАТЫ ТЕНТ ОПЛАТА НАХТ' });
  assert.equal(finalized[0].status, 'skipped_unresolved');
  assert.deepEqual(finalized[0].loadIds, []);
});
