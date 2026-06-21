import { Bot } from 'grammy';
import { getDailySignals, SignalLogEntry } from '../db';

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function signalLine(s: SignalLogEntry): string {
  const dir = s.direction === 'bullish' ? 'LONG' : 'SHORT';

  if (!s.closed_at) {
    const since = Math.round((Date.now() - new Date(s.opened_at).getTime()) / 1000 / 60 / 60);
    return `🔄 *${s.symbol} ${dir}* — noch offen _(Entry: $${fmtPrice(s.entry)}, seit ${since}h)_`;
  }

  switch (s.close_reason) {
    case 'tp2':
      return `🏆 *${s.symbol} ${dir}* — Ziel 2 erreicht *(+3R = 3x Risiko als Gewinn)*`;
    case 'tp1':
      return `✅ *${s.symbol} ${dir}* — Ziel 1 erreicht *(+1.5R = 1.5x Risiko als Gewinn)*`;
    case 'sl': {
      const isBreakEven = s.result_r !== null && s.result_r === 0;
      return isBreakEven
        ? `🔄 *${s.symbol} ${dir}* — Break-Even *(SL auf Entry gezogen, kein Verlust)*`
        : `❌ *${s.symbol} ${dir}* — Stop Loss getroffen *(-1R = Risiko verloren)*`;
    }
    default:
      return `⚪ *${s.symbol} ${dir}* — geschlossen`;
  }
}

export async function buildRecapMessage(): Promise<string> {
  const signals = await getDailySignals();
  const today = fmtDate(new Date().toISOString());

  if (signals.length === 0) {
    return (
      `📊 *Tages-Recap MarketLens — ${today}*\n\n` +
      `Heute keine Signale — der Markt hat keine sauberen Setups geboten.\n\n` +
      `_Geduld ist die halbe Miete. Morgen wieder._`
    );
  }

  const closed     = signals.filter((s) => s.closed_at !== null);
  const wins       = closed.filter((s) => s.close_reason === 'tp1' || s.close_reason === 'tp2');
  const losses     = closed.filter((s) => s.close_reason === 'sl' && (s.result_r ?? -1) < 0);
  const breakEvens = closed.filter((s) => s.close_reason === 'sl' && (s.result_r ?? -1) === 0);
  const open       = signals.filter((s) => s.closed_at === null);
  const totalR     = closed.reduce((sum, s) => sum + (s.result_r ?? 0), 0);

  const lines = signals.map(signalLine).join('\n');

  // Plain-language Fazit
  let fazit = '';
  if (closed.length > 0) {
    const rStr = (totalR >= 0 ? '+' : '') + totalR.toFixed(1);
    const winCount = wins.length;
    const totalCount = closed.length;

    let resultWord = '';
    if (totalR > 1)       resultWord = 'Guter Tag.';
    else if (totalR >= 0) resultWord = 'Solider Tag.';
    else                  resultWord = 'Kein guter Tag — passiert.';

    fazit =
      `\n━━━━━━━━━━━━━━━\n` +
      `📊 *Fazit:* ${winCount} von ${totalCount} Signalen haetten getroffen` +
      `${breakEvens.length > 0 ? ` (+ ${breakEvens.length} Break-Even)` : ''}` +
      `${losses.length > 0 ? `, ${losses.length} mal daneben` : ''}.\n` +
      `💰 *Gesamt heute:* ${rStr}R _(= ${rStr}x deinen Einsatz als Gewinn/Verlust)_\n` +
      `${open.length > 0 ? `🔄 *Noch offen:* ${open.length} Trade${open.length !== 1 ? 's' : ''}\n` : ''}` +
      `\n_${resultWord} Morgen wieder._`;
  } else {
    fazit = `\n_Alle Trades noch offen — morgen mehr._\n`;
  }

  return (
    `📊 *Tages-Recap MarketLens — ${today}*\n\n` +
    `Heute ${signals.length} Signal${signals.length !== 1 ? 'e' : ''}:\n\n` +
    lines +
    fazit
  );
}

export async function sendDailyRecap(
  bot: Bot,
  channelId: string | null,
  userIds: number[],
): Promise<void> {
  console.log('[recap] Sending daily recap...');
  try {
    const message = await buildRecapMessage();

    for (const id of userIds) {
      try {
        await bot.api.sendMessage(id, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error(`[recap] Failed to send to ${id}:`, (e as Error).message);
      }
    }

    if (channelId) {
      try {
        await bot.api.sendMessage(channelId, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('[recap] Failed to send to channel:', (e as Error).message);
      }
    }

    console.log('[recap] Daily recap sent.');
  } catch (e) {
    console.error('[recap] Error building recap:', (e as Error).message);
  }
}
