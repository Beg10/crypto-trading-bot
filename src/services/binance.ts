import axios, { AxiosError } from 'axios';
import { Candle } from '../types';

const BASE = 'https://api.binance.com';

const client = axios.create({
  baseURL: BASE,
  timeout: 10_000,
  headers: process.env.BINANCE_API_KEY
    ? { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
    : {},
});

/** Validates that a symbol exists on Binance spot market. */
export async function validateSymbol(symbol: string): Promise<boolean> {
  try {
    const res = await client.get('/api/v3/ticker/price', {
      params: { symbol: symbol.toUpperCase() },
    });
    return !!res.data?.symbol;
  } catch (e) {
    const err = e as AxiosError<{ code: number }>;
    // Binance returns -1121 for invalid symbols
    if (err.response?.data?.code === -1121) return false;
    throw new Error(`Binance validateSymbol: ${err.message}`);
  }
}

/** Fetches the latest price for a symbol. */
export async function getPrice(symbol: string): Promise<number> {
  try {
    const res = await client.get('/api/v3/ticker/price', {
      params: { symbol: symbol.toUpperCase() },
    });
    return parseFloat(res.data.price);
  } catch (e) {
    throw new Error(`Binance getPrice ${symbol}: ${(e as Error).message}`);
  }
}

/**
 * Fetches OHLCV candles from Binance.
 * @param symbol  e.g. 'BTCUSDT'
 * @param interval e.g. '1h', '4h', '1d'
 * @param limit   number of candles (max 1000)
 */
export async function getCandles(
  symbol: string,
  interval = '1h',
  limit = 100,
): Promise<Candle[]> {
  try {
    const res = await client.get('/api/v3/klines', {
      params: { symbol: symbol.toUpperCase(), interval, limit },
    });

    return (res.data as unknown[][]).map((k) => ({
      openTime: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
      closeTime: k[6] as number,
    }));
  } catch (e) {
    throw new Error(`Binance getCandles ${symbol}: ${(e as Error).message}`);
  }
}

/** Fetches 24h ticker for top traded USDT pairs sorted by quote volume. */
export async function getTop24hTickers(limit = 10): Promise<
  Array<{ symbol: string; price: number; change24h: number; volume: number }>
> {
  try {
    const res = await client.get('/api/v3/ticker/24hr');
    const tickers = (res.data as Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      quoteVolume: string;
    }>)
      .filter((t) => t.symbol.endsWith('USDT'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit);

    return tickers.map((t) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
    }));
  } catch (e) {
    throw new Error(`Binance getTop24hTickers: ${(e as Error).message}`);
  }
}
