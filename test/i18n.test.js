import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the dictionaries the same way i18n.js exports them, without depending on Node's ESM loader
// quirks for the ad-hoc `vm` extraction the web app's own i18n test uses.
const src = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const DICT = vm.runInNewContext(`${src.slice(src.indexOf('const DICT'), src.indexOf('export function pickLang')).replace('const DICT', 'DICT')}; DICT`);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('English, Russian and Uzbek have exactly the same keys', () => {
  const keys = (l) => Object.keys(DICT[l]).sort();
  for (const lang of ['ru', 'uz']) {
    assert.deepEqual(keys(lang).filter((k) => !(k in DICT.en)), [], `${lang} has keys English lacks`);
    assert.deepEqual(keys('en').filter((k) => !(k in DICT[lang])), [], `${lang} is missing keys`);
  }
  assert.ok(keys('en').length > 50);
});

test('every translation keeps the same {placeholders} and none is empty', () => {
  for (const lang of ['ru', 'uz']) {
    for (const [k, v] of Object.entries(DICT[lang])) {
      assert.ok(String(v).trim(), `${lang}.${k} is empty`);
      assert.equal(placeholders(v), placeholders(DICT.en[k]), `${lang}.${k} placeholders differ from English`);
    }
  }
});

test('Uzbek and Russian are really translated (not left in English)', () => {
  const same = (lang) => Object.entries(DICT[lang]).filter(([k, v]) => v === DICT.en[k] && /[a-z]{4}/i.test(v));
  assert.deepEqual(same('uz').map(([k]) => k), [], 'untranslated Uzbek strings');
  assert.deepEqual(same('ru').map(([k]) => k), [], 'untranslated Russian strings');
});
