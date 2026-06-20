# Crypto Trading Assistant — Telegram Bot

A Telegram bot that monitors coins on your personal watchlist, runs technical analysis (RSI, MACD, Bollinger Bands, candlestick patterns) and fires push alerts when signals align. Combines CryptoPanic crypto news with macro news (Trump, Fed, etc.) evaluated by Claude AI.

---

## Stack

| Layer | Tech |
|---|---|
| Bot framework | [grammY](https://grammy.dev) |
| Database | [Supabase](https://supabase.com) (Postgres) |
| Market data | [Binance REST API](https://binance-docs.github.io/apidocs/) |
| Market overview | [CoinGecko API](https://www.coingecko.com/en/api) |
| Crypto news | [CryptoPanic API](https://cryptopanic.com/developers/api/) |
| Macro news | [NewsAPI.org](https://newsapi.org) |
| AI analysis | [Anthropic Claude](https://anthropic.com) (claude-haiku) |
| Technical indicators | [technicalindicators](https://github.com/anandanand84/technicalindicators) |

---

## Setup

### 1. Clone & install

```bash
git clone <repo>
cd crypto-trading-bot
pnpm install
```

### 2. Environment variables

```bash
cp .env.example .env
```

Fill in all values in `.env`:

| Variable | Where to get it |
|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/botfather) on Telegram |
| `SUPABASE_URL` | Supabase project → Settings → API |
| `SUPABASE_KEY` | Supabase project → Settings → API → `service_role` key |
| `BINANCE_API_KEY` | Binance → Account → API Management (optional) |
| `COINGECKO_API_KEY` | [CoinGecko](https://www.coingecko.com/en/api/pricing) (optional free tier) |
| `CRYPTOPANIC_KEY` | [CryptoPanic](https://cryptopanic.com/developers/api/) |
| `NEWSAPI_KEY` | [NewsAPI.org](https://newsapi.org/register) |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com) |

### 3. Apply database migrations

In the Supabase dashboard → SQL Editor, run:

```sql
-- contents of supabase/migrations/001_initial.sql
```

Or with Supabase CLI:

```bash
supabase db push
```

### 4. Build

```bash
pnpm build
```

### 5. Run

The bot and worker run as **two separate processes**. You need both running.

```bash
# Terminal 1 — Telegram bot
pnpm start

# Terminal 2 — Background worker (analysis + news)
pnpm worker
```

For development with hot reload:

```bash
# Terminal 1
pnpm dev

# Terminal 2
pnpm dev:worker
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Register and get welcome message |
| `/watch BTCUSDT` | Add a Binance symbol to your watchlist |
| `/unwatch BTCUSDT` | Remove from watchlist |
| `/list` | Show watchlist with current prices |
| `/news` | Latest crypto + macro news with sentiment |
| `/market` | Top 10 coins by market cap |

---

## How Alerts Work

The worker runs every 5 minutes (configurable via `WORKER_INTERVAL_MINUTES`):

1. Fetches 100× 1h candles per watched symbol from Binance
2. Calculates RSI (14), MACD (12/26/9), Bollinger Bands (20, 2σ)
3. Detects candlestick patterns: Doji, Hammer, Shooting Star, Bullish/Bearish Engulfing, Marubozu, Morning Star
4. Fires alert only when **≥ 2 confirming signals align** (reduces noise)
5. Per-symbol cooldown of 1 hour prevents spam

Example alert:
```
⚡ Signal Alert — BTCUSDT

🟢 BULLISH confluence detected
Price: $42,150.00

Signals:
  • RSI Oversold (27.3)
  • Below Lower Bollinger Band
  • Bullish Engulfing
```

---

## News Pipeline

Runs every 5 minutes alongside analysis:

- **CryptoPanic**: fetches hot English-language crypto news, derives sentiment from vote counts
- **NewsAPI + Claude**: fetches macro headlines matching crypto-relevant keywords (Trump, Fed, inflation, SEC…), passes each to `claude-haiku` for relevance check + bullish/bearish classification + 1-2 sentence impact summary
- All articles stored in `news_cache` table; `/news` command reads from cache (no live API call)

---

## Production Deployment

Recommended: two separate processes on a VPS or Railway/Render.

```bash
# Process 1
node dist/bot.js

# Process 2
node dist/worker.js
```

Or use PM2:

```bash
pm2 start dist/bot.js --name crypto-bot
pm2 start dist/worker.js --name crypto-worker
pm2 save
```

---

## Project Structure

```
src/
├── bot.ts          — Bot entry point, command registration
├── worker.ts       — Background analysis & news loop
├── db.ts           — Supabase queries
├── types.ts        — Shared TypeScript types
├── commands/
│   ├── start.ts
│   ├── watch.ts
│   ├── unwatch.ts
│   ├── list.ts
│   ├── news.ts
│   └── market.ts
└── services/
    ├── binance.ts      — Candles, price, symbol validation
    ├── coingecko.ts    — Market overview
    ├── cryptopanic.ts  — Crypto news + sentiment
    ├── news.ts         — Macro news + Claude analysis
    └── analysis.ts     — RSI, MACD, Bollinger, patterns, signal scoring
supabase/
└── migrations/
    └── 001_initial.sql
```
