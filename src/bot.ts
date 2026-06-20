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

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', handleStart);
bot.command('watch', handleWatch);
bot.command('unwatch', handleUnwatch);
bot.command('list', handleList);
bot.command('news', handleNews);
bot.command('market', handleMarket);

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

// ─── Start ─────────────────────────────────────────────────────────────────────

bot.start({
  onStart: (info) => console.log(`Bot started as @${info.username}`),
});
