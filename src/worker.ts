/**
 * Background worker — runs independently of the Telegram bot process.
 * Start with: pnpm worker  (or  tsx src/worker.ts)
 *
 * Every WORKER_INTERVAL_MINUTES it:
 *   1. Fetches candles for all watched symbols
 *   2. Runs technical analysis
 *   3. Pushes Telegram alerts when signals align
 *   4. Refreshes the news cache (CryptoPanic + NewsAPI/Claude)
 */

import 'dotenv/config';
import { Bot } from 'grammy';
import {
  getAllWatchedSymbols,
  getTelegramIdsByUserIds,
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
// Tracks the last time a signal was sent per symbol to avoid spam.
// In production you'd store this in Redis or the DB; in-process map is fine for single-instance.
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

      // Cooldown check
      const lastTime = lastAlertTime.get(symbol) ?? 0;
      if (Date.now() - lastTime < ALERT_COOLDOWN_MS) {
        console.log(`[worker] ${symbol} alert suppressed (cooldown)`);
        continue;
      }

      lastAlertTime.set(symbol, Date.now());

      const telegramIds = await getTelegramIdsByUserIds(user_ids);
      const message = buildAlertMessage(result);

      for (const telegramId of telegramIds) {
        try {
          await bot.api.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
        } catch (e) {
          // User may have blocked the bot — log and continue
          console.error(`[worker] sendMessage to ${telegramId} failed:`, (e as Error).message);
        }
      }

      console.log(`[worker] Alert sent for ${symbol} to ${telegramIds.length} user(s)`);
    } catch (e) {
      // Don't let one failed symbol abort the whole loop
      console.error(`[worker] Analysis failed for ${symbol}:`, (e as Error).message);
    }
  }
}

function buildAlertMessage(result: AnalysisResult): string {
  const bullishSignals = result.signals.filter(
    (s) =>
      s.includes('Oversold') ||
      s.includes('Bullish') ||
      s.includes('Below Lower') ||
      s.includes('Hammer') ||
      s.includes('Morning Star'),
  );
  const bearishSignals = result.signals.filter(
    (s) =>
      s.includes('Overbought') ||
      s.includes('Bearish') ||
      s.includes('Above Upper') ||
      s.includes('Shooting Star'),
  );

  const direction = bullishSignals.length >= bearishSignals.length ? '🟢 BULLISH' : '🔴 BEARISH';
  const allSignals = result.signals.map((s) => `  • ${s}`).join('\n');
  const price = result.price.toLocaleString('en-US', { maximumFractionDigits: 4 });

  return (
    `⚡ *Signal Alert — ${result.symbol}*\n\n` +
    `${direction} confluence detected\n` +
    `Price: *$${price}*\n\n` +
    `*Signals:*\n${allSignals}\n\n` +
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

// ─── Main loop ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await Promise.allSettled([runAnalysis(), runNewsPipeline()]);
}

async function main(): Promise<void> {
  console.log(`[worker] Starting — interval: ${INTERVAL_MS / 60000} min`);

  // Run immediately on start, then on interval
  await tick();

  setInterval(() => {
    tick().catch((e) => console.error('[worker] Unhandled tick error:', e));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error('[worker] Fatal error:', e);
  process.exit(1);
});
