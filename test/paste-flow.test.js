import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLoadBody } from '../src/pasteFlow.js';

const DRAFT = {
  originCityId: 1, destCityId: 2, equip: 'T', fp: 'Full', weightT: 23, volumeM3: null,
  pickupDate: '2026-10-15', rateUsd: 0, commodity: 'Granule', notes: '',
  contactPhone: '', contactTelegram: '', contactName: '', flags: [],
};
const MEMBER = { contactName: 'Bek', company: 'Acme Logistics', phone: '+998901234567', telegram: '@bek', contactEmail: 'bek@example.com' };

test('falls back to the posting member\'s own contact info when the pasted text carried none', () => {
  const body = toLoadBody(DRAFT, MEMBER);
  assert.equal(body.contactPhone, MEMBER.phone);
  assert.equal(body.contactTelegram, MEMBER.telegram);
  assert.equal(body.contactName, MEMBER.contactName);
  assert.equal(body.contactEmail, MEMBER.contactEmail);
});

test('keeps the draft\'s own contact info when the pasted text carried one', () => {
  const draft = { ...DRAFT, contactPhone: '+77001112233', contactTelegram: '@poster', contactName: 'Poster' };
  const body = toLoadBody(draft, MEMBER);
  assert.equal(body.contactPhone, '+77001112233');
  assert.equal(body.contactTelegram, '@poster');
  assert.equal(body.contactName, 'Poster');
});

test('never posts an empty contact name - falls back to the member\'s company, then "-"', () => {
  assert.equal(toLoadBody(DRAFT, { ...MEMBER, contactName: '' }).contactName, 'Acme Logistics');
  assert.equal(toLoadBody(DRAFT, { ...MEMBER, contactName: '', company: '' }).contactName, '-');
});

test('appends a transparency note for every estimated field, so a guess is never presented as fact', () => {
  const draft = { ...DRAFT, flags: ['weight', 'rate'], notes: 'ASAP' };
  const body = toLoadBody(draft, MEMBER);
  assert.match(body.notes, /^ASAP/);
  assert.match(body.notes, /auto-import: weight, rate estimated - confirm by phone/);
});

test('carries origin/dest/equip/weight/date/rate/commodity through unchanged', () => {
  const body = toLoadBody(DRAFT, MEMBER);
  assert.equal(body.originCityId, 1);
  assert.equal(body.destCityId, 2);
  assert.equal(body.equip, 'T');
  assert.equal(body.fp, 'Full');
  assert.equal(body.weightT, 23);
  assert.equal(body.pickupDate, '2026-10-15');
  assert.equal(body.rateUsd, 0);
  assert.equal(body.commodity, 'Granule');
});
