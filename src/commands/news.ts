import { Context } from 'grammy';
import { getRecentNews } from '../db';

const SENTIMENT_EMOJI: Record<string, string> = {
  bullish: '🟢',
  bearish: '🔴',
  neutral: '⚪',
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export async function handleNews(ctx: Context): Promise<void> {
  try {
    await ctx.reply('Fetching news… ⏳');

    const news = await getRecentNews(24);

    if (news.length === 0) {
      await ctx.reply(
        'No news cached yet.\n\nThe background worker fetches news every 5 minutes. Try again shortly.',
      );
      return;
    }

    // Separate crypto and macro news
    const cryptoNews = news.filter((n) => n.source === 'cryptopanic').slice(0, 5);
    const macroNews = news.filter((n) => n.source === 'newsapi').slice(0, 5);

    let message = '📰 *Crypto & Macro News*\n\n';

    if (cryptoNews.length > 0) {
      message += '─── *Crypto* ───\n';
      for (const item of cryptoNews) {
        const emoji = SENTIMENT_EMOJI[item.sentiment ?? 'neutral'];
        const title = truncate(item.title, 80);
        message += `${emoji} [${title}](${item.url})\n`;
        if (item.related_symbols.length > 0) {
          message += `   _${item.related_symbols.slice(0, 3).join(', ')}_\n`;
        }
        message += '\n';
      }
    }

    if (macroNews.length > 0) {
      message += '─── *Macro / Market* ───\n';
      for (const item of macroNews) {
        const emoji = SENTIMENT_EMOJI[item.sentiment ?? 'neutral'];
        const title = truncate(item.title, 80);
        message += `${emoji} [${title}](${item.url})\n`;
        if (item.impact_summary) {
          message += `   _${truncate(item.impact_summary, 120)}_\n`;
        }
        message += '\n';
      }
    }

    // Telegram has a 4096-char limit per message
    if (message.length > 4000) {
      message = message.slice(0, 3997) + '…';
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.error('handleNews error:', e);
    await ctx.reply('Could not fetch news. Please try again later.');
  }
}
