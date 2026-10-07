import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeCrypto } from '../src/crypto.js';

test('encrypt/decrypt round-trips a refresh token', () => {
  const key = randomBytes(32).toString('base64');
  const { encrypt, decrypt } = makeCrypto(key);
  const token = 'AMf-vBx_some.refresh-token-value';
  const packed = encrypt(token);
  assert.notEqual(packed, token);
  assert.equal(decrypt(packed), token);
});

test('a different key cannot decrypt', () => {
  const a = makeCrypto(randomBytes(32).toString('base64'));
  const b = makeCrypto(randomBytes(32).toString('base64'));
  const packed = a.encrypt('secret');
  assert.throws(() => b.decrypt(packed));
});

test('rejects a key that is not 32 bytes', () => {
  assert.throws(() => makeCrypto(Buffer.from('too-short').toString('base64')));
});
