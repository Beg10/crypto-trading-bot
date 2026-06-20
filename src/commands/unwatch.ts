import { Context } from 'grammy';
import { getUserByTelegramId, removeFromWatchlist } from '../db';

export async function handleUnwatch(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const raw = ctx.message?.text?.split(/\s+/)[1] ?? '';
  const symbol = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!symbol) {
    await ctx.reply('Usage: /unwatch BTCUSDT');
    return;
  }

  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    const removed = await removeFromWatchlist(user.id, symbol);

    if (removed) {
      await ctx.reply(`✅ *${symbol}* removed from your watchlist.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`*${symbol}* was not on your watchlist.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('handleUnwatch error:', e);
    await ctx.reply('Something went wrong. Please try again.');
  }
}
