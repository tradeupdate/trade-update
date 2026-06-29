---
name: Swing strategy architecture
description: Key decisions for the V75 Swing strategy — scoring engine, backtest engine, live bot routing, and type constraints.
---

## Scoring engine (swing-scoring.ts)
- `Candle` type from deriv.ts requires a `volume` field — `build4hCandles` must include `volume: sorted.reduce(...)`.
- 4h candles built from 1h via 14400-second boundary: `Math.floor(time / 14400) * 14400`.
- Scoring: C1=4h trend (0-10, HARD FILTER — returns 0 if misaligned, no partial score), C2=1h momentum (0-10), C3=breakout quality (0-5). Max 25, threshold 20.
- All scoring sub-functions are exported as `score4hTrendBT`, `score1hMomentumBT`, `scoreBreakoutQualityBT` (shared with backtest engine).

## Backtest engine (swing-backtest-engine.ts)
- Independent engine — does NOT extend sniper engine. Reuses same 5m candle cache format.
- Main loop iterates on 1h candles (not 5m). WARMUP_1H = 200 (ensures 50 4h candles for EMA50).
- State machine: detect consolidation → breakout → retest → Stage 1 entry → (Stage 2 auto-added).
- Stops: 80-350 pip range; range.low - 10% rangeSize (BUY) / range.high + 10% (SELL).
- 6h max hold (6 1h bars), BE at 1.5× stop, TP1 at 2× stop (50% close), TP2 at 4× stop.
- Session-end protection (15:00 UTC and 10:00 UTC): close if profit < 1× stop, move BE if >= 1×.

## Live bot (bot.ts)
- BotState extended with: `swingConsolidation`, `swingBreakout`, `swingLastEval1hTime`.
- OpenTrade extended with optional fields: `swingTrade`, `stopDistance`, `retestLevel`, `rangeHigh`, `rangeLow`, `stage2Added`, `stage1Stake`.
- Routing: `if (strategy.type === 'swing') return evaluateSwingSignal(...)` before sniper scoring.
- Blackout zones: 06:45-07:15 UTC and 12:45-13:15 UTC — checked via `isSwingBlackout()`.
- Swing trade monitoring in `monitorOpenTrades` uses `trade.swingTrade` flag.

## Admin backtest route (admin.ts)
- Checks `strategy.type === 'swing'` to route to `runSwingBacktest`.
- Missing fields (featureImportance, regimeStats, scoreHistogram) are returned as null for swing.

## Schema note
- `consecutiveLossStop` does NOT exist in strategies schema — backtest configs use `?? 2` (swing) / `?? 3` (sniper) as fallback. Works correctly.
- strategies table does NOT have a unique constraint on `name`, only on `id` (primary key). Each seed run creates new strategy rows.

**Why:** The swing strategy is fundamentally different from the sniper — longer hold times, wider stops, 4h trend requirement, consolidation state machine. Kept as completely separate engines to avoid breaking existing sniper logic.
