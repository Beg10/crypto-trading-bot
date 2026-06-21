CREATE TABLE IF NOT EXISTS signal_log (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol        text        NOT NULL,
  direction     text        NOT NULL,
  entry         numeric     NOT NULL,
  stop_loss     numeric     NOT NULL,
  take_profit1  numeric     NOT NULL,
  take_profit2  numeric     NOT NULL,
  risk_reward   numeric,
  signals       text[],
  ema50         numeric,
  volume_ratio  numeric,
  opened_at     timestamptz DEFAULT now(),
  closed_at     timestamptz,
  close_reason  text,        -- 'sl' | 'tp1' | 'tp2'
  close_price   numeric,
  result_r      numeric      -- -1 | +1.5 | +3
);

CREATE INDEX IF NOT EXISTS signal_log_symbol_idx    ON signal_log (symbol);
CREATE INDEX IF NOT EXISTS signal_log_closed_at_idx ON signal_log (closed_at);
