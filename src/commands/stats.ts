import { getRecentSignals, getActiveSignals } from '../db';

function fmtR(r: number): string {
  return (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
}

export async function buildStatsMessage(days = 30): Promise<string> {
  const [closed, active] = await Promise.all([
    getRecentSignals(days),
    getActiveSignals(),
  ]);

  if (closed.length === 0 && active.length === 0) {
    return '📊 *Performance Stats*\n\n_Noch keine Trades in der Datenbank._';
  }

  // Overall stats
  const wins      = closed.filter(s => s.close_reason === 'tp1' || s.close_reason === 'tp2');
  const losses    = closed.filter(s => s.close_reason === 'sl' && (s.result_r ?? -1) < 0);
  const breakEvens= closed.filter(s => s.close_reason === 'sl' && (s.result_r ?? 0) === 0);
  const totalR    = closed.reduce((sum, s) => sum + (s.result_r ?? 0), 0);
  const winRate   = closed.length > 0 ? (wins.length / closed.length * 100) : 0;
  const avgR      = closed.length > 0 ? totalR / closed.length : 0;

  const wrEmoji   = winRate >= 55 ? '🟢' : winRate >= 40 ? '🟡' : '🔴';
  const rEmoji    = totalR >= 0 ? '🟢' : '🔴';

  // Per-coin breakdown
  const coinMap = new Map<string, { trades: number; wins: number; totalR: number }>();
  for (const s of closed) {
    const sym = s.symbol.replace(/USDT$/, '');
    if (!coinMap.has(sym)) coinMap.set(sym, { trades: 0, wins: 0, totalR: 0 });
    const c = coinMap.get(sym)!;
    c.trades++;
    if (s.close_reason === 'tp1' || s.close_reason === 'tp2') c.wins++;
    c.totalR += (s.result_r ?? 0);
  }
  const coinRows = [...coinMap.entries()]
    .sort((a, b) => b[1].totalR - a[1].totalR)
    .map(([sym, c]) => {
      const wr  = Math.round(c.wins / c.trades * 100);
      const r   = fmtR(c.totalR);
      const dot = c.totalR >= 0 ? '🟢' : '🔴';
      return `  ${dot} *${sym}* — ${r} (${wr}% WR, ${c.trades} Trades)`;
    })
    .join('\n');

  // Active trades
  const activeLines = active.length > 0
    ? active.map(s => {
        const sym = s.symbol.replace(/USDT$/, '');
        const dir = s.direction === 'bullish' ? '📈 LONG' : '📉 SHORT';
        const since = Math.round((Date.now() - new Date(s.opened_at).getTime()) / 36e5);
        return `  • ${dir} ${sym} — seit ${since}h offen`;
      }).join('\n')
    : '  _Keine offenen Trades_';

  // Last 5 closed trades
  const last5 = closed.slice(0, 5).map(s => {
    const sym    = s.symbol.replace(/USDT$/, '');
    const r      = s.result_r != null ? fmtR(s.result_r) : '?';
    const dot    = (s.result_r ?? -1) > 0 ? '✅' : (s.result_r ?? -1) === 0 ? '🔄' : '❌';
    const reason = s.close_reason === 'tp2' ? 'TP2' : s.close_reason === 'tp1' ? 'TP1' : 'SL';
    return `  ${dot} ${sym} ${reason} ${r}`;
  }).join('\n');

  return (
    `📊 *Performance Stats — letzte ${days} Tage*\n\n` +
    `${wrEmoji} *Win Rate:* ${winRate.toFixed(1)}%  _(${wins.length}W / ${losses.length}L / ${breakEvens.length}BE)_\n` +
    `${rEmoji} *Total R:* ${fmtR(totalR)}\n` +
    `📈 *Avg R/Trade:* ${fmtR(avgR)}\n` +
    `🔢 *Trades gesamt:* ${closed.length}\n\n` +
    `─────────────────────\n` +
    `🏆 *Coin Ranking:*\n${coinRows || '  _Noch keine Daten_'}\n\n` +
    `─────────────────────\n` +
    `⚡ *Offene Trades (${active.length}):*\n${activeLines}\n\n` +
    `─────────────────────\n` +
    `📋 *Letzte Trades:*\n${last5 || '  _Noch keine_'}\n\n` +
    `_Daten aus Supabase · EMA Cross Strategie_`
  );
}
