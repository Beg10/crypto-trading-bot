import axios from 'axios';
import { NewsItem } from '../types';

/**
 * Free crypto news source — CoinDesk RSS feed.
 * No API key, no rate limit worth worrying about. Replaces the paid CryptoPanic API.
 *
 * Function name kept as `fetchCryptoPanicNews` so the worker/news pipeline keeps working.
 */

const FEED_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';

/** Tiny regex-based RSS parser — enough for title/link/pubDate/description. */
function parseRss(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRegex) ?? [];

  for (const block of matches) {
    const pick = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return '';
      // strip CDATA wrapper if present
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };

    items.push({
      title: pick('title'),
      link: pick('link'),
      pubDate: pick('pubDate'),
      description: pick('description'),
    });
  }

  return items;
}

/** Detects which Binance USDT symbols a headline relates to, based on coin keywords. */
const COIN_KEYWORDS: Record<string, string> = {
  bitcoin: 'BTCUSDT',
  btc: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  eth: 'ETHUSDT',
  solana: 'SOLUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
  ripple: 'XRPUSDT',
  cardano: 'ADAUSDT',
  ada: 'ADAUSDT',
  dogecoin: 'DOGEUSDT',
  doge: 'DOGEUSDT',
  avalanche: 'AVAXUSDT',
  avax: 'AVAXUSDT',
  polkadot: 'DOTUSDT',
  polygon: 'MATICUSDT',
  matic: 'MATICUSDT',
  chainlink: 'LINKUSDT',
  link: 'LINKUSDT',
  litecoin: 'LTCUSDT',
  ltc: 'LTCUSDT',
  bnb: 'BNBUSDT',
  binance: 'BNBUSDT',
};

function detectSymbols(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, symbol] of Object.entries(COIN_KEYWORDS)) {
    // word-boundary match to avoid e.g. "linkedin" -> LINK
    if (new RegExp(`\\b${keyword}\\b`).test(lower)) found.add(symbol);
  }
  return Array.from(found);
}

/** Very rough sentiment from headline keywords — not perfect but free. */
function deriveSentiment(text: string): NewsItem['sentiment'] {
  const lower = text.toLowerCase();
  const bullish = /\b(surge|soar|rally|rise|gain|breakout|all[- ]time high|bull|moon|pump)\b/.test(lower);
  const bearish = /\b(crash|plunge|drop|fall|decline|tumble|bear|dump|sell[- ]off|hack|exploit)\b/.test(lower);
  if (bullish && !bearish) return 'bullish';
  if (bearish && !bullish) return 'bearish';
  return 'neutral';
}

/**
 * Fetches latest crypto news from CoinDesk RSS.
 * Drop-in replacement for the original CryptoPanic implementation.
 */
export async function fetchCryptoPanicNews(limit = 20): Promise<NewsItem[]> {
  try {
    const res = await axios.get(FEED_URL, {
      timeout: 10_000,
      headers: { 'User-Agent': 'crypto-trading-bot/1.0' },
    });

    const items = parseRss(res.data as string);

    return items.slice(0, limit).map((item) => {
      const haystack = `${item.title} ${item.description}`;
      return {
        source: 'cryptopanic' as const, // keep source label so DB filters still work
        title: item.title,
        url: item.link,
        sentiment: deriveSentiment(haystack),
        impact_summary: null,
        related_symbols: detectSymbols(haystack),
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      };
    });
  } catch (e) {
    console.error(`[news/rss] fetch failed: ${(e as Error).message}`);
    return [];
  }
}
