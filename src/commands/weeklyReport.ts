import { Bot } from 'grammy';
import { getWeeklySignals, SignalLogEntry } from '../db';

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function getKW(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

function signalLine(s: SignalLogEntry): string {
  const dir = s.direction === 'bullish' ? 'LONG' : 'SHORT';
  const day = new Date(s.opened_at).toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit',
  });

  if (!s.closed_at) {
    return `🔄 *${s.symbol} ${dir}* _(${day}, noch offen, Entry: $${fmtPrice(s.entry)})_`;
  }
  switch (s.close_reason) {
    case 'tp2': return `🏆 *${s.symbol} ${dir}* — Ziel 2 erreicht *+3R* _(${day})_`;
    case 'tp1': return `✅ *${s.symbol} ${dir}* — Ziel 1 erreicht *+1.5R* _(${day})_`;
    case 'sl': {
      const be = s.result_r !== null && s.result_r === 0;
      return be
        ? `🔄 *${s.symbol} ${dir}* — Break-Even *+/-0R* _(${day})_`
        : `❌ *${s.symbol} ${dir}* — Stop Loss *-1R* _(${day})_`;
    }
    default: return `⚪ *${s.symbol} ${dir}* _(${day})_`;
  }
}

export async function buildWeeklyReportMessage(): Promise<string> {
  const signals = await getWeeklySignals();
  const kw = getKW();

  if (signals.length === 0) {
    return (
      `📈 *Wochen-Report MarketLens — KW ${kw}*\n\n` +
      `Diese Woche keine Signale — der Markt war zu unruhig fuer saubere Setups.\n\n` +
      `_Naechste Woche wieder. Geduld zahlt sich aus._`
    );
  }

  const closed     = signals.filter((s) => s.closed_at !== null);
  const wins       = closed.filter((s) => s.close_reason === 'tp1' || s.close_reason === 'tp2');
  const losses     = closed.filter((s) => s.close_reason === 'sl' && (s.result_r ?? -1) < 0);
  const breakEvens = closed.filter((s) => s.close_reason === 'sl' && (s.result_r ?? -1) === 0);
  const open       = signals.filter((s) => s.closed_at === null);
  const totalR     = closed.reduce((sum, s) => sum + (s.result_r ?? 0), 0);
  const winRate    = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : null;

  const lines = signals.map(signalLine).join('\n');

  // Best trade of the week
  const bestTrade = closed
    .filter((s) => s.result_r !== null)
    .sort((a, b) => (b.result_r ?? 0) - (a.result_r ?? 0))[0];

  const bestLine = bestTrade && bestTrade.result_r && bestTrade.result_r > 0
    ? `\n⭐ *Bester Trade:* ${bestTrade.symbol} ${bestTrade.direction === 'bullish' ? 'LONG' : 'SHORT'} (+${bestTrade.result_r}R)\n`
    : '';

  let fazit = '';
  if (closed.length > 0) {
    const rStr = (totalR >= 0 ? '+' : '') + totalR.toFixed(1);
    let bewertung = '';
    if (winRate !== null && winRate >= 70)    bewertung = 'Starke Woche.';
    else if (winRate !== null && winRate >= 50) bewertung = 'Solide Woche.';
    else                                       bewertung = 'Schwierige Woche — der Markt war gegen uns.';

    fazit =
      `\n━━━━━━━━━━━━━━━\n` +
      `📊 *Wochenfazit:*\n` +
      `${wins.length} von ${closed.length} Signalen haetten getroffen` +
      `${breakEvens.length > 0 ? ` (+ ${breakEvens.length} Break-Even)` : ''}` +
      `${losses.length > 0 ? `, ${losses.length} mal daneben` : ''}.\n` +
      `${winRate !== null ? `🏆 *Trefferquote:* ${winRate}%\n` : ''}` +
      `💰 *Gesamtergebnis:* ${rStr}R _(= ${rStr}x Einsatz als Gewinn/Verlust)_\n` +
      `${open.length > 0 ? `🔄 *Noch offen:* ${open.length} Trade${open.length !== 1 ? 's' : ''}\n` : ''}` +
      bestLine +
      `\n_${bewertung} Bis naechsten Sonntag._`;
  } else {
    fazit = `\n_Alle Trades noch offen — kein abschliessender Wert._\n`;
  }

  return (
    `📈 *Wochen-Report MarketLens — KW ${kw}*\n\n` +
    `Diese Woche ${signals.length} Signal${signals.length !== 1 ? 'e' : ''} auf ${new Set(signals.map(s => s.symbol)).size} Coins:\n\n` +
    lines +
    fazit
  );
}

export async function sendWeeklyReport(
  bot: Bot,
  channelId: string | null,
  userIds: number[],
): Promise<void> {
  console.log('[weekly] Sending weekly report...');
  try {
    const message = await buildWeeklyReportMessage();
    for (const id of userIds) {
      try {
        await bot.api.sendMessage(id, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error(`[weekly] Failed to send to ${id}:`, (e as Error).message);
      }
    }
    if (channelId) {
      try {
        await bot.api.sendMessage(channelId, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('[weekly] Channel send failed:', (e as Error).message);
      }
    }
    console.log('[weekly] Weekly report sent.');
  } catch (e) {
    console.error('[weekly] Error:', (e as Error).message);
  }
}
