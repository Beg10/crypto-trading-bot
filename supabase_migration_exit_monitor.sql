-- Exit Monitor: tp1_hit_at Spalte für signal_log
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS tp1_hit_at TIMESTAMPTZ;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS take_profit3 NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS take_profit4 NUMERIC;
