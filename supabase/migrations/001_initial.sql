-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username    TEXT,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users (telegram_id);

-- Watchlist table
CREATE TABLE IF NOT EXISTS watchlist (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, symbol)
);

CREATE INDEX idx_watchlist_user_id ON watchlist (user_id);
CREATE INDEX idx_watchlist_symbol  ON watchlist (symbol);

-- Alerts table
CREATE TABLE IF NOT EXISTS alerts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  condition_type   TEXT NOT NULL, -- e.g. 'RSI_OVERSOLD', 'MACD_CROSS_UP', 'PATTERN_ENGULFING'
  threshold        NUMERIC,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_triggered_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_user_id ON alerts (user_id);
CREATE INDEX idx_alerts_symbol  ON alerts (symbol);

-- News cache table
CREATE TABLE IF NOT EXISTS news_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          TEXT NOT NULL,           -- 'cryptopanic' | 'newsapi'
  title           TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  sentiment       TEXT,                    -- 'bullish' | 'bearish' | 'neutral'
  impact_summary  TEXT,                    -- Claude's short analysis (macro news only)
  related_symbols TEXT[],                  -- e.g. ['BTCUSDT', 'ETHUSDT']
  published_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_news_cache_source       ON news_cache (source);
CREATE INDEX idx_news_cache_published_at ON news_cache (published_at DESC);
CREATE INDEX idx_news_cache_symbols      ON news_cache USING GIN (related_symbols);

-- Clean up news older than 48 hours automatically (optional cron via pg_cron)
-- SELECT cron.schedule('clean-news', '0 * * * *', $$DELETE FROM news_cache WHERE published_at < NOW() - INTERVAL '48 hours'$$);
