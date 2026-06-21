import {
  RSI,
  MACD,
  BollingerBands,
  ATR,
} from 'technicalindicators';
import { Candle, AnalysisResult } from '../types';

// ─── RSI ────────────────────────────────────────────────────────────────────────────

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ values: closes, period });
  return values.length > 0 ? values[values.length - 1] : null;
}

// ─── MACD ────────────────────────────────────────────────────────────────────────────

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

// ─── Bollinger Bands ───────────────────────────────────────────────────────────────────

type BBSignal = 'oversold' | 'overbought' | null;

function calcBBSignal(closes: number[], period = 20): BBSignal {
  if (closes.length < period) return null;

  const values = BollingerBands.calculate({
    values: closes,
    period,
    stdDev: 2,
  });

  if (values.length === 0) return null;
  const last = values[values.length - 1];
  const price = closes[closes.length - 1];

  if (price <= last.lower) return 'oversold';
  if (price >= last.upper) return 'overbought';
  return null;
}

// ─── Candlestick Patterns ───────────────────────────────────────────────────────────────────────

/**
 * Detects basic candlestick patterns from the last 2-3 candles.
 * Returns an array of detected pattern names.
 */
function detectPatterns(candles: Candle[]): string[] {
  if (candles.length < 2) return [];

  const patterns: string[] = [];
  const len = candles.length;
  const c = candles[len - 1]; // current
  const p = candles[len - 2]; // previous

  const cBody = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  const pBody = Math.abs(p.close - p.open);

  // Doji: body < 10% of range
  if (cRange > 0 && cBody / cRange < 0.1) {
    patterns.push('Doji');
  }

  // Hammer: small body near top, long lower shadow (bullish reversal)
  const cLowerShadow = Math.min(c.open, c.close) - c.low;
  const cUpperShadow = c.high - Math.max(c.open, c.close);
  if (cLowerShadow > cBody * 2 && cUpperShadow < cBody * 0.5 && c.close > c.open) {
    patterns.push('Hammer');
  }

  // Shooting Star: small body near bottom, long upper shadow (bearish reversal)
  if (cUpperShadow > cBody * 2 && cLowerShadow < cBody * 0.5 && c.close < c.open) {
    patterns.push('Shooting Star');
  }

  // Bullish Engulfing: prev bearish candle fully covered by current bullish candle
  if (
    p.close < p.open && // previous is bearish
    c.close > c.open && // current is bullish
    c.open <= p.close && // current opens at or below prev close
    c.close >= p.open   // current closes at or above prev open
  ) {
    patterns.push('Bullish Engulfing');
  }

  // Bearish Engulfing
  if (
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    patterns.push('Bearish Engulfing');
  }

  // Marubozu: almost no shadows (strong momentum candle)
  if (cRange > 0 && cBody / cRange > 0.9) {
    patterns.push(c.close > c.open ? 'Bullish Marubozu' : 'Bearish Marubozu');
  }

  // Morning Star (3-candle): bearish → small body → bullish
  if (len >= 3) {
    const pp = candles[len - 3];
    const ppBody = Math.abs(pp.close - pp.open);
    if (
      pp.close < pp.open &&     // first: bearish
      ppBody > pBody * 2 &&     // first has large body
      c.close > c.open &&       // third: bullish
      c.close > (pp.open + pp.close) / 2 // third closes above midpoint of first
    ) {
      patterns.push('Morning Star');
    }
  }

  return patterns;
}

// ─── ATR & Trade Levels ──────────────────────────────────────────────────────────────────────────────

function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const values = ATR.calculate({
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
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
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
}

function calcTradeLevels(candles: Candle[], direction: 'bullish' | 'bearish'): TradeLevels {
  const price = candles[candles.length - 1].close;
  const atr = calcATR(candles) ?? price * 0.02;

  if (direction === 'bullish') {
    const sl = Math.max(swingLow(candles, 20), price - atr * 1.5);
    const risk = price - sl;
    return {
      entry: price,
      stopLoss: sl,
      takeProfit1: price + risk * 1.5,
      takeProfit2: price + risk * 3.0,
      riskReward: risk > 0 ? (risk * 1.5) / risk : 1.5,
    };
  } else {
    const sl = Math.min(swingHigh(candles, 20), price + atr * 1.5);
    const risk = sl - price;
    return {
      entry: price,
      stopLoss: sl,
      takeProfit1: price - risk * 1.5,
      takeProfit2: price - risk * 3.0,
      riskReward: risk > 0 ? (risk * 1.5) / risk : 1.5,
    };
  }
}

// ─── Combined Analysis ────────────────────────────────────────────────────────────────────────────────

/**
 * Runs full technical analysis on a set of candles and produces actionable signals.
 */
export function analyzeCandles(symbol: string, candles: Candle[]): AnalysisResult {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1] ?? 0;

  const rsi = calcRSI(closes);
  const macdSignal = calcMACDSignal(closes);
  const bbSignal = calcBBSignal(closes);
  const patterns = detectPatterns(candles);

  const signals: string[] = [];

  // RSI signals
  if (rsi !== null) {
    if (rsi < 30) signals.push(`RSI Oversold (${rsi.toFixed(1)})`);
    else if (rsi > 70) signals.push(`RSI Overbought (${rsi.toFixed(1)})`);
  }

  // MACD signals
  if (macdSignal === 'bullish_cross') signals.push('MACD Bullish Cross');
  if (macdSignal === 'bearish_cross') signals.push('MACD Bearish Cross');

  // Bollinger Band signals
  if (bbSignal === 'oversold') signals.push('Below Lower Bollinger Band');
  if (bbSignal === 'overbought') signals.push('Above Upper Bollinger Band');

  // Pattern signals
  signals.push(...patterns);

  // ─── Direction & trade levels ──────────────────────────────────────────────────────────────────────────────
  const bullishPatterns = ['Bullish Engulfing', 'Hammer', 'Morning Star', 'Bullish Marubozu'];
  const bearishPatterns = ['Bearish Engulfing', 'Shooting Star', 'Bearish Marubozu'];

  const bullishScore =
    (rsi !== null && rsi < 30 ? 1 : 0) +
    (macdSignal === 'bullish_cross' ? 1 : 0) +
    (bbSignal === 'oversold' ? 1 : 0) +
    (patterns.some((p) => bullishPatterns.includes(p)) ? 1 : 0);

  const bearishScore =
    (rsi !== null && rsi > 70 ? 1 : 0) +
    (macdSignal === 'bearish_cross' ? 1 : 0) +
    (bbSignal === 'overbought' ? 1 : 0) +
    (patterns.some((p) => bearishPatterns.includes(p)) ? 1 : 0);

  let direction: 'bullish' | 'bearish' | null = null;
  let entry: number | null = null;
  let stopLoss: number | null = null;
  let takeProfit1: number | null = null;
  let takeProfit2: number | null = null;
  let riskReward: number | null = null;

  if (bullishScore >= 2 || bearishScore >= 2) {
    direction = bullishScore >= bearishScore ? 'bullish' : 'bearish';
    const levels = calcTradeLevels(candles, direction);
    entry = levels.entry;
    stopLoss = levels.stopLoss;
    takeProfit1 = levels.takeProfit1;
    takeProfit2 = levels.takeProfit2;
    riskReward = levels.riskReward;
  }

  return { symbol, price, rsi, macdSignal, bbSignal, patterns, signals, direction, entry, stopLoss, takeProfit1, takeProfit2, riskReward };
}

/**
 * Returns true if the analysis result warrants sending a push notification.
 * Fires only when multiple confirming signals align (reduces noise).
 */
export function isNotifiableSignal(result: AnalysisResult): boolean {
  const bullishPatterns = ['Bullish Engulfing', 'Hammer', 'Morning Star', 'Bullish Marubozu'];
  const bearishPatterns = ['Bearish Engulfing', 'Shooting Star', 'Bearish Marubozu'];

  const hasBullishPattern = result.patterns.some((p) => bullishPatterns.includes(p));
  const hasBearishPattern = result.patterns.some((p) => bearishPatterns.includes(p));

  const rsiBullish = result.rsi !== null && result.rsi < 30;
  const rsiBearish = result.rsi !== null && result.rsi > 70;
  const macdBullish = result.macdSignal === 'bullish_cross';
  const macdBearish = result.macdSignal === 'bearish_cross';
  const bbBullish = result.bbSignal === 'oversold';
  const bbBearish = result.bbSignal === 'overbought';

  // Require at least 2 confirming bullish signals
  const bullishScore =
    (rsiBullish ? 1 : 0) + (macdBullish ? 1 : 0) + (bbBullish ? 1 : 0) + (hasBullishPattern ? 1 : 0);

  // Require at least 2 confirming bearish signals
  const bearishScore =
    (rsiBearish ? 1 : 0) + (macdBearish ? 1 : 0) + (bbBearish ? 1 : 0) + (hasBearishPattern ? 1 : 0);

  return bullishScore >= 2 || bearishScore >= 2;
}
