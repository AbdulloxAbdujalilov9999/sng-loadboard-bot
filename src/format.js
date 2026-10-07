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
  const lines = [
    `🚚 <b>${escapeHtml(row.origin_city)} → ${escapeHtml(row.dest_city)}</b>`,
    `${equip} · ${fp} · ${Number(row.weight_t)} t${row.volume_m3 ? ` · ${row.volume_m3} m³` : ''}`,
    `📦 ${escapeHtml(row.commodity)}`,
    `📅 ${pickup}`,
    row.distance_km ? `📏 ${row.distance_km} km · 💰 ${money(row.rate_usd, lang)}` : `💰 ${money(row.rate_usd, lang)}`,
  ];
  if (row.notes) lines.push(`📝 ${escapeHtml(row.notes)}`);
  lines.push('');
  lines.push(`${escapeHtml(row.company_name)} · ${escapeHtml(row.contact_name)}`);
  const contact = [row.contact_phone, row.contact_tg, row.contact_email].filter(Boolean).map(escapeHtml);
  if (contact.length) lines.push(contact.join(' · '));
  if (linkUrl) lines.push('', `<a href="${escapeHtml(linkUrl)}">${t(lang, 'msg_view_on_board')}</a>`);
  return lines.join('\n');
}

export function formatLoadPreview(row, lang = 'en') {
  return `${formatLoadMessage(row, lang)}\n\n<i>${t(lang, 'wiz_preview_footer')}</i>`;
}
