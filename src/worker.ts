/**
 * Background worker — runs independently of the Telegram bot process.
 * Every WORKER_INTERVAL_MINUTES it:
 *   1. Fetches candles for all watched symbols + channel symbols
 *   2. Runs technical analysis → sends GEH REIN to users + channel
 *   3. Checks active trades → sends GEH RAUS when SL or TP is hit
 *   4. Auto break-even: moves SL to entry after TP1 hit
 *   5. Logs every signal + outcome to Supabase signal_log
 *   6. Refreshes the news cache
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
} from './db';
import { getCandles } from './services/binance';
import { analyzeCandles, isNotifiableSignal } from './services/analysis';
import { fetchCryptoPanicNews } from './services/cryptopanic';
import { fetchAndAnalyzeMacroNews } from './services/news';
import { AnalysisResult } from './types';
import { sendDailyRecap } from './commands/recap';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = new Bot(process.env.BOT_TOKEN);
const INTERVAL_MS = (parseInt(process.env.WORKER_INTERVAL_MINUTES ?? '5', 10)) * 60 * 1000;

// ─── Channel config ───────────────────────────────────────────────────────────
const CHANNEL_ID: string | null = process.env.CHANNEL_ID ?? null;
const CHANNEL_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT', 'MATICUSDT',
];

// ─── Daily recap tracking ────────────────────────────────────────────────────
let lastRecapDate = '';

// ─── Signal deduplication ─────────────────────────────────────────────────────
const lastAlertTime = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// ─── Active trade tracking ────────────────────────────────────────────────────

interface ActiveTrade {
  symbol:        string;
  direction:     'bullish' | 'bearish';
  entry:         number;
  sl:            number;            // current SL (moves to entry after TP1)
  originalSl:    number;            // original SL for logging
  tp1:           number;
  tp2:           number;
  users:         Array<{ telegram_id: number; capital: number | null }>;
  openTime:      number;
  tp1Hit:        boolean;
  postToChannel: boolean;
  signalLogId:   string | null;     // Supabase signal_log id
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

// ─── Trade links ─────────────────────────────────────────────────────────────

function tradeLinks(symbol: string): string {
  const base  = symbol.replace(/USDT$|BUSD$/, '');
  const quote = symbol.includes('USDT') ? 'USDT' : 'BUSD';
  const tv    = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=240`;
  const bnb   = `https://www.binance.com/en/trade/${base}_${quote}`;
  return `[📊 Chart](${tv}) · [🏦 Binance](${bnb})`;
}

// ─── Channel helper ───────────────────────────────────────────────────────────

async function sendToChannel(message: string): Promise<void> {
  if (!CHANNEL_ID) return;
  try {
    await bot.api.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[worker] Channel send failed:', (e as Error).message);
  }
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildEntryMessage(result: AnalysisResult, capital: number | null = null): string {
  const isBull = result.direction === 'bullish';
  const dirLine = isBull
    ? '🟢 *GEH REIN* — Long Position eröffnen'
    : '⚠️ *FINGER WEG* — Bärisches Signal, kein Trade';

  const allSignals = result.signals.map((s) => `  • ${s}`).join('\n');

  let tradeLevels = '';
  let moneyLines  = '';
  let positionLine = '';

  if (
    result.entry !== null &&
    result.stopLoss !== null &&
    result.takeProfit1 !== null &&
    result.takeProfit2 !== null &&
    result.riskReward !== null
  ) {
    const riskPct = pct(result.entry, result.stopLoss);
    const tp1Pct  = pct(result.entry, result.takeProfit1);
    const tp2Pct  = pct(result.entry, result.takeProfit2);
    const slDist  = Math.abs(result.entry - result.stopLoss);

    tradeLevels =
      `\n📍 *Entry:* $${fmt(result.entry)}\n` +
      `🛑 *Stop Loss:* $${fmt(result.stopLoss)} _(${riskPct})_\n` +
      `🎯 *TP1:* $${fmt(result.takeProfit1)} _(${tp1Pct})_\n` +
      `🏆 *TP2:* $${fmt(result.takeProfit2)} _(${tp2Pct})_\n` +
      `📊 *R:R:* 1 : ${result.riskReward.toFixed(1)}\n`;

    if (capital !== null && capital > 0 && result.entry > 0 && slDist > 0) {
      const slDistPct  = slDist / result.entry;
      const riskAmount = capital * 0.02;
      const position   = Math.min(riskAmount / slDistPct, capital);
      const slLoss     = position * slDistPct;
      const tp1Gain    = position * Math.abs(result.takeProfit1 - result.entry) / result.entry;
      const tp2Gain    = position * Math.abs(result.takeProfit2 - result.entry) / result.entry;

      positionLine = `💼 *Position:* $${fmtMoney(position)} _(2% Risiko von $${fmtMoney(capital)})_\n`;
      moneyLines   =
        `\n💵 *In Dollar:*\n` +
        `  ❌ Max. Verlust: -$${fmtMoney(slLoss)}\n` +
        `  ✅ Gewinn TP1: +$${fmtMoney(tp1Gain)}\n` +
        `  🏆 Gewinn TP2: +$${fmtMoney(tp2Gain)}\n`;
    }
  }

  return (
    `⚡ *Signal — ${result.symbol}* · 4h · ${nowUTC()}\n\n` +
    `${dirLine}\n` +
    `💰 *Preis:* $${fmt(result.price)}\n` +
    tradeLevels +
    positionLine +
    moneyLines +
    `\n📈 *Signale:*\n${allSignals}\n\n` +
    `${tradeLinks(result.symbol)}\n\n` +
    `_⚠️ Kein Finanzrat. Auf eigenes Risiko._`
  );
}

function buildExitMessage(
  trade: ActiveTrade,
  reason: 'sl' | 'tp1' | 'tp2',
  currentPrice: number,
): string {
  const durationH = Math.round((Date.now() - trade.openTime) / 1000 / 60 / 60);
  const profitPct = pct(trade.entry, currentPrice);
  const links     = tradeLinks(trade.symbol);
  const priceStr  = `$${fmt(currentPrice)} _(${profitPct})_`;

  if (reason === 'sl') {
    const isBreakEven = trade.tp1Hit; // SL was moved to entry after TP1
    return (
      `🛑 *GEH RAUS — ${trade.symbol}*\n\n` +
      `${isBreakEven ? '🔄 Break-Even SL getroffen — kein Verlust!' : '❌ Stop Loss getroffen!'}\n\n` +
      `💰 *Ausstiegspreis:* ${priceStr}\n` +
      `📍 *Entry war:* $${fmt(trade.entry)}\n` +
      `⏱ *Trade lief:* ${durationH}h\n` +
      `📊 *Ergebnis:* ${isBreakEven ? '±0R (Break-Even)' : '-1R (Max. Verlust begrenzt)'}\n\n` +
      `👉 Position schließen.\n\n` +
      `${links}\n\n` +
      `_${isBreakEven ? 'TP1 war drin — Rest ohne Risiko gelaufen.' : 'Verlust begrenzt — nächste Chance kommt.'}_`
    );
  }

  if (reason === 'tp1') {
    return (
      `🎯 *GEH RAUS (halb) — ${trade.symbol}*\n\n` +
      `✅ *TP1 erreicht! Gewinne sichern!*\n\n` +
      `💰 *Ausstiegspreis:* ${priceStr}\n` +
      `📍 *Entry war:* $${fmt(trade.entry)}\n` +
      `⏱ *Trade lief:* ${durationH}h\n` +
      `📊 *Ergebnis:* +1.5R erreicht\n\n` +
      `👉 Hälfte der Position schließen.\n` +
      `👉 Rest läuft weiter bis TP2 ($${fmt(trade.tp2)}).\n` +
      `👉 Stop Loss wird automatisch auf Entry gezogen 🤖\n\n` +
      `${links}\n\n` +
      `_Gewinne gesichert — Rest läuft jetzt risikofrei._`
    );
  }

  return (
    `🏆 *GEH RAUS (alles) — ${trade.symbol}*\n\n` +
    `✅ *TP2 erreicht — Voller Gewinn!*\n\n` +
    `💰 *Ausstiegspreis:* ${priceStr}\n` +
    `📍 *Entry war:* $${fmt(trade.entry)}\n` +
    `⏱ *Trade lief:* ${durationH}h\n` +
    `📊 *Ergebnis:* +3R erreicht 🔥\n\n` +
    `👉 Gesamte Position schließen und Gewinn mitnehmen.\n\n` +
    `${links}\n\n` +
    `_Perfekter Trade. Alles raus._`
  );
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

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
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp2', close));
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'tp2', close, 3.0).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
    if (!trade.tp1Hit && high >= tp1) {
      console.log(`[worker] ${symbol} TP1 hit — moving SL to break-even`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp1', close));
      trade.tp1Hit = true;
      trade.sl = trade.entry; // ← Auto break-even
      return;
    }
    if (low <= sl) {
      const reason = trade.tp1Hit ? 'tp1' : 'sl'; // tp1 already counted
      const resultR = trade.tp1Hit ? 0 : -1;
      console.log(`[worker] ${symbol} SL hit${trade.tp1Hit ? ' (break-even)' : ''}`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'sl', close));
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'sl', close, resultR).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
  } else {
    if (low <= tp2) {
      console.log(`[worker] ${symbol} TP2 hit`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp2', close));
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'tp2', close, 3.0).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
    if (!trade.tp1Hit && low <= tp1) {
      console.log(`[worker] ${symbol} TP1 hit — moving SL to break-even`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp1', close));
      trade.tp1Hit = true;
      trade.sl = trade.entry; // ← Auto break-even
      return;
    }
    if (high >= sl) {
      const resultR = trade.tp1Hit ? 0 : -1;
      console.log(`[worker] ${symbol} SL hit${trade.tp1Hit ? ' (break-even)' : ''}`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'sl', close));
      if (trade.signalLogId) await closeSignal(trade.signalLogId, 'sl', close, resultR).catch(console.error);
      activeTrades.delete(symbol);
      return;
    }
  }
}

// ─── Analysis tick ────────────────────────────────────────────────────────────

async function runAnalysis(): Promise<void> {
  console.log('[worker] Running analysis tick…');

  const watched = await getAllWatchedSymbols();

  const symbolMap = new Map<string, string[]>();
  for (const { symbol, user_ids } of watched) {
    symbolMap.set(symbol, user_ids);
  }
  if (CHANNEL_ID) {
    for (const sym of CHANNEL_SYMBOLS) {
      if (!symbolMap.has(sym)) symbolMap.set(sym, []);
    }
  }

  if (symbolMap.size === 0) {
    console.log('[worker] No symbols to analyze — skipping.');
    return;
  }

  for (const [symbol, user_ids] of symbolMap) {
    try {
      const [candles4h, candles1h] = await Promise.all([
        getCandles(symbol, '4h', 100),
        getCandles(symbol, '1h', 100),
      ]);
      const isChannelSymbol = CHANNEL_ID !== null && CHANNEL_SYMBOLS.includes(symbol);

      // 1. Check active trade first (uses 4h candles for price action)
      const activeTrade = activeTrades.get(symbol);
      if (activeTrade) {
        await checkActiveTrade(activeTrade, candles4h);
      }

      if (activeTrades.has(symbol)) continue;

      // 2. Multi-timeframe analysis: 4h is primary, 1h must confirm
      const result4h: AnalysisResult = analyzeCandles(symbol, candles4h);
      const result1h: AnalysisResult = analyzeCandles(symbol, candles1h);

      // Both timeframes must agree on direction
      if (!isNotifiableSignal(result4h)) continue;
      if (result1h.direction === null || result1h.direction !== result4h.direction) {
        console.log(`[worker] ${symbol} skipped — 1h (${result1h.direction ?? 'none'}) vs 4h (${result4h.direction}) mismatch`);
        continue;
      }

      // Merge: use 4h trade levels, add 1h confirmation note to signals
      const result: AnalysisResult = {
        ...result4h,
        signals: [
          ...result4h.signals,
          `1h Bestaetigung: ${result1h.direction === 'bullish' ? 'bullisch' : 'baerisch'} (Score ${
            result1h.signals.filter(s =>
              s.includes('RSI') || s.includes('MACD') || s.includes('Bollinger') ||
              s.includes('StochRSI') || s.includes('Divergenz') ||
              ['Hammer','Bullish Engulfing','Shooting Star','Bearish Engulfing','Morning Star','Bullish Marubozu','Bearish Marubozu','Doji'].some(p => s.includes(p))
            ).length
          } Indikatoren) ✅`,
        ],
      };

      const lastTime = lastAlertTime.get(symbol) ?? 0;
      if (Date.now() - lastTime < ALERT_COOLDOWN_MS) {
        console.log(`[worker] ${symbol} alert suppressed (cooldown)`);
        continue;
      }

      lastAlertTime.set(symbol, Date.now());

      const users = user_ids.length > 0 ? await getUsersForAlert(user_ids) : [];

      // 3. Log signal to Supabase
      let signalLogId: string | null = null;
      if (result.entry !== null && result.stopLoss !== null && result.takeProfit1 !== null && result.takeProfit2 !== null && result.direction !== null) {
        try {
          signalLogId = await logSignal({
            symbol,
            direction: result.direction,
            entry: result.entry,
            stop_loss: result.stopLoss,
            take_profit1: result.takeProfit1,
            take_profit2: result.takeProfit2,
            risk_reward: result.riskReward,
            signals: result.signals,
            ema50: result.ema50 ?? null,
            volume_ratio: result.volumeRatio ?? null,
          });
          console.log(`[worker] Signal logged: ${signalLogId}`);
        } catch (e) {
          console.error('[worker] Failed to log signal:', (e as Error).message);
        }
      }

      // 4. Register active trade
      if (result.entry !== null && result.stopLoss !== null && result.takeProfit1 !== null && result.takeProfit2 !== null && result.direction !== null) {
        activeTrades.set(symbol, {
          symbol,
          direction:     result.direction,
          entry:         result.entry,
          sl:            result.stopLoss,
          originalSl:    result.stopLoss,
          tp1:           result.takeProfit1,
          tp2:           result.takeProfit2,
          users,
          openTime:      Date.now(),
          tp1Hit:        false,
          postToChannel: isChannelSymbol,
          signalLogId,
        });
        console.log(`[worker] Active trade opened: ${symbol} ${result.direction}`);
      }

      // 5. Send to individual users
      for (const { telegram_id, capital } of users) {
        try {
          await bot.api.sendMessage(
            telegram_id,
            buildEntryMessage(result, capital),
            { parse_mode: 'Markdown' },
          );
        } catch (e) {
          console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
        }
      }

      // 6. Send to channel
      if (isChannelSymbol) {
        await sendToChannel(buildEntryMessage(result, null));
      }

      console.log(`[worker] Alert sent for ${symbol} — users: ${users.length}, channel: ${isChannelSymbol}`);
    } catch (e) {
      console.error(`[worker] Analysis failed for ${symbol}:`, (e as Error).message);
    }
  }
}

// ─── News pipeline ────────────────────────────────────────────────────────────

async function runNewsPipeline(): Promise<void> {
  console.log('[worker] Running news pipeline…');
  try {
    const [cryptoNews, macroNews] = await Promise.allSettled([
      fetchCryptoPanicNews(20),
      fetchAndAnalyzeMacroNews(),
    ]);
    const items = [
      ...(cryptoNews.status === 'fulfilled' ? cryptoNews.value : []),
      ...(macroNews.status  === 'fulfilled' ? macroNews.value  : []),
    ];
    if (cryptoNews.status === 'rejected') console.error('[worker] CryptoPanic failed:', cryptoNews.reason);
    if (macroNews.status  === 'rejected') console.error('[worker] NewsAPI/Claude failed:', macroNews.reason);
    await upsertNewsItems(items);
    console.log(`[worker] News cache updated with ${items.length} items.`);
  } catch (e) {
    console.error('[worker] News pipeline error:', (e as Error).message);
  }
}

// ─── Daily recap at 20:00 CET/CEST ──────────────────────────────────────────

async function checkDailyRecap(): Promise<void> {
  const now = new Date();
  // Get current time in Berlin timezone
  const berlinStr = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [hourStr, minuteStr] = berlinStr.split(':');
  const hour   = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  // Date string in Berlin (to track if recap already sent today)
  const berlinDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
    .toISOString().split('T')[0];

  // Fire once when clock hits 20:00–20:04 Berlin time
  if (hour === 20 && minute < 5 && berlinDate !== lastRecapDate) {
    lastRecapDate = berlinDate;

    // Get all user telegram_ids to notify
    let userIds: number[] = [];
    try {
      const users = await getAllUsers();
      userIds = users.map((u) => u.telegram_id);
    } catch (e) {
      console.error('[recap] Failed to fetch users:', (e as Error).message);
    }

    await sendDailyRecap(bot, CHANNEL_ID, userIds);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await Promise.allSettled([runAnalysis(), runNewsPipeline()]);
  await checkDailyRecap();
}

// ─── Admin notification ───────────────────────────────────────────────────────

async function notifyAdmin(message: string): Promise<void> {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;
  try {
    await bot.api.sendMessage(adminId, message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[monitor] Failed to notify admin:', (e as Error).message);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] Starting — interval: ${INTERVAL_MS / 60000} min`);
  if (CHANNEL_ID) console.log(`[worker] Channel broadcasting active: ${CHANNEL_ID}`);
  await notifyAdmin(`⚙️ *Worker gestartet!*\nAnalyse-Intervall: ${INTERVAL_MS / 60000} min\n_${new Date().toISOString()}_`);
  setInterval(tick, INTERVAL_MS);
  await tick();
}

process.on('uncaughtException', async (err) => {
  await notifyAdmin(`🔴 *Worker crashed!*\n\`${err.message}\`\n\nRailway wird neu starten…`);
});

main().catch(async (e) => {
  await notifyAdmin(`🔴 *Worker fatal error!*\n\`${(e as Error).message}\``);
});
