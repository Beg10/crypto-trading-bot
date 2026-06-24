/**
 * Binance Futures (USD-M Perp) data — funding rate + open interest.
 * Used as quality filters BEFORE firing a spot signal:
 *
 *   - Extreme funding against direction = trade is the "obvious" side → fade risk.
 *   - Rising OI confirms breakout; falling OI means short-squeeze / fakeout risk.
 *
 * All calls are best-effort: on error we return null so the signal is NOT blocked
 * by infrastructure issues, only by real adverse signals.
 */

import axios from 'axios';

const FAPI = 'https://fapi.binance.com';

const client = axios.create({
  baseURL: FAPI,
  timeout: 8_000,
});

/** Current funding rate of a perp (e.g. BTCUSDT). 0.0001 = 0.01% per 8h. */
export async function getFundingRate(symbol: string): Promise<number | null> {
  try {
    const res = await client.get('/fapi/v1/premiumIndex', { params: { symbol } });
    const rate = parseFloat(res.data?.lastFundingRate ?? '');
    return Number.isFinite(rate) ? rate : null;
  } catch {
    return null; // Perp may not exist (e.g. USDC pair). Don't block signal.
  }
}

/**
 * Returns Open-Interest change between the two most recent N-hour buckets.
 * Positive value = OI rising, negative = OI falling.
 *
 * @param symbol e.g. 'BTCUSDT'
 * @param period one of '5m','15m','30m','1h','2h','4h','6h','12h','1d'
 * @returns {prev, current, deltaPct}  delta in % of prev; null on error
 */
export async function getOpenInterestDelta(
  symbol: string,
  period: '1h' | '4h' = '4h',
): Promise<{ prev: number; current: number; deltaPct: number } | null> {
  try {
    const res = await client.get('/futures/data/openInterestHist', {
      params: { symbol, period, limit: 2 },
    });

    const rows = res.data as Array<{ sumOpenInterest: string }>;
    if (!rows || rows.length < 2) return null;

    const prev    = parseFloat(rows[0].sumOpenInterest);
    const current = parseFloat(rows[1].sumOpenInterest);
    if (!Number.isFinite(prev) || !Number.isFinite(current) || prev === 0) return null;

    return { prev, current, deltaPct: ((current - prev) / prev) * 100 };
  } catch {
    return null;
  }
}

// ─── Filter thresholds ────────────────────────────────────────────────────────
//
// Funding > +0.05% per 8h = strongly long-skewed → fade longs.
// Funding < -0.05% per 8h = strongly short-skewed → fade shorts.
// (Default Binance funding interval is 8h, so 0.05% ≈ 0.15%/day ≈ 55%/yr annualized.)
//
// OI delta > +3% over 4h = real breakout (new positions opened with the move).
// OI delta < -3% with price up = short squeeze (positions closing); higher fakeout risk.

export const FUNDING_EXTREME = 0.0005; // 0.05% per 8h
export const OI_BREAKOUT_PCT = 3;      // % change over the 4h window
export const OI_FADE_PCT     = -3;

/**
 * Decides whether perp data confirms or contradicts a spot signal.
 * Returns: 'confirm' | 'neutral' | 'block' + a short human-readable reason.
 */
export function evaluatePerpConfluence(
  direction: 'bullish' | 'bearish',
  funding: number | null,
  oiDeltaPct: number | null,
): { verdict: 'confirm' | 'neutral' | 'block'; reason: string } {
  const isLong = direction === 'bullish';

  // Hard block: extreme funding against direction
  if (funding !== null) {
    if (isLong  && funding >  FUNDING_EXTREME) {
      return { verdict: 'block',   reason: `Funding ${(funding * 100).toFixed(3)}% — Longs überheizt, Squeeze-Risiko` };
    }
    if (!isLong && funding < -FUNDING_EXTREME) {
      return { verdict: 'block',   reason: `Funding ${(funding * 100).toFixed(3)}% — Shorts überheizt, Squeeze-Risiko` };
    }
  }

  // OI confirmation
  if (oiDeltaPct !== null) {
    if (isLong  && oiDeltaPct >  OI_BREAKOUT_PCT) {
      return { verdict: 'confirm', reason: `OI +${oiDeltaPct.toFixed(1)}% — neue Longs öffnen mit dem Move ✅` };
    }
    if (!isLong && oiDeltaPct >  OI_BREAKOUT_PCT) {
      return { verdict: 'confirm', reason: `OI +${oiDeltaPct.toFixed(1)}% — neue Shorts öffnen mit dem Move ✅` };
    }
    if (oiDeltaPct < OI_FADE_PCT) {
      return { verdict: 'neutral', reason: `OI ${oiDeltaPct.toFixed(1)}% — Positionen schließen, kein echter Move` };
    }
  }

  return { verdict: 'neutral', reason: '' };
}
