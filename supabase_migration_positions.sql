-- Run this in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS user_positions (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null,
  symbol       text not null,
  margin       numeric not null,
  leverage     int not null,
  opened_at    timestamptz default now(),
  is_active    boolean default true
);

CREATE INDEX IF NOT EXISTS user_positions_symbol_idx ON user_positions(symbol, is_active);
CREATE INDEX IF NOT EXISTS user_positions_telegram_idx ON user_positions(telegram_id);
