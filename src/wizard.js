// /postload: a short guided conversation that ends in the exact same POST /api/loads call the web
// app makes (via apiClient.createLoad), so every validation rule and quota in
// server/src/routes/loads.js applies identically. A single scene with an explicit `step` field
// (rather than telegraf's linear WizardScene) because the contact-info step branches: most people
// just want their profile defaults. See bot/src/bot.js for how `/postload` enters this scene after
// checking the member is linked and approved. ctx.lang (set by bot.js's language middleware, see
// bot/src/lang.js) is available on every update here too, so the whole conversation follows
// whichever of English/Russian/Uzbek the person has chosen.
import { Scenes, Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { escapeHtml, formatLoadPreview } from './format.js';
import { t } from './i18n.js';

const EQUIP_CODES = ['T', 'R', 'F', 'V', 'AC'];
const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

function parsePositiveNumber(text, max) {
  const n = Number(String(text).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

async function showCityChoices(ctx, apiClient, query, prefix) {
  const { items } = await apiClient.searchCities(ctx.scene.state.idToken, query, 6);
  if (!items.length) { await ctx.reply(t(ctx.lang, 'wiz_no_city_match')); return; }
  const rows = items.map((c) => [Markup.button.callback(c.label, `${prefix}:${c.id}`)]);
  await ctx.reply(t(ctx.lang, 'wiz_pick_one'), Markup.inlineKeyboard(rows));
}

export function makePostLoadScene({ apiClient, config }) {
  const scene = new Scenes.BaseScene('postload');

  scene.enter(async (ctx) => {
    ctx.scene.state.draft = {};
    await ctx.reply(t(ctx.lang, 'wiz_intro'));
    ctx.scene.state.step = 'origin';
  });

  scene.command('cancel', async (ctx) => { await ctx.reply(t(ctx.lang, 'wiz_cancelled')); return ctx.scene.leave(); });

  scene.on('text', async (ctx) => {
    const state = ctx.scene.state;
    const text = ctx.message.text.trim();
    // Other commands (e.g. /mystatus) aren't handled while a /postload is in progress - say so
    // instead of silently swallowing them as if they were a field value.
    if (text.startsWith('/')) return ctx.reply(t(ctx.lang, 'wiz_busy_finish_or_cancel'));

    if (state.step === 'origin') {
      return showCityChoices(ctx, apiClient, text, 'po');
    }
    if (state.step === 'dest') {
      return showCityChoices(ctx, apiClient, text, 'pd');
    }
    if (state.step === 'weight') {
      const tons = parsePositiveNumber(text, 100);
      if (!tons) return ctx.reply(t(ctx.lang, 'wiz_weight_invalid'));
      state.draft.weightT = tons;
      state.step = 'pickupDate';
      return ctx.reply(t(ctx.lang, 'wiz_ask_pickup'));
    }
    if (state.step === 'pickupDate') {
      if (!isoDateRe.test(text)) return ctx.reply(t(ctx.lang, 'wiz_pickup_invalid'));
      state.draft.pickupDate = text;
      state.step = 'rate';
      return ctx.reply(t(ctx.lang, 'wiz_ask_rate'));
    }
    if (state.step === 'rate') {
      const rate = text === '-' || Number(text.replace(',', '.')) === 0 ? 0 : parsePositiveNumber(text, 10_000_000); // 0 = negotiable, as on the web board
      if (rate === null) return ctx.reply(t(ctx.lang, 'wiz_rate_invalid'));
      state.draft.rateUsd = rate;
      state.step = 'commodity';
      return ctx.reply(t(ctx.lang, 'wiz_ask_commodity'));
    }
    if (state.step === 'commodity') {
      if (!text) return ctx.reply(t(ctx.lang, 'wiz_commodity_invalid'));
      state.draft.commodity = text.slice(0, 200);
      state.step = 'notes';
      return ctx.reply(t(ctx.lang, 'wiz_ask_notes'));
    }
    if (state.step === 'notes') {
      state.draft.notes = text === '-' ? '' : text.slice(0, 500);
      return offerContact(ctx);
    }
    if (state.step === 'contactName') {
      if (!text) return ctx.reply(t(ctx.lang, 'wiz_ask_contact_name'));
      state.draft.contactName = text.slice(0, 120);
      state.step = 'contactPhone';
      return ctx.reply(t(ctx.lang, 'wiz_ask_contact_phone'));
    }
    if (state.step === 'contactPhone') {
      state.draft.contactPhone = text.slice(0, 40);
      state.step = 'contactEmail';
      return ctx.reply(t(ctx.lang, 'wiz_ask_contact_email'));
    }
    if (state.step === 'contactEmail') {
      state.draft.contactEmail = text.slice(0, 254);
      state.step = 'contactTelegram';
      return ctx.reply(t(ctx.lang, 'wiz_ask_contact_telegram'));
    }
    if (state.step === 'contactTelegram') {
      state.draft.contactTelegram = text.slice(0, 40);
      return showPreview(ctx);
    }
    return undefined;
  });

  async function offerContact(ctx) {
    const state = ctx.scene.state;
    const m = state.member;
    state.step = 'contactChoice';
    const hasDefaults = m.contactName && m.phone && m.contactEmail && m.telegram;
    if (!hasDefaults) return askContactManually(ctx, t(ctx.lang, 'wiz_contact_missing'));
    const summary = [m.contactName, m.phone, m.telegram, m.contactEmail].map(escapeHtml).join(' · ');
    await ctx.reply(
      t(ctx.lang, 'wiz_contact_use_profile_q', { summary }),
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx.lang, 'wiz_contact_btn_use'), 'contact:profile')],
        [Markup.button.callback(t(ctx.lang, 'wiz_contact_btn_manual'), 'contact:manual')],
      ]) },
    );
  }

  async function askContactManually(ctx, intro) {
    ctx.scene.state.step = 'contactName';
    await ctx.reply(`${intro ? intro + '\n\n' : ''}${t(ctx.lang, 'wiz_ask_contact_name')}`);
  }

  async function showPreview(ctx) {
    const state = ctx.scene.state;
    state.step = 'confirm';
    const d = state.draft;
    const previewRow = {
      origin_city: d.originLabel, dest_city: d.destLabel, equip: d.equip, fp: d.fp, weight_t: d.weightT,
      volume_m3: null, commodity: d.commodity, pickup_date: d.pickupDate, delivery_date: null,
      distance_km: null, rate_usd: d.rateUsd, notes: d.notes,
      company_name: state.member.company, contact_name: d.contactName, contact_phone: d.contactPhone,
      contact_email: d.contactEmail, contact_tg: d.contactTelegram,
    };
    await ctx.reply(formatLoadPreview(previewRow, ctx.lang), { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback(t(ctx.lang, 'wiz_btn_post'), 'confirm:post')],
      [Markup.button.callback(t(ctx.lang, 'wiz_btn_cancel'), 'confirm:cancel')],
    ]) });
  }

  function labelFromKeyboard(ctx, callbackData) {
    const kb = ctx.callbackQuery.message.reply_markup?.inline_keyboard ?? [];
    return kb.flat().find((b) => b.callback_data === callbackData)?.text;
  }

  scene.action(/^po:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'origin') return; // stale button from an earlier step
    const id = Number(ctx.match[1]);
    state.draft.originCityId = id;
    state.draft.originLabel = labelFromKeyboard(ctx, `po:${id}`);
    state.step = 'dest';
    await ctx.editMessageText(t(ctx.lang, 'wiz_origin_label', { label: state.draft.originLabel }));
    await ctx.reply(t(ctx.lang, 'wiz_ask_dest'));
  });

  scene.action(/^pd:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'dest') return;
    const id = Number(ctx.match[1]);
    const label = labelFromKeyboard(ctx, `pd:${id}`);
    if (id === state.draft.originCityId) {
      await ctx.reply(t(ctx.lang, 'wiz_dest_same_as_origin'));
      return;
    }
    state.draft.destCityId = id;
    state.draft.destLabel = label;
    state.step = 'equip';
    await ctx.editMessageText(t(ctx.lang, 'wiz_dest_label', { label }));
    await ctx.reply(t(ctx.lang, 'wiz_ask_equip'), Markup.inlineKeyboard(
      EQUIP_CODES.map((code) => [Markup.button.callback(t(ctx.lang, `eq_${code}`), `equip:${code}`)]),
    ));
  });

  scene.action(/^equip:(T|R|F|V|AC)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'equip') return;
    state.draft.equip = ctx.match[1];
    state.step = 'fp';
    await ctx.editMessageText(t(ctx.lang, 'wiz_equip_label', { label: t(ctx.lang, `eq_${ctx.match[1]}`) }));
    await ctx.reply(t(ctx.lang, 'wiz_ask_fp'), Markup.inlineKeyboard([
      [Markup.button.callback(t(ctx.lang, 'wiz_fp_full'), 'fp:Full'), Markup.button.callback(t(ctx.lang, 'wiz_fp_partial'), 'fp:Partial')],
    ]));
  });

  scene.action(/^fp:(Full|Partial)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'fp') return;
    state.draft.fp = ctx.match[1];
    state.step = 'weight';
    await ctx.editMessageText(t(ctx.lang, 'wiz_fp_label', { value: t(ctx.lang, ctx.match[1] === 'Full' ? 'wiz_fp_full' : 'wiz_fp_partial') }));
    await ctx.reply(t(ctx.lang, 'wiz_ask_weight'));
  });

  scene.action('contact:profile', async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'contactChoice') return;
    const m = state.member;
    state.draft.contactName = m.contactName; state.draft.contactPhone = m.phone;
    state.draft.contactEmail = m.contactEmail; state.draft.contactTelegram = m.telegram;
    await ctx.editMessageText(t(ctx.lang, 'wiz_contact_using_profile'));
    return showPreview(ctx);
  });

  scene.action('contact:manual', async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.scene.state.step !== 'contactChoice') return;
    await ctx.editMessageText(t(ctx.lang, 'wiz_contact_manual_intro'));
    return askContactManually(ctx);
  });

  scene.action('confirm:post', async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'confirm') return;
    const d = state.draft;
    try {
      const created = await apiClient.createLoad(state.idToken, {
        originCityId: d.originCityId, destCityId: d.destCityId, equip: d.equip, fp: d.fp,
        weightT: d.weightT, pickupDate: d.pickupDate, rateUsd: d.rateUsd, commodity: d.commodity,
        notes: d.notes || undefined, contactName: d.contactName, contactPhone: d.contactPhone,
        contactEmail: d.contactEmail, contactTelegram: d.contactTelegram,
      });
      // The poster gets their own link too, same one the broadcast sends to every group (see
      // broadcaster.js) - one unique URL per load, backed by GET /api/loads/:id.
      const link = config.webUrlIsPublic === false ? '' : `<a href="${escapeHtml(`${config.webBaseUrl}/?load=${created.id}`)}">${t(ctx.lang, 'msg_view_on_board')}</a>`;
      await ctx.editMessageText(t(ctx.lang, 'wiz_posted', { link }), { parse_mode: 'HTML' });
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.details?.length ? `\n${err.details.map((d2) => `• ${d2.path}: ${d2.code}`).join('\n')}` : '';
        await ctx.editMessageText(t(ctx.lang, 'wiz_post_failed', { message: escapeHtml(err.message) + escapeHtml(detail) }));
      } else {
        await ctx.editMessageText(t(ctx.lang, 'wiz_post_failed_generic'));
      }
    }
    return ctx.scene.leave();
  });

  scene.action('confirm:cancel', async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.scene.state.step !== 'confirm') return;
    await ctx.editMessageText(t(ctx.lang, 'wiz_cancelled'));
    return ctx.scene.leave();
  });

  return scene;
}
