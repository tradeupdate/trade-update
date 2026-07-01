---
name: Reversal backtest fixes
description: Root causes and fixes for V75 Reversal producing 0 trades in backtests
---

# Reversal Backtest — 0 Trades Root Causes

## Root Cause 1: Broken detectDivergenceBT algorithm
The original algorithm found `priceLowIdx` (min in indices 0-8 of a 10-bar window) and then compared `lastPL < prevPL` where `prevPL = min(closes before priceLowIdx)`. Since `lastPL` IS the minimum of all prior closes, `prevPL ≥ lastPL` always — the condition could never produce divergence in a noisy instrument like R_75.

**Fix**: Rewrite to compare current bar vs prior lookback window explicitly:
- `bullish = currentClose <= priorLow * 1.002 && currentRsi > rsiAtLow + 2`
- `bearish = currentClose >= priorHigh * 0.998 && currentRsi < rsiAtHigh - 2`

## Root Cause 2: scoreThreshold defaults overridden by DB value
`admin.ts` uses `strategy.scoreThreshold ?? 8` but the DB has explicit `scoreThreshold=20` for reversal. The `??` fallback never fires when the DB value is non-null.

**Fix**: Cap it: `Math.min(strategy.scoreThreshold ?? 10, 10)` in both `/backtest/run` and stream routes.

## Root Cause 3: RSI threshold inside detectDivergenceBT
Old code had `bullish: ... && currentRsi < 35` inside the function — so even if divergence was detected, it was suppressed if RSI wasn't in oversold territory.

**Fix**: Removed RSI condition from inside detectDivergenceBT. RSI is checked separately in the main loop.

## Root Cause 4: scoreSessionExhaustionBT returns hard 0 wrong direction
When session direction didn't match trade direction, function returned 0 — starving total score.

**Fix**: Returns `Math.max(0, points - 2)` for misaligned direction instead of hard 0.

## Root Cause 5: hasBreachedBB as hard gate (2-sigma)
Required price to breach 2-sigma BB (only ~5% of bars) stacked ON TOP of divergence (already rare). Together they produced 0 qualifying bars.

**Fix**: Removed `if (!hasBreachedBB) continue;` — BB breach now only affects score via `scoreBBBT`.

## Other thresholds lowered
- SESSION_MOVE_THRESHOLD: 200→50
- MIN_STOP_PIPS: 20→10, MAX_STOP_PIPS: 80→150
- MIN_TP_PIPS: 30→10
- MIN_RR: 1.5→0.8

## Verified results (June 2026, 30 days)
- V75 Reversal: 7 trades, 3W/4L, +$48.19
- V75 Swing: 5 trades, 3W/2L, 60% WR
- V10 Range Scalper: 2 trades, 1W/1L, 50% WR
