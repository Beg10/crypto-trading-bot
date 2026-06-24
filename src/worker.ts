/**
 * Background worker — runs independently of the Telegram bot process.
 * Every WORKER_INTERVAL_MINUTES it:
 *   1. Fetches candles for all watched + channel symbols
 *   2. Runs EMA Cross + RSI Bounce analysis → sends signal to users + channel
 *   3. Checks active trades → sends exit when SL or TP is hit
 *   4. Auto break-even: moves SL to entry after TP1 hit
 *   5. Logs every signal + outcome to Supabase signal_log
 *   6. Sends personalized $ P&L to users who used /in
 */

import 'dotenv/config';
import { Bot } from 'grammy';
import {
  getAllWatchedSymbols,
  getUsersForAlert,
  getAllUsers,
  upsertNewsItems,
  logSignal,
  closeSignal,
  markTp1Hit,
  markTp2Hit,
  markTp3Hit,
  getActiveSignals,
  getUsersInPosition,
  closeUserPositions,
} from './db';
import { getCandles } from './services/binance';
import { analyzeCandles, analyzeRsiBounce, isNotifiableSignal } from './services/analysis';
import { fetchCryptoPanicNews } from './services/cryptopanic';
import { fetchAndAnalyzeMacroNews } from './services/news';
import { AnalysisResult } from './types';
import { sendDailyRecap } from './commands/recap';
import { sendWeeklyReport } from './commands/weeklyReport';
import { getWeeklySignals } from './db';
import { buildMorningBriefing } from './commands/morningBriefing';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = new Bot(process.env.BOT_TOKEN);
const INTERVAL_MS = (parseInt(process.env.WORKER_INTERVAL_MINUTES ?? '5', 10)) * 60 * 1000;

// ─── Channel config ───────────────────────────────────────────────────────────
const CHANNEL_ID: string | null = process.env.CHANNEL_ID ?? null;

// EMA Cross: alle 24 validierten Coins
const CHANNEL_SYMBOLS = [
  // Tier-1: Original validierte 12 Coins (4h Walk-Forward +59R/111T)
  'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'LINKUSDT',
  'INJUSDT', 'ALGOUSDT', 'LTCUSDT', 'ADAUSDT', 'VETUSDT', 'AAVEUSDT', 'UNIUSDT',
  // Tier-2: Neu validierte 7 Coins (4h Walk-Forward OOS +16R/18T)
  'OPUSDT', 'FTMUSDT', 'GALAUSDT', 'MANAUSDT', 'ATOMUSDT', 'LDOUSDT', 'SNXUSDT',
  // Tier-3: Batch 3 validierte 5 Coins (4h Walk-Forward OOS +4R)
  'JUPUSDT', 'PYTHUSDT', 'WLDUSDT', 'NOTUSDT', 'WIFUSDT',
];

// RSI Bounce: nur OOS-positive Coins (15 Coins, OOS +16R validiert)
const RSI_BOUNCE_SYMBOLS = [
  'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'LINKUSDT', 'INJUSDT',
  'LTCUSDT', 'VETUSDT', 'AAVEUSDT', 'FTMUSDT', 'GALAUSDT',
  'MANAUSDT', 'LDOUSDT', 'WLDUSDT', 'NOTUSDT', 'WIFUSDT',
];

// ─── Tracking ────────────────────────────────────────────────────────────────
let lastRecapDate    = '';
let lastWeeklyDate   = '';
let lastBriefingDate = '';
let lastBtcMacro: 'bullish' | 'bearish' | null = null;
const lastAlertTime    = new Map<string, number>(); // EMA Cross cooldown
const rsiLastAlertTime = new Map<string, number>(); // RSI Bounce cooldown (separate)
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// ─── Active trade tracking ────────────────────────────────────────────────────

interface ActiveTrade {
  symbol:        string;
  direction:     'bullish' | 'bearish';
  entry:         number;
  sl:            number;
  originalSl:    number;
  tp1:           number;
  tp2:           number;
  tp3:           number;
  tp4:           number;
  risk:          number;
  users:         Array<{ telegram_id: number; capital: number | null }>;
  openTime:      number;
  tp1Hit:        boolean;
  postToChannel: boolean;
  signalLogId:   string | null;
  strategy:      'EMA_CROSS' | 'RSI_BOUNCE';
}

const activeTrades = new Map<string, ActiveTrade>();

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

function nowUTC(): string {
  return new Date().toLocaleString('de-DE', {
    timeZone: 'UTC',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' UTC';
}

function tradeLinks(symbol: string): string {
  const base  = symbol.replace(/USDT$|BUSD$/, '');
  const quote = symbol.includes('USDT') ? 'USDT' : 'BUSD';
  const tv    = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=240`;
  const bnb   = `https://www.binance.com/en/trade/${base}_${quote}`;
  return `[📊 Chart](${tv}) · [🏦 Binance](${bnb})`;
}

// ─── L/S Ratio ────────────────────────────────────────────────────────────────

async function fetchLsRatio(symbol: string): Promise<number | null> {
  try {
    const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ longShortRatio: string }>;
    if (Array.isArray(data) && data.length > 0) {
      return parseFloat(data[0].longShortRatio);
    }
  } catch { /* ignore */ }
  return null;
}

function lsRatioLabel(ratio: number): string {
  if (ratio >= 2.0) return '🐂 Stark bullisch';
  if (ratio >= 1.3) return '📈 Mehr Longs';
  if (ratio >= 0.8) return '⚖️ Ausgeglichen';
  if (ratio >= 0.5) return '📉 Mehr Shorts';
  return '🐻 Stark bärisch';
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildEntryMessage(
  result: AnalysisResult,
  capital: number | null = null,
  lsRatio: number | null = null,
): string {
  const isBull = result.direction === 'bullish';
  const emoji  = isBull ? '🟢' : '🔴';
  const dir    = isBull ? 'LONG' : 'SHORT';

  // ── Strategie-Label ──────────────────────────────────────────────────────
  const strategyLabel = result.strategy === 'RSI_BOUNCE'
    ? `📊 *Strategie: RSI Bounce* _(RSI ${result.rsiValue != null ? result.rsiValue.toFixed(0) : '?'}, ${isBull ? 'überverkauft' : 'überkauft'})_`
    : `📊 *Strategie: EMA Cross* _(Golden/Death Cross)_`;

  // ── TP levels (4x) ──────────────────────────────────────────────────────
  let tpSection  = '';
  let exampleSection = '';

  if (
    result.entry    !== null &&
    result.stopLoss !== null &&
    result.takeProfit1 !== null &&
    result.takeProfit2 !== null
  ) {
    const e    = result.entry;
    const sl   = result.stopLoss;
    const risk = Math.abs(e - sl);

    const tp1 = result.takeProfit1;
    const tp2 = result.takeProfit2;
    const tp3 = isBull ? e + risk * 6 : e - risk * 6;
    const tp4 = isBull ? e + risk * 8 : e - risk * 8;

    const slDist = Math.abs(e - sl) / e;
    const rr1 = Math.abs(tp1 - e) / risk;
    const rr2 = Math.abs(tp2 - e) / risk;

    tpSection =
      `\n💰 *Entry:* \`$${fmt(e)}\`\n` +
      `🛑 *Stop Loss:* \`$${fmt(sl)}\` _(${pct(e, sl)})_\n` +
      `${'─'.repeat(30)}\n` +
      `🎯 *TP1:* \`$${fmt(tp1)}\` _(R/R ${rr1.toFixed(1)} · ${pct(e, tp1)})_ — 25% raus\n` +
      `🎯 *TP2:* \`$${fmt(tp2)}\` _(R/R ${rr2.toFixed(1)} · ${pct(e, tp2)})_ — 25% raus\n` +
      `🚀 *TP3:* \`$${fmt(tp3)}\` _(R/R 6.0 · ${pct(e, tp3)})_ extended\n` +
      `🌕 *TP4:* \`$${fmt(tp4)}\` _(R/R 8.0 · ${pct(e, tp4)})_ moon shot\n`;

    const defMargin = capital ?? 100;
    const defLev    = 10;
    const position  = defMargin * defLev;
    const slLoss    = position * slDist;
    const tp1Gain   = position * slDist * 2;
    const tp2Gain   = position * slDist * 4;
    const tp1Pct    = slDist * defLev * 200;
    const tp2Pct    = slDist * defLev * 400;
    const slPct     = slDist * defLev * 100;

    const label = capital !== null ? `$${fmtMoney(capital)} Margin · ${defLev}x` : `$${defMargin} Margin · ${defLev}x (Beispiel)`;
    exampleSection =
      `\n💵 *Beispielrechnung* _(${label}):_\n` +
      `  → bei TP1: *+$${fmtMoney(tp1Gain / 2)}* _(+${tp1Pct.toFixed(0)}% auf Margin)_\n` +
      `  → bei TP2: *+$${fmtMoney(tp2Gain)}* _(+${tp2Pct.toFixed(0)}% auf Margin)_\n` +
      `  → bei SL:  *-$${fmtMoney(slLoss)}* _(-${slPct.toFixed(0)}% auf Margin)_\n`;
  }

  // ── Confluence score bar ──────────────────────────────────────────────────
  let confluenceLine = '';
  if (result.confluenceScore !== null) {
    const s      = result.confluenceScore;
    const filled = Math.round(s / 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const label  = s >= 80 ? '🔥 SEHR STARK'
                 : s >= 60 ? '🟢 STARK'
                 : s >= 40 ? '🟡 MITTEL'
                 : s >= 20 ? '🟠 SCHWACH'
                 :           '⚠️ GERING';
    confluenceLine = `\n🎯 *Confluence Score: ${s}/100* ${label}\n\`${bar}\`\n`;
  }

  // ── L/S Ratio ─────────────────────────────────────────────────────────────
  const lsLine = lsRatio !== null
    ? `  • L/S Ratio: *${lsRatio.toFixed(2)}* — ${lsRatioLabel(lsRatio)}\n`
    : '';

  const allSignals = result.signals.map((s) => `  • ${s}`).join('\n');

  return (
    `⚡ *Signal — ${result.symbol}* · 4h · ${nowUTC()}\n\n` +
    `${emoji} *${dir}: $${result.symbol}* — Signal 👑\n\n` +
    `${strategyLabel}\n\n` +
    `📊 *Marktstruktur:*\n${lsLine}` +
    tpSection +
    exampleSection +
    confluenceLine +
    `\n📈 *Technische Signale:*\n${allSignals}\n\n` +
    `${tradeLinks(result.symbol)}\n\n` +
    `_Benutze /in ${result.symbol} MARGIN HEBEL um deinen Trade zu tracken_\n` +
    `_⚠️ Kein Finanzrat. Auf eigenes Risiko._`
  );
}

function buildExitMessage(
  trade: ActiveTrade,
  reason: 'sl' | 'tp1' | 'tp2',
  currentPrice: number,
  userPos: { margin: number; leverage: number } | null = null,
): string {
  const durationH = Math.round((Date.now() - trade.openTime) / 1000 / 60 / 60);
  const profitPct = pct(trade.entry, currentPrice);
  const links     = tradeLinks(trade.symbol);
  const priceStr  = `$${fmt(currentPrice)} _(${profitPct})_`;
  const stratTag  = trade.strategy === 'RSI_BOUNCE' ? ' [RSI Bounce]' : ' [EMA Cross]';

  let personalPnl = '';
  if (userPos && trade.risk > 0) {
    const position  = userPos.margin * userPos.leverage;
    const slDistPct = trade.risk / trade.entry;
    let pnlDollar   = 0;
    let pnlPct      = 0;
    if (reason === 'tp2') {
      pnlDollar = position * slDistPct * 4;
      pnlPct    = slDistPct * userPos.leverage * 400;
    } else if (reason === 'tp1') {
      pnlDollar = position * slDistPct * 2 * 0.5;
      pnlPct    = slDistPct * userPos.leverage * 100;
    } else {
      const isBreakEven = trade.tp1Hit;
      pnlDollar = isBreakEven ? position * slDistPct * 2 * 0.5 : -(position * slDistPct);
      pnlPct    = isBreakEven ? slDistPct * userPos.leverage * 100 : -(slDistPct * userPos.leverage * 100);
    }
    const sign = pnlDollar >= 0 ? '+' : '';
    personalPnl = `\n\n💵 *Dein Ergebnis* _(${userPos.margin}$ × ${userPos.leverage}x):_\n` +
                  `${sign}*$${fmtMoney(Math.abs(pnlDollar))}* (${sign}${pnlPct.toFixed(0)}% auf Margin)`;
  }

  if (reason === 'sl') {
    const isBreakEven = trade.tp1Hit;
    return (
      `🛑 *GEH RAUS — ${trade.symbol}*${stratTag}\n\n` +
      `${isBreakEven ? '🔄 Break-Even SL — kein Verlust!' : '❌ Stop Loss getroffen!'}\n\n` +
      `💰 *Ausstieg:* ${priceStr}\n` +
      `📍 *Entry war:* $${fmt(trade.entry)}\n` +
      `⏱ *Trade lief:* ${durationH}h\n` +
      `📊 *Ergebnis:* ${isBreakEven ? '+1R (BE)' : '-1R'}` +
      personalPnl +
      `\n\n${links}\n\n` +
      `_${isBreakEven ? 'TP1 war drin — Rest ohne Risiko.' : 'Verlust begrenzt — nächste Chance kommt.'}_`
    );
  }

  if (reason === 'tp1') {
    return (
      `🎯 *TP1 getroffen! — ${trade.symbol}*${stratTag}\n\n` +
      `✅ *Gewinne sichern! 25% raus!*\n\n` +
      `💰 *Ausstieg:* ${priceStr}\n` +
      `📍 *Entry war:* $${fmt(trade.entry)}\n` +
      `⏱ *Trade lief:* ${durationH}h\n` +
      `📊 *Ergebnis:* +2R erreicht` +
      personalPnl +
      `\n\n👉 25% der Position schließen.\n` +
      `👉 Rest läuft weiter bis TP2 \\($${fmt(trade.tp2)}\\).\n` +
      `👉 Stop Loss zieht auf Entry 🤖\n\n` +
      `${links}\n\n` +
      `_Gewinne gesichert — Rest läuft risikofrei._`
    );
  }

  return (
    `🏆 *TP2 getroffen! — ${trade.symbol}*${stratTag}\n\n` +
    `✅ *Voller Gewinn! Alles raus!*\n\n` +
    `💰 *Ausstieg:* ${priceStr}\n` +
    `📍 *Entry war:* $${fmt(trade.entry)}\n` +
    `⏱ *Trade lief:* ${durationH}h\n` +
    `📊 *Ergebnis:* +3R 🔥` +
    personalPnl +
    `\n\n${links}\n\n` +
    `_Perfekter Trade — alles raus._`
  );
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

async function sendToChannel(message: string): Promise<boolean> {
  if (!CHANNEL_ID) return false;
  try {
    await bot.api.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    return true;
  } catch (e) {
    console.error('[worker] Channel send failed:', (e as Error).message);
    // Loud fallback: tell the admin that the channel is broken so signals don't go dark.
    await notifyAdmin(`⚠️ Channel send failed: ${(e as Error).message}\n\nCHANNEL_ID="${CHANNEL_ID}"`);
    return false;
  }
}

async function sendToTradeUsers(trade: ActiveTrade, message: string): Promise<void> {
  for (const { telegram_id } of trade.users) {
    try {
      await bot.api.sendMessage(telegram_id, message, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
    }
  }
  if (trade.postToChannel) {
    await sendToChannel(message);
  }
}

async function sendPersonalPnl(
  trade: ActiveTrade,
  reason: 'sl' | 'tp1' | 'tp2',
  currentPrice: number,
): Promise<void> {
  try {
    const positions = await getUsersInPosition(trade.symbol);
    if (positions.length === 0) return;

    if (reason === 'tp2' || reason === 'sl') {
      await closeUserPositions(trade.symbol, 0);
    }

    for (const pos of positions) {
      const alreadyNotified = trade.users.some((u) => u.telegram_id === pos.telegram_id);
      const msg = buildExitMessage(trade, reason, currentPrice, pos);
      try {
        if (!alreadyNotified) {
          await bot.api.sendMessage(pos.telegram_id, msg, { parse_mode: 'Markdown' });
        }
      } catch (e) {
        console.error(`[worker] Personal P&L to ${pos.telegram_id} failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error('[worker] sendPersonalPnl failed:', (e as Error).message);
  }
}

// ─── Check active trades ──────────────────────────────────────────────────────

async function checkActiveTrade(
  trade: ActiveTrade,
  candles: Array<{ high: number; low: number; close: number }>,
): Promise<void> {
  const latest = candles[candles.length - 1];
  const { high, low, close } = latest;
  const { direction, sl, tp1, tp2, symbol } = trade;

  if (direction === 'bullish') {
    if (high >= tp2) {
      console.log(`[worker] ${symbol} TP2 hit`);
      const msg = buildExitMessage(trade, 'tp2', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'tp2', close);
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'tp2', close, 3.0).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
    if (!trade.tp1Hit && high >= tp1) {
      console.log(`[worker] ${symbol} TP1 hit — moving SL to break-even`);
      const msg = buildExitMessage(trade, 'tp1', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'tp1', close);
      trade.tp1Hit = true;
      trade.sl     = trade.entry;
      return;
    }
    if (low <= sl) {
      const reason  = trade.tp1Hit ? 'be' as const : 'sl' as const;
      const resultR = trade.tp1Hit ? 1.0 : -1;
      console.log(`[worker] ${symbol} SL hit${trade.tp1Hit ? ' (BE)' : ''}`);
      const msg = buildExitMessage(trade, 'sl', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'sl', close);
      if (trade.signalLogId) await closeSignal(trade.signalLogId, reason, close, resultR).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
  } else {
    if (low <= tp2) {
      console.log(`[worker] ${symbol} TP2 hit`);
      const msg = buildExitMessage(trade, 'tp2', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'tp2', close);
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'tp2', close, 3.0).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
    if (!trade.tp1Hit && low <= tp1) {
      console.log(`[worker] ${symbol} TP1 hit — moving SL to break-even`);
      const msg = buildExitMessage(trade, 'tp1', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'tp1', close);
      trade.tp1Hit = true;
      trade.sl     = trade.entry;
      return;
    }
    if (high >= sl) {
      const reason  = trade.tp1Hit ? 'be' as const : 'sl' as const;
      const resultR = trade.tp1Hit ? 1.0 : -1;
      console.log(`[worker] ${symbol} SL hit${trade.tp1Hit ? ' (BE)' : ''}`);
      const msg = buildExitMessage(trade, 'sl', close);
      await sendToTradeUsers(trade, msg);
      await sendPersonalPnl(trade, 'sl', close);
      if (trade.signalLogId) await closeSignal(trade.signalLogId, reason, close, resultR).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
  }
}

// ─── BTC Macro Shift Alert ───────────────────────────────────────────────────

async function checkBtcMacroShift(): Promise<void> {
  try {
    const candles = await getCandles('BTCUSDT', '4h', 250);
    const closes  = candles.map((c) => c.close);
    const price   = closes[closes.length - 1];

    const { EMA } = await import('technicalindicators');
    const ema200s = EMA.calculate({ values: closes, period: 200 });
    if (ema200s.length === 0) return;
    const ema200 = ema200s[ema200s.length - 1];

    const current: 'bullish' | 'bearish' = price > ema200 ? 'bullish' : 'bearish';

    if (lastBtcMacro !== null && current !== lastBtcMacro) {
      const isBull = current === 'bullish';
      const msg =
        `🌍 *BTC Makro-Shift — Marktregime geändert!*\n\n` +
        `${isBull ? '🟢' : '🔴'} BTC ist jetzt *${isBull ? 'BULLISCH' : 'BÄRISCH'}* (EMA200)\n\n` +
        `📍 *BTC Preis:* $${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
        `📊 *EMA200:* $${ema200.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n\n` +
        `${isBull
          ? '👉 Bot wechselt in _Long-Modus_'
          : '👉 Bot wechselt in _Short-Modus_'}\n\n` +
        `_MarketLens Makro-Alert · ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} Berlin_`;

      await sendToChannel(msg);
      await notifyAdmin(msg);
      console.log(`[worker] BTC macro shift: ${lastBtcMacro} → ${current}`);
    }

    lastBtcMacro = current;
  } catch (e) {
    console.error('[worker] BTC macro check failed:', (e as Error).message);
  }
}

// ─── Helper: fire a signal ────────────────────────────────────────────────────

async function fireSignal(
  symbol: string,
  result: AnalysisResult,
  users: Array<{ telegram_id: number; capital: number | null }>,
  isChannelSymbol: boolean,
  btcDirection: 'bullish' | 'bearish' | null,
): Promise<void> {
  if (!result.entry || !result.stopLoss || !result.takeProfit1 || !result.takeProfit2 || !result.direction) return;

  const lsRatio = await fetchLsRatio(symbol);

  // BTC note in signals
  if (symbol !== 'BTCUSDT' && btcDirection !== null) {
    result.signals.push(`BTC Master Filter: ${btcDirection === 'bullish' ? 'bullisch' : 'baerisch'} ✅`);
  }

  // Log to Supabase
  let signalLogId: string | null = null;
  try {
    const isBull = result.direction === 'bullish';
    const risk   = Math.abs(result.entry - result.stopLoss);
    signalLogId = await logSignal({
      symbol,
      direction:     result.direction,
      entry:         result.entry,
      stop_loss:     result.stopLoss,
      take_profit1:  result.takeProfit1,
      take_profit2:  result.takeProfit2,
      take_profit3:  isBull ? result.entry + risk * 6 : result.entry - risk * 6,
      take_profit4:  isBull ? result.entry + risk * 8 : result.entry - risk * 8,
      risk_reward:   result.riskReward,
      signals:       result.signals,
      ema50:         result.ema50 ?? null,
      volume_ratio:  result.volumeRatio ?? null,
    });
  } catch (e) {
    console.error('[worker] Failed to log signal:', (e as Error).message);
  }

  // Register active trade
  const isBull = result.direction === 'bullish';
  const risk   = Math.abs(result.entry - result.stopLoss);
  activeTrades.set(symbol, {
    symbol,
    direction:     result.direction,
    entry:         result.entry,
    sl:            result.stopLoss,
    originalSl:    result.stopLoss,
    tp1:           result.takeProfit1,
    tp2:           result.takeProfit2,
    tp3:           isBull ? result.entry + risk * 6 : result.entry - risk * 6,
    tp4:           isBull ? result.entry + risk * 8 : result.entry - risk * 8,
    risk,
    users,
    openTime:      Date.now(),
    tp1Hit:        false,
    postToChannel: isChannelSymbol,
    signalLogId,
    strategy:      result.strategy ?? 'EMA_CROSS',
  });

  // Send
  const channelMsg = buildEntryMessage(result, null, lsRatio);
  let dmDelivered = 0;
  for (const { telegram_id, capital } of users) {
    try {
      await bot.api.sendMessage(telegram_id, buildEntryMessage(result, capital, lsRatio), { parse_mode: 'Markdown' });
      dmDelivered++;
    } catch (e) {
      console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
    }
  }
  const channelDelivered = isChannelSymbol ? await sendToChannel(channelMsg) : false;

  // Safety-net: if nobody got the signal, route it to the admin so it doesn't go dark.
  if (dmDelivered === 0 && !channelDelivered) {
    await notifyAdmin(
      `🚨 *Signal ohne Empfänger!* — ${symbol}\n` +
      `users=${users.length}, isChannelSymbol=${isChannelSymbol}, CHANNEL_ID=${CHANNEL_ID ?? 'unset'}\n\n` +
      channelMsg,
    );
  }

  const strat = result.strategy ?? 'EMA_CROSS';
  console.log(`[worker] ${strat} alert sent for ${symbol} — users: ${users.length} (dm=${dmDelivered}), channel: ${channelDelivered}, L/S: ${lsRatio ?? 'n/a'}`);
}

// ─── Analysis tick ────────────────────────────────────────────────────────────

async function runAnalysis(): Promise<void> {
  console.log('[worker] Running analysis tick…');

  const watched = await getAllWatchedSymbols();
  const symbolMap = new Map<string, string[]>();
  for (const { symbol, user_ids } of watched) {
    symbolMap.set(symbol, user_ids);
  }
  // CHANNEL_SYMBOLS + RSI_BOUNCE_SYMBOLS immer scannen (unabhängig von CHANNEL_ID)
  for (const sym of CHANNEL_SYMBOLS) {
    if (!symbolMap.has(sym)) symbolMap.set(sym, []);
  }
  for (const sym of RSI_BOUNCE_SYMBOLS) {
    if (!symbolMap.has(sym)) symbolMap.set(sym, []);
  }

  if (symbolMap.size === 0) {
    console.log('[worker] No symbols to analyze — skipping.');
    return;
  }

  // BTC Master Filter
  let btcDirection: 'bullish' | 'bearish' | null = null;
  try {
    const btcCandles4h = await getCandles('BTCUSDT', '4h', 250);
    btcDirection = analyzeCandles('BTCUSDT', btcCandles4h).direction;
    console.log(`[worker] BTC Master Filter: ${btcDirection ?? 'neutral'}`);
  } catch (e) {
    console.warn('[worker] Could not fetch BTC for master filter:', (e as Error).message);
  }

  for (const [symbol, user_ids] of symbolMap) {
    try {
      const candles4h = await getCandles(symbol, '4h', 250);
      const isChannelSymbol = CHANNEL_ID !== null && (CHANNEL_SYMBOLS.includes(symbol) || RSI_BOUNCE_SYMBOLS.includes(symbol));

      // Check active trade exits
      const activeTrade = activeTrades.get(symbol);
      if (activeTrade) {
        await checkActiveTrade(activeTrade, candles4h);
      }
      if (activeTrades.has(symbol)) {
        console.log(`[dbg] ${symbol}: skipped (active trade)`);
        continue; // trade still open → skip new signals
      }
      console.log(`[dbg] ${symbol}: processing...`);

      const users = user_ids.length > 0 ? await getUsersForAlert(user_ids) : [];

      // ── 1. EMA Cross Strategy ────────────────────────────────────────────
      if (CHANNEL_SYMBOLS.includes(symbol) || user_ids.length > 0) {
        const lastTime = lastAlertTime.get(symbol) ?? 0;
        if (Date.now() - lastTime >= ALERT_COOLDOWN_MS) {
          const result4h = analyzeCandles(symbol, candles4h);

          if (isNotifiableSignal(result4h)) {
            // BTC Master Filter
            const blocked =
              symbol !== 'BTCUSDT' && btcDirection !== null &&
              ((result4h.direction === 'bullish' && btcDirection === 'bearish') ||
               (result4h.direction === 'bearish' && btcDirection === 'bullish'));

            if (!blocked) {
              lastAlertTime.set(symbol, Date.now());
              await fireSignal(symbol, result4h, users, isChannelSymbol, btcDirection);
              continue; // EMA Cross fired — skip RSI Bounce for same symbol this tick
            }
          }
        }
      }

      // ── 2. RSI Bounce Strategy ───────────────────────────────────────────
      if (RSI_BOUNCE_SYMBOLS.includes(symbol)) {
        const rsiLastTime = rsiLastAlertTime.get(symbol) ?? 0;
        if (Date.now() - rsiLastTime >= ALERT_COOLDOWN_MS) {
          const rsiResult = analyzeRsiBounce(symbol, candles4h);
          const rsiVal = rsiResult.rsiValue ?? rsiResult.rsi;
          console.log(`[rsi] ${symbol}: RSI=${rsiVal?.toFixed(1) ?? 'n/a'} dir=${rsiResult.direction ?? 'none'} entry=${rsiResult.entry?.toFixed(4) ?? 'null'}`);

          if (isNotifiableSignal(rsiResult)) {
            // BTC Master Filter for RSI Bounce
            const blocked =
              symbol !== 'BTCUSDT' && btcDirection !== null &&
              ((rsiResult.direction === 'bullish' && btcDirection === 'bearish') ||
               (rsiResult.direction === 'bearish' && btcDirection === 'bullish'));

            if (!blocked) {
              rsiLastAlertTime.set(symbol, Date.now());
              await fireSignal(symbol, rsiResult, users, isChannelSymbol, btcDirection);
            }
          }
        }
      }

    } catch (e) {
      console.error(`[worker] Analysis failed for ${symbol}:`, (e as Error).message);
    }
  }
}

// ─── News pipeline ────────────────────────────────────────────────────────────

async function runNewsPipeline(): Promise<void> {
  try {
    const [cryptoNews, macroNews] = await Promise.allSettled([
      fetchCryptoPanicNews(20),
      fetchAndAnalyzeMacroNews(),
    ]);
    const items = [
      ...(cryptoNews.status === 'fulfilled' ? cryptoNews.value : []),
      ...(macroNews.status  === 'fulfilled' ? macroNews.value  : []),
    ];
    await upsertNewsItems(items);
  } catch (e) {
    console.error('[worker] News pipeline error:', (e as Error).message);
  }
}

// ─── Daily recap at 20:00 CET/CEST ──────────────────────────────────────────

async function checkDailyRecap(): Promise<void> {
  const now       = new Date();
  const berlinStr = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [hourStr, minuteStr] = berlinStr.split(':');
  const hour   = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const berlinDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).toISOString().split('T')[0];

  if (hour === 20 && minute < 5 && berlinDate !== lastRecapDate) {
    lastRecapDate = berlinDate;
    let userIds: number[] = [];
    try {
      const users = await getAllUsers();
      userIds = users.map((u) => u.telegram_id);
    } catch (e) { /* ignore */ }
    await sendDailyRecap(bot, CHANNEL_ID, userIds);
  }
}

// ─── Morning Briefing at 08:00 Berlin ────────────────────────────────────────

async function checkMorningBriefing(): Promise<void> {
  const now       = new Date();
  const berlinStr = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [hourStr, minuteStr] = berlinStr.split(':');
  const hour   = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const berlinDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).toISOString().split('T')[0];

  if (hour === 8 && minute < 5 && berlinDate !== lastBriefingDate) {
    lastBriefingDate = berlinDate;
    console.log('[worker] Sending morning briefing…');
    try {
      const msg = await buildMorningBriefing();
      await sendToChannel(msg);
      try {
        const users = await getAllUsers();
        for (const u of users) {
          try {
            await bot.api.sendMessage(u.telegram_id, msg, { parse_mode: 'Markdown' });
          } catch { /* ignore per-user failures */ }
        }
      } catch { /* ignore if getAllUsers fails */ }
    } catch (e) {
      console.error('[worker] Morning briefing failed:', (e as Error).message);
    }
  }
}

// ─── Exit Monitor — TP1 / TP2 / TP3 / TP4 / SL / BE Checks ─────────────────

async function checkExits(): Promise<void> {
  let actives: import('./db').SignalLogEntry[];
  try { actives = await getActiveSignals(); }
  catch { return; }
  if (actives.length === 0) return;

  for (const sig of actives) {
    try {
      const candles = await getCandles(sig.symbol, '15m', 2);
      if (!candles || candles.length === 0) continue;
      const latest  = candles[candles.length - 1];
      const high    = latest.high;
      const low     = latest.low;
      const isLong  = sig.direction === 'bullish';
      const coin    = sig.symbol.replace('USDT', '');
      const dir     = isLong ? '🟢 LONG' : '🔴 SHORT';
      const tp1     = sig.take_profit1;
      const tp2     = sig.take_profit2;
      const tp3     = sig.take_profit3;
      const tp4     = sig.take_profit4;
      const sl      = sig.stop_loss;
      const entry   = sig.entry;

      const fmtP = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');

      // ── TP4 check ────────────────────────────────────────────────────────
      if (tp4 && !sig.tp3_hit_at && ((isLong && high >= tp4) || (!isLong && low <= tp4))) {
        await closeSignal(sig.id, 'tp2', tp4, 6.0);
        const msg =
          `🌕 *TP4 Moon Shot — ${coin}* ${dir}\n\n` +
          `✅ *Alles rausnehmen!* Maximales Ziel erreicht!\n\n` +
          `💰 Ergebnis: *+6R Gesamt*\n` +
          `   (¼ TP1 + ¼ TP2 + ¼ TP3 + ¼ TP4)\n\n` +
          `🎯 ${entry} → 🌕 ${fmtP(tp4)}`;
        await sendToChannel(msg);
        continue;
      }

      // ── TP3 check ────────────────────────────────────────────────────────
      if (tp3 && !sig.tp3_hit_at && sig.tp2_hit_at && ((isLong && high >= tp3) || (!isLong && low <= tp3))) {
        await markTp3Hit(sig.id);
        const msg =
          `🚀 *TP3 erreicht — ${coin}* ${dir}\n\n` +
          `💡 *Empfehlung:* Weiteres ¼ schließen.\n` +
          `   Letztes ¼ läuft Richtung *TP4 @ ${tp4 ? fmtP(tp4) : '?'}*\n\n` +
          `💰 Bisher gesichert: *+4.5R*\n` +
          `🌕 TP4 = Moon Shot (+8R)`;
        await sendToChannel(msg);
        continue;
      }

      // ── TP2 check ────────────────────────────────────────────────────────
      if (!sig.tp2_hit_at && sig.tp1_hit_at && ((isLong && high >= tp2) || (!isLong && low <= tp2))) {
        if (tp3) {
          await markTp2Hit(sig.id);
          const msg =
            `🎯 *TP2 erreicht — ${coin}* ${dir}\n\n` +
            `💡 *Empfehlung:* Weiteres ¼ schließen (+4R gesichert).\n` +
            `   Rest läuft Richtung *TP3 @ ${fmtP(tp3)}*\n\n` +
            `💰 Bisher gesichert: *+3R*\n` +
            `🚀 TP3 = +6R · 🌕 TP4 = +8R`;
          await sendToChannel(msg);
        } else {
          await closeSignal(sig.id, 'tp2', tp2, 3.0);
          const msg =
            `🏆 *TP2 erreicht — ${coin}* ${dir}\n\n` +
            `✅ *Alles rausnehmen!* Position vollständig schließen.\n\n` +
            `💰 Ergebnis: *+3R Gesamt*\n` +
            `   (½ bei TP1 + ½ bei TP2)\n\n` +
            `Entry: ${fmtP(entry)} → TP2: ${fmtP(tp2)}`;
          await sendToChannel(msg);
        }
        continue;
      }

      // ── TP1 check ────────────────────────────────────────────────────────
      if (!sig.tp1_hit_at && ((isLong && high >= tp1) || (!isLong && low <= tp1))) {
        await markTp1Hit(sig.id);
        const msg =
          `🎯 *TP1 erreicht — ${coin}* ${dir}\n\n` +
          `💡 *Empfehlung:* 25% der Position schließen (+2R gesichert).\n` +
          `   Stop Loss auf *Break-Even (${fmtP(entry)})* verschieben.\n\n` +
          `🎯 TP2 @ *${fmtP(tp2)}* (+4R)\n` +
          `🚀 TP3 @ *${tp3 ? fmtP(tp3) : '?'}* (+6R)\n` +
          `🌕 TP4 @ *${tp4 ? fmtP(tp4) : '?'}* (+8R)`;
        await sendToChannel(msg);
        continue;
      }

      // ── SL / BE check ────────────────────────────────────────────────────
      const effectiveSl = sig.tp1_hit_at ? entry : sl;
      if ((isLong && low <= effectiveSl) || (!isLong && high >= effectiveSl)) {
        if (sig.tp1_hit_at) {
          await closeSignal(sig.id, 'be', effectiveSl, 1.0);
          const msg =
            `⚪ *Break-Even — ${coin}* ${dir}\n\n` +
            `SL war auf Entry — kein Verlust am Rest.\n` +
            `💰 Ergebnis: *+1R* (TP1 gesichert)\n\n` +
            `Nächste Chance kommt. 📈`;
          await sendToChannel(msg);
        } else {
          await closeSignal(sig.id, 'sl', effectiveSl, -1.0);
          const msg =
            `🛑 *Stop Loss — ${coin}* ${dir}\n\n` +
            `Position gestoppt.\n` +
            `💸 Ergebnis: *-1R*\n\n` +
            `Verluste gehören dazu — nächstes Signal kommt. 💪`;
          await sendToChannel(msg);
        }
      }
    } catch (e) {
      console.error(`[exits] Error checking ${sig.symbol}:`, (e as Error).message);
    }
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await Promise.allSettled([runAnalysis(), runNewsPipeline()]);
  await checkExits();
  await checkDailyRecap();
  await checkMorningBriefing();
  await checkBtcMacroShift();
}

// ─── Admin notification ───────────────────────────────────────────────────────

async function notifyAdmin(message: string): Promise<void> {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;
  try {
    await bot.api.sendMessage(adminId, message, { parse_mode: 'Markdown' });
  } catch (e) { /* ignore */ }
}

// ─── Restore active trades ────────────────────────────────────────────────────

async function restoreActiveTrades(): Promise<void> {
  try {
    const openSignals = await getActiveSignals();
    for (const sig of openSignals) {
      if (activeTrades.has(sig.symbol)) continue;
      const isBull = sig.direction === 'bullish';
      const risk   = Math.abs(sig.entry - sig.stop_loss);
      activeTrades.set(sig.symbol, {
        symbol:        sig.symbol,
        direction:     sig.direction as 'bullish' | 'bearish',
        entry:         sig.entry,
        sl:            sig.stop_loss,
        originalSl:    sig.stop_loss,
        tp1:           sig.take_profit1,
        tp2:           sig.take_profit2,
        tp3:           isBull ? sig.entry + risk * 6 : sig.entry - risk * 6,
        tp4:           isBull ? sig.entry + risk * 8 : sig.entry - risk * 8,
        risk,
        users:         [],
        openTime:      new Date(sig.opened_at).getTime(),
        tp1Hit:        false,
        postToChannel: CHANNEL_ID !== null && (CHANNEL_SYMBOLS.includes(sig.symbol) || RSI_BOUNCE_SYMBOLS.includes(sig.symbol)),
        signalLogId:   sig.id,
        strategy:      'EMA_CROSS',
      });
      console.log('[worker] Restored: ' + sig.symbol + ' ' + sig.direction);
    }
    console.log('[worker] Restored ' + openSignals.length + ' active trade(s)');
  } catch (e) {
    console.error('[worker] Could not restore trades:', (e as Error).message);
  }
}

// ─── Entry point ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[worker] Starting — interval: ' + INTERVAL_MS / 60000 + ' min');
  if (CHANNEL_ID) console.log('[worker] Channel: ' + CHANNEL_ID);
  else console.warn('[worker] ⚠️ CHANNEL_ID not set — channel signals will be sent to admin DM only');
  console.log('[worker] EMA Cross: ' + CHANNEL_SYMBOLS.length + ' Coins');
  console.log('[worker] RSI Bounce: ' + RSI_BOUNCE_SYMBOLS.length + ' Coins');

  // Sanity-test the channel right at startup — if it's broken, fail loud now,
  // not silently 6 hours later when a signal fires.
  if (CHANNEL_ID) {
    try {
      await bot.api.sendMessage(CHANNEL_ID, '✅ Worker connected to channel');
    } catch (e) {
      await notifyAdmin(`⚠️ *Channel-Test fehlgeschlagen!* — CHANNEL_ID="${CHANNEL_ID}"\n\`${(e as Error).message}\`\n\nSignale gehen heute NUR an Admin DM bis das gefixt ist.`);
    }
  } else {
    await notifyAdmin('⚠️ CHANNEL_ID ist nicht gesetzt — Signale ohne private Watcher gehen nur an dich (Admin).');
  }

  await restoreActiveTrades();
  await notifyAdmin('Worker gestartet!\nIntervall: ' + INTERVAL_MS / 60000 + ' min\nEMA Cross: ' + CHANNEL_SYMBOLS.length + ' Coins\nRSI Bounce: ' + RSI_BOUNCE_SYMBOLS.length + ' Coins\n' + new Date().toISOString());
  setInterval(tick, INTERVAL_MS);
  await tick();
}

process.on('uncaughtException', async (err) => {
  await notifyAdmin('Worker fatal error!\n' + (err as Error).message);
});

main().catch(async (e) => {
  await notifyAdmin('Worker fatal error!\n' + (e as Error).message);
});
