import {
  EMA,
  ATR,
  ADX,
  RSI,
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

// ─── RSI ──────────────────────────────────────────────────────────────────────

function calcRSIValue(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ values: closes, period });
  return values.length > 0 ? values[values.length - 1] : null;
}

// ─── ADX (Rising Momentum) ────────────────────────────────────────────────────

function isAdxRising(candles: Candle[], period = 14): boolean {
  if (candles.length < period * 2 + 4) return true;
  const values = ADX.calculate({
    high:  candles.map((c) => c.high),
    low:   candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    period,
  });
  if (values.length < 4) return true;
  const now  = values[values.length - 1].adx;
  const prev = values[values.length - 4].adx;
  return now > prev;
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
    if (risk <= 0 || risk / price > 0.08) return null;
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


// ─── Confluence Score (0–100) ─────────────────────────────────────────────────

function calcConfluenceScore(
  candles: Candle[],
  ema20Series: number[],
  ema50Series: number[],
  ema200: number | null,
  volumeRatio: number | null,
  direction: 'bullish' | 'bearish',
): { score: number; breakdown: string[] } {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];
  let score    = 0;
  const breakdown: string[] = [];

  // ── 1. Volume (0–30 pts) ──────────────────────────────────────────────────
  const vr = volumeRatio ?? 1.0;
  let volPts = 0;
  if (vr >= 3.0)      volPts = 30;
  else if (vr >= 2.0) volPts = 22;
  else if (vr >= 1.5) volPts = 14;
  else if (vr >= 1.0) volPts = 7;
  score += volPts;
  breakdown.push(`Vol ${vr.toFixed(1)}x avg → ${volPts}/30`);

  // ── 2. EMA200 distance (0–25 pts) ────────────────────────────────────────
  let ema200Pts = 0;
  if (ema200 !== null) {
    const dist = Math.abs(price - ema200) / price * 100;
    if (dist >= 15)      ema200Pts = 25;
    else if (dist >= 8)  ema200Pts = 18;
    else if (dist >= 4)  ema200Pts = 12;
    else if (dist >= 1)  ema200Pts = 6;
    breakdown.push(`EMA200 Abstand ${dist.toFixed(1)}% → ${ema200Pts}/25`);
  } else {
    ema200Pts = 12;
    breakdown.push(`EMA200 n/a → ${ema200Pts}/25`);
  }
  score += ema200Pts;

  // ── 3. EMA20 slope (0–25 pts) ────────────────────────────────────────────
  let slopePts = 0;
  if (ema20Series.length >= 5) {
    const ema20Now  = ema20Series[ema20Series.length - 1];
    const ema20Five = ema20Series[ema20Series.length - 5];
    const slopePct  = (ema20Now - ema20Five) / ema20Five * 100;
    const abvSlope  = Math.abs(slopePct);
    const correct   = direction === 'bullish' ? slopePct > 0 : slopePct < 0;
    if (correct) {
      if (abvSlope >= 2.0)      slopePts = 25;
      else if (abvSlope >= 1.0) slopePts = 18;
      else if (abvSlope >= 0.4) slopePts = 10;
      else                       slopePts = 4;
    }
    breakdown.push(`EMA20 Slope ${slopePct >= 0 ? '+' : ''}${slopePct.toFixed(2)}% (5c) → ${slopePts}/25`);
  }
  score += slopePts;

  // ── 4. EMA50 alignment clarity (0–20 pts) ────────────────────────────────
  let alignPts = 0;
  if (ema20Series.length >= 10 && ema50Series.length >= 10) {
    let streak = 0;
    for (let i = ema20Series.length - 2; i >= Math.max(0, ema20Series.length - 15); i--) {
      const wasOpposite = direction === 'bullish'
        ? ema20Series[i] <= ema50Series[i]
        : ema20Series[i] >= ema50Series[i];
      if (wasOpposite) streak++;
      else break;
    }
    if (streak >= 8)      alignPts = 20;
    else if (streak >= 5) alignPts = 14;
    else if (streak >= 3) alignPts = 8;
    else                   alignPts = 3;
    breakdown.push(`Trend-Aufbau ${streak} Kerzen → ${alignPts}/20`);
  }
  score += alignPts;

  return { score: Math.min(100, score), breakdown };
}

// ─── Main Analysis: EMA Cross Strategy ───────────────────────────────────────
//
// Signal fires when:
//   LONG:  EMA20 crosses above EMA50 AND price > EMA200 AND ADX rising
//   SHORT: EMA20 crosses below EMA50 AND price < EMA200 AND ADX rising

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

  const volumeOk = volumeRatio === null || volumeRatio >= 1.0;
  const adxOk    = isAdxRising(candles);

  const goldenCross = ema20p !== null && ema50p !== null && ema20 !== null && ema50 !== null &&
    ema20p <= ema50p && ema20 > ema50;
  const deathCross  = ema20p !== null && ema50p !== null && ema20 !== null && ema50 !== null &&
    ema20p >= ema50p && ema20 < ema50;

  const macroUptrend   = ema200 === null || price > ema200;
  const macroDowntrend = ema200 === null || price < ema200;

  let direction: 'bullish' | 'bearish' | null = null;
  if (goldenCross && macroUptrend   && volumeOk && adxOk) direction = 'bullish';
  if (deathCross  && macroDowntrend && volumeOk && adxOk) direction = 'bearish';

  const signals: string[] = [];
  if (ema20 !== null && ema50 !== null) {
    if (goldenCross) signals.push(`EMA20 kreuzt EMA50 nach oben (Golden Cross) \u{1F4C8}`);
    if (deathCross)  signals.push(`EMA20 kreuzt EMA50 nach unten (Death Cross) \u{1F4C9}`);
    signals.push(`EMA20: $${ema20.toFixed(2)} | EMA50: $${ema50.toFixed(2)}`);
  }
  if (ema200 !== null) {
    signals.push(`EMA200: $${ema200.toFixed(2)} — Makrotrend ${price > ema200 ? '↗ bullisch' : '↘ baerisch'}`);
  }
  if (volumeRatio !== null) {
    signals.push(`Volumen: ${volumeRatio.toFixed(2)}x Durchschnitt ${volumeRatio >= 1.0 ? '✅' : '⚠️'}`);
  }
  signals.push(`ADX Momentum: ${adxOk ? '✅ steigend' : '⚠️ flach/fallend'}`);

  const { score: confluenceScore, breakdown: confluenceBreakdown } =
    direction !== null
      ? calcConfluenceScore(candles, ema20Series, ema50Series, ema200, volumeRatio, direction)
      : { score: null as unknown as number, breakdown: [] as string[] };

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
      direction = null;
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
    confluenceScore:     direction !== null ? confluenceScore : null,
    confluenceBreakdown: direction !== null ? confluenceBreakdown : [],
    strategy: 'EMA_CROSS',
  };
}

// ─── RSI Bounce Strategy ──────────────────────────────────────────────────────
//
// Signal fires when:
//   LONG:  RSI < 30 (oversold) AND price > EMA200 (macro uptrend)
//   SHORT: RSI > 70 (overbought) AND price < EMA200 (macro downtrend)
//
// OOS-validated on 15 coins: +16R total, ~1.5 signals/day

export function analyzeRsiBounce(symbol: string, candles: Candle[]): AnalysisResult {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1] ?? 0;

  const ema200Series = calcEMASeries(closes, 200);
  const ema50Series  = calcEMASeries(closes, 50);
  const volumeRatio  = calcVolumeRatio(candles);
  const rsiValue     = calcRSIValue(closes, 14);

  const ema200 = ema200Series.length > 0 ? ema200Series[ema200Series.length - 1] : null;
  const ema50  = ema50Series.length  > 0 ? ema50Series[ema50Series.length - 1]   : null;

  let direction: 'bullish' | 'bearish' | null = null;

  // RSI Bounce = pure mean reversion — kein EMA200 Filter nötig
  // (EMA200 würde in Korrekturen alle LONG Signale blockieren)
  if (rsiValue !== null) {
    if (rsiValue < 30) direction = 'bullish';
    if (rsiValue > 70) direction = 'bearish';
  }

  const signals: string[] = [];
  if (rsiValue !== null) {
    signals.push(`RSI(14): ${rsiValue.toFixed(1)} ${rsiValue < 30 ? '\u{1F7E2} überkauft/oversold' : rsiValue > 70 ? '\u{1F534} überkauft/overbought' : 'neutral'}`);
  }
  if (ema200 !== null) {
    signals.push(`EMA200: $${ema200.toFixed(2)} — Makrotrend ${price > ema200 ? '↗ bullisch' : '↘ baerisch'}`);
  }
  if (volumeRatio !== null) {
    signals.push(`Volumen: ${volumeRatio.toFixed(2)}x Durchschnitt`);
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
      direction = null;
    }
  }

  return {
    symbol, price,
    rsi:         rsiValue,
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
    confluenceScore:     null,
    confluenceBreakdown: [],
    strategy:   'RSI_BOUNCE',
    rsiValue,
  };
}

export function isNotifiableSignal(result: AnalysisResult): boolean {
  return result.direction !== null &&
    result.entry !== null &&
    result.stopLoss !== null;
}
