// What the bot sends to the API on a member's behalf. Two kinds of stored link:
//  * "sng:<session>"  - a session the SERVER issued after /link (phone + 4-digit PIN). Valid ~180 days, renewed
//                       automatically while it is used; it ends at once if the member changes their PIN.
//  * anything else    - an older link made with e-mail + password (Firebase refresh token); Firebase ID tokens last
//                       1 hour, so they are refreshed a little before they expire and the rotated token is stored.
// A short in-memory cache avoids doing that work on every message.

export class NotLinkedError extends Error {}

export const OWN_PREFIX = 'sng:';
const RENEW_WHEN_LEFT_MS = 30 * 86_400_000;

/** Expiry (ms) of one of our session tokens, read from its payload (the server still verifies the signature). */
export function sessionExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000;
  } catch { return 0; }
}

export function makeTokenManager({ store, firebaseAuth, apiClient }) {
  const cache = new Map(); // telegramUserId -> { idToken, expiresAt }

  async function ownSession(telegramUserId, token) {
    const expiresAt = sessionExpiryMs(token);
    if (!expiresAt || expiresAt <= Date.now()) { throw new NotLinkedError('session expired'); }
    if (expiresAt - Date.now() < RENEW_WHEN_LEFT_MS && apiClient) {
      try {
        const fresh = await apiClient.refreshSession(token);
        await store.updateRefreshToken(telegramUserId, `${OWN_PREFIX}${fresh.token}`);
        cache.set(telegramUserId, { idToken: fresh.token, expiresAt: Date.now() + 10 * 60_000 });
        return fresh.token;
      } catch (err) {
        if (err?.status === 401) throw new NotLinkedError('session ended'); // PIN changed or account blocked: link again
        // any other failure (network): keep using the token we have, try renewing next time
      }
    }
    cache.set(telegramUserId, { idToken: token, expiresAt: Date.now() + 10 * 60_000 });
    return token;
  }

  async function getIdToken(telegramUserId) {
    const cached = cache.get(telegramUserId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.idToken;

    const link = await store.getLinkByTelegramUserId(telegramUserId);
    if (!link) throw new NotLinkedError('not linked');
    if (link.refreshToken.startsWith(OWN_PREFIX)) return ownSession(telegramUserId, link.refreshToken.slice(OWN_PREFIX.length));

    const { idToken, refreshToken, expiresInSec } = await firebaseAuth.refreshIdToken(link.refreshToken);
    await store.updateRefreshToken(telegramUserId, refreshToken);
    cache.set(telegramUserId, { idToken, expiresAt: Date.now() + expiresInSec * 1000 });
    return idToken;
  }

  function invalidate(telegramUserId) { cache.delete(telegramUserId); }

  return { getIdToken, invalidate };
}
