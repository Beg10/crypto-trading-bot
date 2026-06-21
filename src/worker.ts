/**
 * Background worker — runs independently of the Telegram bot process.
 * Start with: pnpm worker  (or  tsx src/worker.ts)
 *
 * Every WORKER_INTERVAL_MINUTES it:
 *   1. Fetches candles for all watched symbols
 *   2. Runs technical analysis
 *   3. Pushes Telegram alerts when signals align (personalized with position sizing)
 *   4. Refreshes the news cache (CryptoPanic + NewsAPI/Claude)
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
      const candles = await getCandles(symbol, '1h', 100);
      const result: AnalysisResult = analyzeCandles(symbol, candles);

      if (!isNotifiableSignal(result)) continue;

      const lastTime = lastAlertTime.get(symbol) ?? 0;
      if (Date.now() - lastTime < ALERT_COOLDOWN_MS) {
        console.log(`[worker] ${symbol} alert suppressed (cooldown)`);
        continue;
      }

      lastAlertTime.set(symbol, Date.now());

      const users = await getUsersForAlert(user_ids);

      for (const { telegram_id, capital } of users) {
        try {
          const message = buildAlertMessage(result, capital);
          await bot.api.sendMessage(telegram_id, message, { parse_mode: 'Markdown' });
        } catch (e) {
          console.error(`[worker] sendMessage to ${telegram_id} failed:`, (e as Error).message);
        }
      }

      console.log(`[worker] Alert sent for ${symbol} to ${users.length} user(s)`);
    } catch (e) {
      console.error(`[worker] Analysis failed for ${symbol}:`, (e as Error).message);
    }
  }
}

function fmt(n: number): string {
  // Auto-precision: enough decimals for small altcoins
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function pct(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

function buildAlertMessage(result: AnalysisResult, capital: number | null = null): string {
  const dir = result.direction === 'bullish' ? '🟢 BULLISH' : '🔴 BEARISH';
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

    // Position sizing — 2% risk model
    if (capital !== null && capital > 0 && result.entry > 0) {
      const slDistance = Math.abs(result.entry - result.stopLoss) / result.entry;
      if (slDistance > 0) {
        const riskAmount = capital * 0.02;
        const rawPosition = riskAmount / slDistance;
        const position = Math.min(rawPosition, capital);
        positionLine = `💼 *Position:* $${fmt(position)} _(2% Risiko)_\n`;
      }
    }
  }

  return (
    `⚡ *Signal Alert — ${result.symbol}*\n\n` +
    `${dir} confluence\n` +
    `💰 *Price:* $${fmt(result.price)}\n` +
    tradeLevels +
    positionLine +
    `\n*Signals:*\n${allSignals}\n\n` +
    `_This is technical analysis, not financial advice._`
  );
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

    if (cryptoNews.status === 'rejected') {
      console.error('[worker] CryptoPanic failed:', cryptoNews.reason);
    }
    if (macroNews.status === 'rejected') {
      console.error('[worker] NewsAPI/Claude failed:', macroNews.reason);
    }

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
