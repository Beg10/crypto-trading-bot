import { Context } from 'grammy';
import { getActiveSignals, getRecentSignals } from '../db';
import { getPrice } from '../services/binance';

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function pct(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

export async function handleStatus(ctx: Context): Promise<void> {
  await ctx.reply('🔍 Lade Status…');

  try {
    const [active, recent] = await Promise.all([
      getActiveSignals(),
      getRecentSignals(30),
    ]);

    // ── Active trades ─────────────────────────────────────────────────────────
    let msg = '📊 *MarketLens Status*\n\n';

    if (active.length === 0) {
      msg += '🟡 *Aktive Trades:* Keine\n';
      msg += '_Bot wartet auf das nächste Signal._\n';
    } else {
      msg += `🟢 *Aktive Trades:* ${active.length}\n\n`;

      for (const trade of active) {
        let currentPrice: number | null = null;
        let plLine = '';
        try {
          currentPrice = await getPrice(trade.symbol);
          const plPct = pct(trade.entry, currentPrice);
          const isUp = currentPrice > trade.entry;
          plLine = `💰 Aktuell: $${fmt(currentPrice)} _(${plPct})_ ${isUp ? '📈' : '📉'}\n`;
        } catch { /* price unavailable */ }

        const openedAt = new Date(trade.opened_at).toLocaleString('de-DE', {
          timeZone: 'UTC', day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });

        const slLabel = trade.close_reason === null && currentPrice !== null && currentPrice >= trade.entry
          ? `$${fmt(trade.stop_loss)} _(Break-even gesetzt? Prüfe manuell)_`
          : `$${fmt(trade.stop_loss)}`;

        msg +=
          `*${trade.symbol}* · ${trade.direction === 'bullish' ? '🟢 LONG' : '🔴 SHORT'}\n` +
          `📍 Entry: $${fmt(trade.entry)}\n` +
          plLine +
          `🛑 SL: $${fmt(trade.stop_loss)}\n` +
          `🎯 TP1: $${fmt(trade.take_profit1)}\n` +
          `🏆 TP2: $${fmt(trade.take_profit2)}\n` +
          `⏱ Offen seit: ${openedAt} UTC\n\n`;
      }
    }

    // ── Performance (last 30 days) ────────────────────────────────────────────
    msg += '─────────────────\n';
    msg += '📈 *Performance (letzte 30 Tage)*\n\n';

    if (recent.length === 0) {
      msg += '_Noch keine abgeschlossenen Trades._\n';
    } else {
      const wins   = recent.filter((r) => (r.result_r ?? 0) > 0).length;
      const losses = recent.filter((r) => (r.result_r ?? 0) < 0).length;
      const be     = recent.filter((r) => (r.result_r ?? 0) === 0).length;
      const totalR = recent.reduce((sum, r) => sum + (r.result_r ?? 0), 0);
      const winRate = recent.length > 0 ? Math.round((wins / recent.length) * 100) : 0;

      msg +=
        `✅ Wins: ${wins} · ❌ Losses: ${losses} · 🔄 BE: ${be}\n` +
        `📊 Trefferquote: ${winRate}%\n` +
        `💰 Gesamt: ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R\n` +
        `📋 Trades: ${recent.length}\n`;
    }

    msg += '\n_Daten aus Supabase signal\\_log_';

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[status] Error:', (e as Error).message);
    await ctx.reply('❌ Fehler beim Laden des Status.');
  }
}
