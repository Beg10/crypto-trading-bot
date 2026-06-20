import { Context } from 'grammy';
import { getUserByTelegramId, getWatchlist } from '../db';
import { getPrice } from '../services/binance';

export async function handleList(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    const watchlist = await getWatchlist(user.id);

    if (watchlist.length === 0) {
      await ctx.reply('Your watchlist is empty.\n\nUse /watch BTCUSDT to add a coin.');
      return;
    }

    // Fetch current prices in parallel (best-effort — don't fail if one fails)
    const priceResults = await Promise.allSettled(
      watchlist.map((w) => getPrice(w.symbol)),
    );

    const lines = watchlist.map((w, i) => {
      const priceResult = priceResults[i];
      const price =
        priceResult.status === 'fulfilled'
          ? `$${priceResult.value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
          : 'N/A';
      return `• *${w.symbol}* — ${price}`;
    });

    await ctx.reply(
      `📋 *Your Watchlist* (${watchlist.length} coin${watchlist.length === 1 ? '' : 's'})\n\n` +
        lines.join('\n'),
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    console.error('handleList error:', e);
    await ctx.reply('Something went wrong. Please try again.');
  }
}
