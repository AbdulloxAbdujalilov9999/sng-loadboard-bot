// Per-message pipeline: cheap filter -> claim (dedupe against redelivery/restart) -> the same AI
// parser the web app's "paste from Telegram" feature uses -> per-load fingerprint dedupe -> post
// through the real API. No load is ever built or inserted here directly - createLoad below is the
// exact same door server/src/routes/loads.js guards for everyone else, so quotas, city validation
// and every CHECK constraint apply to an auto-imported load exactly as they do to a human's.
import { createHash } from 'node:crypto';
import { looksLikeLoad } from './ingestFilter.js';
import { ApiError } from './apiClient.js';

// Spaces out AI calls to a fixed rate, independent of how bursty a group gets - well under both
// the per-account hourly AI budget (server/src/routes/ai.js) and Gemini's own rate limits.
export function makeRateLimiter(perMinute) {
  const minGapMs = 60_000 / Math.max(1, perMinute);
  let next = 0;
  return async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minGapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

const normPhone = (s) => String(s ?? '').replace(/\D/g, '').slice(-10); // last 10 digits: ignores +998/8/+7 country-code variants
const normTg = (s) => String(s ?? '').toLowerCase().replace(/^@/, '');

// Same route + pickup date + whoever's contact info it carries = the same load, however many times
// (or however many groups) it gets reposted in.
export function fingerprintFor(draft) {
  const contact = normPhone(draft.contactPhone) || normTg(draft.contactTelegram);
  const basis = [draft.originCityId, draft.destCityId, draft.pickupDate, contact].join('|');
  return createHash('sha1').update(basis).digest('hex');
}

// contactPhone/contactTelegram/contactName/contactEmail are REQUIRED by loadBody (server/src/lib/schemas.js).
// A group post almost always has a phone but rarely an e-mail, and sometimes no @handle - exactly the gap the
// web app's AI-import screen fills with the IMPORTING MEMBER's own profile (web/js/aiimport.js's shared
// contact box). Here the service account's profile plays that same role.
export function toLoadBody(draft, profile) {
  const estimated = draft.flags?.length ? ` · auto-import: ${draft.flags.join(', ')} estimated - confirm by phone` : '';
  const notes = `${draft.notes || ''}${estimated}`.trim().slice(0, 500);
  return {
    originCityId: draft.originCityId,
    destCityId: draft.destCityId,
    equip: draft.equip,
    fp: draft.fp,
    weightT: draft.weightT,
    pickupDate: draft.pickupDate,
    rateUsd: draft.rateUsd,
    commodity: draft.commodity,
    notes: notes || undefined,
    contactName: draft.contactName || profile.contactName || profile.company,
    contactPhone: draft.contactPhone || profile.phone,
    contactEmail: profile.contactEmail || profile.email,
    contactTelegram: draft.contactTelegram || profile.telegram,
  };
}

export function makeIngestPipeline({ config, apiClient, store, getIdToken, getProfile, rateLimiter, log = console }) {
  async function handleMessage({ chatId, messageId, text }) {
    if (!looksLikeLoad(text, { minChars: config.minChars, requireContact: config.requireContact })) return;

    const claimed = await store.claimMessage(chatId, messageId);
    if (!claimed) return; // already seen (redelivery or restart) - never double-process

    try {
      const [idToken, profile] = await Promise.all([getIdToken(), getProfile()]);
      await rateLimiter();
      const { loads } = await apiClient.parseLoads(idToken, text);
      if (!loads.length) {
        await store.finalizeMessage(chatId, messageId, { status: 'skipped_no_load' });
        return;
      }

      const postedIds = [];
      const notes = [];
      for (const draft of loads) {
        if (!draft.originCityId || !draft.destCityId) { notes.push('unresolved city'); continue; }

        const fp = fingerprintFor(draft);
        const existingLoadId = await store.claimFingerprint(fp, config.dedupeWindowHours);
        if (existingLoadId) { notes.push(`duplicate of load ${existingLoadId}`); continue; }

        try {
          const created = await apiClient.createLoad(idToken, toLoadBody(draft, profile));
          postedIds.push(created.id);
          await store.attachFingerprintLoad(fp, created.id);
        } catch (err) {
          notes.push(err instanceof ApiError ? `post failed: ${err.code}` : 'post failed');
        }
      }

      await store.bumpChatPosted(chatId, postedIds.length);
      const status = postedIds.length === loads.length ? 'posted'
        : postedIds.length > 0 ? 'partial'
        : notes.some((n) => n.startsWith('unresolved')) ? 'skipped_unresolved' : 'skipped_duplicate';
      await store.finalizeMessage(chatId, messageId, { status, loadIds: postedIds, detail: notes.join('; ') });
    } catch (err) {
      log.error?.(`ingest message ${chatId}/${messageId} failed: ${err.message}`);
      await store.finalizeMessage(chatId, messageId, { status: 'error', detail: String(err.message).slice(0, 2000) }).catch(() => {});
    }
  }

  return { handleMessage };
}
