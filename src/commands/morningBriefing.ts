/**
 * Morning Briefing — sent every day at 08:00 Berlin time
 * Shows: BTC macro regime, coins near EMA cross, overall market vibe
 */

import { Bot } from 'grammy';
import { getCandles } from '../services/binance';
import { EMA, ADX } from 'technicalindicators';

const BRIEFING_COINS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LTCUSDT', 'BNBUSDT', 'SOLUSDT', 'LINKUSDT'];

interface CoinStatus {
  symbol:     string;
  price:      number;
  ema20:      number;
  ema50:      number;
  ema200:     number;
  adxRising:  boolean;
  adxValue:   number;
  aboveEma200: boolean;
  crossDist:  number; // % distance between EMA20 and EMA50 (0 = at cross)
  direction:  'bullish' | 'bearish' | 'neutral';
}

function calcEMALast(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1];
  const vals = EMA.calculate({ values: closes, period });
  return vals[vals.length - 1];
}

function calcADXLast(candles: { high: number; low: number; close: number }[], period = 14): { adx: number; rising: boolean } {
  if (candles.length < period * 2 + 4) return { adx: 0, rising: false };
  const vals = ADX.calculate({
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
    period,
  });
  if (vals.length < 4) return { adx: 0, rising: false };
  const now  = vals[vals.length - 1].adx;
  const prev = vals[vals.length - 4].adx;
  return { adx: now, rising: now > prev };
}

async function analyzeCoinStatus(symbol: string): Promise<CoinStatus | null> {
  try {
    const candles = await getCandles(symbol, '4h', 250);
    const closes  = candles.map(c => c.close);
    const price   = closes[closes.length - 1];

    const ema20  = calcEMALast(closes, 20);
    const ema50  = calcEMALast(closes, 50);
    const ema200 = calcEMALast(closes, 200);
    const { adx, rising: adxRising } = calcADXLast(candles);

    const aboveEma200 = price > ema200;
    // Cross distance: how far (%) EMA20 is from EMA50 — near 0% = near cross
    const crossDist = Math.abs(ema20 - ema50) / ema50 * 100;

    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (ema20 > ema50 && aboveEma200) direction = 'bullish';
    if (ema20 < ema50 && !aboveEma200) direction = 'bearish';

    return { symbol, price, ema20, ema50, ema200, adxRising, adxValue: adx, aboveEma200, crossDist, direction };
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 5 });
}

export async function buildMorningBriefing(): Promise<string> {
  const results = await Promise.allSettled(
    BRIEFING_COINS.map(s => analyzeCoinStatus(s))
  );

  const statuses = results
    .filter((r): r is PromiseFulfilledResult<CoinStatus | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((s): s is CoinStatus => s !== null);

  const btc = statuses.find(s => s.symbol === 'BTCUSDT');
  const alts = statuses.filter(s => s.symbol !== 'BTCUSDT');

  // BTC regime
  const btcRegime = btc
    ? btc.aboveEma200 ? '🟢 BULLISCH (über EMA200)' : '🔴 BÄRISCH (unter EMA200)'
    : '❓ Unbekannt';
  const btcLine = btc
    ? `BTC: $${fmt(btc.price)} | EMA200: $${fmt(btc.ema200)} | ${btcRegime}`
    : 'BTC: Daten nicht verfügbar';

  // Coins near cross (EMA20 within 2% of EMA50)
  const nearCross = alts
    .filter(s => s.crossDist < 2.0)
    .sort((a, b) => a.crossDist - b.crossDist);

  // Coins with active bullish/bearish setup + ADX rising
  const hotSignals = alts
    .filter(s => s.direction !== 'neutral' && s.adxRising)
    .sort((a, b) => a.crossDist - b.crossDist);

  // Build near-cross section
  let nearCrossSection = '';
  if (nearCross.length > 0) {
    const lines = nearCross.map(s => {
      const ema20Above = s.ema20 > s.ema50;
      const arrow = ema20Above ? '↗' : '↘';
      const tag = s.adxRising ? ' ⚡ ADX steigt' : '';
      return `  • *${s.symbol.replace('USDT','')}* ${arrow} ${s.crossDist.toFixed(2)}% Abstand${tag}`;
    });
    nearCrossSection = `\n⚡ *Coins nahe am EMA-Cross* (< 2%):\n${lines.join('\n')}\n`;
  } else {
    nearCrossSection = `\n⚡ *Coins nahe am EMA-Cross:* Aktuell keine\n`;
  }

  // Build hot setups section
  let hotSection = '';
  if (hotSignals.length > 0) {
    const lines = hotSignals.map(s => {
      const emoji = s.direction === 'bullish' ? '🟢' : '🔴';
      const dir   = s.direction === 'bullish' ? 'LONG' : 'SHORT';
      return `  ${emoji} *${s.symbol.replace('USDT','')}* ${dir} — ADX ${s.adxValue.toFixed(0)} steigend`;
    });
    hotSection = `\n🔥 *Aktive Setups mit Momentum:*\n${lines.join('\n')}\n`;
  }

  // Overall market score
  const bullCount = alts.filter(s => s.direction === 'bullish').length;
  const bearCount = alts.filter(s => s.direction === 'bearish').length;
  const totalAlt  = alts.length;
  const sentiment = bullCount > bearCount
    ? `🐂 Risk-On (${bullCount}/${totalAlt} Coins bullisch)`
    : bearCount > bullCount
    ? `🐻 Risk-Off (${bearCount}/${totalAlt} Coins bärisch)`
    : `⚖️ Neutral (${bullCount} bull / ${bearCount} bear)`;

  const now = new Date().toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });

  return (
    `☀️ *MarketLens Morning Briefing*\n_${now}_\n\n` +
    `📊 *BTC Marktregime:*\n  ${btcLine}\n` +
    `🌡️ *Gesamtstimmung:* ${sentiment}\n` +
    nearCrossSection +
    hotSection +
    `\n_Der Bot scannt alle ${BRIEFING_COINS.length} Coins und sendet automatisch Signale wenn die Bedingungen erfüllt sind._\n` +
    `_/aktiv — offene Trades  |  /stats — Performance_`
  );
}
