import {
  RSI,
  MACD,
  BollingerBands,
  ATR,
  EMA,
} from 'technicalindicators';
import { Candle, AnalysisResult } from '../types';

// ─── RSI ──────────────────────────────────────────────────────────────────────

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ values: closes, period });
  return values.length > 0 ? values[values.length - 1] : null;
}

/** Returns the full RSI series (for divergence detection). */
function calcRSISeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  return RSI.calculate({ values: closes, period });
}

// ─── StochRSI ─────────────────────────────────────────────────────────────────
// Formula:
//   1. Calculate RSI series
//   2. For each window of rsiPeriod RSI values: stoch = (rsi - min) / (max - min) * 100
//   3. %K = SMA(stoch, kPeriod)
//   4. %D = SMA(%K, dPeriod)

function calcStochRSI(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kPeriod = 3,
  dPeriod = 3,
): Array<{ k: number; d: number }> {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod + kPeriod + dPeriod - 2) return [];

  // Raw stochastic of RSI
  const rawStoch: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const minRSI = Math.min(...window);
    const maxRSI = Math.max(...window);
    const range  = maxRSI - minRSI;
    rawStoch.push(range === 0 ? 50 : ((rsiSeries[i] - minRSI) / range) * 100);
  }

  // %K = SMA(rawStoch, kPeriod)
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < rawStoch.length; i++) {
    const w = rawStoch.slice(i - kPeriod + 1, i + 1);
    kValues.push(w.reduce((a, b) => a + b, 0) / kPeriod);
  }

  // %D = SMA(%K, dPeriod)
  const result: Array<{ k: number; d: number }> = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const w = kValues.slice(i - dPeriod + 1, i + 1);
    const d = w.reduce((a, b) => a + b, 0) / dPeriod;
    result.push({ k: kValues[i], d });
  }

  return result;
}

// ─── RSI Divergence ───────────────────────────────────────────────────────────

/** Finds indices of local minima (swing lows) within an array. */
function findSwingLows(values: number[], wing = 3): number[] {
  const lows: number[] = [];
  for (let i = wing; i < values.length - wing; i++) {
    let isLow = true;
    for (let j = 1; j <= wing; j++) {
      if (values[i] >= values[i - j] || values[i] >= values[i + j]) {
        isLow = false;
        break;
      }
    }
    if (isLow) lows.push(i);
  }
  return lows;
}

/** Finds indices of local maxima (swing highs) within an array. */
function findSwingHighs(values: number[], wing = 3): number[] {
  const highs: number[] = [];
  for (let i = wing; i < values.length - wing; i++) {
    let isHigh = true;
    for (let j = 1; j <= wing; j++) {
      if (values[i] <= values[i - j] || values[i] <= values[i + j]) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) highs.push(i);
  }
  return highs;
}

/**
 * Detects RSI divergence over the last `lookback` candles.
 * Bullish: price makes lower low, RSI makes higher low → trend reversal up.
 * Bearish: price makes higher high, RSI makes lower high → trend reversal down.
 */
function detectRSIDivergence(
  closes: number[],
  rsiPeriod = 14,
  lookback = 40,
): 'bullish' | 'bearish' | null {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  // Align: rsiSeries[i] corresponds to closes[i + rsiPeriod]
  // Use last `lookback` aligned points
  const n = Math.min(lookback, rsiSeries.length, closes.length - rsiPeriod);
  if (n < 10) return null;

  const recentCloses = closes.slice(closes.length - n);
  const recentRSI    = rsiSeries.slice(rsiSeries.length - n);

  // ── Bullish divergence (swing lows) ─────────────────────────────────────────
  const priceLows = findSwingLows(recentCloses);
  const rsiLows   = findSwingLows(recentRSI);

  if (priceLows.length >= 2 && rsiLows.length >= 2) {
    const pi1 = priceLows[priceLows.length - 2];
    const pi2 = priceLows[priceLows.length - 1];
    // Find the two most recent RSI lows that are "near" the price lows (±5 bars)
    const ri1 = rsiLows.find((i) => Math.abs(i - pi1) <= 5);
    const ri2 = rsiLows.slice().reverse().find((i) => Math.abs(i - pi2) <= 5);
    if (
      ri1 !== undefined && ri2 !== undefined && ri1 !== ri2 &&
      recentCloses[pi2] < recentCloses[pi1] && // price: lower low
      recentRSI[ri2]    > recentRSI[ri1]        // RSI:   higher low
    ) {
      return 'bullish';
    }
  }

  // ── Bearish divergence (swing highs) ────────────────────────────────────────
  const priceHighs = findSwingHighs(recentCloses);
  const rsiHighs   = findSwingHighs(recentRSI);

  if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
    const pi1 = priceHighs[priceHighs.length - 2];
    const pi2 = priceHighs[priceHighs.length - 1];
    const ri1 = rsiHighs.find((i) => Math.abs(i - pi1) <= 5);
    const ri2 = rsiHighs.slice().reverse().find((i) => Math.abs(i - pi2) <= 5);
    if (
      ri1 !== undefined && ri2 !== undefined && ri1 !== ri2 &&
      recentCloses[pi2] > recentCloses[pi1] && // price: higher high
      recentRSI[ri2]    < recentRSI[ri1]        // RSI:   lower high
    ) {
      return 'bearish';
    }
  }

  return null;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

type MACDSignal = 'bullish_cross' | 'bearish_cross' | null;

function calcMACDSignal(closes: number[]): MACDSignal {
  if (closes.length < 35) return null;

  const values = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (values.length < 2) return null;

  const prev = values[values.length - 2];
  const curr = values[values.length - 1];

  if (!prev.MACD || !prev.signal || !curr.MACD || !curr.signal) return null;

  const prevDiff = prev.MACD - prev.signal;
  const currDiff = curr.MACD - curr.signal;

  if (prevDiff < 0 && currDiff >= 0) return 'bullish_cross';
  if (prevDiff > 0 && currDiff <= 0) return 'bearish_cross';
  return null;
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

type BBSignal = 'oversold' | 'overbought' | null;

function calcBBSignal(closes: number[], period = 20): BBSignal {
  if (closes.length < period) return null;

  const values = BollingerBands.calculate({
    values: closes,
    period,
    stdDev: 2,
  });

  if (values.length === 0) return null;
  const last  = values[values.length - 1];
  const price = closes[closes.length - 1];

  if (price <= last.lower) return 'oversold';
  if (price >= last.upper) return 'overbought';
  return null;
}

// ─── EMA Trend Filter ─────────────────────────────────────────────────────────

function calcEMA50(closes: number[]): number | null {
  if (closes.length < 50) return null;
  const values = EMA.calculate({ values: closes, period: 50 });
  return values.length > 0 ? values[values.length - 1] : null;
}

// ─── Volume Filter ────────────────────────────────────────────────────────────

/**
 * Returns ratio of current candle volume vs 20-candle average.
 * e.g. 1.5 = 50% above average = good confirmation.
 */
function calcVolumeRatio(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const pastVols = candles.slice(-period - 1, -1).map((c) => c.volume);
  const avgVol   = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;
  const curVol   = candles[candles.length - 1].volume;
  return avgVol > 0 ? curVol / avgVol : null;
}

// ─── Candlestick Patterns ─────────────────────────────────────────────────────

function detectPatterns(candles: Candle[]): string[] {
  if (candles.length < 2) return [];

  const patterns: string[] = [];
  const len = candles.length;
  const c = candles[len - 1];
  const p = candles[len - 2];

  const cBody = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  const pBody = Math.abs(p.close - p.open);

  if (cRange > 0 && cBody / cRange < 0.1) patterns.push('Doji');

  const cLowerShadow = Math.min(c.open, c.close) - c.low;
  const cUpperShadow = c.high - Math.max(c.open, c.close);
  if (cLowerShadow > cBody * 2 && cUpperShadow < cBody * 0.5 && c.close > c.open) patterns.push('Hammer');
  if (cUpperShadow > cBody * 2 && cLowerShadow < cBody * 0.5 && c.close < c.open) patterns.push('Shooting Star');

  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open) patterns.push('Bullish Engulfing');
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) patterns.push('Bearish Engulfing');

  if (cRange > 0 && cBody / cRange > 0.9) patterns.push(c.close > c.open ? 'Bullish Marubozu' : 'Bearish Marubozu');

  if (len >= 3) {
    const pp = candles[len - 3];
    const ppBody = Math.abs(pp.close - pp.open);
    if (pp.close < pp.open && ppBody > pBody * 2 && c.close > c.open && c.close > (pp.open + pp.close) / 2) {
      patterns.push('Morning Star');
    }
  }

  return patterns;
}

// ─── ATR & Trade Levels ───────────────────────────────────────────────────────

function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const values = ATR.calculate({
    high:   candles.map((c) => c.high),
    low:    candles.map((c) => c.low),
    close:  candles.map((c) => c.close),
    period,
  });
  return values.length > 0 ? values[values.length - 1] : null;
}

function swingLow(candles: Candle[], lookback = 20): number {
  return Math.min(...candles.slice(-lookback).map((c) => c.low));
}

function swingHigh(candles: Candle[], lookback = 20): number {
  return Math.max(...candles.slice(-lookback).map((c) => c.high));
}

interface TradeLevels {
  entry:       number;
  stopLoss:    number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward:  number;
}

function calcTradeLevels(candles: Candle[], direction: 'bullish' | 'bearish'): TradeLevels {
  const price = candles[candles.length - 1].close;
  const atr   = calcATR(candles) ?? price * 0.02;

  if (direction === 'bullish') {
    const sl   = Math.max(swingLow(candles, 20), price - atr * 2.0);
    const risk = price - sl;
    return {
      entry:       price,
      stopLoss:    sl,
      takeProfit1: price + risk * 1.5,
      takeProfit2: price + risk * 3.0,
      riskReward:  risk > 0 ? (risk * 1.5) / risk : 1.5,
    };
  } else {
    const sl   = Math.min(swingHigh(candles, 20), price + atr * 2.0);
    const risk = sl - price;
    return {
      entry:       price,
      stopLoss:    sl,
      takeProfit1: price - risk * 1.5,
      takeProfit2: price - risk * 3.0,
      riskReward:  risk > 0 ? (risk * 1.5) / risk : 1.5,
    };
  }
}

// ─── Combined Analysis ────────────────────────────────────────────────────────

export function analyzeCandles(symbol: string, candles: Candle[]): AnalysisResult {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1] ?? 0;

  const rsi         = calcRSI(closes);
  const macdSignal  = calcMACDSignal(closes);
  const bbSignal    = calcBBSignal(closes);
  const patterns    = detectPatterns(candles);
  const ema50       = calcEMA50(closes);
  const volumeRatio = calcVolumeRatio(candles);

  // StochRSI — get last two values for cross detection
  const stochHistory = calcStochRSI(closes);
  const stochCurr    = stochHistory.length > 0 ? stochHistory[stochHistory.length - 1] : null;
  const stochPrev    = stochHistory.length > 1 ? stochHistory[stochHistory.length - 2] : null;

  // Cross detection: K crossed above D (bullish) or below D (bearish)
  const stochBullCross = stochPrev !== null && stochCurr !== null &&
    stochPrev.k <= stochPrev.d && stochCurr.k > stochCurr.d;
  const stochBearCross = stochPrev !== null && stochCurr !== null &&
    stochPrev.k >= stochPrev.d && stochCurr.k < stochCurr.d;

  // RSI divergence
  const divergence = detectRSIDivergence(closes);

  // ── Trend & volume filters ───────────────────────────────────────────────────
  const trendAllowsBull = ema50 === null || price > ema50;
  const trendAllowsBear = ema50 === null || price < ema50;
  const volumeOk        = volumeRatio === null || volumeRatio >= 1.0;

  const signals: string[] = [];

  // ── RSI signals ─────────────────────────────────────────────────────────────
  if (rsi !== null) {
    if (rsi < 30) signals.push(`RSI Oversold (${rsi.toFixed(1)})`);
    else if (rsi > 70) signals.push(`RSI Overbought (${rsi.toFixed(1)})`);
  }

  // ── StochRSI signals ────────────────────────────────────────────────────────
  if (stochCurr !== null) {
    if (stochBullCross && stochCurr.k < 50) {
      signals.push(`StochRSI Bullish Cross (K:${stochCurr.k.toFixed(1)})`);
    } else if (stochBearCross && stochCurr.k > 50) {
      signals.push(`StochRSI Bearish Cross (K:${stochCurr.k.toFixed(1)})`);
    } else if (stochCurr.k < 20) {
      signals.push(`StochRSI Oversold (K:${stochCurr.k.toFixed(1)})`);
    } else if (stochCurr.k > 80) {
      signals.push(`StochRSI Overbought (K:${stochCurr.k.toFixed(1)})`);
    }
  }

  // ── MACD signals ────────────────────────────────────────────────────────────
  if (macdSignal === 'bullish_cross') signals.push('MACD Bullish Cross');
  if (macdSignal === 'bearish_cross') signals.push('MACD Bearish Cross');

  // ── Bollinger Band signals ───────────────────────────────────────────────────
  if (bbSignal === 'oversold')   signals.push('Below Lower Bollinger Band');
  if (bbSignal === 'overbought') signals.push('Above Upper Bollinger Band');

  // ── Candlestick patterns ─────────────────────────────────────────────────────
  signals.push(...patterns);

  // ── RSI Divergence ──────────────────────────────────────────────────────────
  if (divergence === 'bullish') signals.push('RSI Bullische Divergenz 📈');
  if (divergence === 'bearish') signals.push('RSI Baerische Divergenz 📉');

  // ── Informational signals (not scored) ──────────────────────────────────────
  if (ema50 !== null) {
    signals.push(`EMA50: $${ema50.toFixed(2)} — Trend ${price > ema50 ? '↗ bullisch' : '↘ baerisch'}`);
  }
  if (volumeRatio !== null) {
    signals.push(`Volumen: ${volumeRatio.toFixed(2)}x Ø ${volumeRatio >= 1.0 ? '✅' : '⚠️ niedrig'}`);
  }

  // ── Scoring ─────────────────────────────────────────────────────────────────
  const bullishPatterns = ['Bullish Engulfing', 'Hammer', 'Morning Star', 'Bullish Marubozu'];
  const bearishPatterns = ['Bearish Engulfing', 'Shooting Star', 'Bearish Marubozu'];

  const bullishScore =
    (rsi !== null && rsi < 30 ? 1 : 0) +
    (macdSignal === 'bullish_cross' ? 1 : 0) +
    (bbSignal === 'oversold' ? 1 : 0) +
    (patterns.some((p) => bullishPatterns.includes(p)) ? 1 : 0) +
    ((stochBullCross || (stochCurr !== null && stochCurr.k < 20)) ? 1 : 0) +
    (divergence === 'bullish' ? 2 : 0); // divergence is a strong signal (+2)

  const bearishScore =
    (rsi !== null && rsi > 70 ? 1 : 0) +
    (macdSignal === 'bearish_cross' ? 1 : 0) +
    (bbSignal === 'overbought' ? 1 : 0) +
    (patterns.some((p) => bearishPatterns.includes(p)) ? 1 : 0) +
    ((stochBearCross || (stochCurr !== null && stochCurr.k > 80)) ? 1 : 0) +
    (divergence === 'bearish' ? 2 : 0);

  let direction:   'bullish' | 'bearish' | null = null;
  let entry:       number | null = null;
  let stopLoss:    number | null = null;
  let takeProfit1: number | null = null;
  let takeProfit2: number | null = null;
  let riskReward:  number | null = null;

  const isBullish = bullishScore >= 2 && trendAllowsBull && volumeOk;
  const isBearish = bearishScore >= 2 && trendAllowsBear && volumeOk;

  if (isBullish || isBearish) {
    direction = isBullish && bullishScore >= bearishScore ? 'bullish' : 'bearish';
    if (direction === 'bullish' && !isBullish) direction = null;
    if (direction === 'bearish' && !isBearish) direction = null;
  }

  if (direction !== null) {
    const levels = calcTradeLevels(candles, direction);
    entry       = levels.entry;
    stopLoss    = levels.stopLoss;
    takeProfit1 = levels.takeProfit1;
    takeProfit2 = levels.takeProfit2;
    riskReward  = levels.riskReward;
  }

  return {
    symbol, price, rsi, macdSignal, bbSignal, patterns, signals,
    direction, entry, stopLoss, takeProfit1, takeProfit2, riskReward,
    ema50, volumeRatio,
    stochRsiK:  stochCurr?.k ?? null,
    stochRsiD:  stochCurr?.d ?? null,
    divergence,
  };
}

export function isNotifiableSignal(result: AnalysisResult): boolean {
  return result.direction !== null &&
    result.entry !== null &&
    result.stopLoss !== null;
}
