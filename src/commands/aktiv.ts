import { getActiveSignals } from '../db';

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function pct(from: number, to: number): string {
  const p = ((to - from) / from) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

export async function buildAktivMessage(): Promise<string> {
  const active = await getActiveSignals();

  if (active.length === 0) {
    return '⏳ *Aktive Trades*\n\n_Aktuell keine offenen Positionen._';
  }

  const lines = active.map(s => {
    const sym  = s.symbol.replace(/USDT$/, '');
    const dir  = s.direction === 'bullish' ? '📈 LONG' : '📉 SHORT';
    const since = Math.round((Date.now() - new Date(s.opened_at).getTime()) / 36e5);
    const sl1Pct = pct(s.entry, s.stop_loss);
    const tp1Pct = pct(s.entry, s.take_profit1);
    const tp2Pct = pct(s.entry, s.take_profit2);

    return (
      `${dir} *${sym}*\n` +
      `  📍 Entry: $${fmt(s.entry)}\n` +
      `  🛑 SL: $${fmt(s.stop_loss)} _(${sl1Pct})_\n` +
      `  🎯 TP1: $${fmt(s.take_profit1)} _(${tp1Pct})_\n` +
      `  🏆 TP2: $${fmt(s.take_profit2)} _(${tp2Pct})_\n` +
      `  ⏱ Offen seit: ${since}h`
    );
  });

  return (
    `⚡ *Aktive Trades (${active.length})*\n\n` +
    lines.join('\n\n─────────────────────\n\n') +
    `\n\n_Daten aus Supabase · nach Bot-Restart wieder aktiv_`
  );
}
