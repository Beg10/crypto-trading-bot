const axios = require('axios');
const { EMA, ATR } = require('technicalindicators');

const COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT','MATICUSDT',
];

async function fetchCandles(symbol, interval='4h', limit=1000) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval, limit }, timeout: 15000,
  });
  return res.data.map(k => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function calcEMASeries(closes, period) {
  if (closes.length < period) return [];
  return EMA.calculate({ values: closes, period });
}

function calcATR(candles, period=14) {
  if (candles.length < period+1) return null;
  const v = ATR.calculate({ high: candles.map(c=>c.high), low: candles.map(c=>c.low), close: candles.map(c=>c.close), period });
  return v.length > 0 ? v[v.length-1] : null;
}

function calcVolumeRatio(candles, period=20) {
  if (candles.length < period+1) return null;
  const past = candles.slice(-period-1,-1).map(c=>c.volume);
  const avg = past.reduce((a,b)=>a+b,0)/past.length;
  return avg > 0 ? candles[candles.length-1].volume/avg : null;
}

function analyze(candles) {
  const closes = candles.map(c=>c.close);
  const price = closes[closes.length-1];

  const ema20s = calcEMASeries(closes, 20);
  const ema50s = calcEMASeries(closes, 50);
  const ema200s = calcEMASeries(closes, 200);

  if (ema20s.length < 2 || ema50s.length < 2 || ema200s.length < 1) return null;

  const ema20  = ema20s[ema20s.length-1];
  const ema20p = ema20s[ema20s.length-2];
  const ema50  = ema50s[ema50s.length-1];
  const ema50p = ema50s[ema50s.length-2];
  const ema200 = ema200s[ema200s.length-1];

  const volRatio = calcVolumeRatio(candles);
  const volOk = volRatio === null || volRatio >= 1.0;

  const goldenCross = ema20p <= ema50p && ema20 > ema50; // EMA20 kreuzt über EMA50
  const deathCross  = ema20p >= ema50p && ema20 < ema50; // EMA20 kreuzt unter EMA50

  let direction = null;
  if (goldenCross && price > ema200 && volOk) direction = 'bullish';
  if (deathCross  && price < ema200 && volOk) direction = 'bearish';
  if (!direction) return null;

  const atr = calcATR(candles) ?? price * 0.02;
  const lows20  = candles.slice(-20).map(c=>c.low);
  const highs20 = candles.slice(-20).map(c=>c.high);

  if (direction === 'bullish') {
    const sl = Math.max(Math.min(...lows20), price - atr * 1.5);
    const risk = price - sl;
    if (risk <= 0 || risk / price > 0.08) return null; // skip if SL > 8% away
    return { direction, entry: price, sl, tp1: price + risk * 2.0, tp2: price + risk * 4.0 };
  } else {
    const sl = Math.min(Math.max(...highs20), price + atr * 1.5);
    const risk = sl - price;
    if (risk <= 0 || risk / price > 0.08) return null;
    return { direction, entry: price, sl, tp1: price - risk * 2.0, tp2: price - risk * 4.0 };
  }
}

async function backtestCoin(symbol) {
  let candles;
  try { candles = await fetchCandles(symbol); }
  catch(e) { return { symbol, error: e.message, trades: [] }; }

  const LOOKBACK = 210, COOLDOWN = 6; // 6 candles = 24h cooldown
  const trades = [];
  let lastSignalIdx = -COOLDOWN;
  let activeTrade = null;

  for (let i = LOOKBACK; i < candles.length; i++) {
    const c = candles[i];

    if (activeTrade) {
      const { direction, sl, tp1, tp2, entry } = activeTrade;
      if (direction === 'bullish') {
        if (c.high >= tp2) { trades.push({ symbol, direction, result: 'tp2', r: 4.0, entry }); activeTrade = null; continue; }
        if (c.high >= tp1) { trades.push({ symbol, direction, result: 'tp1', r: 2.0, entry }); activeTrade = null; continue; }
        if (c.low  <= sl)  { trades.push({ symbol, direction, result: 'sl',  r: -1,  entry }); activeTrade = null; continue; }
      } else {
        if (c.low  <= tp2) { trades.push({ symbol, direction, result: 'tp2', r: 4.0, entry }); activeTrade = null; continue; }
        if (c.low  <= tp1) { trades.push({ symbol, direction, result: 'tp1', r: 2.0, entry }); activeTrade = null; continue; }
        if (c.high >= sl)  { trades.push({ symbol, direction, result: 'sl',  r: -1,  entry }); activeTrade = null; continue; }
      }
      continue;
    }

    if (i - lastSignalIdx < COOLDOWN) continue;
    const sig = analyze(candles.slice(0, i+1));
    if (!sig) continue;
    lastSignalIdx = i;
    activeTrade = { ...sig };
  }

  return { symbol, trades };
}

async function main() {
  console.log('MarketLens Backtest v4 — EMA Cross Strategy (20/50/200)');
  console.log('Trend-following | TP1=2R, TP2=4R | SL=ATR×1.5 | 4h\n');

  const allTrades = [], coinResults = [];

  for (const coin of COINS) {
    process.stdout.write(`${coin}... `);
    const res = await backtestCoin(coin);
    if (res.error) { console.log(`FEHLER: ${res.error}`); continue; }
    const t = res.trades;
    const longs  = t.filter(x=>x.direction==='bullish').length;
    const shorts  = t.filter(x=>x.direction==='bearish').length;
    const wins    = t.filter(x=>x.result==='tp1'||x.result==='tp2').length;
    const tp2w    = t.filter(x=>x.result==='tp2').length;
    const losses  = t.filter(x=>x.result==='sl').length;
    const totalR  = t.reduce((s,x)=>s+x.r,0);
    const wr      = t.length>0 ? Math.round(wins/t.length*100) : 0;
    console.log(`${t.length}T (L:${longs}/S:${shorts}) | ${wins}W(TP2:${tp2w}) ${losses}L | ${totalR>=0?'+':''}${totalR.toFixed(1)}R | WR:${wr}%`);
    coinResults.push({ symbol: coin, trades: t.length, wins, losses, totalR, wr });
    allTrades.push(...t);
  }

  const sep = '═'.repeat(62);
  console.log('\n'+sep+'  GESAMT\n'+sep);
  const tT  = allTrades.length;
  const tW  = allTrades.filter(x=>x.result==='tp1'||x.result==='tp2').length;
  const tTP1= allTrades.filter(x=>x.result==='tp1').length;
  const tTP2= allTrades.filter(x=>x.result==='tp2').length;
  const tL  = allTrades.filter(x=>x.result==='sl').length;
  const tR  = allTrades.reduce((s,x)=>s+x.r,0);
  const wr  = tT>0?(tW/tT*100).toFixed(1):0;
  const avg = tT>0?(tR/tT).toFixed(2):0;

  console.log(`Trades:        ${tT} (Long:${allTrades.filter(x=>x.direction==='bullish').length} / Short:${allTrades.filter(x=>x.direction==='bearish').length})`);
  console.log(`Gewonnen:      ${tW} (TP1:${tTP1} / TP2:${tTP2})`);
  console.log(`Verloren:      ${tL}`);
  console.log(`Trefferquote:  ${wr}%`);
  console.log(`Gesamt R:      ${tR>=0?'+':''}${tR.toFixed(1)}R`);
  console.log(`Ø pro Trade:   ${avg}R`);

  const sorted = [...coinResults].sort((a,b)=>b.totalR-a.totalR);
  console.log('\n--- RANKING ---');
  for (const c of sorted) {
    const rStr = (c.totalR>=0?'+':'')+c.totalR.toFixed(1)+'R';
    const bar = c.totalR>0?'█'.repeat(Math.min(Math.round(c.totalR),20)):'▓'.repeat(Math.min(Math.round(-c.totalR),10));
    console.log(`${c.symbol.padEnd(12)} ${rStr.padStart(7)}  WR:${String(c.wr+'%').padStart(4)}  ${c.trades}T  ${bar}`);
  }
  console.log(sep);
}

main().catch(console.error);
