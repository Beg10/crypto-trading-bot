import axios from 'axios';
import { CoinMarketData } from '../types';

const client = axios.create({
  baseURL: 'https://api.coingecko.com/api/v3',
  timeout: 15_000,
  headers: process.env.COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
    : {},
});

/** Maps common Binance USDT symbols to CoinGecko IDs for the top coins. */
const SYMBOL_TO_ID: Record<string, string> = {
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  BNBUSDT: 'binancecoin',
  SOLUSDT: 'solana',
  XRPUSDT: 'ripple',
  ADAUSDT: 'cardano',
  DOGEUSDT: 'dogecoin',
  AVAXUSDT: 'avalanche-2',
  DOTUSDT: 'polkadot',
  MATICUSDT: 'matic-network',
  LINKUSDT: 'chainlink',
  LTCUSDT: 'litecoin',
  UNIUSDT: 'uniswap',
  ATOMUSDT: 'cosmos',
  ETCUSDT: 'ethereum-classic',
};

/**
 * Returns top N coins by market cap from CoinGecko.
 */
export async function getTopCoins(limit = 10): Promise<CoinMarketData[]> {
  try {
    const res = await client.get('/coins/markets', {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: limit,
        page: 1,
        sparkline: false,
        price_change_percentage: '24h',
      },
    });

    return (
      res.data as Array<{
        symbol: string;
        name: string;
        current_price: number;
        price_change_percentage_24h: number;
        market_cap: number;
        total_volume: number;
      }>
    ).map((c) => ({
      symbol: c.symbol.toUpperCase() + 'USDT',
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h ?? 0,
      marketCap: c.market_cap,
      volume24h: c.total_volume,
    }));
  } catch (e) {
    throw new Error(`CoinGecko getTopCoins: ${(e as Error).message}`);
  }
}

/** Resolves a Binance symbol like 'BTCUSDT' to a CoinGecko ID. */
export function symbolToGeckoId(symbol: string): string | null {
  return SYMBOL_TO_ID[symbol.toUpperCase()] ?? null;
}
