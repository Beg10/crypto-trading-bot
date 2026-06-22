const axios = require('axios');
const { EMA, ATR } = require('technicalindicators');

// ── Config — must match src/services/analysis.ts exactly ──────────────────────
const COINS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LTCUSDT', 'BNBUSDT', 'ATOMUSDT', 'SOLUSDT'];
const VOL_THRESHOLD   = 1.2;   // volume >= 1.2x average
const SPREAD_MIN      = 0.003; // EMA20-EMA50 spread >= 0.3% of price
const SL_ATR_MULT     = 1.5;
const MAX_SL_PCT      = 0.08;
const TP1_R           = 2.0;
const TP2_R           = 4.0;
const COOLDOWN        = 6;     // candles (6 × 4h = 24h)
const LOOKBACK        = 210;   // candles needed for EMA200

async function fetchCandles(symbol, interval = '4h', limit = 1000) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval, limit }, timeout: 15000,
  });
  return res.data.map(k => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
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

function calcVolumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const past = candles.slice(-period - 1, -1).map(c => c.volume);
  const avg = past.reduce((a, b) => a + b, 0) / past.length;
  return avg > 0 ? candles[candles.length - 1].volume / avg : null;
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

  // Volume filter
  const volRatio = calcVolumeRatio(candles);
  const volOk    = volRatio === null || volRatio >= VOL_THRESHOLD;

  // EMA spread filter — prevents micro-crosses in choppy markets
  const spread   = Math.abs(ema20 - ema50) / price;
  const spreadOk = spread >= SPREAD_MIN;

  // Cross detection
  const goldenCross = ema20p <= ema50p && ema20 > ema50;
  const deathCross  = ema20p >= ema50p && ema20 < ema50;

  // Macro filter
  const macroUp   = price > ema200;
  const macroDown = price < ema200;

  let direction = null;
  if (goldenCross && macroUp   && volOk && spreadOk) direction = 'bullish';
  if (deathCross  && macroDown && volOk && spreadOk) direction = 'bearish';
  if (!direction) return null;

  // BTC Master Filter (skip for BTC itself)
  if (btcDirection !== null) {
    if (direction === 'bullish' && btcDirection === 'bearish') return null;
    if (direction === 'bearish' && btcDirection === 'bullish') return null;
  }

  // Trade levels
  const atr    = calcATR(candles) ?? price * 0.02;
  const lows20  = candles.slice(-20).map(c => c.low);
  const highs20 = candles.slice(-20).map(c => c.high);

  if (direction === 'bullish') {
    const sl   = Math.max(Math.min(...lows20), price - atr * SL_ATR_MULT);
    const risk = price - sl;
    if (risk <= 0 || risk / price > MAX_SL_PCT) return null;
    return { direction, entry: price, sl, tp1: price + risk * TP1_R, tp2: price + risk * TP2_R };
  } else {
    const sl   = Math.min(Math.max(...highs20), price + atr * SL_ATR_MULT);
    const risk = sl - price;
    if (risk <= 0 || risk / price > MAX_SL_PCT) return null;
    return { direction, entry: price, sl, tp1: price - risk * TP1_R, tp2: price - risk * TP2_R };
  }
}

// Get BTC direction at a given candle index (uses full BTC candle array)
function getBtcDirection(btcCandles, idx) {
  if (!btcCandles || idx < LOOKBACK) return null;
  const slice  = btcCandles.slice(0, idx + 1);
  const closes = slice.map(c => c.close);
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
  const goldenCross = ema20p <= ema50p && ema20 > ema50;
  const deathCross  = ema20p >= ema50p && ema20 < ema50;
  if (goldenCross && price > ema200) return 'bullish';
  if (deathCross  && price < ema200) return 'bearish';
  // Between crosses: use current EMA alignment as proxy
  if (ema20 > ema50 && price > ema200) return 'bullish';
  if (ema20 < ema50 && price < ema200) return 'bearish';
  return null; // neutral
}

async function backtestCoin(symbol, btcCandles) {
  let candles;
  try { candles = await fetchCandles(symbol); }
  catch (e) { return { symbol, error: e.message, trades: [] }; }

  const isBtc  = symbol === 'BTCUSDT';
  const trades = [];
  let lastSignalIdx = -COOLDOWN;
  let activeTrade   = null;
  let tp1Hit        = false;

  for (let i = LOOKBACK; i < candles.length; i++) {
    const c = candles[i];

    if (activeTrade) {
      const { direction, sl, tp1, tp2, entry, beHit } = activeTrade;

      if (direction === 'bullish') {
        if (c.high >= tp2) {
          trades.push({ symbol, direction, result: 'tp2', r: 4.0, entry });
          activeTrade = null; continue;
        }
        if (!activeTrade.tp1Hit && c.high >= tp1) {
          activeTrade.tp1Hit = true;
          activeTrade.sl     = entry; // move SL to break-even
          continue;
        }
        if (c.low <= activeTrade.sl) {
          // BE: TP1 was hit, SL now at entry → +0.75R (avg of +1.5R half + 0R half)
          const r = activeTrade.tp1Hit ? 0.75 : -1;
          trades.push({ symbol, direction, result: activeTrade.tp1Hit ? 'be' : 'sl', r, entry });
          activeTrade = null; continue;
        }
      } else {
        if (c.low <= tp2) {
          trades.push({ symbol, direction, result: 'tp2', r: 4.0, entry });
          activeTrade = null; continue;
        }
        if (!activeTrade.tp1Hit && c.low <= tp1) {
          activeTrade.tp1Hit = true;
          activeTrade.sl     = entry;
          continue;
        }
        if (c.high >= activeTrade.sl) {
          const r = activeTrade.tp1Hit ? 0.75 : -1;
          trades.push({ symbol, direction, result: activeTrade.tp1Hit ? 'be' : 'sl', r, entry });
          activeTrade = null; continue;
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
  console.log('MarketLens Backtest v5 — EMA Cross + All Filters');
  console.log('Filters: EMA200 macro | BTC master | Spread 0.3% | Volume 1.2x');
  console.log('Exits:   TP1=2R, TP2=4R | SL=ATR×1.5 | BE=+0.75R | 4h\n');

  // Fetch BTC candles once for master filter
  let btcCandles = null;
  try {
    process.stdout.write('Fetching BTC candles for master filter... ');
    btcCandles = await fetchCandles('BTCUSDT');
    console.log('OK\n');
  } catch (e) {
    console.log(`FEHLER: ${e.message} — running without BTC filter\n`);
  }

  const allTrades = [], coinResults = [];

  for (const coin of COINS) {
    process.stdout.write(`${coin.padEnd(12)} `);
    const res = await backtestCoin(coin, btcCandles);
    if (res.error) { console.log(`FEHLER: ${res.error}`); continue; }
    const t      = res.trades;
    const longs  = t.filter(x => x.direction === 'bullish').length;
    const shorts = t.filter(x => x.direction === 'bearish').length;
    const wins   = t.filter(x => x.result === 'tp1' || x.result === 'tp2').length;
    const tp1w   = t.filter(x => x.result === 'tp1').length;
    const tp2w   = t.filter(x => x.result === 'tp2').length;
    const be     = t.filter(x => x.result === 'be').length;
    const losses = t.filter(x => x.result === 'sl').length;
    const totalR = t.reduce((s, x) => s + x.r, 0);
    const wr     = t.length > 0 ? Math.round(wins / t.length * 100) : 0;
    console.log(
      `${String(t.length).padStart(3)}T (L:${longs}/S:${shorts}) | ` +
      `${wins}W(TP1:${tp1w} TP2:${tp2w}) ${be}BE ${losses}L | ` +
      `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R | WR:${wr}%`
    );
    coinResults.push({ symbol: coin, trades: t.length, wins, losses, be, totalR, wr });
    allTrades.push(...t);
  }

  const sep  = '═'.repeat(65);
  const tT   = allTrades.length;
  const tW   = allTrades.filter(x => x.result === 'tp1' || x.result === 'tp2').length;
  const tTP1 = allTrades.filter(x => x.result === 'tp1').length;
  const tTP2 = allTrades.filter(x => x.result === 'tp2').length;
  const tBE  = allTrades.filter(x => x.result === 'be').length;
  const tL   = allTrades.filter(x => x.result === 'sl').length;
  const tR   = allTrades.reduce((s, x) => s + x.r, 0);
  const wr   = tT > 0 ? (tW / tT * 100).toFixed(1) : 0;
  const avg  = tT > 0 ? (tR / tT).toFixed(2) : 0;

  console.log('\n' + sep);
  console.log('  GESAMT');
  console.log(sep);
  console.log(`Trades:        ${tT} (Long:${allTrades.filter(x => x.direction === 'bullish').length} / Short:${allTrades.filter(x => x.direction === 'bearish').length})`);
  console.log(`Gewonnen:      ${tW} (TP1:${tTP1} / TP2:${tTP2})`);
  console.log(`Break-Even:    ${tBE} (TP1 war drin, +0.75R each)`);
  console.log(`Verloren:      ${tL}`);
  console.log(`Trefferquote:  ${wr}%  (nur TP1/TP2 = Win)`);
  console.log(`Gesamt R:      ${tR >= 0 ? '+' : ''}${tR.toFixed(1)}R`);
  console.log(`Ø pro Trade:   ${avg}R`);

  const sorted = [...coinResults].sort((a, b) => b.totalR - a.totalR);
  console.log('\n  RANKING');
  console.log(sep);
  for (const c of sorted) {
    const rStr = (c.totalR >= 0 ? '+' : '') + c.totalR.toFixed(1) + 'R';
    const bar  = c.totalR > 0
      ? '█'.repeat(Math.min(Math.round(c.totalR), 20))
      : '▓'.repeat(Math.min(Math.round(-c.totalR), 10));
    console.log(
      `${c.symbol.replace('USDT','').padEnd(6)} ` +
      `${rStr.padStart(7)}  WR:${String(c.wr + '%').padStart(4)}  ` +
      `${c.trades}T (${c.wins}W/${c.be}BE/${c.losses}L)  ${bar}`
    );
  }
  console.log(sep);
}

main().catch(console.error);
