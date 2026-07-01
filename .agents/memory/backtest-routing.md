---
name: Backtest routing and engines
description: Which strategy type routes to which backtest engine, V10 binary payout model, swing simplified signal, and cache key normalization requirement.
---

## Strategy type → backtest engine routing (admin.ts)

| type | engine |
|------|--------|
| `swing` | `runSwingBacktest` (swing-backtest-engine.ts) |
| `reversal` | `runReversalBacktest` (reversal-backtest-engine.ts) |
| `mean_reversion` | `runV10Backtest` (v10-backtest-engine.ts) |
| all other | `runDeterministicBacktest` (backtest-engine.ts) — V75 Sniper |

**Why:** V10 Range Scalper (`type: "mean_reversion"`) was previously falling through to `runDeterministicBacktest` which hardcodes `SYMBOL = "R_75"` and uses `score()` (V75 scorer). It must use `runV10Backtest` which fetches R_10 data and uses `scoreV10()`.

## V10 backtest model

- File: `artifacts/api-server/src/services/v10-backtest-engine.ts`
- Symbol: `R_10` (not R_75)
- Scorer: `scoreV10()` from `scoring-v10.ts`
- P&L model: **binary options** — `PAYOUT_RATE = 0.87`
  - TP hit → `stake * 0.87`
  - SL hit → `-stake`
  - Time stop → `stake * 0.87 * 0.5` if profitable, `-stake * 0.5` if not
- Time stop: 24 × 5m bars (2 hours) — V10 is short-duration mean reversion
- WARMUP: 50 5m candles
- 1m proxy: passes last 5m candle (with `volume: 0`) as 1m candle array to scoreV10

**Candle type requirement:** When mapping raw candles to `Candle[]` for scoreV10, must include `volume: 0` — the `Candle` type requires it.

## Swing backtest signal (simplified)

- File: `artifacts/api-server/src/services/swing-backtest-engine.ts`
- Previous approach: consolidation → breakout → retest (rarely triggered, 0 trades)
- Current approach: EMA trend + RSI pullback on 5m loop
  - 4h EMA20 > EMA50 → bull trend
  - 1h EMA9 > EMA21 → bull momentum
  - 5m price within 0.5% of EMA21 (nearEMA)
  - RSI 30–55 for BUY, RSI 45–70 for SELL
- ATR-based stop: `Math.max(80, atr * 2)`, TP1 = `2× stop`, TP2 = `3× stop`
- Loop: 5m candles with WARMUP=200, time stop 72 bars (6h)
- P&L: TP2 = `stake * 0.5 * 0.85 * tp2Multi`, SL = `-stake`, time stop ±0.4× stake

## Cache key normalization

All three backtest engines must normalize dates to UTC midnight to produce identical keys for the same date range:

```typescript
function normalizeMidnightUTC(unix: number): number {
  const d = new Date(unix * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
// key: `${SYMBOL}_5m_${normalizeMidnightUTC(from)}_${normalizeMidnightUTC(to)}`
```

**Why:** Without normalization, the Sniper (backtest-engine.ts) produced a different key than Swing/Reversal for the same user-selected dates, causing "data mismatch" warnings in the UI.

## Admin route result type union

The `result` variable in `/backtest/run` must include V10 in the union type:
```typescript
let result: Awaited<ReturnType<typeof runDeterministicBacktest>>
  | Awaited<ReturnType<typeof runSwingBacktest>>
  | Awaited<ReturnType<typeof runReversalBacktest>>
  | Awaited<ReturnType<typeof runV10Backtest>>;
```

`featureImportance`/`regimeStats`/`scoreHistogram` only exist on `BacktestRunResult` (Sniper). Use `isSniperOnly` flag (not `isSwing`) to guard the cast. `partialExitStats` is missing from `ReversalBacktestResult` — access via `(result as SwingBacktestResult).partialExitStats ?? null`.
