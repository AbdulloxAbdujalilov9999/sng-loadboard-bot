// Encrypts the one secret this process stores at rest: each linked member's Firebase refresh
// token (equivalent to "stay signed in forever" - worth protecting even though it cannot read
// the member's password). AES-256-GCM with a key from BOT_ENCRYPTION_KEY; never logged, never
// sent to Telegram or the API.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function makeCrypto(encryptionKeyBase64) {
  const key = Buffer.from(encryptionKeyBase64, 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (base64-encoded)');

  function encrypt(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
  }

  function decrypt(packed) {
    const [ivB64, tagB64, encB64] = String(packed).split('.');
    if (!ivB64 || !tagB64 || !encB64) throw new Error('malformed ciphertext');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}
