import 'dotenv/config';
import { Bot, GrammyError, HttpError } from 'grammy';

import { handleStart }    from './commands/start';
import { handleWatch }    from './commands/watch';
import { handleUnwatch }  from './commands/unwatch';
import { handleList }     from './commands/list';
import { handleNews }     from './commands/news';
import { handleMarket }   from './commands/market';
import { handleCapital }  from './commands/capital';
import { handleStatus }   from './commands/status';
import { buildRecapMessage }        from './commands/recap';
import { buildWeeklyReportMessage } from './commands/weeklyReport';
import { buildStatsMessage }        from './commands/stats';
import { buildAktivMessage }        from './commands/aktiv';
import { handleIn, handleOut, handlePos } from './commands/position';
import { buildMorningBriefing } from './commands/morningBriefing';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

export const bot = new Bot(process.env.BOT_TOKEN);

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

bot.command('start',   handleStart);
bot.command('watch',   handleWatch);
bot.command('unwatch', handleUnwatch);
bot.command('list',    handleList);
bot.command('news',    handleNews);
bot.command('market',  handleMarket);
bot.command('capital', handleCapital);
bot.command('status',  handleStatus);

// Position tracker
bot.command('in',  handleIn);
bot.command('out', handleOut);
bot.command('pos', handlePos);

bot.command('woche', async (ctx) => {
  await ctx.reply('Lade Wochen-Report...', { parse_mode: 'Markdown' });
  const msg = await buildWeeklyReportMessage();
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});
bot.command('aktiv', async (ctx) => {
  const msg = await buildAktivMessage();
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});
bot.command('stats', async (ctx) => {
  await ctx.reply('Lade Stats...', { parse_mode: 'Markdown' });
  const msg = await buildStatsMessage(30);
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});
bot.command('recap', async (ctx) => {
  await ctx.reply('Lade Recap...', { parse_mode: 'Markdown' });
  const msg = await buildRecapMessage();
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});
bot.command('myid', async (ctx) => {
  await ctx.reply('Your chat ID: ' + ctx.chat.id, { parse_mode: 'Markdown' });
});
bot.command('briefing', async (ctx) => {
  await ctx.reply('Lade Morning Briefing...', { parse_mode: 'Markdown' });
  const msg = await buildMorningBriefing();
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply(
      'Unbekannter Befehl. Verfuegbare Befehle:\n\n' +
      '/start — Uebersicht\n' +
      '/aktiv — Aktive Trades\n' +
      '/stats — Performance Stats\n' +
      '/briefing — Morning Briefing\n' +
      '/in SYMBOL MARGIN HEBEL — Trade tracken\n' +
      '/out SYMBOL — Position schliessen\n' +
      '/pos — Aktive Positionen\n' +
      '/capital — Kapital setzen',
    );
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  const ctx = err.ctx;
  console.error('Error handling update ' + ctx.update.update_id + ':');
  if (err.error instanceof GrammyError) {
    console.error('grammY error:', err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error('HTTP error:', err.error);
  } else {
    console.error('Unknown error:', err.error);
  }
});

process.on('uncaughtException', async (err) => {
  console.error('[bot] Uncaught exception:', err);
  await notifyAdmin('Bot crashed!\n' + err.message + '\n\nRailway wird neu starten...');
  process.exit(1);
});

bot
  .start({
    onStart: async (info) => {
      console.log('Bot started as @' + info.username);
      await notifyAdmin('Bot gestartet!\n@' + info.username + ' ist online.\n' + new Date().toISOString());
    },
  })
  .catch(async (e) => {
    if (e instanceof GrammyError && e.error_code === 409) {
      console.log('[bot] 409 conflict — restarting...');
      process.exit(1);
    }
    console.error('[bot] fatal error:', e);
    await notifyAdmin('Bot fatal error!\n' + (e as Error).message);
    process.exit(1);
  });
