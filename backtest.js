const axios = require('axios');
const { RSI, MACD, BollingerBands, ATR, EMA } = require('technicalindicators');

const COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT','MATICUSDT',
];

async function fetchCandles(symbol) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval: '4h', limit: 1000 },
    timeout: 15000,
  });
  return res.data.map(k => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function calcRSI(closes, period=14) {
  if (closes.length < period+1) return null;
  const v = RSI.calculate({ values: closes, period });
  return v.length > 0 ? v[v.length-1] : null;
}
function calcRSISeries(closes, period=14) {
  if (closes.length < period+1) return [];
  return RSI.calculate({ values: closes, period });
}
function calcMACDSignal(closes) {
  if (closes.length < 35) return null;
  const v = MACD.calculate({ values: closes, fastPeriod:12, slowPeriod:26, signalPeriod:9, SimpleMAOscillator:false, SimpleMASignal:false });
  if (v.length < 2) return null;
  const prev = v[v.length-2], curr = v[v.length-1];
  if (!prev.MACD||!prev.signal||!curr.MACD||!curr.signal) return null;
  const pd = prev.MACD-prev.signal, cd = curr.MACD-curr.signal;
  if (pd<0&&cd>=0) return 'bullish_cross';
  if (pd>0&&cd<=0) return 'bearish_cross';
  return null;
}
function calcBBSignal(closes, period=20) {
  if (closes.length < period) return null;
  const v = BollingerBands.calculate({ values: closes, period, stdDev:2 });
  if (!v.length) return null;
  const last=v[v.length-1], price=closes[closes.length-1];
  if (price<=last.lower) return 'oversold';
  if (price>=last.upper) return 'overbought';
  return null;
}
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const v = EMA.calculate({ values: closes, period });
  return v.length > 0 ? v[v.length-1] : null;
}
function calcVolumeRatio(candles, period=20) {
  if (candles.length < period+1) return null;
  const past = candles.slice(-period-1,-1).map(c=>c.volume);
  const avg = past.reduce((a,b)=>a+b,0)/past.length;
  return avg > 0 ? candles[candles.length-1].volume/avg : null;
}
function calcStochRSI(closes) {
  const rsi = calcRSISeries(closes,14);
  if (rsi.length < 20) return null;
  const stoch = [];
  for (let i=13; i<rsi.length; i++) {
    const w=rsi.slice(i-13,i+1), mn=Math.min(...w), mx=Math.max(...w);
    stoch.push(mx===mn?50:(rsi[i]-mn)/(mx-mn)*100);
  }
  if (stoch.length<6) return null;
  const k=[];
  for (let i=2;i<stoch.length;i++) k.push((stoch[i]+stoch[i-1]+stoch[i-2])/3);
  if (k.length<3) return null;
  const d=[];
  for (let i=2;i<k.length;i++) d.push((k[i]+k[i-1]+k[i-2])/3);
  if (!k.length||!d.length) return null;
  return { k:k[k.length-1], d:d[d.length-1], kPrev:k.length>1?k[k.length-2]:null, dPrev:d.length>1?d[d.length-2]:null };
}
function calcATR(candles, period=14) {
  if (candles.length<period+1) return null;
  const v=ATR.calculate({ high:candles.map(c=>c.high), low:candles.map(c=>c.low), close:candles.map(c=>c.close), period });
  return v.length>0?v[v.length-1]:null;
}

function analyze(candles) {
  const closes = candles.map(c=>c.close);
  const price = closes[closes.length-1];
  const rsi = calcRSI(closes);
  const macd = calcMACDSignal(closes);
  const bb = calcBBSignal(closes);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const volRatio = calcVolumeRatio(candles);
  const stoch = calcStochRSI(closes);

  // Both EMA50 AND EMA200 must confirm (key quality gate)
  const trendBull = (ema50===null||price>ema50) && (ema200===null||price>ema200);
  const trendBear = (ema50===null||price<ema50) && (ema200===null||price<ema200);
  const volOk = volRatio===null||volRatio>=1.0;

  const stochBullCross = stoch&&stoch.kPrev!==null&&stoch.dPrev!==null&&stoch.kPrev<=stoch.dPrev&&stoch.k>stoch.d;
  const stochBearCross = stoch&&stoch.kPrev!==null&&stoch.dPrev!==null&&stoch.kPrev>=stoch.dPrev&&stoch.k<stoch.d;

  const bullScore =
    (rsi!==null&&rsi<30?1:0) +
    (macd==='bullish_cross'?1:0) +
    (bb==='oversold'?1:0) +
    ((stochBullCross||(stoch&&stoch.k<20))?1:0);

  const bearScore =
    (rsi!==null&&rsi>70?1:0) +
    (macd==='bearish_cross'?1:0) +
    (bb==='overbought'?1:0) +
    ((stochBearCross||(stoch&&stoch.k>80))?1:0);

  // Score threshold: 3 (raised from 2)
  const isBull = bullScore>=3 && trendBull && volOk;
  const isBear = bearScore>=3 && trendBear && volOk;

  let direction = null;
  if (isBull && bullScore>=bearScore) direction='bullish';
  else if (isBear) direction='bearish';
  if (direction==='bullish'&&!isBull) direction=null;
  if (direction==='bearish'&&!isBear) direction=null;
  if (!direction) return null;

  const atr = calcATR(candles)??price*0.02;
  const lows20  = candles.slice(-20).map(c=>c.low);
  const highs20 = candles.slice(-20).map(c=>c.high);

  if (direction==='bullish') {
    const sl=Math.max(Math.min(...lows20), price-atr*2);
    const risk=price-sl;
    if (risk<=0) return null;
    return { direction, entry:price, sl, tp1:price+risk*1.5, tp2:price+risk*3 };
  } else {
    const sl=Math.min(Math.max(...highs20), price+atr*2);
    const risk=sl-price;
    if (risk<=0) return null;
    return { direction, entry:price, sl, tp1:price-risk*1.5, tp2:price-risk*3 };
  }
}

async function backtestCoin(symbol) {
  let candles;
  try { candles = await fetchCandles(symbol); }
  catch(e) { return { symbol, error:e.message, trades:[] }; }

  const LOOKBACK=200, COOLDOWN=12;
  const trades=[];
  let lastSignalIdx=-COOLDOWN;
  let activeTrade=null;

  for (let i=LOOKBACK; i<candles.length; i++) {
    const c=candles[i];
    if (activeTrade) {
      const { direction, entry, sl, tp1, tp2, tp1Hit } = activeTrade;
      const curSL = tp1Hit ? entry : sl;
      if (direction==='bullish') {
        if (!tp1Hit&&c.high>=tp2) { trades.push({symbol,direction,result:'tp2',r:3.0,entry}); activeTrade=null; continue; }
        if (!tp1Hit&&c.high>=tp1) { activeTrade.tp1Hit=true; continue; }
        if (c.low<=curSL) { trades.push({symbol,direction,result:tp1Hit?'be':'sl',r:tp1Hit?0:-1,entry}); activeTrade=null; continue; }
      } else {
        if (!tp1Hit&&c.low<=tp2) { trades.push({symbol,direction,result:'tp2',r:3.0,entry}); activeTrade=null; continue; }
        if (!tp1Hit&&c.low<=tp1) { activeTrade.tp1Hit=true; continue; }
        if (c.high>=curSL) { trades.push({symbol,direction,result:tp1Hit?'be':'sl',r:tp1Hit?0:-1,entry}); activeTrade=null; continue; }
      }
      continue;
    }
    if (i-lastSignalIdx<COOLDOWN) continue;
    const sig=analyze(candles.slice(0,i+1));
    if (!sig) continue;
    lastSignalIdx=i;
    activeTrade={...sig,tp1Hit:false};
  }
  return { symbol, trades };
}

async function main() {
  console.log('MarketLens Backtest v2 — EMA200 + Score>=3 + Shorts aktiv');
  console.log('1000x 4h Candles pro Coin (~166 Tage)\n');

  const allTrades=[], coinResults=[];

  for (const coin of COINS) {
    process.stdout.write(`${coin}... `);
    const res=await backtestCoin(coin);
    if (res.error) { console.log(`FEHLER: ${res.error}`); continue; }
    const closed=res.trades;
    const longs=closed.filter(t=>t.direction==='bullish').length;
    const shorts=closed.filter(t=>t.direction==='bearish').length;
    const wins=closed.filter(t=>t.result==='tp1'||t.result==='tp2').length;
    const losses=closed.filter(t=>t.result==='sl').length;
    const bes=closed.filter(t=>t.result==='be').length;
    const totalR=closed.reduce((s,t)=>s+t.r,0);
    const wr=closed.length>0?Math.round(wins/closed.length*100):0;
    console.log(`${closed.length} Trades (L:${longs}/S:${shorts}) | ${wins}W ${losses}L ${bes}BE | ${totalR>=0?'+':''}${totalR.toFixed(1)}R | WR:${wr}%`);
    coinResults.push({symbol:coin,trades:closed.length,wins,losses,bes,totalR,wr,longs,shorts});
    allTrades.push(...closed);
  }

  const sep='═'.repeat(62);
  console.log('\n'+sep);
  console.log('GESAMT-ERGEBNIS');
  console.log(sep);

  const totalTrades=allTrades.length;
  const totalWins=allTrades.filter(t=>t.result==='tp1'||t.result==='tp2').length;
  const tp2Wins=allTrades.filter(t=>t.result==='tp2').length;
  const totalLosses=allTrades.filter(t=>t.result==='sl').length;
  const totalBEs=allTrades.filter(t=>t.result==='be').length;
  const totalLongs=allTrades.filter(t=>t.direction==='bullish').length;
  const totalShorts=allTrades.filter(t=>t.direction==='bearish').length;
  const totalR=allTrades.reduce((s,t)=>s+t.r,0);
  const winRate=totalTrades>0?(totalWins/totalTrades*100).toFixed(1):0;
  const avgR=totalTrades>0?(totalR/totalTrades).toFixed(2):0;

  console.log(`Trades gesamt:  ${totalTrades} (Long:${totalLongs} / Short:${totalShorts})`);
  console.log(`Gewonnen:       ${totalWins} (davon TP2: ${tp2Wins})`);
  console.log(`Break-Even:     ${totalBEs}`);
  console.log(`Verloren:       ${totalLosses}`);
  console.log(`Trefferquote:   ${winRate}%`);
  console.log(`Gesamt R:       ${totalR>=0?'+':''}${totalR.toFixed(1)}R`);
  console.log(`Ø pro Trade:    ${avgR}R`);

  const sorted=[...coinResults].sort((a,b)=>b.totalR-a.totalR);
  if (sorted.length>0) {
    console.log(`\nBester Coin:    ${sorted[0].symbol} (${sorted[0].totalR>=0?'+':''}${sorted[0].totalR.toFixed(1)}R, WR:${sorted[0].wr}%)`);
    console.log(`Schlechtester:  ${sorted[sorted.length-1].symbol} (${sorted[sorted.length-1].totalR.toFixed(1)}R, WR:${sorted[sorted.length-1].wr}%)`);
  }

  console.log('\n'+'-'.repeat(62));
  console.log('COIN-RANKING:');
  console.log('-'.repeat(62));
  for (const c of sorted) {
    const rStr=(c.totalR>=0?'+':'')+c.totalR.toFixed(1)+'R';
    const bar=c.totalR>0?'█'.repeat(Math.min(Math.round(c.totalR),15)):'▓'.repeat(Math.min(Math.round(-c.totalR),15));
    console.log(`${c.symbol.padEnd(12)} ${rStr.padStart(7)}  WR:${String(c.wr+'%').padStart(4)}  ${c.trades}T  ${bar}`);
  }
  console.log(sep);
}

main().catch(console.error);
