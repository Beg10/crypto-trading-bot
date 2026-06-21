/**
 * Background worker — runs independently of the Telegram bot process.
 * Every WORKER_INTERVAL_MINUTES it:
 *   1. Fetches candles for all watched symbols
 *   2. Runs technical analysis → sends GEH REIN alert when signals align
 *   3. Checks active trades → sends GEH RAUS when SL or TP is hit
 *   4. Refreshes the news cache
 */

import 'dotenv/config';
import { Bot } from 'grammy';
import {
  getAllWatchedSymbols,
  getUsersForAlert,
  upsertNewsItems,
} from './db';
import { getCandles } from './services/binance';
import { analyzeCandles, isNotifiableSignal } from './services/analysis';
import { fetchCryptoPanicNews } from './services/cryptopanic';
import { fetchAndAnalyzeMacroNews } from './services/news';
import { AnalysisResult } from './types';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = new Bot(process.env.BOT_TOKEN);
const INTERVAL_MS = (parseInt(process.env.WORKER_INTERVAL_MINUTES ?? '5', 10)) * 60 * 1000;

// ─── Signal deduplication ─────────────────────────────────────────────────────
const lastAlertTime = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per symbol

// ─── Active trade tracking ────────────────────────────────────────────────────

interface ActiveTrade {
  symbol:    string;
  direction: 'bullish' | 'bearish';
  entry:     number;
  sl:        number;
  tp1:       number;
  tp2:       number;
  users:     Array<{ telegram_id: number; capital: number | null }>;
  openTime:  number;
  tp1Hit:    boolean; // true after TP1 notified — we still watch for TP2
}

const activeTrades = new Map<string, ActiveTrade>();

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function pct(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildEntryMessage(result: AnalysisResult, capital: number | null = null): string {
  const dir = result.direction === 'bullish' ? '🟢 GEH REIN' : '🔴 GEH RAUS — SHORT';
  const allSignals = result.signals.map((s) => `  • ${s}`).join('\n');

  let tradeLevels = '';
  let positionLine = '';

  if (
    result.entry !== null &&
    result.stopLoss !== null &&
    result.takeProfit1 !== null &&
    result.takeProfit2 !== null &&
    result.riskReward !== null
  ) {
    tradeLevels =
      `\n📍 *Entry:* $${fmt(result.entry)}\n` +
      `🛑 *Stop Loss:* $${fmt(result.stopLoss)} _(${pct(result.entry, result.stopLoss)})_\n` +
      `🎯 *TP1:* $${fmt(result.takeProfit1)} _(${pct(result.entry, result.takeProfit1)})_\n` +
      `🏆 *TP2:* $${fmt(result.takeProfit2)} _(${pct(result.entry, result.takeProfit2)})_\n` +
      `📊 *R:R:* 1:${result.riskReward.toFixed(1)}\n`;

    if (capital !== null && capital > 0 && result.entry > 0) {
      const slDistance = Math.abs(result.entry - result.stopLoss) / result.entry;
      if (slDistance > 0) {
        const riskAmount   = capital * 0.02;
        const rawPosition  = riskAmount / slDistance;
        const position     = Math.min(rawPosition, capital);
        positionLine = `💼 *Position:* $${fmt(position)} _(2% Risiko)_\n`;
      }
    }
  }

  return (
    `⚡ *Signal Alert — ${result.symbol}*\n\n` +
    `${dir}\n` +
    `💰 *Preis:* $${fmt(result.price)}\n` +
    tradeLevels +
    positionLine +
    `\n*Signale:*\n${allSignals}\n\n` +
    `_Technische Analyse — kein Finanzrat._`
  );
}

function buildExitMessage(trade: ActiveTrade, reason: 'sl' | 'tp1' | 'tp2', currentPrice: number): string {
  const durationH = Math.round((Date.now() - trade.openTime) / 1000 / 60 / 60);
  const profitPct = pct(trade.entry, currentPrice);

  if (reason === 'sl') {
    return (
      `🛑 *GEH RAUS — ${trade.symbol}*\n\n` +
      `❌ Stop Loss erreicht!\n` +
      `💰 *Preis:* $${fmt(currentPrice)} _(${profitPct})_\n` +
      `⏱ Trade lief: ${durationH}h\n\n` +
      `_Verlust begrenzt — nächste Chance kommt._`
    );
  }
  if (reason === 'tp1') {
    return (
      `🎯 *GEH RAUS (halb) — ${trade.symbol}*\n\n` +
      `✅ TP1 erreicht! Gewinne sichern!\n` +
      `💰 *Preis:* $${fmt(currentPrice)} _(${profitPct})_\n` +
      `⏱ Trade lief: ${durationH}h\n\n` +
      `_Tipp: Nimm die Hälfte raus, Rest läuft auf TP2 ($${fmt(trade.tp2)})_`
    );
  }
  // tp2
  return (
    `🏆 *GEH RAUS (alles) — ${trade.symbol}*\n\n` +
    `✅ TP2 erreicht — voller Gewinn!\n` +
    `💰 *Preis:* $${fmt(currentPrice)} _(${profitPct})_\n` +
    `⏱ Trade lief: ${durationH}h\n\n` +
    `_Top Trade! Alles raus und Gewinne sichern._`
  );
}

// ─── Send to all users of a trade ────────────────────────────────────────────

async function sendToTradeUsers(trade: ActiveTrade, message: string): Promise<void> {
  for (const { telegram_id } of trade.users) {
    try {
      await bot.api.sendMessage(telegram_id, message, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
    }
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
    // Check TP2 first (best outcome)
    if (!trade.tp1Hit && high >= tp2) {
      console.log(`[worker] ${symbol} TP2 hit (bullish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp2', close));
      activeTrades.delete(symbol);
      return;
    }
    if (high >= tp2 && trade.tp1Hit) {
      console.log(`[worker] ${symbol} TP2 hit (bullish, after TP1)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp2', close));
      activeTrades.delete(symbol);
      return;
    }
    // TP1 hit — notify, keep watching for TP2
    if (!trade.tp1Hit && high >= tp1) {
      console.log(`[worker] ${symbol} TP1 hit (bullish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp1', close));
      trade.tp1Hit = true;
      return;
    }
    // Stop loss
    if (low <= sl) {
      console.log(`[worker] ${symbol} SL hit (bullish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'sl', close));
      activeTrades.delete(symbol);
      return;
    }
  } else {
    // bearish
    if (low <= tp2) {
      console.log(`[worker] ${symbol} TP2 hit (bearish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp2', close));
      activeTrades.delete(symbol);
      return;
    }
    if (!trade.tp1Hit && low <= tp1) {
      console.log(`[worker] ${symbol} TP1 hit (bearish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'tp1', close));
      trade.tp1Hit = true;
      return;
    }
    if (high >= sl) {
      console.log(`[worker] ${symbol} SL hit (bearish)`);
      await sendToTradeUsers(trade, buildExitMessage(trade, 'sl', close));
      activeTrades.delete(symbol);
      return;
    }
  }
}

// ─── Analysis tick ────────────────────────────────────────────────────────────

async function runAnalysis(): Promise<void> {
  console.log('[worker] Running analysis tick…');

  const watched = await getAllWatchedSymbols();
  if (watched.length === 0) {
    console.log('[worker] No symbols watched — skipping analysis.');
    return;
  }

  for (const { symbol, user_ids } of watched) {
    try {
      const candles = await getCandles(symbol, '4h', 100);

      // 1. Check active trade for this symbol
      const activeTrade = activeTrades.get(symbol);
      if (activeTrade) {
        await checkActiveTrade(activeTrade, candles);
      }

      // 2. Look for new entry signal (skip if trade already active)
      if (activeTrades.has(symbol)) continue;

      const result: AnalysisResult = analyzeCandles(symbol, candles);
      if (!isNotifiableSignal(result)) continue;

      const lastTime = lastAlertTime.get(symbol) ?? 0;
      if (Date.now() - lastTime < ALERT_COOLDOWN_MS) {
        console.log(`[worker] ${symbol} alert suppressed (cooldown)`);
        continue;
      }

      lastAlertTime.set(symbol, Date.now());

      const users = await getUsersForAlert(user_ids);

      // Register active trade
      if (result.entry !== null && result.stopLoss !== null && result.takeProfit1 !== null && result.takeProfit2 !== null && result.direction !== null) {
        activeTrades.set(symbol, {
          symbol,
          direction: result.direction,
          entry:     result.entry,
          sl:        result.stopLoss,
          tp1:       result.takeProfit1,
          tp2:       result.takeProfit2,
          users,
          openTime:  Date.now(),
          tp1Hit:    false,
        });
        console.log(`[worker] Active trade opened: ${symbol} ${result.direction}`);
      }

      // Send GEH REIN to each user
      for (const { telegram_id, capital } of users) {
        try {
          const message = buildEntryMessage(result, capital);
          await bot.api.sendMessage(telegram_id, message, { parse_mode: 'Markdown' });
        } catch (e) {
          console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
        }
      }

      console.log(`[worker] Entry alert sent for ${symbol} to ${users.length} user(s)`);
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
      ...(macroNews.status === 'fulfilled' ? macroNews.value : []),
    ];
    if (cryptoNews.status === 'rejected') console.error('[worker] CryptoPanic failed:', cryptoNews.reason);
    if (macroNews.status === 'rejected')  console.error('[worker] NewsAPI/Claude failed:', macroNews.reason);
    await upsertNewsItems(items);
    console.log(`[worker] News cache updated with ${items.length} items.`);
  } catch (e) {
    console.error('[worker] News pipeline error:', (e as Error).message);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await Promise.allSettled([runAnalysis(), runNewsPipeline()]);
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
