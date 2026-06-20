import { Context } from 'grammy';
import { upsertUser } from '../db';

export async function handleStart(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    await upsertUser(telegramId, ctx.from?.username);

    await ctx.reply(
      `👋 *Welcome to Crypto Trading Assistant!*\n\n` +
        `I monitor coins on your watchlist and alert you when technical signals align.\n\n` +
        `*Available commands:*\n` +
        `/watch BTCUSDT — Add coin to watchlist\n` +
        `/unwatch BTCUSDT — Remove from watchlist\n` +
        `/list — Show your watchlist\n` +
        `/news — Latest crypto & macro news\n` +
        `/market — Top coins overview\n\n` +
        `_Signals fire when RSI, MACD, Bollinger Bands and candlestick patterns align — not on every tick._`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    console.error('handleStart error:', e);
    await ctx.reply('Something went wrong. Please try again.');
  }
}
