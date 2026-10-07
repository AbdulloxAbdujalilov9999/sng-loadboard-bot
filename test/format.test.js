import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatLoadMessage } from '../src/format.js';

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

test('a rate of 0 is shown as "negotiable" in every language, never as $0', () => {
  const row = { origin_city: 'A, UZ', dest_city: 'B, RU', equip: 'T', fp: 'Full', weight_t: 20, commodity: 'x', pickup_date: '2026-10-10', rate_usd: '0.00', company_name: 'Co', contact_name: 'n' };
  assert.match(formatLoadMessage(row, 'en'), /💰 Negotiable/);
  assert.match(formatLoadMessage(row, 'ru'), /💰 Договорная/);
  assert.match(formatLoadMessage(row, 'uz'), /💰 Kelishilgan/);
  assert.ok(!formatLoadMessage(row, 'en').includes('$0'));
  assert.match(formatLoadMessage({ ...row, rate_usd: '1500.00' }, 'en'), /💰 \$1,500/, 'real prices are unchanged');
});
