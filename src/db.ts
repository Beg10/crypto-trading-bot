import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { User, WatchlistEntry, NewsItem } from './types';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
}

export const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// ─── Users ───────────────────────────────────────────────────────────────────────────────

export async function upsertUser(telegramId: number, username?: string): Promise<User> {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      { telegram_id: telegramId, username: username ?? null },
      { onConflict: 'telegram_id', ignoreDuplicates: false },
    )
    .select()
    .single();

  if (error) throw new Error(`DB upsertUser: ${error.message}`);
  return data as User;
}

export async function getUserByTelegramId(telegramId: number): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (error?.code === 'PGRST116') return null; // not found
  if (error) throw new Error(`DB getUserByTelegramId: ${error.message}`);
  return data as User;
}

export async function setCapital(userId: string, capital: number | null): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ capital })
    .eq('id', userId);

  if (error) throw new Error(`DB setCapital: ${error.message}`);
}

// ─── Watchlist ──────────────────────────────────────────────────────────────────────────────────

export async function addToWatchlist(userId: string, symbol: string): Promise<void> {
  const { error } = await supabase
    .from('watchlist')
    .insert({ user_id: userId, symbol: symbol.toUpperCase() });

  if (error?.code === '23505') throw new Error('DUPLICATE'); // unique violation
  if (error) throw new Error(`DB addToWatchlist: ${error.message}`);
}

export async function removeFromWatchlist(userId: string, symbol: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('watchlist')
    .delete()
    .eq('user_id', userId)
    .eq('symbol', symbol.toUpperCase())
    .select();

  if (error) throw new Error(`DB removeFromWatchlist: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function getWatchlist(userId: string): Promise<WatchlistEntry[]> {
  const { data, error } = await supabase
    .from('watchlist')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`DB getWatchlist: ${error.message}`);
  return (data ?? []) as WatchlistEntry[];
}

/** Returns all unique symbols currently watched by any user, with their user_ids */
export async function getAllWatchedSymbols(): Promise<Array<{ symbol: string; user_ids: string[] }>> {
  const { data, error } = await supabase
    .from('watchlist')
    .select('symbol, user_id');

  if (error) throw new Error(`DB getAllWatchedSymbols: ${error.message}`);

  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    const existing = map.get(row.symbol) ?? [];
    existing.push(row.user_id);
    map.set(row.symbol, existing);
  }

  return Array.from(map.entries()).map(([symbol, user_ids]) => ({ symbol, user_ids }));
}

/** Resolves user_ids -> telegram_ids for push notifications */
export async function getTelegramIdsByUserIds(userIds: string[]): Promise<number[]> {
  if (userIds.length === 0) return [];

  const { data, error } = await supabase
    .from('users')
    .select('telegram_id')
    .in('id', userIds);

  if (error) throw new Error(`DB getTelegramIdsByUserIds: ${error.message}`);
  return (data ?? []).map((r) => r.telegram_id as number);
}

/** Resolves user_ids -> { user_id, telegram_id, capital } for personalized alerts */
export async function getUsersForAlert(
  userIds: string[],
): Promise<Array<{ user_id: string; telegram_id: number; capital: number | null }>> {
  if (userIds.length === 0) return [];

  const { data, error } = await supabase
    .from('users')
    .select('id, telegram_id, capital')
    .in('id', userIds);

  if (error) throw new Error(`DB getUsersForAlert: ${error.message}`);
  return (data ?? []).map((r) => ({
    user_id: r.id as string,
    telegram_id: r.telegram_id as number,
    capital: r.capital != null ? (r.capital as number) : null,
  }));
}

// ─── News Cache ────────────────────────────────────────────────────────────────────────────────

export async function upsertNewsItems(items: NewsItem[]): Promise<void> {
  if (items.length === 0) return;

  const { error } = await supabase
    .from('news_cache')
    .upsert(items, { onConflict: 'url', ignoreDuplicates: true });

  if (error) throw new Error(`DB upsertNewsItems: ${error.message}`);
}

export async function getRecentNews(limitHours = 24): Promise<NewsItem[]> {
  const since = new Date(Date.now() - limitHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('news_cache')
    .select('*')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`DB getRecentNews: ${error.message}`);
  return (data ?? []) as NewsItem[];
}

// ─── Signal Log ───────────────────────────────────────────────────────────────────────────────

export interface SignalLogEntry {
  id: string;
  symbol: string;
  direction: string;
  entry: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number;
  take_profit3: number | null;
  take_profit4: number | null;
  risk_reward: number | null;
  signals: string[];
  ema50: number | null;
  volume_ratio: number | null;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  close_price: number | null;
  result_r: number | null;
  tp1_hit_at: string | null;
  tp2_hit_at: string | null;
  tp3_hit_at: string | null;
}

export async function logSignal(data: {
  symbol: string;
  direction: string;
  entry: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number;
  take_profit3?: number | null;
  take_profit4?: number | null;
  risk_reward: number | null;
  signals: string[];
  ema50: number | null;
  volume_ratio: number | null;
}): Promise<string> {
  const { data: row, error } = await supabase
    .from('signal_log')
    .insert(data)
    .select('id')
    .single();
  if (error) throw new Error(`DB logSignal: ${error.message}`);
  return row.id as string;
}

export async function closeSignal(
  id: string,
  closeReason: 'sl' | 'tp1' | 'tp2' | 'be',
  closePrice: number,
  resultR: number,
): Promise<void> {
  const { error } = await supabase
    .from('signal_log')
    .update({
      closed_at: new Date().toISOString(),
      close_reason: closeReason,
      close_price: closePrice,
      result_r: resultR,
    })
    .eq('id', id);
  if (error) throw new Error(`DB closeSignal: ${error.message}`);
}

export async function markTp1Hit(id: string): Promise<void> {
  const { error } = await supabase
    .from('signal_log')
    .update({ tp1_hit_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`DB markTp1Hit: ${error.message}`);
}

export async function markTp2Hit(id: string): Promise<void> {
  const { error } = await supabase
    .from('signal_log')
    .update({ tp2_hit_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`DB markTp2Hit: ${error.message}`);
}

export async function markTp3Hit(id: string): Promise<void> {
  const { error } = await supabase
    .from('signal_log')
    .update({ tp3_hit_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`DB markTp3Hit: ${error.message}`);
}

export async function getActiveSignals(): Promise<SignalLogEntry[]> {
  const { data, error } = await supabase
    .from('signal_log')
    .select('*')
    .is('closed_at', null)
    .order('opened_at', { ascending: false });
  if (error) throw new Error(`DB getActiveSignals: ${error.message}`);
  return (data ?? []) as SignalLogEntry[];
}

export async function getRecentSignals(limitDays = 30): Promise<SignalLogEntry[]> {
  const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('signal_log')
    .select('*')
    .gte('opened_at', since)
    .not('closed_at', 'is', null)
    .order('opened_at', { ascending: false });
  if (error) throw new Error(`DB getRecentSignals: ${error.message}`);
  return (data ?? []) as SignalLogEntry[];
}

export async function getDailySignals(): Promise<SignalLogEntry[]> {
  // Midnight today in Europe/Berlin timezone → UTC
  const now = new Date();
  const berlinMidnight = new Date(
    new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
      .toISOString()
      .split('T')[0] + 'T00:00:00',
  );
  // Adjust for Berlin offset (CET=+1, CEST=+2)
  const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getTime();
  const since = new Date(berlinMidnight.getTime() + offsetMs).toISOString();

  const { data, error } = await supabase
    .from('signal_log')
    .select('*')
    .gte('opened_at', since)
    .order('opened_at', { ascending: true });
  if (error) throw new Error(`DB getDailySignals: ${error.message}`);
  return (data ?? []) as SignalLogEntry[];
}

export async function getAllUsers(): Promise<Array<{ telegram_id: number }>> {
  const { data, error } = await supabase
    .from('users')
    .select('telegram_id');
  if (error) throw new Error(`DB getAllUsers: ${error.message}`);
  return (data ?? []) as Array<{ telegram_id: number }>;
}

export async function getWeeklySignals(): Promise<SignalLogEntry[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('signal_log')
    .select('*')
    .gte('opened_at', since)
    .order('opened_at', { ascending: true });
  if (error) throw new Error(`DB getWeeklySignals: ${error.message}`);
  return (data ?? []) as SignalLogEntry[];
}

/**
 * Per-symbol performance summary over the past N days, used by the auto-disable
 * loop in the worker. Only closed trades count (result_r IS NOT NULL).
 */
export interface SymbolPerformance {
  symbol: string;
  trades: number;
  rSum:   number;
  wins:   number;
  losses: number;
}

export async function getSymbolPerformance(days = 60): Promise<SymbolPerformance[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('signal_log')
    .select('symbol, result_r')
    .gte('opened_at', since)
    .not('result_r', 'is', null);

  if (error) throw new Error(`DB getSymbolPerformance: ${error.message}`);

  const map = new Map<string, SymbolPerformance>();
  for (const row of (data ?? []) as Array<{ symbol: string; result_r: number }>) {
    const cur = map.get(row.symbol) ?? { symbol: row.symbol, trades: 0, rSum: 0, wins: 0, losses: 0 };
    cur.trades += 1;
    cur.rSum   += row.result_r;
    if (row.result_r > 0) cur.wins   += 1;
    else                  cur.losses += 1;
    map.set(row.symbol, cur);
  }
  return Array.from(map.values());
}

// ─── User Positions (position tracker for /in command) ───────────────────────

export interface UserPosition {
  telegram_id: number;
  symbol: string;
  margin: number;
  leverage: number;
}

export async function getUsersInPosition(symbol: string): Promise<UserPosition[]> {
  const { data, error } = await supabase
    .from('user_positions')
    .select('telegram_id, symbol, margin, leverage')
    .eq('symbol', symbol)
    .eq('is_active', true);
  if (error) {
    console.error(`DB getUsersInPosition: ${error.message}`);
    return [];
  }
  return (data ?? []) as UserPosition[];
}


export async function closeUserPositions(symbol: string, telegramId: number): Promise<void> {
  let query = supabase
    .from('user_positions')
    .update({ is_active: false, closed_at: new Date().toISOString() })
    .eq('symbol', symbol)
    .eq('is_active', true);
  if (telegramId !== 0) query = query.eq('telegram_id', telegramId);
  const { error } = await query;
  if (error) throw new Error(`DB closeUserPositions: ${error.message}`);
}
