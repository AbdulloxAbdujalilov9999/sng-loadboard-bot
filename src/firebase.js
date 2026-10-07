// Talks to Firebase's public Identity Toolkit REST API - the same thing the web app's Firebase SDK
// calls under the hood when someone signs in with e-mail + password. The bot has no special
// privilege here: it proves the password exactly as a browser would, and gets back the same kind
// of ID token the API already verifies in server/src/auth.js.
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_BASE = 'https://securetoken.googleapis.com/v1';

class FirebaseAuthError extends Error {
  constructor(code) {
    super(code);
    // Firebase's error codes sometimes carry extra detail after " : " (e.g. rate-limit messages);
    // the bare code is what i18n.js's fb_* keys are keyed on (see firebaseErrorKey below).
    this.code = code?.split(' : ')[0] ?? code;
  }
}

/** Maps a raw Firebase error code to one of i18n.js's fb_* keys (bot.js localizes it from there). */
export function firebaseErrorKey(code) {
  const known = ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'USER_DISABLED', 'TOKEN_EXPIRED', 'USER_NOT_FOUND'];
  return known.includes(code) ? `fb_${code.toLowerCase()}` : 'fb_generic';
}

async function call(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FirebaseAuthError(data?.error?.message || `http_${res.status}`);
  return data;
}

export function makeFirebaseAuth({ apiKey }) {
  /** Exchanges e-mail + password for ID/refresh tokens, exactly like the web app's sign-in form. */
  async function signInWithPassword(email, password) {
    const data = await call(`${IDENTITY_BASE}/accounts:signInWithPassword?key=${apiKey}`, {
      email, password, returnSecureToken: true,
    });
    // Firebase doesn't report email_verified on this endpoint; the ID token's claim is checked
    // server-side (server/src/auth.js) the moment we call the API with it.
    return { idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId };
  }

  /** Mints a fresh ID token from a stored refresh token. Firebase rotates the refresh token too. */
  async function refreshIdToken(refreshToken) {
    const data = await call(`${TOKEN_BASE}/token?key=${apiKey}`, {
      grant_type: 'refresh_token', refresh_token: refreshToken,
    });
    return { idToken: data.id_token, refreshToken: data.refresh_token, expiresInSec: Number(data.expires_in) };
  }

  return { signInWithPassword, refreshIdToken };
}

export { FirebaseAuthError };
