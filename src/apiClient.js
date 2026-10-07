// Every write the bot makes goes through the real HTTP API, with the member's own ID token - the
// exact same door the web app uses. This means quotas, validation, CHECK constraints and the
// "default contact info" prefill behave identically no matter whether a load was posted from the
// browser or from Telegram, and there is only one place (server/src/routes/loads.js) that decides
// what a valid load looks like.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function makeApiClient({ baseUrl }) {
  async function request(idToken, method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? 'Request failed', err.details);
    }
    return data;
  }

  const getMe = (idToken) => request(idToken, 'GET', '/api/me');
  const searchCities = (idToken, q, limit = 6) =>
    request(idToken, 'GET', `/api/cities?q=${encodeURIComponent(q)}&limit=${limit}`);
  const createLoad = (idToken, body) => request(idToken, 'POST', '/api/loads', body);

  return { getMe, searchCities, createLoad };
}
