/**
 * Backtest — run with:  npx tsx src/backtest.ts
 *
 * Slides a 100-candle window over historical 1h data,
 * fires the same signal logic as the production worker,
 * and checks whether price hit TP1 before SL within 24h.
 */

import 'dotenv/config';
import { getCandles } from './services/binance';
import { analyzeCandles, isNotifiableSignal } from './services/analysis';
import { AnalysisResult } from './types';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const WINDOW   = 100;   // same as production
const LOOKAHEAD = 24;   // candles to evaluate outcome (1h each)
const COOLDOWN  = 12;   // skip re-signals within N candles of last signal

interface Signal {
  direction: 'bullish' | 'bearish';
  entry:  number;
  sl:     number;
  tp1:    number;
  tp2:    number;
  rr:     number;
  slPct:  number;
  tp1Pct: number;
  hitTp1: boolean;
  hitSl:  boolean;
  timeout: boolean;
}

function backtest(candles: Array<{ open: number; high: number; low: number; close: number; volume: number; openTime: number; closeTime: number }>, symbol: string): Signal[] {
  const signals: Signal[] = [];
  let cooldown = 0;

  for (let i = WINDOW; i < candles.length - LOOKAHEAD; i++) {
    if (cooldown > 0) { cooldown--; continue; }

    const window = candles.slice(i - WINDOW, i);
    const result: AnalysisResult = analyzeCandles(symbol, window);

    if (!isNotifiableSignal(result) || result.entry === null || result.stopLoss === null || result.takeProfit1 === null || result.takeProfit2 === null) continue;

    const future = candles.slice(i, i + LOOKAHEAD);
    const { entry, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, direction, riskReward } = result;

    let hitTp1 = false;
    let hitSl  = false;

    for (const fc of future) {
      if (direction === 'bullish') {
        if (fc.high >= tp1 && !hitSl) { hitTp1 = true; break; }
        if (fc.low  <= sl)            { hitSl  = true; break; }
      } else {
        if (fc.low  <= tp1 && !hitSl) { hitTp1 = true; break; }
        if (fc.high >= sl)            { hitSl  = true; break; }
      }
    }

    const slPct  = Math.abs(sl - entry) / entry * 100;
    const tp1Pct = Math.abs(tp1 - entry) / entry * 100;
    const rr     = slPct > 0 ? tp1Pct / slPct : 0;

    signals.push({ direction: direction!, entry, sl, tp1, tp2, rr, slPct, tp1Pct, hitTp1, hitSl, timeout: !hitTp1 && !hitSl });
    cooldown = COOLDOWN;
  }

  return signals;
}

function fmt(n: number, dec = 1) { return n.toFixed(dec); }

function printReport(symbol: string, signals: Signal[], totalCandles: number) {
  const n = signals.length;
  const bar = '─'.repeat(50);

  console.log(`\n${bar}`);
  console.log(`  ${symbol}  •  4h  •  ${totalCandles} candles  •  lookahead ${LOOKAHEAD}h`);
  console.log(bar);

  if (n === 0) {
    console.log('  No signals found.');
    return;
  }

  const wins     = signals.filter(s => s.hitTp1);
  const losses   = signals.filter(s => s.hitSl);
  const timeouts = signals.filter(s => s.timeout);
  const bulls    = signals.filter(s => s.direction === 'bullish');
  const bears    = signals.filter(s => s.direction === 'bearish');
  const bWins    = bulls.filter(s => s.hitTp1);
  const beWins   = bears.filter(s => s.hitTp1);

  const winRate  = wins.length / n * 100;
  const avgRR    = signals.reduce((a, s) => a + s.rr, 0) / n;
  const avgSl    = signals.reduce((a, s) => a + s.slPct, 0) / n;
  const avgTp1   = signals.reduce((a, s) => a + s.tp1Pct, 0) / n;
  const ev       = (winRate / 100) * avgRR - (losses.length / n);

  console.log(`  Signals total : ${n}`);
  if (bulls.length) console.log(`  🟢 Bullish    : ${bulls.length}  →  ${bWins.length} wins (${fmt(bWins.length/bulls.length*100)}%)`);
  if (bears.length) console.log(`  🔴 Bearish    : ${bears.length}  →  ${beWins.length} wins (${fmt(beWins.length/bears.length*100)}%)`);
  console.log(`  ${bar.slice(0,20)}`);
  console.log(`  ✅ TP1 hit    : ${wins.length}  (${fmt(winRate)}%)`);
  console.log(`  ❌ SL hit     : ${losses.length}  (${fmt(losses.length/n*100)}%)`);
  console.log(`  ⏳ Timeout    : ${timeouts.length}  (${fmt(timeouts.length/n*100)}%)`);
  console.log(`  ${bar.slice(0,20)}`);
  console.log(`  Avg R:R       : 1:${fmt(avgRR, 2)}`);
  console.log(`  Avg SL dist   : ${fmt(avgSl, 2)}%`);
  console.log(`  Avg TP1 dist  : ${fmt(avgTp1, 2)}%`);
  console.log(`  Exp. value    : ${ev >= 0 ? '+' : ''}${fmt(ev, 3)}R per trade`);
  console.log();
}

async function main() {
  console.log('=== BACKTEST START ===');
  console.log(`Window: ${WINDOW} candles  |  Lookahead: ${LOOKAHEAD}h  |  Cooldown: ${COOLDOWN} candles\n`);

  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}…`);
    try {
      // 1000 candles = ~41 days of 1h data
      const candles = await getCandles(symbol, '4h', 1000);
      process.stdout.write(` ${candles.length} candles\n`);
      const signals = backtest(candles, symbol);
      printReport(symbol, signals, candles.length);
    } catch (e) {
      console.error(` ERROR: ${(e as Error).message}`);
    }
  }

  console.log('=== BACKTEST DONE ===');
}

main().catch(console.error);
