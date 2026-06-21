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

// ─── Error handling ─────────────────────────────────────────────────�