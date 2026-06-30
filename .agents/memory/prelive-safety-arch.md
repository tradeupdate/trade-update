---
name: Pre-live safety architecture
description: Design of all safety systems added in PROMPT 3 — keep-alive, contract sync, rejection handler, capital preservation, hard stop, compounding, conviction sizing, pre-live UI
---

## Keep-Alive (Item 1)
- Server self-pings `GET /api/health` every 4 minutes from `index.ts` via `startKeepAlive()`
- `recordKeepAlivePing()` / `getLastKeepAlivePing()` exported from `routes/health.ts` (module-level timestamp)
- SSE heartbeat upgraded from `: ping` comment to structured `{ type: "heartbeat", timestamp }` every 30s in `routes/user.ts`
- `/api/health` returns `{ status, timestamp, uptime, botsRunning, derivConnected, version }`

## Contract Sync (Item 2)
- `botManager.syncDerivContracts(userId)` in `services/bot.ts` — live-mode only
- Called on every dashboard load (`GET /api/user/dashboard`) for live users
- Called on Deriv reconnect via `derivService.onReconnect()` listener registered in `index.ts`
- DerivService has `getOpenContracts()` — sends `{ portfolio: 1 }`, waits for `portfolio` msg type
- Marks DB trades closed (pnl=0, exitPrice=entryPrice) if Deriv has no open contracts
- Updates `usersTable.lastContractSync` timestamp after each sync

## Rejection Handler (Item 3)
- `botManager.placeOrderWithRetry(direction, stake, userId, token, state)` — 1 retry after 3s
- On all failures: pauses bot, logs to `authLogTable`, broadcasts `alert` SSE event
- `derivService.placeOrder(direction, stake, token)` — two-step: proposal request → buy
- Proposal uses 5-tick duration Rise/Fall contract on R_75

## Capital Preservation (Item 4)
- `botManager.checkCapitalPreservation(balance, currentThreshold)` — private method
- Triggers at balance ≤ $80: stake fixed at $1.00, score threshold raised to 23
- Exits at balance > $100
- Applied in both `executeTrade` (sniper/swing) and `evaluateReversalSignal` (reversal)
- `state.capitalPreservationMode: boolean` broadcasted in every SSE bot event

## Hard Stop (Item 5)
- `botManager.checkHardStop(userId, balance, peakBalance, state)` — called after every `closeTrade`
- Triggers at balance ≤ $50 OR drawdown ≥ 50% from peak
- Sets `usersTable.botHardStopped = 1`, `autoRestartAt = now + 24h`
- Broadcasts `hard_stop` SSE event with restartAt timestamp
- `botManager.checkAutoRestart()` runs on server startup + every hour from `index.ts`
- `botManager.startMicroStakeRecovery(userId)` — clears hard stop, sets `microStakeRecoveryMode = true`

## Daily Compound (Item 6)
- `botManager.scheduleDailyCompound()` called from `index.ts` at startup
- Runs for all active users with `autoCompoundEnabled = 1` at midnight UTC
- Phase risk: SEED ($0-$200) 1%, BUILDING ($200-$500) 1.5%, GROWTH ($500-$1000) 2%, PROTECTION ($1000+) 1.5%
- Stake bounds: min $1.00, max $50.00
- Updates `usersTable.stakeSize` and `dailyStartBalance`

## Conviction Sizing (Item 7)
- `botManager.calculateConvictionStake(baseStake, score, maxScore, balance)` — private
- Multipliers: ≥96% → 1.5×, ≥88% → 1.25×, ≥80% → 1.0×, ≥72% → 0.75×, else 1.0×
- Hard cap: min $1.00, max of (convictionStake, min($50, balance×2%))
- Applied after all other stake modifiers in both trade executors

## Pre-Live Check UI (Item 8)
- API: `GET /api/admin/prelive-check/:userId` in `routes/admin.ts`
- Returns array of 14 checks: 10 auto + 4 manual
- Auto checks: token, WS connection, keep-alive (lastPing < 5min), contract sync, strategy, threshold, daily loss cap, consecutive loss stop, paper trades ≥ 10, balance ≥ $100
- Frontend: `pages/admin/prelive-check.tsx`, route `/admin/prelive-check`, nav link with ShieldCheck icon
- Manual checks use toggle buttons; "READY FOR LIVE TRADING" shown only when all pass

## DB Schema Changes
- `usersTable` new columns: `botHardStopped int`, `autoRestartAt int`, `lastContractSync int`, `lastKeepAlivePing int`
- Run `pnpm --filter @workspace/db run push` after schema changes

**Why:** These safety layers prevent catastrophic loss when running with real money — each mechanism is independent so multiple can be active simultaneously.
