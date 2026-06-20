import { Context } from 'grammy';
import { getTop24hTickers } from '../services/binance';

function formatNum(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatVol(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + formatNum(n);
}

export async function handleMarket(ctx: Context): Promise<void> {
  try {
    await ctx.reply('Fetching market data... ');

    const tickers = await getTop24hTickers(10);

    let message = '*Top 10 by 24h Volume (Binance)*\n\n';

    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i];
      const symbol = t.symbol.replace('USDT', '');
      const arrow = t.change24h >= 0 ? '+' : '';
      const changeStr = arrow + t.change24h.toFixed(2) + '%';
      const price = t.price < 1 ? formatNum(t.price, 6) : formatNum(t.price, 2);

      message += (i + 1) + '. *' + symbol + '/USDT*\n';
      message += '   $' + price + '  ' + changeStr + '\n';
      message += '   Vol: ' + formatVol(t.volume) + '\n\n';
    }

    message += 'Updated: ' + new Date().toUTCString();

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('handleMarket error:', e);
    await ctx.reply('Could not fetch market data. Please try again later.');
  }
}
