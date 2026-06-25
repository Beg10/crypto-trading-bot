/**
 * News-pause filter — blocks new trade entries during high-impact macro windows.
 *
 * Trades opened into FOMC / CPI / NFP / rate-decision candles routinely take
 * 3–5R losses because price moves 2–5% on a single 5-minute candle, blowing
 * through tight technical SLs. Better to skip the entry entirely.
 *
 * We read the existing news_cache (populated by news.ts) and look for
 * high-impact keywords in the title. The pause window is ±2h around the
 * news event's published_at.
 */

import { getRecentNews } from '../db';

// Keywords that signal a macro event capable of moving crypto >2% in minutes.
const HIGH_IMPACT_PATTERNS = [
  /\bFOMC\b/i,
  /\bFed\b.*\b(rate|decision|meeting|hike|cut|pause)\b/i,
  /\b(rate|interest)\s+(decision|hike|cut)\b/i,
  /\bCPI\b/i,
  /\binflation\s+(data|report|reading)\b/i,
  /\bNFP\b/i,
  /\bnon[- ]?farm\s+payroll/i,
  /\bjobs?\s+report\b/i,
  /\bPPI\b/i,
  /\bPCE\b/i,
  /\bPowell\s+(speaks|speech|testimony)/i,
  /\bECB\b.*\b(rate|decision)\b/i,
];

const PAUSE_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2h

let cache: { until: number; events: string[] } = { until: 0, events: [] };
const CACHE_TTL_MS = 10 * 60 * 1000; // refresh once every 10 min

interface PauseStatus {
  paused: boolean;
  reason: string;
}

/**
 * Returns whether a new entry should be paused right now, plus a short reason
 * suitable for logging / admin notification.
 */
export async function checkNewsPause(): Promise<PauseStatus> {
  // Cheap memoize: news_cache only refreshes every ~15min, no need to query
  // Supabase every signal evaluation.
  const now = Date.now();
  if (now < cache.until) {
    return matchesNow(now);
  }

  try {
    const news = await getRecentNews(48); // pull last 48h
    cache = {
      until: now + CACHE_TTL_MS,
      events: news
        .filter((n) => HIGH_IMPACT_PATTERNS.some((p) => p.test(n.title)))
        .map((n) => `${n.published_at}|${n.title}`),
    };
  } catch {
    return { paused: false, reason: '' };
  }

  return matchesNow(now);
}

function matchesNow(now: number): PauseStatus {
  for (const entry of cache.events) {
    const [iso, title] = entry.split('|');
    const t = new Date(iso).getTime();
    if (Math.abs(now - t) < PAUSE_WINDOW_MS) {
      const minutesAway = Math.round((t - now) / 60_000);
      const when = minutesAway > 0
        ? `in ${minutesAway} min`
        : `vor ${Math.abs(minutesAway)} min`;
      return { paused: true, reason: `Macro-Event "${title.slice(0, 60)}" ${when}` };
    }
  }
  return { paused: false, reason: '' };
}
