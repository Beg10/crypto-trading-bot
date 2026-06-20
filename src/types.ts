export interface User {
  id: string;
  telegram_id: number;
  username: string | null;
  plan: string;
  created_at: string;
}

export interface WatchlistEntry {
  id: string;
  user_id: string;
  symbol: string;
  created_at: string;
}

export interface Alert {
  id: string;
  user_id: string;
  symbol: string;
  condition_type: string;
  threshold: number | null;
  is_active: boolean;
  last_triggered_at: string | null;
  created_at: string;
}

export interface NewsItem {
  id?: string;
  source: 'cryptopanic' | 'newsapi';
  title: string;
  url: string;
  sentiment: 'bullish' | 'bearish' | 'neutral' | null;
  impact_summary: string | null;
  related_symbols: string[];
  published_at: string;
}

// Binance REST kline/candlestick
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface AnalysisResult {
  symbol: string;
  price: number;
  rsi: number | null;
  macdSignal: 'bullish_cross' | 'bearish_cross' | null;
  bbSignal: 'oversold' | 'overbought' | null;
  patterns: string[];
  signals: string[];
}

export interface CoinMarketData {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  marketCap: number;
  volume24h: number;
}

export interface CryptoPanicArticle {
  title: string;
  url: string;
  published_at: string;
  currencies?: Array<{ code: string; slug: string }>;
  votes?: { positive: number; negative: number; important: number };
}

export interface NewsApiArticle {
  title: string;
  url: string;
  publishedAt: string;
  description: string | null;
}
