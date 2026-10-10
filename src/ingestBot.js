// The ingestion bot's Telegram side: listens to every message in whatever group/supergroup/channel
// it has been added to (requires Telegram privacy mode OFF - see bot/README.md) and hands text to
// the pipeline. DMs are for the operator only: a few admin commands to see what is being watched
// and to pause a noisy or low-quality source without redeploying.
import { Telegraf } from 'telegraf';

const SOURCE_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

export function makeIngestBot({ config, store, pipeline }) {
  const bot = new Telegraf(config.botToken);

  // Fires the moment the bot is added to / removed from a chat - the operator's own action of
  // "add this bot to the group" is the authorization signal to start watching it.
  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    if (!SOURCE_CHAT_TYPES.has(upd.chat.type)) return;
    const status = upd.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
      await store.upsertChat({ chatId: upd.chat.id, chatType: upd.chat.type, title: upd.chat.title || '', addedBy: upd.from?.id });
      console.log(`ingest: now watching "${upd.chat.title}" (${upd.chat.id})`);
    } else if (status === 'left' || status === 'kicked') {
      await store.markChatRemoved(upd.chat.id);
      console.log(`ingest: removed from chat ${upd.chat.id}`);
    }
  });

  bot.on('message', async (ctx) => {
    const chat = ctx.chat;
    if (!SOURCE_CHAT_TYPES.has(chat.type)) return; // private messages are admin commands only (below)
    const text = ctx.message.text ?? ctx.message.caption ?? '';
    if (!text) return;
    const status = await store.bumpChatSeen({ chatId: chat.id, chatType: chat.type, title: chat.title || '' });
    if (status !== 'active') return; // paused or removed - counted, but not ingested
    try {
      await pipeline.handleMessage({ chatId: chat.id, messageId: ctx.message.message_id, text });
    } catch (err) {
      console.error(`ingest: unhandled error on message ${chat.id}/${ctx.message.message_id}:`, err.message);
    }
  });

  const isAdmin = (ctx) => ctx.chat.type === 'private' && config.adminTelegramIds.has(ctx.from?.id);

  bot.command('ingeststatus', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const chats = await store.listChats();
    if (!chats.length) return ctx.reply('No source groups yet - add this bot to a group to start watching it.');
    const icon = { active: '🟢', paused: '⏸', removed: '⚪️' };
    const lines = chats.map((c) =>
      `${icon[c.status] ?? '•'} ${c.title || '(untitled)'} — ${c.chat_id}\n   seen ${c.messages_seen} · posted ${c.loads_posted}`);
    await ctx.reply(lines.join('\n\n'));
  });

  bot.command('pausesource', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number(ctx.message.text.trim().split(/\s+/)[1]);
    const ok = Number.isFinite(id) && await store.setChatStatus(id, 'paused');
    await ctx.reply(ok ? `Paused ${id}. It will stop producing new loads until /resumesource ${id}.` : 'Usage: /pausesource <chatId> - see /ingeststatus for ids.');
  });

  bot.command('resumesource', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number(ctx.message.text.trim().split(/\s+/)[1]);
    const ok = Number.isFinite(id) && await store.setChatStatus(id, 'active');
    await ctx.reply(ok ? `Resumed ${id}.` : 'Usage: /resumesource <chatId> - see /ingeststatus for ids.');
  });

  bot.start((ctx) => {
    if (ctx.chat.type === 'private') ctx.reply('This bot only reads groups it has been added to and posts loads to the SNG ONE board automatically. There is nothing to do here in DM unless you are an admin (/ingeststatus).');
  });

  return bot;
}
