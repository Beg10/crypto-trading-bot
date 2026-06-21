import {
  EMA,
  ATR,
} from 'technicalindicators';
import { Candle, AnalysisResult } from '../types';

// ─── EMA Series ───────────────────────────────────────────────────────────────

function calcEMASeries(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  return EMA.calculate({ values: closes, period });
}

function calcEMALast(closes: number[], period: number): number | null {
  const series = calcEMASeries(closes, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

// ─── Volume Filter ────────────────────────────────────────────────────────────

function calcVolumeRatio(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const pastVols = candles.slice(-period - 1, -1).map((c) => c.volume);
  const avgVol   = pastVols.reduce((a, b) => a + b, 0) / pastVols.length;
  const curVol   = candles[candles.length - 1].volume;
  return avgVol > 0 ? curVol / avgVol : null;
}

// ─── ATR & Trade Levels ───────────────────────────────────────────────────────

function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const values = ATR.calculate({
    high:  candles.map((c) => c.high),
    low:   candles.map((c) => c.low),
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
  entry: number; stopLoss: number; takeProfit1: number; takeProfit2: number; riskReward: number;
}

function calcTradeLevels(candles: Candle[], direction: 'bullish' | 'bearish'): TradeLevels | null {
  const price = candles[candles.length - 1].close;
  const atr   = calcATR(candles) ?? price * 0.02;

  if (direction === 'bullish') {
    const sl   = Math.max(swingLow(candles, 20), price - atr * 1.5);
    const risk = price - sl;
    if (risk <= 0 || risk / price > 0.08) return null; // skip if SL > 8%
    return {
      entry: price, stopLoss: sl,
      takeProfit1: price + risk * 2.0,
      takeProfit2: price + risk * 4.0,
      riskReward: 2.0,
    };
  } else {
    const sl   = Math.min(swingHigh(candles, 20), price + atr * 1.5);
    const risk = sl - price;
    if (risk <= 0 || risk / price > 0.08) return null;
    return {
      entry: price, stopLoss: sl,
      takeProfit1: price - risk * 2.0,
      takeProfit2: price - risk * 4.0,
      riskReward: 2.0,
    };
  }
}

// ─── Main Analysis: EMA Cross Strategy ───────────────────────────────────────
//
// Signal fires when:
//   LONG:  EMA20 crosses above EMA50 AND price > EMA200 (macro uptrend)
//   SHORT: EMA20 crosses below EMA50 AND price < EMA200 (macro downtrend)
//
// This is a trend-following approach — we ride the trend, not fight it.

export function analyzeCandles(symbol: string, candles: Candle[]): AnalysisResult {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1] ?? 0;

  const ema20Series  = calcEMASeries(closes, 20);
  const ema50Series  = calcEMASeries(closes, 50);
  const ema200Series = calcEMASeries(closes, 200);
  const volumeRatio  = calcVolumeRatio(candles);

  const ema20  = ema20Series.length  > 0 ? ema20Series[ema20Series.length - 1]   : null;
  const ema20p = ema20Series.length  > 1 ? ema20Series[ema20Series.length - 2]   : null;
  const ema50  = ema50Series.length  > 0 ? ema50Series[ema50Series.length - 1]   : null;
  const ema50p = ema50Series.length  > 1 ? ema50Series[ema50Series.length - 2]   : null;
  const ema200 = ema200Series.length > 0 ? ema200Series[ema200Series.length - 1] : null;

  // Volume must be at least average
  const volumeOk = volumeRatio === null || volumeRatio >= 1.0;

  // EMA20/50 cross detection
  const goldenCross = ema20p !== null && ema50p !== null && ema20 !== null && ema50 !== null &&
    ema20p <= ema50p && ema20 > ema50;
  const deathCross  = ema20p !== null && ema50p !== null && ema20 !== null && ema50 !== null &&
    ema20p >= ema50p && ema20 < ema50;

  // Macro trend filter: EMA200 must confirm
  const macroUptrend   = ema200 === null || price > ema200;
  const macroDowntrend = ema200 === null || price < ema200;

  let direction: 'bullish' | 'bearish' | null = null;
  if (goldenCross && macroUptrend   && volumeOk) direction = 'bullish';
  if (deathCross  && macroDowntrend && volumeOk) direction = 'bearish';

  // Build signal info lines
  const signals: string[] = [];
  if (ema20 !== null && ema50 !== null) {
    if (goldenCross) signals.push(`EMA20 kreuzt EMA50 nach oben (Golden Cross) 📈`);
    if (deathCross)  signals.push(`EMA20 kreuzt EMA50 nach unten (Death Cross) 📉`);
    signals.push(`EMA20: $${ema20.toFixed(2)} | EMA50: $${ema50.toFixed(2)}`);
  }
  if (ema200 !== null) {
    signals.push(`EMA200: $${ema200.toFixed(2)} — Makrotrend ${price > ema200 ? '↗ bullisch' : '↘ baerisch'}`);
  }
  if (volumeRatio !== null) {
    signals.push(`Volumen: ${volumeRatio.toFixed(2)}x Durchschnitt ${volumeRatio >= 1.0 ? '✅' : '⚠️'}`);
  }

  let entry:       number | null = null;
  let stopLoss:    number | null = null;
  let takeProfit1: number | null = null;
  let takeProfit2: number | null = null;
  let riskReward:  number | null = null;

  if (direction !== null) {
    const levels = calcTradeLevels(candles, direction);
    if (levels) {
      entry       = levels.entry;
      stopLoss    = levels.stopLoss;
      takeProfit1 = levels.takeProfit1;
      takeProfit2 = levels.takeProfit2;
      riskReward  = levels.riskReward;
    } else {
      direction = null; // invalid levels, skip signal
    }
  }

  return {
    symbol, price,
    rsi:         null,
    macdSignal:  null,
    bbSignal:    null,
    patterns:    [],
    signals,
    direction,
    entry, stopLoss, takeProfit1, takeProfit2, riskReward,
    ema50,
    volumeRatio,
    stochRsiK:  null,
    stochRsiD:  null,
    divergence: null,
  };
}

export function isNotifiableSignal(result: AnalysisResult): boolean {
  return result.direction !== null &&
    result.entry !== null &&
    result.stopLoss !== null;
}
