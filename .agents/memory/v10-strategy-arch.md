---
name: V10 Range Scalper architecture
description: Multi-pair V10 mean-reversion strategy — key design decisions for deriv.ts, bot.ts, scoring-v10.ts, DB schema
---

## V10 Strategy — architectural decisions

### Multi-pair Deriv service
- R_75 uses req_ids 1/5/15/60 for 1m/5m/15m/1h; R_10 uses 101/105/115/160
- Both pairs subscribed simultaneously on startup — separate candle stores in DerivService
- Tick routing done by `tick.symbol` field in the `tick` message
- Added `getCandlesForPair(pair, tf, count)` and `getLatestTickForPair(pair)` public API
- Payout rate: `fetchPayoutRate(pair, stake)` uses req_ids ≥1000 (separate from trading proposals which use "pending" key)
- PRICE_BOUNDS: R_75={20000–80000}, R_10={3000–20000} for sanity checking incoming ticks

### Bot routing
- Strategy type `"mean_reversion"` → `evaluateV10Signal()` method (after reversal routing, before sniper)
- V10-specific 3-minute cooldown (in BotState.v10CooldownUntil) — separate from global 10-min cooldown
- V10 trades marked with `v10Trade: true` on OpenTrade — V10 monitoring branch in monitorOpenTrades
- V10 time stop: 15 minutes (vs 20 min for reversal)
- No break-even, no partial close for V10 — single TP at middle Bollinger Band

### V10 scoring engine (scoring-v10.ts)
- C1: Range Cleanliness (0-10) — 30 candle lookback, respects BB upper/lower touches
- C2: BB extreme + RSI + Stochastic confluence (0-10) — uses 20-period BB, 14-period RSI, 5/3 Stoch
- C3: Rejection confirmation on 1m (0-5) — wick ratio analysis
- Total threshold: 18/25
- Trend filter: ADX > 25 OR 8+/10 directional candles → blocks mean reversion entries

### DB schema additions
- `strategies.pair` TEXT DEFAULT 'R_75' — which index this strategy trades
- `strategies.consecutiveLossStop` INTEGER — was seeded but missing from schema
- `users.activePair` TEXT DEFAULT 'R_75' — user's current trading pair

### Pair switch API
- `PATCH /api/user/settings/pair` — validates no open trade, pauses bot via botManager.pauseBot()
- `activePair` included in dashboard endpoint response alongside `demoMode`, `stakeSize`, `maxDailyLoss`

### Seeded credentials
- v10test100 / V10Test100! — $5000 paper, safe profile, V10 Range Scalper strategy, activePair=R_10
**Why:** V10 is a completely different market (lower volatility, smaller pip values ~3000–20000) requiring its own price validation bounds, separate candle stores, and different scoring logic from V75.
