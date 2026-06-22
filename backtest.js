const axios = require('axios');
const { EMA, ATR, ADX, RSI } = require('technicalindicators');

// ── Config ─────────────────────────────────────────────────────────────────────
const COINS         = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LTCUSDT', 'BNBUSDT', 'ATOMUSDT', 'SOLUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'ADAUSDT'];
const VOL_THRESHOLD = 1.0;
const SL_ATR_MULT   = 1.5;
const MAX_SL_PCT    = 0.08;
const TP1_R         = 2.0;
const TP2_R         = 4.0;
const COOLDOWN      = 6;
const LOOKBACK      = 210;
const ADX_PERIOD    = 14;
const RSI_PERIOD    = 14;
const RSI_LONG_MAX  = 65;   // don't enter LONG if RSI >= this (overbought)
const RSI_SHORT_MIN = 35;   // don't enter SHORT if RSI <= this (oversold)

async function fetchCandles(symbol, interval = '4h', totalLimit = 3000) {
  const maxPerReq = 1000;
  let allCandles = [];
  let endTime = undefined;

  while (allCandles.length < totalLimit) {
    const limit = Math.min(maxPerReq, totalLimit - allCandles.length);
    const params = { symbol, interval, limit };
    if (endTime) params.endTime = endTime;
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params, timeout: 15000,
    });
    if (!res.data || res.data.length === 0) break;
    const batch = res.data.map(k => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    allCandles = [...batch, ...allCandles];
    endTime = res.data[0][0] - 1; // go further back in time
    if (res.data.length < limit) break;
  }
  return allCandles;
}

function calcEMASeries(closes, period) {
  if (closes.length < period) return [];
  return EMA.calculate({ values: closes, period });
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const v = ATR.calculate({
    high: candles.map(c => c.high), low: candles.map(c => c.low),
    close: candles.map(c => c.close), period,
  });
  return v.length > 0 ? v[v.length - 1] : null;
}

function calcADXSeries(candles, period = ADX_PERIOD) {
  if (candles.length < period * 2) return [];
  return ADX.calculate({
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
    period,
  });
}

function calcVolumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const past = candles.slice(-period - 1, -1).map(c => c.volume);
  const avg  = past.reduce((a, b) => a + b, 0) / past.length;
  return avg > 0 ? candles[candles.length - 1].volume / avg : null;
}

function calcRSILast(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  const vals = RSI.calculate({ values: closes, period });
  return vals.length > 0 ? vals[vals.length - 1] : null;
}

function isAdxRisingAt(adxSeries, idx) {
  if (idx < 3 || adxSeries.length <= idx) return false;
  return adxSeries[idx].adx > adxSeries[idx - 3].adx;
}

function analyze(candles, btcDirection) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];

  const ema20s  = calcEMASeries(closes, 20);
  const ema50s  = calcEMASeries(closes, 50);
  const ema200s = calcEMASeries(closes, 200);

  if (ema20s.length < 2 || ema50s.length < 2 || ema200s.length < 1) return null;

  const ema20  = ema20s[ema20s.length - 1];
  const ema20p = ema20s[ema20s.length - 2];
  const ema50  = ema50s[ema50s.length - 1];
  const ema50p = ema50s[ema50s.length - 2];
  const ema200 = ema200s[ema200s.length - 1];

  const volRatio = calcVolumeRatio(candles);
  const volOk    = volRatio === null || volRatio >= VOL_THRESHOLD;

  const adxSeries = calcADXSeries(candles);
  let adxOk = true;
  if (adxSeries.length >= 4) {
    adxOk = adxSeries[adxSeries.length - 1].adx > adxSeries[adxSeries.length - 4].adx;
  }

  const goldenCross = ema20p <= ema50p && ema20 > ema50;
  const deathCross  = ema20p >= ema50p && ema20 < ema50;
  const macroUp     = price > ema200;
  const macroDown   = price < ema200;

  const rsi    = calcRSILast(closes);
  const rsiOkL = rsi === null || rsi < RSI_LONG_MAX;   // not overbought for longs
  const rsiOkS = rsi === null || rsi > RSI_SHORT_MIN;  // not oversold for shorts

  let direction = null;
  if (goldenCross && macroUp   && volOk && adxOk) direction = 'bullish';
  if (deathCross  && macroDown && volOk && adxOk) direction = 'bearish';
  if (!direction) return null;

  if (btcDirection !== null) {
    if (direction === 'bullish' && btcDirection === 'bearish') return null;
    if (direction === 'bearish' && btcDirection === 'bullish') return null;
  }

  const atr    = calcATR(candles) ?? price * 0.02;
  const lows20  = candles.slice(-20).map(c => c.low);
  const highs20 = candles.slice(-20).map(c => c.high);

  if (direction === 'bullish') {
    const sl   = Math.max(Math.min(...lows20), price - atr * SL_ATR_MULT);
    const risk = price - sl;
    if (risk <= 0 || risk / price > MAX_SL_PCT) return null;
    return { direction, entry: price, sl, risk,
             tp1: price + risk * TP1_R, tp2: price + risk * TP2_R };
  } else {
    const sl   = Math.min(Math.max(...highs20), price + atr * SL_ATR_MULT);
    const risk = sl - price;
    if (risk <= 0 || risk / price > MAX_SL_PCT) return null;
    return { direction, entry: price, sl, risk,
             tp1: price - risk * TP1_R, tp2: price - risk * TP2_R };
  }
}

function getBtcDirection(btcCandles, idx) {
  if (!btcCandles || idx < LOOKBACK) return null;
  const closes = btcCandles.slice(0, idx + 1).map(c => c.close);
  const price   = closes[closes.length - 1];
  const ema200s = calcEMASeries(closes, 200);
  if (ema200s.length < 1) return null;
  const ema200 = ema200s[ema200s.length - 1];
  return price > ema200 ? 'bullish' : price < ema200 ? 'bearish' : null;
}

async function backtestCoin(symbol, btcCandles) {
  let candles;
  try { candles = await fetchCandles(symbol); }
  catch (e) { return { symbol, error: e.message, trades: [] }; }

  const closes     = candles.map(c => c.close);
  const ema20Full  = calcEMASeries(closes, 20);
  const adxFull    = calcADXSeries(candles);
  const ema20Off   = closes.length - ema20Full.length;
  const adxOff     = candles.length - adxFull.length;

  const isBtc  = symbol === 'BTCUSDT';
  const trades = [];
  let lastSignalIdx = -COOLDOWN;
  let activeTrade   = null;

  // Walk-Forward split: 60% in-sample, 40% out-of-sample
  const totalTradeable = candles.length - LOOKBACK;
  const splitAt        = LOOKBACK + Math.floor(totalTradeable * 0.6);

  for (let i = LOOKBACK; i < candles.length; i++) {
    const c = candles[i];
    const ema20Now = ema20Full[i - ema20Off] ?? null;
    const adxIdx   = i - adxOff;
    const period   = i < splitAt ? 'in' : 'out';

    if (activeTrade) {
      const { direction, entry, sl, risk, tp1, tp2 } = activeTrade;

      // ── Phase 1: before TP1 ───────────────────────────────────────────────
      if (!activeTrade.tp1Hit) {
        if (direction === 'bullish') {
          if (c.low <= sl) {
            trades.push({ symbol, direction, result: 'sl', r: -1, entry, period });
            activeTrade = null; continue;
          }
          if (c.high >= tp1) {
            activeTrade.tp1Hit = true;
            activeTrade.sl     = entry; // move SL to break-even
          }
        } else {
          if (c.high >= sl) {
            trades.push({ symbol, direction, result: 'sl', r: -1, entry, period });
            activeTrade = null; continue;
          }
          if (c.low <= tp1) {
            activeTrade.tp1Hit = true;
            activeTrade.sl     = entry;
          }
        }
      }

      // ── Phase 2: between TP1 and TP2 (SL at BE) ──────────────────────────
      else {
        if (direction === 'bullish') {
          if (c.high >= tp2) {
            // TP2 hit: first half already exited at +2R, second half at +4R → total +3R
            trades.push({ symbol, direction, result: 'tp2', r: 3.0, entry, period });
            activeTrade = null; continue;
          }
          if (c.low <= activeTrade.sl) {
            // BE stop — first half at +2R, second half at 0 → total +1R
            trades.push({ symbol, direction, result: 'be', r: 1.0, entry, period });
            activeTrade = null; continue;
          }
        } else {
          if (c.low <= tp2) {
            trades.push({ symbol, direction, result: 'tp2', r: 3.0, entry, period });
            activeTrade = null; continue;
          }
          if (c.high >= activeTrade.sl) {
            trades.push({ symbol, direction, result: 'be', r: 1.0, entry, period });
            activeTrade = null; continue;
          }
        }
      }
      continue;
    }

    if (i - lastSignalIdx < COOLDOWN) continue;

    const btcDir = isBtc ? null : getBtcDirection(btcCandles, i);
    const sig    = analyze(candles.slice(0, i + 1), btcDir);
    if (!sig) continue;

    lastSignalIdx = i;
    activeTrade   = { ...sig, tp1Hit: false };
  }

  return { symbol, trades };
}

async function main() {
  console.log('MarketLens Backtest — Walk-Forward Validation (3000 Kerzen / ~500 Tage)');
  console.log('Filters:  EMA200 macro | BTC master | Volume 1.0x | ADX rising');
  console.log('Exits:    TP1=2R (half out, SL→BE) → TP2=4R (full close) = +3R total\n');

  let btcCandles = null;
  try {
    process.stdout.write('Fetching BTC candles for master filter... ');
    btcCandles = await fetchCandles('BTCUSDT');
    console.log('OK\n');
  } catch (e) {
    console.log(`FEHLER: ${e.message}\n`);
  }

  const allTrades = [], coinResults = [];

  for (const coin of COINS) {
    process.stdout.write(`${coin.padEnd(12)} `);
    const res = await backtestCoin(coin, btcCandles);
    if (res.error) { console.log(`FEHLER: ${res.error}`); continue; }
    const t      = res.trades;
    const longs  = t.filter(x => x.direction === 'bullish').length;
    const shorts = t.filter(x => x.direction === 'bearish').length;
    const tp2s   = t.filter(x => x.result === 'tp2').length;
    const trails = t.filter(x => x.result === 'trail').length;
    const bes    = t.filter(x => x.result === 'be').length;
    const losses = t.filter(x => x.result === 'sl').length;
    const totalR = t.reduce((s, x) => s + x.r, 0);
    const wins   = tp2s;
    const wr     = t.length > 0 ? Math.round(wins / t.length * 100) : 0;
    const maxR   = t.length > 0 ? Math.max(...t.map(x => x.r)).toFixed(1) : '–';
    console.log(
      `${String(t.length).padStart(3)}T (L:${longs}/S:${shorts}) | ` +
      `${tp2s}TP2 ${trails}Trail ${bes}BE ${losses}SL | ` +
      `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R | WR:${wr}% | max:${maxR}R`
    );
    coinResults.push({ symbol: coin, trades: t.length, wins, tp2s, trails, bes, losses, totalR, wr });
    allTrades.push(...t);
  }

  const sep = '═'.repeat(70);

  function periodStats(trades, label) {
    const t   = trades.length;
    const tp2 = trades.filter(x => x.result === 'tp2').length;
    const be  = trades.filter(x => x.result === 'be').length;
    const sl  = trades.filter(x => x.result === 'sl').length;
    const r   = trades.reduce((s, x) => s + x.r, 0);
    const wr  = t > 0 ? (tp2 / t * 100).toFixed(1) : '0.0';
    const avg = t > 0 ? (r / t).toFixed(2) : '0.00';
    console.log(`  ${label}`);
    console.log(sep);
    console.log(`  Trades: ${t}  |  TP2: ${tp2}  BE: ${be}  SL: ${sl}`);
    console.log(`  WR: ${wr}%  |  Gesamt: ${r >= 0 ? '+' : ''}${r.toFixed(1)}R  |  Ø/Trade: ${avg}R`);
  }

  const inTrades  = allTrades.filter(x => x.period === 'in');
  const outTrades = allTrades.filter(x => x.period === 'out');
  const tR        = allTrades.reduce((s, x) => s + x.r, 0);

  console.log('\n' + sep);
  console.log('  WALK-FORWARD VALIDATION');
  console.log(sep);
  periodStats(inTrades,  '📊 IN-SAMPLE   (erste 60% / ~300 Tage)');
  console.log('');
  periodStats(outTrades, '🔍 OUT-OF-SAMPLE (letzte 40% / ~200 Tage) ← entscheidend');
  console.log('');
  console.log(sep);
  const verdict = outTrades.length > 0 && outTrades.reduce((s,x) => s+x.r, 0) > 0
    ? '✅ VALIDIERT — Strategie funktioniert auf ungesehenen Daten'
    : '❌ NICHT VALIDIERT — Out-of-Sample negativ → overfitted';
  console.log('  ' + verdict);
  console.log(`  Gesamt: ${tR >= 0 ? '+' : ''}${tR.toFixed(1)}R über alle ${allTrades.length} Trades`);

  const sorted = [...coinResults].sort((a, b) => b.totalR - a.totalR);
  console.log('\n  COIN RANKING (alle Trades)');
  console.log(sep);
  for (const c of sorted) {
    const rStr = (c.totalR >= 0 ? '+' : '') + c.totalR.toFixed(1) + 'R';
    const bar  = c.totalR > 0
      ? '█'.repeat(Math.min(Math.round(c.totalR), 25))
      : '▓'.repeat(Math.min(Math.round(-c.totalR), 10));
    console.log(
      `${c.symbol.replace('USDT','').padEnd(6)} ` +
      `${rStr.padStart(7)}  WR:${String(c.wr + '%').padStart(4)}  ` +
      `${c.trades}T (${c.tp2s}TP2/${c.trails}Trail/${c.bes}BE/${c.losses}SL)  ${bar}`
    );
  }
  console.log(sep);
}

main().catch(console.error);
