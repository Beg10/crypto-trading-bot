// scripts/export-stats.js
// Fetches signal_log from Supabase and writes website/data/stats.json
// Run by GitHub Action every hour

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

function fetchJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  // Fetch last 90 days of signals
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/signal_log?opened_at=gte.${since}&order=opened_at.desc&limit=500`;

  let signals;
  try {
    signals = await fetchJSON(url, headers);
  } catch(e) {
    console.error('Failed to fetch signals:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(signals)) {
    console.error('Unexpected response:', signals);
    process.exit(1);
  }

  const closed = signals.filter(s => s.closed_at !== null);
  const active = signals.filter(s => s.closed_at === null);

  const wins      = closed.filter(s => s.close_reason === 'tp1' || s.close_reason === 'tp2');
  const losses    = closed.filter(s => s.close_reason === 'sl' && (s.result_r ?? -1) < 0);
  const breakEvens= closed.filter(s => s.close_reason === 'sl' && (s.result_r ?? -1) === 0);
  const totalR    = closed.reduce((sum, s) => sum + (s.result_r ?? 0), 0);
  const winRate   = closed.length > 0 ? (wins.length / closed.length * 100) : 0;
  const avgR      = closed.length > 0 ? totalR / closed.length : 0;

  // Per-coin stats (winRate as percentage)
  const coinMap = {};
  for (const s of closed) {
    if (!coinMap[s.symbol]) coinMap[s.symbol] = { symbol: s.symbol, trades: 0, wins: 0, totalR: 0 };
    coinMap[s.symbol].trades++;
    if (s.close_reason === 'tp1' || s.close_reason === 'tp2') coinMap[s.symbol].wins++;
    coinMap[s.symbol].totalR += (s.result_r ?? 0);
  }
  const coinStats = Object.values(coinMap).map(c => ({
    symbol:   c.symbol,
    trades:   c.trades,
    wins:     c.wins,
    winRate:  c.trades > 0 ? Math.round(c.wins / c.trades * 1000) / 10 : 0,
    totalR:   Math.round(c.totalR * 100) / 100,
  })).sort((a, b) => b.totalR - a.totalR);

  // Recent 15 signals for feed (all, not just closed)
  // Map field names to match what website/index.html reads
  const recentSignals = signals.slice(0, 15).map(s => ({
    symbol:     s.symbol,
    direction:  s.direction,
    entry:      s.entry,
    status:     s.closed_at === null ? 'open' : s.close_reason,
    result_r:   s.result_r,
    created_at: s.opened_at,
    closed_at:  s.closed_at,
  }));

  // Monthly breakdown (last 3 months)
  const monthMap = {};
  for (const s of closed) {
    const m = (s.opened_at || '').slice(0, 7);
    if (!m) continue;
    if (!monthMap[m]) monthMap[m] = { month: m, trades: 0, wins: 0, totalR: 0 };
    monthMap[m].trades++;
    if (s.close_reason === 'tp1' || s.close_reason === 'tp2') monthMap[m].wins++;
    monthMap[m].totalR += (s.result_r ?? 0);
  }
  const monthlyStats = Object.values(monthMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-3)
    .map(m => ({ ...m, totalR: Math.round(m.totalR * 100) / 100 }));

  // Flat structure — matches what website/index.html reads directly off `data.*`
  const output = {
    exportedAt:  new Date().toISOString(),
    totalTrades: closed.length,
    wins:        wins.length,
    losses:      losses.length,
    breakEvens:  breakEvens.length,
    openTrades:  active.length,
    winRate:     Math.round(winRate * 10) / 10,
    totalR:      Math.round(totalR * 100) / 100,
    avgR:        Math.round(avgR * 100) / 100,
    recentSignals,
    coinStats,
    monthlyStats,
  };

  const outDir = path.join(__dirname, '..', 'website', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(output, null, 2));
  console.log(`Stats exported: ${closed.length} closed trades, ${active.length} open, WR: ${winRate.toFixed(1)}%, Total R: ${totalR.toFixed(2)}`);
}

main();
