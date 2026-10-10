import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeLoad } from '../src/ingestFilter.js';

test('rejects short messages before any AI call would be spent', () => {
  assert.equal(looksLikeLoad('ok'), false);
  assert.equal(looksLikeLoad(''), false);
  assert.equal(looksLikeLoad(null), false);
});

test('rejects plain chatter with no contact info by default', () => {
  assert.equal(looksLikeLoad('кто едет в Москву на следующей неделе, подскажите пожалуйста'), false);
});

test('accepts a realistic load post (flags + phone)', () => {
  const text = '🇷🇺 ТОМСК\n🇺🇿 ТАШКЕНТ\nДСП МДФ\nТЕНТ\nОПЛАТА НАХТ\n+998901234567';
  assert.equal(looksLikeLoad(text), true);
});

test('accepts a message with only an @handle as contact', () => {
  const text = 'Москва - Самарканд, тент 20т, оплата после разгрузки, пишите @dispatcher_bek пожалуйста';
  assert.equal(looksLikeLoad(text), true);
});

test('requireContact:false still needs a flag/freight signal, not just length', () => {
  const chatter = 'Доброе утро всем, как погода в чате сегодня, давно не писал';
  assert.equal(looksLikeLoad(chatter, { requireContact: false }), false);
  const load = '🇷🇺 МОСКВА 🇰🇿 АЛМАТЫ РЕФ ОПЛАТА НАХТ';
  assert.equal(looksLikeLoad(load, { requireContact: false }), true);
});

test('minChars is configurable', () => {
  const short = '🇷🇺 М 🇰🇿 А +998901234567';
  assert.equal(looksLikeLoad(short, { minChars: 50 }), false);
  assert.equal(looksLikeLoad(short, { minChars: 5 }), true);
});
