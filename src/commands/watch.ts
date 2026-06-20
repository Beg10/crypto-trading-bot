import { Context } from 'grammy';
import { getUserByTelegramId, addToWatchlist } from '../db';
import { validateSymbol } from '../services/binance';

export async function handleWatch(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Extract first whitespace-separated token after the command, keep only A-Z0-9.
  // Guards against users pasting multi-line text or extra junk after the command.
  const raw = ctx.message?.text?.split(/\s+/)[1] ?? '';
  const symbol = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!symbol) {
    await ctx.reply('Usage: /watch BTCUSDT');
    return;
  }

  try {
    // Validate symbol exists on Binance
    const valid = await validateSymbol(symbol);
    if (!valid) {
      await ctx.reply(
        `❌ *${symbol}* is not a valid Binance symbol.\n\nExamples: BTCUSDT, ETHUSDT, SOLUSDT`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    // Free plan limit: 10 symbols
    await addToWatchlist(user.id, symbol);

    await ctx.reply(`✅ *${symbol}* added to your watchlist.\n\nI'll notify you when signals appear.`, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    if ((e as Error).message === 'DUPLICATE') {
      await ctx.reply(`*${symbol}* is already on your watchlist.`, { parse_mode: 'Markdown' });
      return;
    }
    console.error('handleWatch error:', e);
    await ctx.reply('Something went wrong. Please try again.');
  }
}
