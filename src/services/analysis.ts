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
  const last = values[values.length - 1];
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

  const rsi        = calcRSI(closes);
  const macdSignal = calcMACDSignal(closes);
  const bbSignal   = calcBBSignal(closes);
  const patterns   = detectPatterns(candles);
  const ema50      = calcEMA50(closes);
  const volumeRatio = calcVolumeRatio(candles);

  // ── Trend & volume filters ───────────────────────────────────────────────────
  // Only allow bullish signals when price is above EMA50 (uptrend confirmed)
  // Only allow bearish signals when price is below EMA50 (downtrend confirmed)
  const trendAllowsBull = ema50 === null || price > ema50;
  const trendAllowsBear = ema50 === null || price < ema50;
  // Require at least average volume (ratio >= 1.0) for signal confirmation
  const volumeOk = volumeRatio === null || volumeRatio >= 1.0;

  const signals: string[] = [];

  if (rsi !== null) {
    if (rsi < 30) signals.push(`RSI Oversold (${rsi.toFixed(1)})`);
    else if (rsi > 70) signals.push(`RSI Overbought (${rsi.toFixed(1)})`);
  }
  if (macdSignal === 'bullish_cross') signals.push('MACD Bullish Cross');
  if (macdSignal === 'bearish_cross') signals.push('MACD Bearish Cross');
  if (bbSignal === 'oversold')   signals.push('Below Lower Bollinger Band');
  if (bbSignal === 'overbought') signals.push('Above Upper Bollinger Band');
  signals.push(...patterns);

  // Info signals (not scored, just informational)
  if (ema50 !== null) {
    signals.push(`EMA50: $${ema50.toFixed(2)} — Trend ${price > ema50 ? '↗ bullisch' : '↘ bärisch'}`);
  }
  if (volumeRatio !== null) {
    signals.push(`Volumen: ${volumeRatio.toFixed(2)}x Ø ${volumeRatio >= 1.0 ? '✅' : '⚠️ niedrig'}`);
  }

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
  };
}

export function isNotifiableSignal(result: AnalysisResult): boolean {
  return result.direction !== null &&
    result.entry !== null &&
    result.stopLoss !== null;
}
