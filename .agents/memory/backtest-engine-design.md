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
- scoreThreshold: 38 (from strategy DB)

## Feature importance

Pearson correlation of each sub-score (trend, volatility, timing, pullback, risk) vs trade outcome (+1 win, -1 loss). Computed after all trades. Needs ≥10 trades for statistical meaning.

## Measured improvement (7-day backtest)

Before: 5 trades, 40% WR, $47.50 P&L, Sharpe 1.83
After all 5 levers: 12 trades, 66.7% WR, $245.04 P&L, Sharpe 6.21
