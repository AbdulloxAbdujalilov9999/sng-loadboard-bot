// /link: connect this Telegram account to an SNG ONE member with the phone number and the 4-digit PIN the member chose
// on the website. (/linkemail keeps the older e-mail + password way, see bot.js.) The PIN message is deleted at once,
// and the server locks PIN sign-in for a phone number after 5 wrong tries, so the bot adds no new way to guess it.
import { Scenes, Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { escapeHtml } from './format.js';
import { OWN_PREFIX } from './tokens.js';
import { t } from './i18n.js';

/** "90 123 45 67", "998901234567", "+998 (90) 123-45-67" -> "+998901234567" (null when it is not a phone number). */
export function normalizePhone(raw) {
  let v = String(raw ?? '').trim().replace(/[\s()\-.]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (!v.startsWith('+')) {
    if (/^\d{9}$/.test(v)) v = `+998${v}`;          // a local Uzbek number
    else if (/^\d{10,15}$/.test(v)) v = `+${v}`;
  }
  return /^\+\d{8,15}$/.test(v) ? v : null;
}

/** Signs in with phone + PIN, checks the account may be linked, and stores the link. Returns { ok, ... } - never throws for expected failures. */
export async function performLink({ apiClient, store, tokens, from, phone, pin }) {
  let session;
  try {
    session = await apiClient.pinLogin(phone, pin);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { ok: false, reason: 'wrong' };
    if (err instanceof ApiError && err.status === 429) return { ok: false, reason: 'locked', min: err.details?.[0]?.params?.min ?? 15 };
    return { ok: false, reason: 'unreachable' };
  }
  let me;
  try { me = await apiClient.getMe(session.token); } catch { return { ok: false, reason: 'unreachable' }; }
  if (!me.profile) return { ok: false, reason: 'no_account' };
  if (me.profile.status !== 'approved') return { ok: false, reason: me.profile.status === 'rejected' ? 'blocked' : 'not_approved', status: me.profile.status };
  await store.saveLink({
    memberId: me.profile.id, telegramUserId: from.id, telegramUsername: from.username || '', refreshToken: `${OWN_PREFIX}${session.token}`,
  });
  tokens.invalidate(from.id);
  return { ok: true, company: me.profile.company };
}

const MAX_PIN_TRIES = 3;

export function makeLinkScene({ apiClient, store, tokens }) {
  const scene = new Scenes.BaseScene('link');

  scene.enter(async (ctx) => {
    ctx.scene.state.step = 'phone';
    ctx.scene.state.tries = 0;
    await ctx.reply(t(ctx.lang, 'link_ask_phone'), Markup.keyboard([[Markup.button.contactRequest(t(ctx.lang, 'link_share_phone'))]]).oneTime().resize());
  });

  const finish = (ctx, message) => ctx.reply(message, { parse_mode: 'HTML', ...Markup.removeKeyboard() }).then(() => ctx.scene.leave());
  scene.command('cancel', (ctx) => finish(ctx, t(ctx.lang, 'link_cancelled')));

  async function askPin(ctx, phone) {
    ctx.scene.state.phone = phone;
    ctx.scene.state.step = 'pin';
    await ctx.reply(t(ctx.lang, 'link_ask_pin'), Markup.removeKeyboard());
  }

  // "Share my number" button: only the person's OWN Telegram number is accepted.
  scene.on('contact', async (ctx) => {
    if (ctx.scene.state.step !== 'phone') return undefined;
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply(t(ctx.lang, 'link_contact_not_yours'));
    const phone = normalizePhone(c.phone_number);
    return phone ? askPin(ctx, phone) : ctx.reply(t(ctx.lang, 'link_bad_phone'));
  });

  scene.on('text', async (ctx) => {
    const state = ctx.scene.state;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return ctx.reply(t(ctx.lang, 'wiz_busy_finish_or_cancel'));

    if (state.step === 'phone') {
      const phone = normalizePhone(text);
      return phone ? askPin(ctx, phone) : ctx.reply(t(ctx.lang, 'link_bad_phone'));
    }
    if (state.step === 'pin') {
      ctx.deleteMessage(ctx.message.message_id).catch(() => {}); // scrub the PIN from the chat, whatever happens next
      if (!/^\d{4}$/.test(text)) return ctx.reply(t(ctx.lang, 'link_bad_pin'));
      const r = await performLink({ apiClient, store, tokens, from: ctx.from, phone: state.phone, pin: text });
      if (r.ok) return finish(ctx, t(ctx.lang, 'link_success', { company: escapeHtml(r.company) }));
      if (r.reason === 'wrong') {
        state.tries += 1;
        if (state.tries >= MAX_PIN_TRIES) return finish(ctx, t(ctx.lang, 'link_pin_wrong_final'));
        return ctx.reply(t(ctx.lang, 'link_pin_wrong'));
      }
      return finish(ctx, linkFailureText(ctx.lang, r));
    }
    return undefined;
  });

  return scene;
}

export function linkFailureText(lang, r) {
  switch (r.reason) {
    case 'locked': return t(lang, 'link_pin_locked', { min: r.min });
    case 'blocked': return t(lang, 'link_blocked');
    case 'no_account': return t(lang, 'link_no_account');
    case 'not_approved': return t(lang, 'link_not_approved', { status: t(lang, `status_${r.status}`) });
    case 'wrong': return t(lang, 'link_pin_wrong_final');
    default: return t(lang, 'link_unreachable');
  }
}
