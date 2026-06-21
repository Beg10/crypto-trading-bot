import 'dotenv/config'; // must be first import
import { Bot, GrammyError, HttpError } from 'grammy';

import { handleStart } from './commands/start';
import { handleWatch } from './commands/watch';
import { handleUnwatch } from './commands/unwatch';
import { handleList } from './commands/list';
import { handleNews } from './commands/news';
import { handleMarket } from './commands/market';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// ─── Monitoring helper ────────────────────────────────────────────────────────

async function notifyAdmin(message: string): Promise<void> {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;
  try {
    await bot.api.sendMessage(adminId, message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[monitor] Failed to notify admin:', (e as Error).message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', handleStart);
bot.command('watch', handleWatch);
bot.command('unwatch', handleUnwatch);
bot.command('list', handleList);
bot.command('news', handleNews);
bot.command('market', handleMarket);

// Returns the user's Telegram chat ID — needed once to set ADMIN_CHAT_ID
bot.command('myid', async (ctx) => {
  await ctx.reply(`Your chat ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// Unknown commands
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply(
      'Unknown command. Use /start to see available commands.',
    );
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error handling update ${ctx.update.update_id}:`);

  if (err.error instanceof GrammyError) {
    console.error('grammY error:', err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error('HTTP error:', err.error);
  } else {
    console.error('Unknown error:', err.error);
  }
});

// ─── Crash monitoring ─────────────────────────────────────────────────────────

process.on('uncaughtException', async (err) => {
  console.error('[bot] Uncaught exception:', err);
  await notifyAdmin(`🔴 *Bot crashed!*\n\`${err.message}\`\n\nRailway wird neu starten…`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[bot] Unhandled rejection:', reason);
  await notifyAdmin(`🔴 *Bot unhandled rejection!*\n\`${String(reason)}\`\n\nRailway wird neu starten…`);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

bot.start({
  onStart: async (info) => {
    console.log(`Bot started as @${info.username}`);
    await notifyAdmin(`🟢 *Bot gestartet!*\n@${info.username} ist online.\n_${new Date().toISOString()}_`);
  },
});
