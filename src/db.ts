import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { User, WatchlistEntry, NewsItem } from './types';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
}

export const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// ─── Users ───────────────────────────────────────────────────────────────────

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

// ─── Watchlist ────────────────────────────────────────────────────────────────

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

/** Resolves user_ids → telegram_ids for push notifications */
export async function getTelegramIdsByUserIds(userIds: string[]): Promise<number[]> {
  if (userIds.length === 0) return [];

  const { data, error } = await supabase
    .from('users')
    .select('telegram_id')
    .in('id', userIds);

  if (error) throw new Error(`DB getTelegramIdsByUserIds: ${error.message}`);
  return (data ?? []).map((r) => r.telegram_id as number);
}

// ─── News Cache ───────────────────────────────────────────────────────────────

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
