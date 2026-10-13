// /paste: turn a pasted/forwarded freight post into reviewed, posted loads, inside this same bot
// process - so a load published this way broadcasts through the EXACT same broadcaster.js and
// telegram_chats list /postload and the web app already use. No new tables, no new listener.
//
//   paste text -> AI parse (same /api/ai/parse-loads the web app's import screen calls)
//              -> one message per draft: Publish / Edit / Skip, plus a "Publish all remaining"
//              -> Publish (single or batch) -> POST /api/loads (or /bulk) under the member's own
//                 account -> the real `loads` table publish()es an event -> broadcaster.js picks
//                 it up exactly as it would for a /postload or web-app post
//
// No load is ever built or inserted here directly - createLoad/createLoadsBulk are the exact same
// doors server/src/routes/loads.js guards for everyone else, so quotas, city validation and every
// CHECK constraint apply exactly as they do to a load typed by hand on the web app.
import { randomBytes } from 'node:crypto';
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { escapeHtml, formatDraftBlock, formatLoadMessage, draftToRow, isDraftPostable } from './format.js';
import { t } from './i18n.js';

const MIN_PASTE_CHARS = 8; // matches server/src/routes/ai.js's own minimum - shorter can't be a load
const EQUIP_CODES = ['T', 'R', 'F', 'V', 'AC'];
const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

function makeRateLimiter(perMinute) {
  const minGapMs = 60_000 / Math.max(1, perMinute);
  let next = 0;
  return async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minGapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

const newNonce = () => randomBytes(5).toString('hex');

// contactPhone/contactTelegram/contactName are REQUIRED by loadBody (server/src/lib/schemas.js: a
// phone OR a Telegram username, either one). A pasted group post often has neither - exactly the
// gap the web app's AI-import screen fills with the posting member's own profile ("default
// contact info"). We do the same here with the linked member's profile.
export function toLoadBody(draft, member) {
  const estimated = draft.flags?.length ? ` · auto-import: ${draft.flags.join(', ')} estimated - confirm by phone` : '';
  const notes = `${draft.notes || ''}${estimated}`.trim().slice(0, 500);
  return {
    originCityId: draft.originCityId,
    destCityId: draft.destCityId,
    equip: draft.equip,
    fp: draft.fp,
    weightT: draft.weightT,
    volumeM3: draft.volumeM3 ?? undefined,
    pickupDate: draft.pickupDate,
    rateUsd: draft.rateUsd,
    commodity: draft.commodity,
    notes: notes || undefined,
    contactName: draft.contactName || member.contactName || member.company || '-',
    contactPhone: draft.contactPhone || member.phone || '',
    contactEmail: member.contactEmail || '',
    contactTelegram: draft.contactTelegram || member.telegram || '',
  };
}

const hasContact = (draft, member) => Boolean(draft.contactPhone || draft.contactTelegram || member.phone || member.telegram);

function draftKeyboardFor(lang, nonce, idx) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, 'btn_publish'), `pd:${nonce}:${idx}:pub`), Markup.button.callback(t(lang, 'btn_edit'), `pd:${nonce}:${idx}:edit`)],
    [Markup.button.callback(t(lang, 'btn_skip'), `pd:${nonce}:${idx}:skip`)],
  ]);
}

function editMenuKeyboard(lang, nonce, idx) {
  const row = (keys) => keys.map((k) => Markup.button.callback(t(lang, `field_${k}`), `pf:${nonce}:${idx}:${k}`));
  return Markup.inlineKeyboard([
    row(['originCity', 'destCity']),
    row(['equip', 'fp']),
    row(['weight', 'date']),
    row(['rate', 'commodity']),
    row(['cname', 'cphone']),
    row(['ctg', 'notes']),
    [Markup.button.callback(t(lang, 'btn_back'), `pd:${nonce}:${idx}:back`)],
  ]);
}

function footerKeyboard(lang, nonce, postableCount) {
  const rows = [];
  if (postableCount > 0) rows.push([Markup.button.callback(t(lang, 'btn_publish_all', { count: postableCount }), `pa:${nonce}:all`)]);
  rows.push([Markup.button.callback(t(lang, 'btn_cancel_all'), `pa:${nonce}:cancel`)]);
  return Markup.inlineKeyboard(rows);
}

function footerText(lang, entry) {
  const pending = entry.drafts.filter((d) => d.status === 'pending');
  const postablePending = pending.filter(isDraftPostable).length;
  const posted = entry.drafts.filter((d) => d.status === 'posted').length;
  const skipped = entry.drafts.filter((d) => d.status === 'skipped').length;
  if (pending.length === 0) return t(lang, 'batch_done', { posted, skipped });
  return t(lang, 'batch_status', { pending: pending.length, postable: postablePending, posted, skipped });
}

export function makePasteFlow({ apiClient, tokens, config, log = console }) {
  const rateLimiter = makeRateLimiter(config.aiMaxPerMin);
  const pending = new Map(); // telegramUserId -> { nonce, member, chatId, createdAt, footerMessageId, drafts: [...] }
  const editing = new Map(); // telegramUserId -> { nonce, idx, field, kind: 'text'|'city' }
  const ttlMs = config.pendingTtlMin * 60_000;

  async function requireLinkedApproved(ctx) {
    const idToken = await tokens.getIdToken(ctx.from.id);
    const me = await apiClient.getMe(idToken);
    if (!me.profile || me.profile.status !== 'approved') {
      const err = new Error('not approved');
      err.notApproved = true;
      throw err;
    }
    return { idToken, member: me.profile };
  }

  function getEntry(ctx) {
    const entry = pending.get(ctx.from.id);
    if (!entry || Date.now() - entry.createdAt > ttlMs) { pending.delete(ctx.from.id); return null; }
    return entry;
  }

  const noButtons = { reply_markup: { inline_keyboard: [] } };

  async function renderDraft(ctx, entry, idx) {
    const d = entry.drafts[idx];
    const text = formatDraftBlock(d, idx + 1, ctx.lang, entry.member);
    const extra = { parse_mode: 'HTML', ...(d.status === 'pending' ? draftKeyboardFor(ctx.lang, entry.nonce, idx) : noButtons) };
    await ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, text, extra).catch(() => {});
  }

  async function renderFooter(ctx, entry) {
    const pendingPostable = entry.drafts.filter((d) => d.status === 'pending' && isDraftPostable(d)).length;
    const allDone = entry.drafts.every((d) => d.status !== 'pending');
    const extra = allDone ? noButtons : footerKeyboard(ctx.lang, entry.nonce, pendingPostable);
    await ctx.telegram.editMessageText(entry.chatId, entry.footerMessageId, undefined, footerText(ctx.lang, entry), extra).catch(() => {});
  }

  // ---------------------------------------------------------------- new paste -> drafts
  async function handleNewPaste(ctx, text) {
    let idToken, member;
    try {
      ({ idToken, member } = await requireLinkedApproved(ctx));
    } catch (err) {
      if (err instanceof NotLinkedError) return ctx.reply(t(ctx.lang, 'postload_not_linked'));
      if (err?.notApproved) return ctx.reply(t(ctx.lang, 'postload_not_approved'));
      return ctx.reply(t(ctx.lang, 'postload_unreachable'));
    }

    const waitMsg = await ctx.reply(t(ctx.lang, 'paste_parsing'));
    let loads, truncated;
    try {
      await rateLimiter();
      ({ loads, truncated } = await apiClient.parseLoads(idToken, text));
    } catch (err) {
      const key = err instanceof ApiError
        ? ({ ai_unavailable: 'paste_ai_unavailable', ai_busy: 'paste_ai_busy', quota_exceeded: 'paste_ai_busy', ai_bad_output: 'paste_bad_output' }[err.code] ?? 'postload_unreachable')
        : 'postload_unreachable';
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, t(ctx.lang, key)).catch(() => {});
      return undefined;
    }
    if (!loads.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, t(ctx.lang, 'paste_no_loads_found')).catch(() => {});
      return undefined;
    }

    const nonce = newNonce();
    const drafts = loads.map((d) => ({ ...d, status: 'pending', messageId: null }));
    const entry = { nonce, member, chatId: ctx.chat.id, createdAt: Date.now(), footerMessageId: null, drafts };
    pending.set(ctx.from.id, entry);

    const header = t(ctx.lang, 'paste_found_header', { count: loads.length }) + (truncated ? `\n${t(ctx.lang, 'paste_truncated_note', { max: loads.length })}` : '');
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, header).catch(() => {});

    for (let i = 0; i < drafts.length; i += 1) {
      const block = formatDraftBlock(drafts[i], i + 1, ctx.lang, member);
      const sent = await ctx.reply(block, { parse_mode: 'HTML', ...draftKeyboardFor(ctx.lang, nonce, i) });
      drafts[i].messageId = sent.message_id;
    }
    const footer = await ctx.reply(footerText(ctx.lang, entry), footerKeyboard(ctx.lang, nonce, drafts.filter(isDraftPostable).length));
    entry.footerMessageId = footer.message_id;
    return undefined;
  }

  // ---------------------------------------------------------------- publish (single)
  async function publishOne(ctx, entry, idx) {
    const d = entry.drafts[idx];
    if (!isDraftPostable(d)) return ctx.answerCbQuery(t(ctx.lang, 'cb_unresolved'), { show_alert: true });
    if (!hasContact(d, entry.member)) return ctx.answerCbQuery(t(ctx.lang, 'cb_need_contact'), { show_alert: true });
    let idToken;
    try { idToken = await tokens.getIdToken(ctx.from.id); } catch { return ctx.answerCbQuery(t(ctx.lang, 'postload_session_error'), { show_alert: true }); }
    try {
      const created = await apiClient.createLoad(idToken, toLoadBody(d, entry.member));
      d.status = 'posted';
      const link = config.webUrlIsPublic === false ? null : `${config.webBaseUrl}/?load=${created.id}`;
      const row = draftToRow(d, entry.member);
      await ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, `#${idx + 1} ${formatLoadMessage(row, ctx.lang, link)}`, { parse_mode: 'HTML', ...noButtons }).catch(() => {});
      await renderFooter(ctx, entry);
    } catch (err) {
      const msg = err instanceof ApiError && err.code === 'subscription_required' ? t(ctx.lang, 'wiz_subscription_required') : t(ctx.lang, 'wiz_post_failed_generic');
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  async function skipOne(ctx, entry, idx) {
    entry.drafts[idx].status = 'skipped';
    await renderDraft(ctx, entry, idx);
    await renderFooter(ctx, entry);
  }

  async function publishAll(ctx, entry) {
    const candidates = entry.drafts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.status === 'pending' && isDraftPostable(d) && hasContact(d, entry.member));
    if (!candidates.length) return ctx.answerCbQuery(t(ctx.lang, 'cb_none_ready'), { show_alert: true });
    let idToken;
    try { idToken = await tokens.getIdToken(ctx.from.id); } catch { return ctx.answerCbQuery(t(ctx.lang, 'postload_session_error'), { show_alert: true }); }
    try {
      const { items } = await apiClient.createLoadsBulk(idToken, candidates.map(({ d }) => toLoadBody(d, entry.member)));
      candidates.forEach(({ d, i }, n) => {
        d.status = 'posted';
        const created = items[n];
        const link = config.webUrlIsPublic === false ? null : `${config.webBaseUrl}/?load=${created.id}`;
        const row = draftToRow(d, entry.member);
        ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, `#${i + 1} ${formatLoadMessage(row, ctx.lang, link)}`, { parse_mode: 'HTML', ...noButtons }).catch(() => {});
      });
      await renderFooter(ctx, entry);
    } catch (err) {
      const msg = err instanceof ApiError && err.code === 'subscription_required' ? t(ctx.lang, 'wiz_subscription_required') : t(ctx.lang, 'wiz_post_failed_generic');
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
  }

  async function cancelAll(ctx, entry) {
    entry.drafts.forEach((d) => { if (d.status === 'pending') d.status = 'skipped'; });
    for (let i = 0; i < entry.drafts.length; i += 1) await renderDraft(ctx, entry, i);
    await renderFooter(ctx, entry);
  }

  // ---------------------------------------------------------------- editing a field
  async function openEditMenu(ctx, entry, idx) {
    await ctx.telegram.editMessageText(entry.chatId, entry.drafts[idx].messageId, undefined,
      `${formatDraftBlock(entry.drafts[idx], idx + 1, ctx.lang, entry.member)}\n\n${t(ctx.lang, 'edit_pick_field')}`,
      { parse_mode: 'HTML', ...editMenuKeyboard(ctx.lang, entry.nonce, idx) }).catch(() => {});
  }

  async function pickField(ctx, entry, idx, field) {
    const d = entry.drafts[idx];
    const back = Markup.button.callback(t(ctx.lang, 'btn_back'), `pd:${entry.nonce}:${idx}:back`);
    if (field === 'equip') {
      const kb = Markup.inlineKeyboard([...EQUIP_CODES.map((c) => [Markup.button.callback(t(ctx.lang, `eq_${c}`), `pv:${entry.nonce}:${idx}:equip:${c}`)]), [back]]);
      return ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, t(ctx.lang, 'wiz_ask_equip'), { ...kb }).catch(() => {});
    }
    if (field === 'fp') {
      const kb = Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'wiz_fp_full'), `pv:${entry.nonce}:${idx}:fp:Full`), Markup.button.callback(t(ctx.lang, 'wiz_fp_partial'), `pv:${entry.nonce}:${idx}:fp:Partial`)], [back]]);
      return ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, t(ctx.lang, 'wiz_ask_fp'), { ...kb }).catch(() => {});
    }
    const kind = field === 'originCity' || field === 'destCity' ? 'city' : 'text';
    editing.set(ctx.from.id, { nonce: entry.nonce, idx, field, kind });
    const promptKey = kind === 'city' ? 'edit_ask_city' : `edit_ask_${field}`;
    return ctx.telegram.editMessageText(entry.chatId, d.messageId, undefined, t(ctx.lang, promptKey), Markup.inlineKeyboard([[back]])).catch(() => {});
  }

  function applyEnumValue(entry, idx, field, value) {
    entry.drafts[idx][field] = value;
  }

  function clearFlag(d, ...flags) { d.flags = (d.flags ?? []).filter((f) => !flags.includes(f)); }

  async function applyCityPick(ctx, entry, idx, field, cityId, label) {
    const d = entry.drafts[idx];
    if (field === 'originCity') { d.originCityId = cityId; d.originCity = label; d.originText = label; clearFlag(d, 'origin', 'origin_check', 'same_city'); }
    else { d.destCityId = cityId; d.destCity = label; d.destText = label; clearFlag(d, 'dest', 'dest_check', 'same_city'); }
    if (d.originCityId && d.destCityId && d.originCityId === d.destCityId) d.flags = [...new Set([...(d.flags ?? []), 'same_city'])];
  }

  function applyTextValue(d, field, raw) {
    const text = raw.trim();
    const skip = (v) => (v === '-' ? '' : v);
    switch (field) {
      case 'weight': {
        const n = Number(text.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0 || n > 100) return 'wiz_weight_invalid';
        d.weightT = Math.round(n * 100) / 100;
        clearFlag(d, 'weight');
        return null;
      }
      case 'date': {
        if (!isoDateRe.test(text)) return 'wiz_pickup_invalid';
        d.pickupDate = text;
        clearFlag(d, 'date');
        return null;
      }
      case 'rate': {
        if (text === '-' || Number(text.replace(',', '.')) === 0) { d.rateUsd = 0; clearFlag(d, 'rate'); return null; }
        const n = Number(text.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return 'wiz_rate_invalid';
        d.rateUsd = Math.round(n * 100) / 100;
        clearFlag(d, 'rate');
        return null;
      }
      case 'commodity':
        if (!text) return 'wiz_commodity_invalid';
        d.commodity = text.slice(0, 200);
        return null;
      case 'notes': d.notes = skip(text).slice(0, 500); return null;
      case 'cname': d.contactName = text.slice(0, 120); return null;
      case 'cphone': d.contactPhone = skip(text).slice(0, 40); return null;
      case 'ctg': d.contactTelegram = skip(text).slice(0, 40); return null;
      default: return null;
    }
  }

  // ---------------------------------------------------------------- dispatch
  async function handleText(ctx) {
    if (ctx.chat.type !== 'private') return undefined;
    const text = ctx.message.text.trim();

    const edit = editing.get(ctx.from.id);
    if (edit) {
      const entry = pending.get(ctx.from.id);
      if (!entry || entry.nonce !== edit.nonce) { editing.delete(ctx.from.id); return ctx.reply(t(ctx.lang, 'paste_expired')); }
      if (edit.kind === 'city') {
        let idToken;
        try { idToken = await tokens.getIdToken(ctx.from.id); } catch { editing.delete(ctx.from.id); return ctx.reply(t(ctx.lang, 'postload_session_error')); }
        const { items } = await apiClient.searchCities(idToken, text, 6);
        if (!items.length) return ctx.reply(t(ctx.lang, 'wiz_no_city_match'));
        const kb = Markup.inlineKeyboard(items.map((c) => [Markup.button.callback(c.label, `pc:${edit.nonce}:${edit.idx}:${edit.field}:${c.id}`)]));
        return ctx.reply(t(ctx.lang, 'wiz_pick_one'), kb);
      }
      const errKey = applyTextValue(entry.drafts[edit.idx], edit.field, text);
      if (errKey) return ctx.reply(t(ctx.lang, errKey));
      editing.delete(ctx.from.id);
      await renderDraft(ctx, entry, edit.idx);
      return undefined;
    }

    if (text.startsWith('/')) return undefined;
    if (text.length < MIN_PASTE_CHARS) return undefined;
    return handleNewPaste(ctx, text);
  }

  async function onDraftAction(ctx, nonce, idx, action) {
    await ctx.answerCbQuery();
    const entry = getEntry(ctx);
    if (!entry || entry.nonce !== nonce) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    if (action === 'pub') return publishOne(ctx, entry, idx);
    if (action === 'skip') return skipOne(ctx, entry, idx);
    if (action === 'edit') return openEditMenu(ctx, entry, idx);
    if (action === 'back') { editing.delete(ctx.from.id); return renderDraft(ctx, entry, idx); }
    return undefined;
  }

  async function onFieldPick(ctx, nonce, idx, field) {
    await ctx.answerCbQuery();
    const entry = getEntry(ctx);
    if (!entry || entry.nonce !== nonce) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    return pickField(ctx, entry, idx, field);
  }

  async function onEnumValue(ctx, nonce, idx, field, value) {
    await ctx.answerCbQuery();
    const entry = getEntry(ctx);
    if (!entry || entry.nonce !== nonce) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    applyEnumValue(entry, idx, field, value);
    return renderDraft(ctx, entry, idx);
  }

  async function onCityPick(ctx, nonce, idx, field, cityId) {
    await ctx.answerCbQuery();
    const entry = getEntry(ctx);
    if (!entry || entry.nonce !== nonce) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    const label = ctx.callbackQuery.message.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data === ctx.callbackQuery.data)?.text ?? '';
    editing.delete(ctx.from.id);
    await applyCityPick(ctx, entry, idx, field, Number(cityId), label);
    await ctx.editMessageText(t(ctx.lang, 'edit_city_set', { label: escapeHtml(label) })).catch(() => {});
    return renderDraft(ctx, entry, idx);
  }

  async function onBatchAction(ctx, nonce, action) {
    await ctx.answerCbQuery();
    const entry = getEntry(ctx);
    if (!entry || entry.nonce !== nonce) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    if (action === 'all') return publishAll(ctx, entry);
    if (action === 'cancel') return cancelAll(ctx, entry);
    return undefined;
  }

  return { handleText, onDraftAction, onFieldPick, onEnumValue, onCityPick, onBatchAction };
}
