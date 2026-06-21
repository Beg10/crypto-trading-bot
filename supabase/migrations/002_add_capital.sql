-- Migration 002: add capital column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS capital NUMERIC;
