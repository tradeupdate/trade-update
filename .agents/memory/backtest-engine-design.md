---
name: Backtest Engine Design
description: Key decisions for the deterministic backtest engine — warmup, exit strategy, regime, scoring
---

## Critical constraints

**WARMUP must be ≥ 175** — score() requires 50+ 15m candles. At 5m granularity: 175 × 5m = 875 min ≈ 58 15m candles. Previous value of 60 caused score() to always return null.

**Score patternFound cap was removed** — old code capped score at 25 if no candle pattern, which was below the 40 threshold. Pattern is now a +3 bonus only.

## Regime detection (scoring.ts)

ADX < 18 → `regime = "RANGING"` → mean-reversion direction logic (fade BB band touches with RSI < 42 for BUY, RSI > 58 for SELL).

ADX ≥ 18 → `regime = "TRENDING"` → existing tiered ADX/RSI follow-trend logic.

**Why:** V75 alternates between trending and ranging. The original strategy only handled trending, leaving ~60% of candles unused.

## Partial exit logic (backtest-engine.ts)

Two-phase exit per trade:
1. Phase 1: Check TP1 (at `tp1Multiplier × ATR`) — hit → close 50%, book `halfPnlLocked`, move SL to entryPrice (breakeven), mark `halfClosed = true`
2. Phase 2: Check TP2 (at `tp2Multiplier × ATR`) or breakeven SL — TP2 → close remaining 50% for profit; BE SL → closePnl = 0 (capital protected)

Total trade PnL = halfPnlLocked + closePnl. Both added to tradeList at close.

**Why:** Eliminates "profits-that-turned-into-losses" scenario. After TP1 hit, worst case is breakeven.

## Config defaults

- tp1Multiplier: 2.0 (was 1.5, unused before)
- tp2Multiplier: 3.0
- stopMultiplier: 1.5
- sessionFilter: enabled, 06:00–20:00 UTC
- scoreThreshold: **16** (DB + seed + admin-route default all updated — old 38–44 caused 0 trades since max score is 25)
- maxTradesDay: **6** (updated across DB, seed, all strategies)

## Six improvement fixes (backtest-engine.ts)

1. **BE at 1.5× stop** — SL does NOT move to entry at TP1. After TP1, `beTriggered` fires when price reaches 1.5× stop distance → SL moves to entry + BUFFER_PIPS (5 pips).
2. **15m soft scoring** — C2 layer is −2 to +5 bonus, not a hard veto. Threshold is 16/25.
3. **30-min time-stop extension** — at MAX_HOLD_BARS (30min), if in profit → set `timeExtended=true`, hold to EXTENDED_HOLD_BARS (45min). If not in profit → close with proportional P&L.
4. **Trend filter** — last 3 closed 1h candles checked; if <2 aligned with trade direction → deduct 3 from score. If adjusted score < threshold, skip.
5. **5-min cooldown** — `candle.time - lastTradeExitTime < COOLDOWN_SECS (300)` blocks re-entry immediately after a close.
6. **Proportional P&L** — time-stop exits calculate `profitPips / stopDist` ratio (capped at ±fullStake) instead of flat 0.3× multiplier.

**Why:** These combine to produce realistic trade simulation: BE protects late runners, cooldown prevents overtrading, trend filter reduces counter-trend entries, proportional P&L avoids phantom win/loss inflation.

## Feature importance

Pearson correlation of each sub-score (trend, volatility, timing, pullback, risk) vs trade outcome (+1 win, -1 loss). Computed after all trades. Needs ≥10 trades for statistical meaning.

## Measured improvement (7-day backtest)

Before: 5 trades, 40% WR, $47.50 P&L, Sharpe 1.83
After all 5 levers: 12 trades, 66.7% WR, $245.04 P&L, Sharpe 6.21
