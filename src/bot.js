// Wires up every Telegram-facing command. Business logic (what a valid load is, quotas, who may
// post) stays on the server; this file's job is turning chat messages into the same API calls the
// web app makes, plus the things that are Telegram-only: linking an account, tracking which chats
// to broadcast to, and each person's own bot language (English/Russian/Uzbek, see i18n.js).
import { Telegraf, Scenes, session, Markup } from 'telegraf';
import { FirebaseAuthError, firebaseErrorKey } from './firebase.js';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { makePostLoadScene } from './wizard.js';
import { escapeHtml } from './format.js';
import { makeLangManager } from './lang.js';
import { t, LANGS, LANG_NAMES } from './i18n.js';

const BROADCAST_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

export function makeBot({ config, firebaseAuth, apiClient, tokens, store }) {
  const bot = new Telegraf(config.botToken);
  const lang = makeLangManager({ store });

  bot.use(session());
  bot.use(async (ctx, next) => { ctx.lang = await lang.getLang(ctx); return next(); });

  const stage = new Scenes.Stage([makePostLoadScene({ apiClient, config })]);
  bot.use(stage.middleware());

  // Keeps the bot's chat list (for broadcasting) in sync with reality: fires whenever the bot's own
  // membership in a chat changes, in either direction. The confirmation message uses the fixed
  // broadcast language (config.broadcastLang), like the load broadcasts themselves - a group mixes
  // people, so there is no single "this group's language" to follow.
  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    if (!BROADCAST_CHAT_TYPES.has(upd.chat.type)) return;
    const status = upd.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
      await store.upsertChat({ chatId: upd.chat.id, chatType: upd.chat.type, title: upd.chat.title || '', addedBy: upd.from?.id });
      await ctx.telegram.sendMessage(upd.chat.id, t(config.broadcastLang, 'group_connected')).catch(() => {});
    } else if (status === 'left' || status === 'kicked') {
      await store.markChatRemoved(upd.chat.id);
    }
  });

  bot.start((ctx) => ctx.reply(t(ctx.lang, 'welcome')));
  bot.help((ctx) => ctx.reply(t(ctx.lang, 'welcome')));

  bot.command('language', async (ctx) => {
    await ctx.reply(t(ctx.lang, 'language_prompt'), Markup.inlineKeyboard(
      LANGS.map((code) => [Markup.button.callback(LANG_NAMES[code], `lang:${code}`)]),
    ));
  });
  bot.action(/^lang:(en|ru|uz)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    await lang.setLang(ctx.from.id, code);
    await ctx.editMessageText(t(code, 'language_set'));
  });

  bot.command('link', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(t(ctx.lang, 'link_dm_only'));
      return;
    }
    const m = ctx.message.text.match(/^\/link(?:@\S+)?\s+(\S+)\s+(.+)$/s);
    if (!m) { await ctx.reply(t(ctx.lang, 'link_usage')); return; }
    const [, email, password] = m;
    ctx.deleteMessage(ctx.message.message_id).catch(() => {}); // best-effort: scrub the password from the chat log

    let signIn;
    try {
      signIn = await firebaseAuth.signInWithPassword(email, password);
    } catch (err) {
      const key = err instanceof FirebaseAuthError ? firebaseErrorKey(err.code) : 'fb_generic';
      await ctx.reply(t(ctx.lang, key, { code: err.code }));
      return;
    }

    let me;
    try {
      me = await apiClient.getMe(signIn.idToken);
    } catch (err) {
      // The API refuses e-mail accounts whose address was never confirmed (401): that is the person's to fix, not an outage.
      await ctx.reply(t(ctx.lang, err instanceof ApiError && err.status === 401 ? 'link_unverified' : 'link_unreachable'));
      return;
    }
    if (!me.profile) {
      await ctx.reply(t(ctx.lang, 'link_no_account'));
      return;
    }
    if (me.profile.status !== 'approved') {
      await ctx.reply(t(ctx.lang, 'link_not_approved', { status: t(ctx.lang, `status_${me.profile.status}`) }));
      return;
    }

    await store.saveLink({
      memberId: me.profile.id, telegramUserId: ctx.from.id, telegramUsername: ctx.from.username || '', refreshToken: signIn.refreshToken,
    });
    tokens.invalidate(ctx.from.id);
    await ctx.reply(t(ctx.lang, 'link_success', { company: escapeHtml(me.profile.company) }), { parse_mode: 'HTML' });
  });

  bot.command('unlink', async (ctx) => {
    const removed = await store.removeLink(ctx.from.id);
    tokens.invalidate(ctx.from.id);
    await ctx.reply(t(ctx.lang, removed ? 'unlink_done' : 'unlink_none'));
  });

  bot.command('mystatus', async (ctx) => {
    const link = await store.getLinkByTelegramUserId(ctx.from.id);
    if (!link) { await ctx.reply(t(ctx.lang, 'mystatus_none')); return; }
    await ctx.reply(t(ctx.lang, 'mystatus_linked', {
      company: escapeHtml(link.company), email: escapeHtml(link.email), status: t(ctx.lang, `status_${link.member_status}`),
    }), { parse_mode: 'HTML' });
  });

  bot.command('postload', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(t(ctx.lang, 'postload_dm_only'));
      return;
    }
    let idToken;
    try {
      idToken = await tokens.getIdToken(ctx.from.id);
    } catch (err) {
      await ctx.reply(t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error'));
      return;
    }
    let me;
    try {
      me = await apiClient.getMe(idToken);
    } catch {
      await ctx.reply(t(ctx.lang, 'postload_unreachable'));
      return;
    }
    if (!me.profile || me.profile.status !== 'approved') {
      await ctx.reply(t(ctx.lang, 'postload_not_approved'));
      return;
    }
    await ctx.scene.enter('postload', { idToken, member: me.profile });
  });

  bot.catch((err, ctx) => {
    console.error(`bot error for update ${ctx.update.update_id}:`, err instanceof ApiError ? `${err.code}: ${err.message}` : err);
    ctx.reply?.(t(ctx.lang ?? 'en', 'generic_error')).catch(() => {});
  });

  return bot;
}
