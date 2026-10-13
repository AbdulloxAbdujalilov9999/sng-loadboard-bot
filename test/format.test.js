import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatLoadMessage, joinLines, formatDraftBlock, draftToRow, isDraftPostable } from '../src/format.js';

const ROW = {
  origin_city: 'Tashkent, UZ', dest_city: 'Moscow, RU', equip: 'T', fp: 'Full', weight_t: '20.00',
  volume_m3: null, pickup_date: '2026-03-15', delivery_date: null, distance_km: 3200, rate_usd: '1500.00',
  commodity: 'Furniture', notes: '', company_name: 'Acme Logistics', contact_name: 'Bek',
  contact_phone: '+998901234567', contact_email: 'bek@example.com', contact_tg: '@bek',
};

test('formats a load into a readable Telegram message', () => {
  const msg = formatLoadMessage(ROW);
  assert.match(msg, /Tashkent, UZ → Moscow, RU/);
  assert.match(msg, /Tent\/Tilt/);
  assert.match(msg, /20 t/);
  assert.match(msg, /2026-03-15/);
  assert.match(msg, /3200 km/);
  assert.match(msg, /\$1,500/);
  assert.match(msg, /Acme Logistics/);
  assert.match(msg, /@bek/);
});

test('escapes HTML-sensitive characters in free text fields', () => {
  const row = { ...ROW, commodity: '<script>alert(1)</script> & co' };
  const msg = formatLoadMessage(row);
  assert.doesNotMatch(msg, /<script>/);
  assert.match(msg, /&lt;script&gt;/);
  assert.match(msg, /&amp; co/);
});

test('escapeHtml handles null/undefined safely', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('omits distance when unknown (e.g. the /postload preview, computed only on the server)', () => {
  const msg = formatLoadMessage({ ...ROW, distance_km: null });
  assert.doesNotMatch(msg, / km/);
  assert.match(msg, /\$1,500/);
});

test('localizes equipment, load type and dates into Russian and Uzbek', () => {
  const ru = formatLoadMessage(ROW, 'ru');
  assert.match(ru, /Тент/);
  assert.match(ru, /Полная/);
  assert.match(ru, /Погрузка 2026-03-15/);

  const uz = formatLoadMessage({ ...ROW, fp: 'Partial', delivery_date: '2026-03-20' }, 'uz');
  assert.match(uz, /Shtorali/);
  assert.match(uz, /Qisman/);
  assert.match(uz, /Olib ketish 2026-03-15 → yetkazish 2026-03-20/);
});

test('appends a link to the load on the web board when given one', () => {
  const withLink = formatLoadMessage(ROW, 'en', 'https://sng.example/?load=42');
  assert.match(withLink, /<a href="https:\/\/sng\.example\/\?load=42">🔗 View on the loadboard<\/a>/);
  const withoutLink = formatLoadMessage(ROW, 'en');
  assert.doesNotMatch(withoutLink, /<a href/);
});

test('shows the poster\'s name once, not twice, when company and contact name are the same', () => {
  const row = { ...ROW, company_name: 'Abdulloh Abdujalilov', contact_name: 'Abdulloh Abdujalilov' };
  const msg = formatLoadMessage(row);
  assert.equal((msg.match(/Abdulloh Abdujalilov/g) ?? []).length, 1);
});

test('shows both company and contact name when they differ', () => {
  const msg = formatLoadMessage(ROW); // company_name: 'Acme Logistics', contact_name: 'Bek'
  assert.match(msg, /Acme Logistics \(Bek\)/);
});

test('joinLines invites the configured channel/group, in every language, with no leading "@@"', () => {
  const cfg = { joinChannel: 'sngOne_yuklar', joinGroup: '@sngOne_yuklarr' }; // either form of the handle works
  assert.equal(joinLines(cfg, 'en'), '📢 Channel: @sngOne_yuklar\n💬 Group: @sngOne_yuklarr');
  assert.match(joinLines(cfg, 'ru'), /Канал: @sngOne_yuklar/);
  assert.match(joinLines(cfg, 'uz'), /Kanal: @sngOne_yuklar/);
});

test('joinLines is empty when neither is configured, and shows just one line when only one is', () => {
  assert.equal(joinLines({}, 'en'), '');
  assert.equal(joinLines({ joinChannel: 'sngOne_yuklar' }, 'en'), '📢 Channel: @sngOne_yuklar');
  assert.equal(joinLines({ joinGroup: 'sngOne_yuklarr' }, 'en'), '💬 Group: @sngOne_yuklarr');
});

test('a rate of 0 is shown as "negotiable" in every language, never as $0', () => {
  const row = { origin_city: 'A, UZ', dest_city: 'B, RU', equip: 'T', fp: 'Full', weight_t: 20, commodity: 'x', pickup_date: '2026-10-10', rate_usd: '0.00', company_name: 'Co', contact_name: 'n' };
  assert.match(formatLoadMessage(row, 'en'), /💰 Negotiable/);
  assert.match(formatLoadMessage(row, 'ru'), /💰 Договорная/);
  assert.match(formatLoadMessage(row, 'uz'), /💰 Kelishilgan/);
  assert.ok(!formatLoadMessage(row, 'en').includes('$0'));
  assert.match(formatLoadMessage({ ...row, rate_usd: '1500.00' }, 'en'), /💰 \$1,500/, 'real prices are unchanged');
});

// ---------------------------------------------------------------- /paste (AI import review)
const DRAFT = {
  originCityId: 1, originCity: 'Kazan, RU', originText: 'Казань',
  destCityId: 2, destCity: 'Tashkent, UZ', destText: 'Тошкент',
  equip: 'T', fp: 'Full', weightT: 23, volumeM3: null, pickupDate: '2026-10-15', rateUsd: 0,
  commodity: 'Granule', notes: '', contactPhone: '', contactTelegram: '', contactName: '', flags: [], status: 'pending',
};
const MEMBER = { contactName: 'Bek', company: 'Acme Logistics', phone: '+998901234567', telegram: '@bek', contactEmail: 'bek@example.com' };

test('a resolved draft is postable; one with a missing or duplicate city is not', () => {
  assert.equal(isDraftPostable(DRAFT), true);
  assert.equal(isDraftPostable({ ...DRAFT, originCityId: null }), false);
  assert.equal(isDraftPostable({ ...DRAFT, destCityId: null }), false);
  assert.equal(isDraftPostable({ ...DRAFT, destCityId: DRAFT.originCityId }), false);
});

test('draftToRow builds the same row shape formatLoadMessage expects, falling back to the member\'s own contact', () => {
  const row = draftToRow(DRAFT, MEMBER);
  const msg = formatLoadMessage(row, 'en');
  assert.match(msg, /Kazan, RU → Tashkent, UZ/);
  assert.match(msg, /Acme Logistics/);
  assert.match(msg, /\+998901234567/);
});

test('draftToRow prefers the draft\'s own contact info over the member\'s', () => {
  const draft = { ...DRAFT, contactPhone: '+77001112233', contactTelegram: '@poster', contactName: 'Poster' };
  const row = draftToRow(draft, MEMBER);
  assert.equal(row.contact_phone, '+77001112233');
  assert.equal(row.contact_tg, '@poster');
  assert.equal(row.contact_name, 'Poster');
});

test('formatDraftBlock numbers the draft and shows a blocking flag with the 🚫 marker, not a soft warning', () => {
  const block = formatDraftBlock({ ...DRAFT, destCityId: null, flags: ['dest'] }, 2, 'en', MEMBER);
  assert.match(block, /#2 🚫/);
  assert.match(block, /destination city not recognized/);
});

test('formatDraftBlock shows a soft warning (amber flag) without the 🚫 marker when the city is a guess', () => {
  const block = formatDraftBlock({ ...DRAFT, flags: ['origin_check'] }, 1, 'en', MEMBER);
  assert.doesNotMatch(block, /#1 🚫/);
  assert.match(block, /⚠️.*origin city is a guess/);
});

test('formatDraftBlock shows a short outcome line once a draft is posted or skipped, with no flags', () => {
  const posted = formatDraftBlock({ ...DRAFT, status: 'posted' }, 1, 'en', MEMBER);
  assert.match(posted, /#1 ✅.*published/);
  const skipped = formatDraftBlock({ ...DRAFT, status: 'skipped' }, 3, 'en', MEMBER);
  assert.match(skipped, /#3 ⏭.*skipped/);
});

test('formatDraftBlock localizes flags into Russian and Uzbek', () => {
  const ru = formatDraftBlock({ ...DRAFT, flags: ['weight'] }, 1, 'ru', MEMBER);
  assert.match(ru, /вес не указан/);
  const uz = formatDraftBlock({ ...DRAFT, flags: ['rate'] }, 1, 'uz', MEMBER);
  assert.match(uz, /narx ko'rsatilmagan/);
});
