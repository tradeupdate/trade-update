---
name: V10 Precision Scalper Architecture
description: Key design decisions and parameter tuning for the precision_scalper strategy type on R_10 1m.
---

## Strategy type
`precision_scalper` — separate from `mean_reversion` (V10 Range Scalper). Do NOT modify mean_reversion.

## Critical TP decision
- TP = 50% of SL distance (NOT middle Bollinger Band as originally stated in spec)
- **Why:** V10 (Volatility 10) is a random-walk synthetic. P(TP first) = SL/(SL+TP). With TP at middle BB (2σ from entry, SL ≈ 1.875σ), win rate is ~48-50%. With TP = 0.5×SL, P = 66.7% — within the 62-70% target.
- **How to apply:** Never revert TP to middle BB. The 50% SL rule is intentional.

## Entry gate
- BB(20,2) score must be 8 (price strictly OUTSIDE the band, not just near it) before even evaluating RSI+Stoch.
- Near-band entries (BB score 2-6) generate too many marginal signals with ~50% win rate.

## Validated backtest results (June-July 2026, 30 days)
- 590 trades, 65.3% win rate, PF 1.77, P&L +$714.87, max DD 0.87%, Sharpe 4.55
- Stop/TP placement: 0 bugs confirmed

## Live bot patches vs other strategies
- Global 10-min cooldown (CHECK 10) is BYPASSED for precision_scalper; it uses its own 3-min v10PrecisionCooldownUntil.
- Consecutive-loss stop uses strategy.consecutiveLossStop (5) not profile-based (3 for "safe").
- Time stop: 25 minutes (vs 15 for V10 Range Scalper)

## Scoring thresholds
- Total score: 0-20. Threshold: 15.
- Components: BB(0-8), RSI7(0-7), Stoch(0-5).
- 5m ADX veto fires when ADX > 30 (rarely on V10 1m/5m).
