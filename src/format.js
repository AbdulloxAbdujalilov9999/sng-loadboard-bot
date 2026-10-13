// Turns a `loads` row (same snake_case shape server/src/routes/loads.js inserts/returns) into the
// message broadcast to every group, and into the confirmation preview shown inside /postload.
// Pure functions - no I/O - so they're covered by bot/test without a database or Telegram.
import { t } from './i18n.js';

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A rate of 0 means "not stated / negotiable" (the web board shows it the same way), never "$0".
const money = (n, lang = 'en') => (n === null || n === undefined ? '-' : Number(n) === 0 ? t(lang, 'msg_negotiable') : `$${Number(n).toLocaleString('en-US')}`);

/** `linkUrl`, when given, becomes a "view on the loadboard" line - see bot/src/broadcaster.js. */
export function formatLoadMessage(row, lang = 'en', linkUrl = null) {
  const equip = t(lang, `eq_${row.equip}`);
  const fp = t(lang, row.fp === 'Full' ? 'wiz_fp_full' : 'wiz_fp_partial');
  const pickup = row.delivery_date
    ? t(lang, 'msg_pickup_delivery', { date: row.pickup_date, date2: row.delivery_date })
    : t(lang, 'msg_pickup', { date: row.pickup_date });
  // One fact per line (each tagged by its own emoji, no label text to translate) - easier to scan
  // in a group chat than the old layout, which crammed equip+fp+weight and distance+rate together.
  const lines = [
    `🚚 <b>${escapeHtml(row.origin_city)} → ${escapeHtml(row.dest_city)}</b>`,
    '',
    `🔧 ${equip} (${fp})`,
    `⚖️ ${Number(row.weight_t)} t${row.volume_m3 ? ` · ${row.volume_m3} m³` : ''}`,
    `📦 ${escapeHtml(row.commodity)}`,
    `📅 ${pickup}`,
  ];
  if (row.distance_km) lines.push(`📏 ${row.distance_km} km`);
  lines.push(`💰 ${money(row.rate_usd, lang)}`);
  if (row.notes) lines.push(`📝 ${escapeHtml(row.notes)}`);
  lines.push('');
  // Company and contact name are often the same person/one-person company - show it once, not twice.
  const name = row.company_name && row.company_name !== row.contact_name
    ? `${row.company_name} (${row.contact_name})`
    : (row.contact_name || row.company_name);
  if (name) lines.push(escapeHtml(name));
  const contact = [row.contact_phone, row.contact_tg, row.contact_email].filter(Boolean).map(escapeHtml);
  if (contact.length) lines.push(contact.join(' · '));
  if (linkUrl) lines.push('', `<a href="${escapeHtml(linkUrl)}">${t(lang, 'msg_view_on_board')}</a>`);
  return lines.join('\n');
}

export function formatLoadPreview(row, lang = 'en') {
  return `${formatLoadMessage(row, lang)}\n\n<i>${t(lang, 'wiz_preview_footer')}</i>`;
}

/**
 * Our own official channel/group, as a line (or two) to append to the welcome message, the
 * /postload confirmation, and every broadcast message - see bot.js, wizard.js and broadcaster.js.
 * `config` is bot config (`joinChannel`/`joinGroup`, see config.js) - both optional, so this is ''
 * (append nothing) when neither is set.
 */
export function joinLines(config, lang = 'en') {
  const at = (handle) => `@${String(handle).replace(/^@/, '')}`; // config.js already strips "@" - also guard here against a bare "@handle" passed directly
  const lines = [];
  if (config.joinChannel) lines.push(t(lang, 'join_channel', { handle: at(config.joinChannel) }));
  if (config.joinGroup) lines.push(t(lang, 'join_group', { handle: at(config.joinGroup) }));
  return lines.join('\n');
}

// ---------------------------------------------------------------- /paste (AI import review)
const FLAG_ORDER = ['origin', 'dest', 'same_city', 'origin_check', 'dest_check', 'weight', 'date', 'rate'];
// Flags that mean "could not resolve a city" - these drafts are excluded from posting (the API
// would reject the whole bulk batch otherwise) and listed separately so the member can fix the
// wording and paste that one load again.
const BLOCKING_FLAGS = new Set(['origin', 'dest', 'same_city']);

/** Whether a parsed draft has everything POST /api/loads (or /bulk) needs to accept it. */
export function isDraftPostable(draft) {
  return Boolean(draft.originCityId) && Boolean(draft.destCityId) && draft.originCityId !== draft.destCityId;
}

/** A draft (camelCase, from /api/ai/parse-loads, possibly mid-edit) as the snake_case row
 * formatLoadMessage expects - with the member's own contact as the shown fallback, exactly what
 * would actually be posted. */
export function draftToRow(draft, member) {
  return {
    origin_city: draft.originCity || draft.originText || '?',
    dest_city: draft.destCity || draft.destText || '?',
    equip: draft.equip, fp: draft.fp, weight_t: draft.weightT, volume_m3: draft.volumeM3,
    commodity: draft.commodity, pickup_date: draft.pickupDate, delivery_date: null, distance_km: null,
    rate_usd: draft.rateUsd, notes: draft.notes,
    company_name: member.company,
    contact_name: draft.contactName || member.contactName || member.company || '-',
    contact_phone: draft.contactPhone || member.phone || '',
    contact_email: member.contactEmail || '',
    contact_tg: draft.contactTelegram || member.telegram || '',
  };
}

function flagText(lang, flag) {
  const key = `flag_${flag}`;
  const s = t(lang, key);
  return s === key ? null : s;
}

/** The per-draft review block for /paste: the same message shape it would be posted/broadcast as,
 * plus a number, a 🚫/⚠️ status line for anything the AI had to guess or couldn't resolve, and -
 * once acted on - a one-line outcome instead of the live preview. */
export function formatDraftBlock(draft, idx, lang, member) {
  if (draft.status === 'posted') return `#${idx} ✅ ${escapeHtml(draft.originCity || draft.originText)} → ${escapeHtml(draft.destCity || draft.destText)} — ${t(lang, 'draft_published')}`;
  if (draft.status === 'skipped') return `#${idx} ⏭ ${escapeHtml(draft.originCity || draft.originText)} → ${escapeHtml(draft.destCity || draft.destText)} — ${t(lang, 'draft_skipped')}`;

  const postable = isDraftPostable(draft);
  const body = formatLoadMessage(draftToRow(draft, member), lang);
  const flags = (draft.flags ?? []).filter((f) => FLAG_ORDER.includes(f)).sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b));
  const blocking = flags.filter((f) => BLOCKING_FLAGS.has(f)).map((f) => flagText(lang, f)).filter(Boolean);
  const warnings = flags.filter((f) => !BLOCKING_FLAGS.has(f)).map((f) => flagText(lang, f)).filter(Boolean);
  const tail = [];
  if (blocking.length) tail.push(`🚫 <i>${blocking.join(' · ')}</i>`);
  if (warnings.length) tail.push(`⚠️ <i>${warnings.join(' · ')}</i>`);
  const header = `<b>#${idx}${postable ? '' : ' 🚫'}</b>`;
  return [header, body, ...tail].join('\n');
}
