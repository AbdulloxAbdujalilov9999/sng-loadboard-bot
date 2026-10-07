// Firebase ID tokens last 1 hour. Rather than mint one on every message, keep a short in-memory
// cache per Telegram user and refresh it (via the stored refresh token) a little before it expires.
// The refreshed token is persisted immediately, since Firebase rotates the refresh token on every use.

export class NotLinkedError extends Error {}

export function makeTokenManager({ store, firebaseAuth }) {
  const cache = new Map(); // telegramUserId -> { idToken, expiresAt }

  async function getIdToken(telegramUserId) {
    const cached = cache.get(telegramUserId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.idToken;

    const link = await store.getLinkByTelegramUserId(telegramUserId);
    if (!link) throw new NotLinkedError('not linked');

    const { idToken, refreshToken, expiresInSec } = await firebaseAuth.refreshIdToken(link.refreshToken);
    await store.updateRefreshToken(telegramUserId, refreshToken);
    cache.set(telegramUserId, { idToken, expiresAt: Date.now() + expiresInSec * 1000 });
    return idToken;
  }

  function invalidate(telegramUserId) { cache.delete(telegramUserId); }

  return { getIdToken, invalidate };
}
