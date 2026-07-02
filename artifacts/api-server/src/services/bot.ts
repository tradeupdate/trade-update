import { db } from "@workspace/db";
import {
  usersTable, tradesTable, signalLogTable, strategiesTable,
  adaptiveWeightsTable, sessionPerformanceTable, systemSettingsTable,
  botActivityLogTable, systemErrorLogTable, botInstancesTable, authLogTable
} from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { derivService, placePrecisionLiveContract, fetchDerivBalance } from "./deriv.js";
import type { DerivContract, PrecisionSettlementResult } from "./deriv.js";
import { decrypt } from "../lib/crypto.js";
import { score, type ScoreResult } from "./scoring.js";
import { scoreV10, detectRangeCleanliness, detectV10TrendRisk } from "./scoring-v10.js";
import { scoreV10Precision } from "./v10-precision-scoring.js";
import {
  detectConsolidationRange, detectBreakout, scoreSwing, build4hCandles,
  type ConsolidationRange, type BreakoutResult,
} from "./swing-scoring.js";
import { scoreReversal, type ReversalScoreResult } from "./reversal-scoring.js";
import { getCurrentSession, getNextSession, isInSession, SESSIONS } from "./sessions.js";
import { logger } from "../lib/logger.js";

export interface BotState {
  isRunning: boolean;
  killSwitchActive: boolean;
  tradingMode: string;
  todayTrades: number;
  thisHourTrades: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  dailyPnl: number;
  dailyStartBalance: number;
  peakBalance: number;
  currentDrawdown: number;
  recoveryModeActive: boolean;
  winStreakCautionActive: boolean;
  dailyLossHit: boolean;
  sessionMultiplier: number;
  adaptiveWeightsActive: boolean;
  pauseReason: string | null;
  lastSignalScore: number | null;
  lastSignalDirection: string | null;
  currentScore: number | null;
  openTrade: OpenTrade | null;
  rangeContext: string | null;
  spikeDetected: boolean;
  consolidationDetected: boolean;
  firstCandleWaiting: boolean;
  strategyCircuitBreakerActive: boolean;
  cooldownSecondsRemaining: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  lastScoreResult: ScoreResult | null;
  lastTradeTime: number | null;
  spikeWaitCandles: number;
  hourlyTradeReset: number;
  // Swing-specific state
  swingConsolidation: ConsolidationRange | null;
  swingBreakout: BreakoutResult | null;
  swingLastEval1hTime: number;
  // Reversal-specific state
  reversalCooldownUntil: number | null;
  // V10 mean-reversion state
  v10CooldownUntil: number | null;
  v10CleanlinessScore: number | null;
  v10TrendRisk: boolean;
  v10Adx: number | null;
  // V10 Precision Scalper state
  v10PrecisionCooldownUntil: number | null;
  // Risk management state
  capitalPreservationMode: boolean;
  hardStopped: boolean;
  microStakeRecoveryMode: boolean;
}

interface OpenTrade {
  id: string;
  direction: string;
  entryPrice: number;
  currentPrice: number;
  stake: number;
  pnl: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  breakEvenMoved: boolean;
  partialClosed: boolean;
  momentumExtensionActive: boolean;
  openedAt: number;
  // Swing-specific (optional)
  swingTrade?: boolean;
  stopDistance?: number;
  retestLevel?: number;
  rangeHigh?: number;
  rangeLow?: number;
  stage2Added?: boolean;
  stage1Stake?: number;
  // Reversal-specific (optional)
  reversalTrade?: boolean;
  reversalTargetPrice?: number;
  reversalIsPremium?: boolean;
  // V10-specific (optional)
  v10Trade?: boolean;
  v10TargetPrice?: number;
  v10OpenedAt?: number;
  // V10 Precision Scalper-specific (optional)
  v10PrecisionTrade?: boolean;
  v10PrecisionTargetPrice?: number;
  /** Set when a live Deriv contract has been placed — settlement comes from Deriv, not local monitoring */
  precisionContractId?: number;
  precisionIsLive?: boolean;
  /** Set when live placement failed mid-trade — force binary P&L even though tradingMode is non-paper */
  precisionFallbackPaper?: boolean;
}

interface ScoreBreakdown {
  c1: number;
  c2: number;
  c3: number;
  total: number;
  direction: string;
}

class BotManager {
  private bots: Map<string, BotState> = new Map();
  private sseClients: Map<string, Set<((data: string) => void)>> = new Map();
  private lastCandleTime: number = 0;
  private last5mCandleTime: number = 0;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;

  constructor() {
    this.startGlobalLoop();
  }

  private startGlobalLoop() {
    this.monitorInterval = setInterval(() => {
      this.monitorOpenTrades();
      this.checkNewCandle();
      this.tickCount++;
      // Heartbeat every 30s (6 × 5s ticks)
      if (this.tickCount % 6 === 0) {
        for (const userId of this.bots.keys()) {
          this.writeHeartbeat(userId).catch(() => {});
        }
      }
    }, 5000);
  }

  private async checkNewCandle() {
    const candles5m = derivService.getCandles("5m", 5);
    if (!candles5m.length) return;
    const latest5m = candles5m[candles5m.length - 1];

    const candles1m = derivService.getCandles("1m", 5);
    if (candles1m.length) {
      const latest1m = candles1m[candles1m.length - 1];
      if (latest1m.time !== this.lastCandleTime) {
        this.lastCandleTime = latest1m.time;
      }
    }

    if (latest5m.time === this.last5mCandleTime) return;
    this.last5mCandleTime = latest5m.time;

    for (const [userId, state] of this.bots.entries()) {
      if (!state.isRunning || state.killSwitchActive) continue;
      if (state.openTrade) continue;
      try {
        await this.evaluateSignal(userId, state);
      } catch (err) {
        logger.error({ err, userId }, "Bot evaluation error");
      }
    }
  }

  private async evaluateSignal(userId: string, state: BotState) {
    const now = Math.floor(Date.now() / 1000);

    // CHECK 1 — Master stop
    const ms = await db.select().from(systemSettingsTable).where(eq(systemSettingsTable.key, "master_stop")).limit(1);
    if (ms[0]?.value === "true") {
      state.pauseReason = "System maintenance";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 2 — Kill switch
    if (state.killSwitchActive) {
      state.pauseReason = "Kill switch active";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Get user and strategy
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user || !user.strategyId) return;

    const strats = await db.select().from(strategiesTable).where(eq(strategiesTable.id, user.strategyId)).limit(1);
    const strategy = strats[0];
    if (!strategy) return;

    // CHECK 3 — Strategy circuit breaker
    state.strategyCircuitBreakerActive = strategy.circuitBreakerActive === 1;
    if (state.strategyCircuitBreakerActive) {
      state.pauseReason = "Strategy paused by admin";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 4 — Session filter
    const sessionsEnabled = JSON.parse(strategy.sessionsEnabled || "[]") as string[];
    const currentSession = getCurrentSession();
    if (sessionsEnabled.length > 0 && !isInSession(sessionsEnabled)) {
      const next = getNextSession();
      const name = next?.session.name ?? "next session";
      const mins = next?.minutesUntil ?? 0;
      state.pauseReason = `Outside session — ${name} in ${mins}m`;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 5 — First candle rule (15 minutes after session open)
    if (currentSession) {
      const nowUtcMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const sessionStartMinutes = currentSession.startUtcHour * 60;
      const minutesIntoSession = nowUtcMinutes - sessionStartMinutes;
      if (minutesIntoSession >= 0 && minutesIntoSession < 15) {
        state.pauseReason = "Waiting for first session candle";
        this.broadcastBotEvent(userId, state);
        return;
      }
    }

    // CHECK 6 — Spike filter
    const candles1m = derivService.getCandles("1m", 20);
    if (candles1m.length >= 15) {
      const lastC1m = candles1m[candles1m.length - 1];
      const atrVals = this.calcATR(candles1m, 14);
      const lastAtr1m = atrVals[atrVals.length - 1] || 100;
      const range = lastC1m.high - lastC1m.low;
      if (range > 3 * lastAtr1m) {
        state.spikeDetected = true;
        state.spikeWaitCandles = 2;
        state.pauseReason = "Spike detected — waiting 2 candles";
        this.broadcastBotEvent(userId, state);
        return;
      }
      if (state.spikeWaitCandles > 0) {
        state.spikeWaitCandles--;
        state.pauseReason = "Post-spike cooldown";
        this.broadcastBotEvent(userId, state);
        return;
      } else {
        state.spikeDetected = false;
      }
    }

    // CHECK 7 — Consolidation (handled in scoring engine, pass through)
    // (consolidationDetected is set from score result)

    // CHECK 8 — Daily loss cap
    const balance = user.accountBalance || 100;
    const peak = user.peakBalance || balance;
    if (state.dailyStartBalance === 0) {
      state.dailyStartBalance = balance;
    }
    state.peakBalance = peak;
    const profileMaxLossPct: Record<string, number> = { safe: 5, pro: 8, aggressive: 12 };
    const maxLossPct = user.maxDailyLoss ?? (profileMaxLossPct[user.tradingProfile || "safe"] || 5);
    const dailyLossPct = ((state.dailyStartBalance - balance) / state.dailyStartBalance) * 100;
    if (dailyLossPct >= maxLossPct) {
      state.dailyLossHit = true;
      state.isRunning = false;
      state.pauseReason = "Daily loss limit reached";
      this.broadcastBotEvent(userId, state);
      this.logActivity(userId, `Daily loss limit of ${maxLossPct}% reached — bot stopped`, "error").catch(() => {});
      return;
    }
    if (dailyLossPct >= maxLossPct * 0.75) {
      this.broadcastToUser(userId, "alert", { level: "warning", message: `Daily loss at ${dailyLossPct.toFixed(1)}% — limit is ${maxLossPct}%` });
    }

    // CHECK 9 — Consecutive losses
    // precision_scalper uses strategy-level stop (5); other strategies use profile-based stop.
    const maxLosses: Record<string, number> = { safe: 3, pro: 4, aggressive: 5 };
    const maxConsecLosses = strategy.type === "precision_scalper"
      ? (strategy.consecutiveLossStop ?? 5)
      : (maxLosses[user.tradingProfile || "safe"] || 3);
    if (state.consecutiveLosses >= maxConsecLosses) {
      state.isRunning = false;
      state.pauseReason = `${state.consecutiveLosses} consecutive losses — tap Resume to continue`;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 10 — Cooldown between trades.
    // precision_scalper manages its own 3-minute cooldown via v10PrecisionCooldownUntil,
    // so we skip the global 10-minute gate for that strategy type.
    if (state.lastTradeTime && strategy.type !== "precision_scalper") {
      const secondsSince = now - state.lastTradeTime;
      const cooldownSecs = 10 * 60;
      if (secondsSince < cooldownSecs) {
        const remaining = cooldownSecs - secondsSince;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        state.cooldownSecondsRemaining = remaining;
        state.pauseReason = `Cooldown — ${mins}m ${secs}s remaining`;
        this.broadcastBotEvent(userId, state);
        return;
      }
    }
    state.cooldownSecondsRemaining = null;

    // CHECK 11 — Open trade
    if (state.openTrade) {
      state.pauseReason = "Trade in progress";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 12 — Trade limits
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTs = Math.floor(todayStart.getTime() / 1000);
    const todayTradesRes = await db.select({ count: sql<number>`count(*)` }).from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.openedAt, todayTs)));
    state.todayTrades = Number(todayTradesRes[0]?.count || 0);
    if (state.todayTrades >= (strategy.maxTradesDay || 10)) {
      state.pauseReason = "Daily trade limit reached";
      this.broadcastBotEvent(userId, state);
      return;
    }

    const hourStart = now - 3600;
    const hourTradesRes = await db.select({ count: sql<number>`count(*)` }).from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.openedAt, hourStart)));
    state.thisHourTrades = Number(hourTradesRes[0]?.count || 0);
    if (state.thisHourTrades >= (strategy.maxTradesHour || 3)) {
      state.pauseReason = "Hourly limit reached";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // ── SWING strategy routing ────────────────────────────────────────────
    if (strategy.type === "swing") {
      await this.evaluateSwingSignal(userId, user, strategy, state, now, currentSession);
      return;
    }

    // ── REVERSAL strategy routing ─────────────────────────────────────────
    if (strategy.type === "reversal") {
      await this.evaluateReversalSignal(userId, user, strategy, state, now, currentSession);
      return;
    }

    // ── V10 MEAN REVERSION strategy routing ───────────────────────────────
    if (strategy.type === "mean_reversion") {
      await this.evaluateV10Signal(userId, user, strategy, state, now);
      return;
    }

    // ── V10 PRECISION SCALPER strategy routing ────────────────────────────
    if (strategy.type === "precision_scalper") {
      await this.evaluateV10PrecisionSignal(userId, user, strategy, state, now);
      return;
    }

    // Run scoring engine (sniper)
    const candles5m  = derivService.getCandles("5m", 100);
    const candles15m = derivService.getCandles("15m", 60);
    const candles1h  = derivService.getCandles("1h", 120);

    const result = score(candles1h, candles15m, candles5m);

    if (!result) {
      state.pauseReason = null;
      state.currentScore = null;
      this.broadcastToUser(userId, "scores", {
        loading: true,
        message: "Gathering market data...",
        candlesLoaded: candles1h.length,
        candlesNeeded: 55,
      });
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.currentScore = result.total;
    state.rangeContext = null;
    state.spikeDetected = false;
    state.consolidationDetected = false;
    state.lastScoreResult = result;
    state.scoreBreakdown = {
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      total: result.total,
      direction: result.direction,
    };

    // Broadcast scores via SSE
    this.broadcastToUser(userId, "scores", {
      total: result.total,
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      signal: result.direction,
      direction: result.direction,
      loading: false,
      ema20_1h: result.ema20_1h,
      ema50_1h: result.ema50_1h,
      ema9_15m: result.ema9_15m,
      ema21_15m: result.ema21_15m,
      adx15m: result.adx15m,
      rsi5m: result.rsi5m,
      ema21_5m: result.ema21_5m,
      rejectionReason: null,
    });

    // Log signal
    const signalId = randomUUID();
    const threshold = strategy.scoreThreshold ?? 16;
    const action = result.total >= threshold && result.direction !== "NONE" ? "executed" : "rejected";
    const rejectionReason = action === "rejected"
      ? result.direction === "NONE" ? "No clear signal" : `Score ${result.total} < threshold ${threshold}`
      : null;

    await db.insert(signalLogTable).values({
      id: signalId, userId, strategyId: strategy.id, timestamp: now,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      direction: result.direction, action, rejectionReason,
      ema9: result.ema9_15m, ema21: result.ema21_15m, rsi: result.rsi5m,
      rangeContext: null, sessionName: currentSession?.name || null,
      consolidationDetected: 0,
      spikeDetected: 0,
    });

    if (action !== "executed" || result.direction === "NONE") {
      state.pauseReason = rejectionReason;
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.pauseReason = null;
    await this.executeTrade(userId, user, strategy, result, currentSession?.name || null, state);
  }

  // ── Swing blackout zone check ─────────────────────────────────────────────
  private isSwingBlackout(): boolean {
    const now = new Date();
    const h = now.getUTCHours(), m = now.getUTCMinutes();
    const t = h * 60 + m;
    return (t >= 6 * 60 + 45 && t <= 7 * 60 + 15) || (t >= 12 * 60 + 45 && t <= 13 * 60 + 15);
  }

  // ── Swing signal evaluation ───────────────────────────────────────────────
  private async evaluateSwingSignal(
    userId: string,
    user: any,
    strategy: any,
    state: BotState,
    now: number,
    currentSession: ReturnType<typeof getCurrentSession>
  ) {
    const candles1h  = derivService.getCandles("1h", 120);
    const candles15m = derivService.getCandles("15m", 60);
    const candles4h  = build4hCandles(candles1h);

    if (candles1h.length < 55) {
      state.pauseReason = null;
      this.broadcastToUser(userId, "scores", { loading: true, message: "Gathering swing candle data...", candlesLoaded: candles1h.length, candlesNeeded: 55 });
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Update swing state when a new 1h candle closes
    const latest1hTime = candles1h[candles1h.length - 1]?.time ?? 0;
    if (latest1hTime !== state.swingLastEval1hTime) {
      state.swingLastEval1hTime = latest1hTime;
      if (!state.swingBreakout) {
        if (!state.swingConsolidation) {
          state.swingConsolidation = detectConsolidationRange(candles1h) ?? null;
          if (state.swingConsolidation) {
            logger.info({ userId }, `Swing: consolidation detected high=${state.swingConsolidation.high.toFixed(2)} low=${state.swingConsolidation.low.toFixed(2)}`);
            this.logActivity(userId, `Swing: Consolidation detected — range ${state.swingConsolidation.low.toFixed(2)}-${state.swingConsolidation.high.toFixed(2)}`, "info").catch(() => {});
          }
        } else {
          const newBreakout = detectBreakout(candles1h, state.swingConsolidation);
          if (newBreakout) {
            state.swingBreakout = newBreakout;
            logger.info({ userId, dir: newBreakout.direction }, `Swing: breakout detected at ${newBreakout.breakoutPrice.toFixed(2)}`);
            this.logActivity(userId, `Swing: Breakout ${newBreakout.direction} @ ${newBreakout.breakoutPrice.toFixed(2)} — watching for retest`, "info").catch(() => {});
          } else {
            // Recheck consolidation (range may have expanded/reset)
            const fresh = detectConsolidationRange(candles1h);
            if (!fresh) state.swingConsolidation = null;
          }
        }
      }
    }

    // Score and check for entry
    const threshold = strategy.scoreThreshold ?? 20;
    const swingResult = scoreSwing(candles4h, candles1h, candles15m, state.swingConsolidation, state.swingBreakout, derivService.getLatestTick().price, threshold);

    if (!swingResult) {
      state.currentScore = null;
      state.pauseReason = "Awaiting swing setup";
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.currentScore = swingResult.total;
    state.scoreBreakdown = { c1: swingResult.c1, c2: swingResult.c2, c3: swingResult.c3, total: swingResult.total, direction: swingResult.direction };

    this.broadcastToUser(userId, "scores", {
      total: swingResult.total,
      c1: swingResult.c1, c2: swingResult.c2, c3: swingResult.c3,
      signal: swingResult.direction,
      loading: false,
      ema20_1h: swingResult.ema20_4h,
      ema50_1h: swingResult.ema50_4h,
      ema9_15m: swingResult.ema9_1h,
      ema21_15m: swingResult.ema21_1h,
      adx15m: swingResult.adx1h,
      rsi5m: swingResult.rsi1h,
      rejectionReason: swingResult.direction === "NONE" ? (swingResult.total < threshold ? `Score ${swingResult.total} < ${threshold}` : "Awaiting retest") : null,
    });

    if (!swingResult.ready || swingResult.direction === "NONE") {
      state.pauseReason = swingResult.consolidation ? (swingResult.breakout ? "Waiting for retest" : "Watching for breakout") : "Scanning for consolidation";
      this.broadcastBotEvent(userId, state);
      return;
    }

    if (this.isSwingBlackout()) {
      state.pauseReason = "Swing blackout zone — waiting for window";
      this.logActivity(userId, "Swing: Signal during blackout zone — skipped", "info").catch(() => {});
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Execute swing Stage 1 entry
    state.pauseReason = null;
    const consolidation = state.swingConsolidation!;
    const breakout = state.swingBreakout!;
    const isBuy = swingResult.direction === "BUY";
    const entryPrice = derivService.getLatestTick().price;
    const stopDist = isBuy ? entryPrice - (consolidation.low - consolidation.size * 0.1) : (consolidation.high + consolidation.size * 0.1) - entryPrice;

    const MIN_STOP = 80, MAX_STOP = 350;
    if (stopDist < MIN_STOP || stopDist > MAX_STOP) {
      state.pauseReason = `Stop distance ${stopDist.toFixed(0)} pip out of range ${MIN_STOP}-${MAX_STOP} — skipping`;
      this.logActivity(userId, `Swing: ${state.pauseReason}`, "info").catch(() => {});
      // Reset breakout — this setup is invalid
      state.swingBreakout = null;
      state.swingConsolidation = null;
      this.broadcastBotEvent(userId, state);
      return;
    }

    const balance = user.accountBalance || 100;
    const riskPct = (strategy.maxRiskPercent ?? 1.0) / 100;
    const stage1Stake = Math.max(0.5, Math.round(balance * riskPct * 0.5 * 100) / 100);
    const slPrice = isBuy ? consolidation.low - consolidation.size * 0.1 : consolidation.high + consolidation.size * 0.1;
    const tp1 = isBuy ? entryPrice + stopDist * (strategy.tp1Multiplier ?? 2.0) : entryPrice - stopDist * (strategy.tp1Multiplier ?? 2.0);
    const tp2 = isBuy ? entryPrice + stopDist * (strategy.tp2Multiplier ?? 4.0) : entryPrice - stopDist * (strategy.tp2Multiplier ?? 4.0);

    const tradeId = randomUUID();
    await db.insert(tradesTable).values({
      id: tradeId, userId, strategyId: strategy.id,
      direction: swingResult.direction, entryPrice, stake: stage1Stake,
      scoreTotal: swingResult.total, scoreTrend: swingResult.c1, scoreVolatility: swingResult.c2, scoreTiming: swingResult.c3,
      scorePullback: 0, scoreRisk: 0,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0, isDemo: 0,
      symbol: "R_75", tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss: slPrice, takeProfit1: tp1, takeProfit2: tp2,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName: currentSession?.name || null, rangeContext: null,
      openedAt: now, rsiAtEntry: swingResult.rsi1h, stochAtEntry: null, macdAtEntry: null,
    });

    state.openTrade = {
      id: tradeId, direction: swingResult.direction, entryPrice, currentPrice: entryPrice,
      stake: stage1Stake, pnl: 0, stopLoss: slPrice, takeProfit1: tp1, takeProfit2: tp2,
      breakEvenMoved: false, partialClosed: false, momentumExtensionActive: false, openedAt: now,
      swingTrade: true, stopDistance: stopDist, retestLevel: breakout.retestLevel,
      rangeHigh: consolidation.high, rangeLow: consolidation.low, stage2Added: false, stage1Stake,
    };
    state.lastTradeTime = now;
    state.lastSignalScore = swingResult.total;
    state.lastSignalDirection = swingResult.direction;
    // Reset swing state — breakout consumed
    state.swingBreakout = null;
    state.swingConsolidation = null;

    this.broadcastToUser(userId, "trade", { action: "opened", trade: state.openTrade });
    this.broadcastBotEvent(userId, state);
    this.logActivity(userId, `Swing Stage 1: ${swingResult.direction} @ ${entryPrice.toFixed(2)} — SL ${slPrice.toFixed(2)} — TP1 ${tp1.toFixed(2)} — TP2 ${tp2.toFixed(2)} — Score ${swingResult.total}`, "info").catch(() => {});
    logger.info({ userId, tradeId, dir: swingResult.direction, score: swingResult.total }, "Swing Stage 1 opened");
  }

  // ── Reversal signal evaluation ────────────────────────────────────────────
  private async evaluateReversalSignal(
    userId: string,
    user: any,
    strategy: any,
    state: BotState,
    now: number,
    currentSession: ReturnType<typeof getCurrentSession>
  ) {
    const candles1m  = derivService.getCandles("1m", 30);
    const candles5m  = derivService.getCandles("5m", 100);
    const candles15m = derivService.getCandles("15m", 60);

    if (candles5m.length < 30 || candles15m.length < 14) {
      state.pauseReason = null;
      this.broadcastToUser(userId, "scores", {
        loading: true,
        message: "Gathering reversal candle data...",
        candlesLoaded: candles5m.length,
        candlesNeeded: 30,
      });
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK — Reversal cooldown (30 min after last reversal trade)
    if (state.reversalCooldownUntil && now < state.reversalCooldownUntil) {
      const remaining = state.reversalCooldownUntil - now;
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      state.pauseReason = `Reversal cooldown — ${mins}m ${secs}s remaining`;
      this.broadcastBotEvent(userId, state);
      return;
    }
    if (state.reversalCooldownUntil && now >= state.reversalCooldownUntil) {
      state.reversalCooldownUntil = null;
    }

    const threshold = strategy.scoreThreshold ?? 17;
    const result = scoreReversal(candles1m, candles5m, candles15m, threshold);

    if (!result) {
      state.currentScore = null;
      state.pauseReason = "Gathering reversal data...";
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.currentScore = result.total;
    state.scoreBreakdown = {
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      total: result.total,
      direction: result.direction,
    };

    // Broadcast scores
    this.broadcastToUser(userId, "scores", {
      total: result.total,
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      signal: result.direction,
      direction: result.direction,
      loading: false,
      rsi5m: result.divergence5m.currentRsi,
      rejectionReason: result.rejectionReason,
      sessionMovePips: result.sessionMove.currentMove.toFixed(0),
      bbMiddle: result.bbExtreme.middle?.toFixed(2),
    });

    // Log signal
    const signalId = randomUUID();
    const action = result.direction !== "NONE" ? "executed" : "rejected";

    await db.insert(signalLogTable).values({
      id: signalId, userId, strategyId: strategy.id, timestamp: now,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      direction: result.direction, action, rejectionReason: result.rejectionReason,
      ema9: null, ema21: null, rsi: result.divergence5m.currentRsi,
      rangeContext: `session_move:${result.sessionMove.currentMove.toFixed(0)}pips`,
      sessionName: currentSession?.name || null,
      consolidationDetected: 0,
      spikeDetected: 0,
    });

    if (result.direction === "NONE") {
      state.pauseReason = result.rejectionReason;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Execute reversal trade
    state.pauseReason = null;
    const isBuy = result.direction === "BUY";
    const balance = user.accountBalance || 100;
    const riskPct = (strategy.maxRiskPercent ?? 1.0) / 100;
    let stake = result.isPremium
      ? Math.max(0.5, Math.round(balance * riskPct * 1.25 * 100) / 100)
      : Math.max(0.5, Math.round(balance * riskPct * 100) / 100);
    stake = Math.min(1000, stake);
    if (state.winStreakCautionActive) stake = Math.round(stake * 0.8 * 100) / 100;
    if (state.recoveryModeActive) stake = Math.round(stake * 0.5 * 100) / 100;
    // Item 4: capital preservation override
    const revPres = this.checkCapitalPreservation(balance, strategy.scoreThreshold ?? 20);
    state.capitalPreservationMode = revPres.active;
    if (revPres.active) { stake = revPres.stake; }
    // Item 7: conviction sizing
    stake = this.calculateConvictionStake(stake, result.total, 25, balance);
    stake = Math.max(0.5, Math.min(1000, Math.round(stake * 100) / 100));

    if (result.isPremium) {
      this.logActivity(userId, "Premium reversal — 1.25× stake", "info").catch(() => {});
    }

    const tradeId = randomUUID();
    await db.insert(tradesTable).values({
      id: tradeId, userId, strategyId: strategy.id,
      direction: result.direction, entryPrice: result.entryPrice, stake,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0, isDemo: 0,
      symbol: "R_75", tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss: result.stopLoss, takeProfit1: result.takeProfit, takeProfit2: result.takeProfit,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName: currentSession?.name || null,
      rangeContext: `session_move:${result.sessionMove.currentMove.toFixed(0)}pips|rr:${result.rr.toFixed(2)}`,
      openedAt: now,
      rsiAtEntry: result.divergence5m.currentRsi, stochAtEntry: null, macdAtEntry: null,
    });

    state.openTrade = {
      id: tradeId,
      direction: result.direction,
      entryPrice: result.entryPrice,
      currentPrice: result.entryPrice,
      stake,
      pnl: 0,
      stopLoss: result.stopLoss,
      takeProfit1: result.takeProfit,
      takeProfit2: result.takeProfit,
      breakEvenMoved: false,
      partialClosed: false,
      momentumExtensionActive: false,
      openedAt: now,
      reversalTrade: true,
      reversalTargetPrice: result.takeProfit,
      reversalIsPremium: result.isPremium,
    };
    state.lastTradeTime = now;
    state.lastSignalScore = result.total;
    state.lastSignalDirection = result.direction;

    this.broadcastToUser(userId, "trade", { action: "opened", trade: state.openTrade });
    this.broadcastBotEvent(userId, state);
    const premiumTag = result.isPremium ? " [PREMIUM 1.25×]" : "";
    this.logActivity(userId, `Reversal ${result.direction} @ ${result.entryPrice.toFixed(2)} — SL ${result.stopLoss.toFixed(2)} — TP ${result.takeProfit.toFixed(2)} — R:R ${result.rr.toFixed(2)} — Score ${result.total}${premiumTag}`, "info").catch(() => {});
    logger.info({ userId, tradeId, dir: result.direction, score: result.total, rr: result.rr, premium: result.isPremium }, "Reversal trade opened");
  }

  // ── V10 Precision Scalper signal evaluation ──────────────────────────────
  private async evaluateV10PrecisionSignal(
    userId: string,
    user: any,
    strategy: any,
    state: BotState,
    now: number
  ) {
    const pair = user.activePair || "R_10";
    const candles1m = derivService.getCandlesForPair(pair, "1m", 100);
    const candles5m = derivService.getCandlesForPair(pair, "5m", 60);

    if (candles1m.length < 30) {
      state.pauseReason = null;
      this.broadcastToUser(userId, "scores", {
        loading: true,
        message: `Gathering V10 Precision data... (${candles1m.length}/30 1m candles)`,
        candlesLoaded: candles1m.length,
        candlesNeeded: 30,
      });
      this.broadcastBotEvent(userId, state);
      return;
    }

    // V10 Precision-specific cooldown (3 minutes after last trade)
    if (state.v10PrecisionCooldownUntil && now < state.v10PrecisionCooldownUntil) {
      const remaining = state.v10PrecisionCooldownUntil - now;
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      state.pauseReason = `V10 Precision cooldown — ${mins}m ${secs}s remaining`;
      this.broadcastBotEvent(userId, state);
      return;
    }
    if (state.v10PrecisionCooldownUntil && now >= state.v10PrecisionCooldownUntil) {
      state.v10PrecisionCooldownUntil = null;
    }

    const result = scoreV10Precision(candles1m, candles5m);

    if (!result) {
      state.currentScore = null;
      state.pauseReason = "Gathering V10 Precision signal data...";
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.currentScore = result.total;
    state.scoreBreakdown = {
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      total: result.total,
      direction: result.signal,
    };

    this.broadcastToUser(userId, "scores", {
      total: result.total,
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      signal: result.signal,
      direction: result.signal,
      loading: false,
      rsi5m: null,
      rejectionReason: result.signal === "NONE" ? result.reason : null,
    });

    const signalId = randomUUID();
    const action = result.signal !== "NONE" ? "executed" : "rejected";
    await db.insert(signalLogTable).values({
      id: signalId, userId, strategyId: strategy.id, timestamp: now,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      direction: result.signal, action, rejectionReason: result.signal === "NONE" ? result.reason : null,
      ema9: null, ema21: null, rsi: null,
      rangeContext: `bb_middle:${result.bbMiddle.toFixed(4)}|bb_upper:${result.bbUpper.toFixed(4)}|bb_lower:${result.bbLower.toFixed(4)}`,
      sessionName: "24/7",
      consolidationDetected: 0, spikeDetected: 0,
    });

    if (result.signal === "NONE") {
      state.pauseReason = result.reason;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Validate stop levels before executing
    const entryPrice = result.entryPrice;
    let { stopLoss, takeProfit } = result;

    if (result.signal === "BUY" && stopLoss >= entryPrice) {
      logger.error({ userId }, "V10P BUY stop above entry — correcting");
      stopLoss = entryPrice - Math.max(3, result.atrValue * 1.5);
    }
    if (result.signal === "SELL" && stopLoss <= entryPrice) {
      logger.error({ userId }, "V10P SELL stop below entry — correcting");
      stopLoss = entryPrice + Math.max(3, result.atrValue * 1.5);
    }
    if (result.signal === "BUY" && takeProfit <= entryPrice) {
      state.pauseReason = "V10P: TP below entry — skipping";
      this.broadcastBotEvent(userId, state);
      return;
    }
    if (result.signal === "SELL" && takeProfit >= entryPrice) {
      state.pauseReason = "V10P: TP above entry — skipping";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Execute V10 Precision trade
    state.pauseReason = null;
    const balance = user.accountBalance || 100;
    const riskPct = (strategy.maxRiskPercent ?? 0.5) / 100;
    let stake = balance * riskPct;
    if (state.recoveryModeActive) stake *= 0.5;
    stake = Math.max(1.0, Math.min(5.0, Math.round(stake * 100) / 100));

    const tradeId = randomUUID();

    await db.insert(tradesTable).values({
      id: tradeId, userId, strategyId: strategy.id,
      direction: result.signal, entryPrice, stake,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0, isDemo: user.demoMode === 1 ? 1 : 0,
      symbol: pair, tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss, takeProfit1: takeProfit, takeProfit2: takeProfit,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName: "24/7",
      rangeContext: `bb_middle:${result.bbMiddle.toFixed(4)}|stop:${stopLoss.toFixed(4)}|tp:${takeProfit.toFixed(4)}|score:${result.total}/20`,
      openedAt: now,
      rsiAtEntry: null, stochAtEntry: null, macdAtEntry: null,
    });

    state.openTrade = {
      id: tradeId,
      direction: result.signal,
      entryPrice,
      currentPrice: entryPrice,
      stake,
      pnl: 0,
      stopLoss,
      takeProfit1: takeProfit,
      takeProfit2: takeProfit,
      breakEvenMoved: false,
      partialClosed: false,
      momentumExtensionActive: false,
      openedAt: now,
      v10PrecisionTrade: true,
      v10PrecisionTargetPrice: takeProfit,
    };
    state.lastTradeTime = now;
    state.v10PrecisionCooldownUntil = now + 3 * 60;
    state.lastSignalScore = result.total;
    state.lastSignalDirection = result.signal;

    this.broadcastToUser(userId, "trade", { action: "opened", trade: state.openTrade });
    this.broadcastBotEvent(userId, state);

    const modeLabel = user.tradingMode === "demo" ? "[DEMO LIVE]" : "[PAPER]";
    this.logActivity(userId, `V10 Precision ${result.signal} @ ${entryPrice.toFixed(4)} — SL ${stopLoss.toFixed(4)} — TP ${takeProfit.toFixed(4)} (50% SL) — Score ${result.total}/20 ${modeLabel}`, "info").catch(() => {});
    logger.info({ userId, tradeId, dir: result.signal, score: result.total, pair, mode: user.tradingMode }, "V10 Precision trade opened");

    // ── Place live contract for demo/live accounts ──────────────────────
    if (user.tradingMode !== "paper" && user.derivTokenEncrypted) {
      let token: string;
      try {
        token = decrypt(user.derivTokenEncrypted);
      } catch (err) {
        logger.error({ userId, err }, "V10P: Failed to decrypt Deriv token — staying paper");
        return;
      }

      const self = this;
      placePrecisionLiveContract(
        result.signal,
        stake,
        token,
        pair,
        25, // 25-minute contract
        (settlement: PrecisionSettlementResult) => {
          self.handlePrecisionSettlement(userId, tradeId, settlement).catch((err) =>
            logger.error({ userId, tradeId, err }, "V10P settlement handler error")
          );
        }
      ).then((orderResult) => {
        if (orderResult.success && orderResult.contractId) {
          // Mark the open trade as live (skip local SL/TP monitoring)
          const s = self.bots.get(userId);
          if (s?.openTrade?.id === tradeId) {
            s.openTrade.precisionContractId = orderResult.contractId;
            s.openTrade.precisionIsLive = true;
            s.openTrade.entryPrice = orderResult.entrySpot ?? entryPrice;
          }
          // Store contract_id in DB
          db.update(tradesTable).set({ contractId: String(orderResult.contractId) })
            .where(eq(tradesTable.id, tradeId))
            .catch(() => {});
          logger.info({ userId, tradeId, contractId: orderResult.contractId }, "V10P live contract placed");
          self.logActivity(userId, `V10P Deriv contract #${orderResult.contractId} placed — awaiting settlement`, "info").catch(() => {});
        } else {
          logger.warn({ userId, tradeId, error: orderResult.error }, "V10P contract placement failed — monitoring as paper");
          // Mark trade so closeTrade() uses binary P&L regardless of tradingMode
          const sf = self.bots.get(userId);
          if (sf?.openTrade?.id === tradeId) sf.openTrade.precisionFallbackPaper = true;
          self.broadcastToUser(userId, "alert", {
            level: "warning",
            message: `Deriv contract failed: ${orderResult.error}. Monitoring as paper trade.`,
          });
        }
      }).catch((err) => {
        logger.error({ userId, tradeId, err }, "V10P placePrecisionLiveContract threw");
      });
    }
  }

  // ── V10 Precision settlement handler (called by Deriv WebSocket callback) ─
  private async handlePrecisionSettlement(
    userId: string,
    tradeId: string,
    settlement: PrecisionSettlementResult
  ): Promise<void> {
    const state = this.bots.get(userId);
    if (!state) return;

    // If state.openTrade no longer matches (already closed by time-stop), skip
    if (state.openTrade?.id !== tradeId) {
      logger.warn({ userId, tradeId }, "V10P settlement arrived but trade already closed");
      return;
    }

    const trade = state.openTrade;
    const now = Math.floor(Date.now() / 1000);
    const duration = Math.floor((now - trade.openedAt) / 60);
    const pnl = settlement.pnl;
    const exitPrice = settlement.exitSpot || trade.currentPrice;
    const isWin = pnl > 0;

    await db.update(tradesTable).set({
      status: "closed",
      closedAt: now,
      exitPrice,
      pnl,
      durationMinutes: duration,
      contractId: String(settlement.contractId),
    }).where(eq(tradesTable.id, tradeId));

    // Update streaks and daily P&L
    if (isWin) {
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      if (state.consecutiveWins >= 5) state.winStreakCautionActive = true;
    } else {
      state.consecutiveLosses++;
      state.consecutiveWins = 0;
      state.winStreakCautionActive = false;
    }
    state.dailyPnl += pnl;
    state.openTrade = null;
    state.pauseReason = null;
    state.v10PrecisionCooldownUntil = now + 3 * 60;

    // Update user balance
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (user) {
      const newBalance = Math.round(((user.accountBalance || 100) + pnl) * 100) / 100;
      const newPeak = Math.max(user.peakBalance || newBalance, newBalance);
      state.currentDrawdown = (newPeak - newBalance) / newPeak;
      state.peakBalance = newPeak;
      if (state.currentDrawdown >= 0.15 && !state.recoveryModeActive) {
        state.recoveryModeActive = true;
        this.broadcastToUser(userId, "alert", { level: "warning", message: "Recovery mode activated — stake reduced 50%" });
      }
      if (state.recoveryModeActive && newBalance >= newPeak * 0.95) {
        state.recoveryModeActive = false;
        this.broadcastToUser(userId, "alert", { level: "info", message: "Recovery complete" });
      }
      await db.update(usersTable).set({ accountBalance: newBalance, peakBalance: newPeak }).where(eq(usersTable.id, userId));

      // Async-confirm the balance from Deriv after writing the calculated value
      this.syncDerivBalanceBackground(userId, user.derivTokenEncrypted, state);
    }

    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : `-${Math.abs(pnl).toFixed(2)}`;
    this.broadcastToUser(userId, "trade", { action: "closed", result: isWin ? "win" : "loss", pnl, tradeId, exitPrice });
    this.broadcastBotEvent(userId, state);
    this.logActivity(userId, `V10P Deriv contract #${settlement.contractId} settled — ${pnlStr} — ${isWin ? "WIN ✓" : "LOSS ✗"}`, isWin ? "win" : "loss").catch(() => {});
    logger.info({ userId, tradeId, contractId: settlement.contractId, pnl, won: isWin }, "V10P settlement processed");
  }

  // ── V10 Range Scalper signal evaluation ──────────────────────────────────
  private async evaluateV10Signal(
    userId: string,
    user: any,
    strategy: any,
    state: BotState,
    now: number
  ) {
    const pair = user.activePair || "R_10";
    const candles1m  = derivService.getCandlesForPair(pair, "1m", 50);
    const candles5m  = derivService.getCandlesForPair(pair, "5m", 80);
    const candles15m = derivService.getCandlesForPair(pair, "15m", 60);

    if (candles5m.length < 30 || candles15m.length < 30) {
      state.pauseReason = null;
      this.broadcastToUser(userId, "scores", {
        loading: true,
        message: `Gathering V10 data... (${candles5m.length}/30 5m candles)`,
        candlesLoaded: candles5m.length, candlesNeeded: 30,
      });
      this.broadcastBotEvent(userId, state);
      return;
    }

    // V10-specific cooldown (3 minutes after last trade)
    if (state.v10CooldownUntil && now < state.v10CooldownUntil) {
      const remaining = state.v10CooldownUntil - now;
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      state.pauseReason = `V10 cooldown — ${mins}m ${secs}s remaining`;
      this.broadcastBotEvent(userId, state);
      return;
    }
    if (state.v10CooldownUntil && now >= state.v10CooldownUntil) {
      state.v10CooldownUntil = null;
    }

    const result = scoreV10(candles1m, candles5m, candles15m);

    if (!result) {
      state.currentScore = null;
      state.pauseReason = "Gathering V10 signal data...";
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.v10CleanlinessScore = result.cleanlinessScore;
    state.v10TrendRisk = result.trendRisk;
    state.v10Adx = result.adx;
    state.currentScore = result.total;
    state.scoreBreakdown = {
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      total: result.total,
      direction: result.direction,
    };

    this.broadcastToUser(userId, "scores", {
      total: result.total,
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
      signal: result.direction,
      direction: result.direction,
      loading: false,
      rsi5m: result.rsi,
      cleanlinessScore: result.cleanlinessScore,
      trendRisk: result.trendRisk,
      adx: result.adx,
      rejectionReason: result.rejectionReason,
    });

    const signalId = randomUUID();
    const threshold = strategy.scoreThreshold ?? 15;
    const action = result.direction !== "NONE" ? "executed" : "rejected";
    await db.insert(signalLogTable).values({
      id: signalId, userId, strategyId: strategy.id, timestamp: now,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      direction: result.direction, action, rejectionReason: result.rejectionReason,
      ema9: null, ema21: null, rsi: result.rsi,
      rangeContext: `range:${result.rangeLow.toFixed(2)}-${result.rangeHigh.toFixed(2)}|cleanliness:${result.cleanlinessScore}|adx:${result.adx.toFixed(1)}`,
      sessionName: "24/7",
      consolidationDetected: 0, spikeDetected: 0,
    });

    if (result.direction === "NONE") {
      state.pauseReason = result.rejectionReason;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Execute V10 trade
    state.pauseReason = null;
    const balance = user.accountBalance || 100;
    const riskPct = (strategy.maxRiskPercent ?? 1.0) / 100;
    let stake = user.stakeSize != null && user.stakeSize > 0
      ? user.stakeSize
      : balance * riskPct;
    if (state.recoveryModeActive) stake *= 0.5;
    // Tier 2 (BB approach) trades use half position size by design
    const v10Tier = result.tier ?? "T1";
    if (v10Tier === "T2") stake *= 0.5;
    stake = Math.max(0.5, Math.min(1000, Math.round(stake * 100) / 100));

    const entryPrice = result.entryPrice;
    const tradeId = randomUUID();

    await db.insert(tradesTable).values({
      id: tradeId, userId, strategyId: strategy.id,
      direction: result.direction, entryPrice, stake,
      scoreTotal: result.total, scoreTrend: result.c1, scoreVolatility: result.c2,
      scoreTiming: result.c3, scorePullback: 0, scoreRisk: 0,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0, isDemo: user.demoMode === 1 ? 1 : 0,
      symbol: pair, tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss: result.stopLoss, takeProfit1: result.takeProfit, takeProfit2: result.takeProfit,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName: "24/7",
      rangeContext: `range:${result.rangeLow.toFixed(2)}-${result.rangeHigh.toFixed(2)}|tp_mid_bb:${result.takeProfit.toFixed(4)}|tier:${v10Tier}`,
      openedAt: now,
      rsiAtEntry: result.rsi, stochAtEntry: null, macdAtEntry: null,
    });

    state.openTrade = {
      id: tradeId,
      direction: result.direction,
      entryPrice,
      currentPrice: entryPrice,
      stake,
      pnl: 0,
      stopLoss: result.stopLoss,
      takeProfit1: result.takeProfit,
      takeProfit2: result.takeProfit,
      breakEvenMoved: false,
      partialClosed: false,
      momentumExtensionActive: false,
      openedAt: now,
      v10Trade: true,
      v10TargetPrice: result.takeProfit,
      v10OpenedAt: now,
    };
    state.lastTradeTime = now;
    state.v10CooldownUntil = now + 3 * 60;
    state.lastSignalScore = result.total;
    state.lastSignalDirection = result.direction;

    this.broadcastToUser(userId, "trade", { action: "opened", trade: state.openTrade });
    this.broadcastBotEvent(userId, state);
    this.logActivity(userId, `V10 [${v10Tier}] ${result.direction} @ ${entryPrice.toFixed(4)} — SL ${result.stopLoss.toFixed(4)} — TP mid-BB ${result.takeProfit.toFixed(4)} — Score ${result.total}/25 — cleanliness ${result.cleanlinessScore}/10${v10Tier === "T2" ? " — half size" : ""}`, "info").catch(() => {});
    logger.info({ userId, tradeId, dir: result.direction, score: result.total, pair }, "V10 trade opened");

    // ── Place live Deriv contract for demo/live accounts ──────────────────
    if (user.tradingMode !== "paper" && user.derivTokenEncrypted) {
      let token: string;
      try { token = decrypt(user.derivTokenEncrypted); } catch (err) {
        logger.error({ userId, err }, "V10 Range Scalper: failed to decrypt token — staying paper");
        return;
      }
      const self = this;
      placePrecisionLiveContract(
        result.direction as "BUY" | "SELL",
        stake,
        token,
        pair,
        5,
        (settlement: PrecisionSettlementResult) => {
          self.handlePrecisionSettlement(userId, tradeId, settlement).catch((err) =>
            logger.error({ userId, tradeId, err }, "V10 Range Scalper settlement handler error")
          );
        }
      ).then((orderResult) => {
        if (orderResult.success && orderResult.contractId) {
          const s = self.bots.get(userId);
          if (s?.openTrade?.id === tradeId) {
            s.openTrade.precisionContractId = orderResult.contractId;
            s.openTrade.precisionIsLive = true;
            s.openTrade.entryPrice = orderResult.entrySpot ?? s.openTrade.entryPrice;
          }
          db.update(tradesTable).set({ contractId: String(orderResult.contractId) })
            .where(eq(tradesTable.id, tradeId)).catch(() => {});
          logger.info({ userId, tradeId, contractId: orderResult.contractId }, `V10 Range Scalper live contract placed on ${pair}`);
          self.logActivity(userId, `V10 Scalper Deriv contract #${orderResult.contractId} placed on ${pair} — 5m binary — awaiting settlement`, "info").catch(() => {});
        } else {
          logger.warn({ userId, tradeId, error: orderResult.error }, "V10 Range Scalper contract placement failed — monitoring as paper");
          const sf = self.bots.get(userId);
          if (sf?.openTrade?.id === tradeId) sf.openTrade.precisionFallbackPaper = true;
          self.broadcastToUser(userId, "alert", {
            level: "warning",
            message: `Deriv contract failed: ${orderResult.error}. Monitoring as paper trade.`,
          });
        }
      }).catch((err) => {
        logger.error({ userId, tradeId, err }, "V10 Range Scalper placePrecisionLiveContract threw");
      });
    }
  }

  private calcATR(candles: Array<{ high: number; low: number; close: number }>, period = 14): number[] {
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    });
    const result: number[] = [];
    if (tr.length < period) return result;
    let avg = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(...new Array(period - 1).fill(NaN), avg);
    for (let i = period; i < tr.length; i++) {
      avg = (avg * (period - 1) + tr[i]) / period;
      result.push(avg);
    }
    return result;
  }

  private async executeTrade(userId: string, user: any, strategy: any, result: ScoreResult, sessionName: string | null, state: BotState) {
    const balance = user.accountBalance || 100;
    const profile = user.tradingProfile || "safe";
    let stake: number;
    if (user.stakeSize != null && user.stakeSize > 0) {
      stake = user.stakeSize;
    } else {
      const riskMap: Record<string, number> = { safe: 1.0, pro: 1.5, aggressive: 2.0 };
      const riskPct = riskMap[profile] || 1.0;
      stake = (balance * riskPct) / 100;
    }
    if (state.winStreakCautionActive) stake *= 0.8;
    if (state.recoveryModeActive) stake *= 0.5;
    // Item 4: capital preservation override
    const pres = this.checkCapitalPreservation(balance, strategy.scoreThreshold ?? 16);
    state.capitalPreservationMode = pres.active;
    if (pres.active) { stake = pres.stake; }
    // Item 7: conviction-based sizing
    stake = this.calculateConvictionStake(stake, result.total, 25, balance);
    stake = Math.max(0.5, Math.min(1000, Math.round(stake * 100) / 100));
    const isDemo = user.demoMode === 1;

    const tick = derivService.getLatestTick();
    const entryPrice = tick.price;
    const atr = result.atrValue || 100;
    const stop = Math.max(50, Math.min(200, atr * (strategy.stopMultiplier || 1.5)));
    const tp1 = stop * (strategy.tp1Multiplier || 1.5);
    const tp2 = stop * (strategy.tp2Multiplier || 3.0);

    const stopLoss = result.direction === "BUY" ? entryPrice - stop : entryPrice + stop;
    const takeProfit1 = result.direction === "BUY" ? entryPrice + tp1 : entryPrice - tp1;
    const takeProfit2 = result.direction === "BUY" ? entryPrice + tp2 : entryPrice - tp2;

    const tradeId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await db.insert(tradesTable).values({
      id: tradeId, userId, strategyId: strategy.id,
      direction: result.direction, entryPrice, stake,
      scoreTotal: result.total, scoreTrend: result.c1,
      scoreVolatility: result.c2, scoreTiming: result.c3,
      scorePullback: 0, scoreRisk: 0,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0,
      isDemo: isDemo ? 1 : 0,
      symbol: "R_75",
      tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss, takeProfit1, takeProfit2,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName, rangeContext: null,
      openedAt: now,
      rsiAtEntry: result.rsi5m, stochAtEntry: null, macdAtEntry: null,
    });

    state.openTrade = {
      id: tradeId, direction: result.direction, entryPrice, currentPrice: entryPrice,
      stake, pnl: 0, stopLoss, takeProfit1, takeProfit2,
      breakEvenMoved: false, partialClosed: false, momentumExtensionActive: false,
      openedAt: now,
    };

    state.lastTradeTime = now;
    state.lastSignalScore = result.total;
    state.lastSignalDirection = result.direction;

    this.broadcastToUser(userId, "trade", {
      action: "opened",
      trade: state.openTrade
    });
    this.broadcastBotEvent(userId, state);
    this.logActivity(userId, `Trade opened: ${result.direction} @ ${entryPrice.toFixed(2)} — Stake $${stake.toFixed(2)} — Score ${result.total.toFixed(0)}${isDemo ? " [DEMO]" : ""}`, "info").catch(() => {});
    logger.info({ userId, tradeId, direction: result.direction, score: result.total }, "Trade opened");

    // ── Place live Deriv contract for demo/live accounts ──────────────────
    if (user.tradingMode !== "paper" && user.derivTokenEncrypted) {
      let token: string;
      try { token = decrypt(user.derivTokenEncrypted); } catch (err) {
        logger.error({ userId, err }, "V75 Sniper: failed to decrypt token — staying paper");
        return;
      }
      const self = this;
      placePrecisionLiveContract(
        result.direction as "BUY" | "SELL",
        stake,
        token,
        "R_75",
        15,
        (settlement: PrecisionSettlementResult) => {
          self.handlePrecisionSettlement(userId, tradeId, settlement).catch((err) =>
            logger.error({ userId, tradeId, err }, "V75 Sniper settlement handler error")
          );
        }
      ).then((orderResult) => {
        if (orderResult.success && orderResult.contractId) {
          const s = self.bots.get(userId);
          if (s?.openTrade?.id === tradeId) {
            s.openTrade.precisionContractId = orderResult.contractId;
            s.openTrade.precisionIsLive = true;
            s.openTrade.entryPrice = orderResult.entrySpot ?? s.openTrade.entryPrice;
          }
          db.update(tradesTable).set({ contractId: String(orderResult.contractId) })
            .where(eq(tradesTable.id, tradeId)).catch(() => {});
          logger.info({ userId, tradeId, contractId: orderResult.contractId }, "V75 Sniper live contract placed on R_75");
          self.logActivity(userId, `Sniper Deriv contract #${orderResult.contractId} placed on R_75 — 15m binary — awaiting settlement`, "info").catch(() => {});
        } else {
          logger.warn({ userId, tradeId, error: orderResult.error }, "V75 Sniper contract placement failed — monitoring as paper");
          const sf = self.bots.get(userId);
          if (sf?.openTrade?.id === tradeId) sf.openTrade.precisionFallbackPaper = true;
          self.broadcastToUser(userId, "alert", {
            level: "warning",
            message: `Deriv contract failed: ${orderResult.error}. Monitoring as paper trade.`,
          });
        }
      }).catch((err) => {
        logger.error({ userId, tradeId, err }, "V75 Sniper placePrecisionLiveContract threw");
      });
    }
  }

  private async monitorOpenTrades() {
    const tick = derivService.getLatestTick();
    const currentPrice = tick.price;

    for (const [userId, state] of this.bots.entries()) {
      if (!state.openTrade) continue;
      const trade = state.openTrade;
      const isBuy = trade.direction === "BUY";
      trade.currentPrice = currentPrice;

      const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
      const rawPips = isBuy ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;

      if (state.tradingMode === "paper") {
        const ratio = stopDistance > 0 ? rawPips / stopDistance : 0;
        trade.pnl = Math.round(trade.stake * ratio * 0.85 * 100) / 100;
      } else {
        trade.pnl = rawPips;
      }

      let shouldClose = false;
      let closeReason = "";
      const elapsed = Math.floor(Date.now() / 1000) - trade.openedAt;

      // ── Swing trade monitoring ─────────────────────────────────────────
      if (trade.swingTrade) {
        const swingStopDist = trade.stopDistance || stopDistance;

        // Session end protection (15:00 UTC and 10:00 UTC)
        const utcH = new Date().getUTCHours(), utcM = new Date().getUTCMinutes();
        const isSessionEnd = (utcH === 15 || utcH === 10) && utcM === 0;
        if (isSessionEnd) {
          if (rawPips >= swingStopDist) {
            // In good profit — move to break even
            if (!trade.breakEvenMoved) {
              trade.stopLoss = isBuy ? trade.entryPrice + 5 : trade.entryPrice - 5;
              trade.breakEvenMoved = true;
              this.broadcastToUser(userId, "trade", { action: "break_even", trade });
              this.logActivity(userId, `Swing session-end: BE moved at ${utcH}:00 UTC — profit ${rawPips.toFixed(0)} pip`, "info").catch(() => {});
            }
          } else {
            // Insufficient profit — close at market
            shouldClose = true;
            closeReason = "time_stop";
            this.logActivity(userId, `Swing session-end: closing at ${utcH}:00 UTC — insufficient profit`, "info").catch(() => {});
          }
        }

        if (!shouldClose) {
          // SL hit
          if (isBuy && currentPrice <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
          if (!isBuy && currentPrice >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
        }

        if (!shouldClose) {
          // BE at 1.5× stop distance
          if (!trade.breakEvenMoved && rawPips >= swingStopDist * 1.5) {
            trade.stopLoss = isBuy ? trade.entryPrice + 5 : trade.entryPrice - 5;
            trade.breakEvenMoved = true;
            this.broadcastToUser(userId, "trade", { action: "break_even", trade });
          }

          // TP1 at 2× stop
          if (!trade.partialClosed && rawPips >= swingStopDist * 2.0) {
            trade.partialClosed = true;
            if (!trade.breakEvenMoved) {
              trade.stopLoss = isBuy ? trade.entryPrice + 5 : trade.entryPrice - 5;
              trade.breakEvenMoved = true;
            }
            this.broadcastToUser(userId, "trade", { action: "partial_close", trade });
          }

          // TP2 at 4× stop
          if (trade.partialClosed && rawPips >= swingStopDist * 4.0) {
            shouldClose = true;
            closeReason = "tp2";
          }

          // 6h max hold
          if (elapsed > 6 * 3600) { shouldClose = true; closeReason = "time_stop"; }
        }

        if (shouldClose) {
          await this.closeTrade(userId, state, trade, currentPrice, closeReason);
        }
        continue;
      }

      // ── Reversal trade monitoring ──────────────────────────────────────
      if (trade.reversalTrade) {
        // SL
        if (isBuy && currentPrice <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
        if (!isBuy && currentPrice >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }

        if (!shouldClose) {
          // TP — single target: middle Bollinger Band
          const tp = trade.reversalTargetPrice ?? trade.takeProfit1;
          if (isBuy && currentPrice >= tp) { shouldClose = true; closeReason = "tp2"; }
          if (!isBuy && currentPrice <= tp) { shouldClose = true; closeReason = "tp2"; }

          // 20-minute time stop
          if (elapsed > 20 * 60) { shouldClose = true; closeReason = "time_stop"; }
        }

        if (shouldClose) {
          await this.closeTrade(userId, state, trade, currentPrice, closeReason);
          // Set 30-minute cooldown after any reversal trade closes
          const state2 = this.bots.get(userId);
          if (state2) {
            state2.reversalCooldownUntil = Math.floor(Date.now() / 1000) + 15 * 60;
            this.logActivity(userId, "Reversal cooldown: 15 minutes until next entry", "info").catch(() => {});
          }
        }
        continue;
      }

      // ── V10 Precision Scalper trade monitoring ─────────────────────────
      if (trade.v10PrecisionTrade) {
        const v10pPrice = derivService.getLatestTickForPair("R_10").price;
        trade.currentPrice = v10pPrice;

        // Live Deriv contract — settlement arrives via WebSocket callback.
        // Only apply an emergency time-stop (35 min) in case the callback never fires.
        if (trade.precisionIsLive) {
          if (elapsed > 35 * 60) {
            logger.warn({ userId, tradeId: trade.id }, "V10P emergency time-stop: Deriv settlement never arrived");
            await this.handlePrecisionSettlement(userId, trade.id, {
              won: false,
              pnl: -trade.stake,
              exitSpot: v10pPrice,
              contractId: trade.precisionContractId ?? 0,
            });
          }
          continue;
        }

        // Paper mode — simulate using live tick feed
        const v10pStopDist = Math.abs(trade.entryPrice - trade.stopLoss);
        const v10pPips = trade.direction === "BUY" ? v10pPrice - trade.entryPrice : trade.entryPrice - v10pPrice;
        trade.pnl = Math.round(trade.stake * (v10pStopDist > 0 ? v10pPips / v10pStopDist : 0) * 0.87 * 100) / 100;

        // SL check
        if (trade.direction === "BUY" && v10pPrice <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
        if (trade.direction === "SELL" && v10pPrice >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }

        if (!shouldClose) {
          // TP check (50% SL target)
          const tp = trade.v10PrecisionTargetPrice ?? trade.takeProfit1;
          if (trade.direction === "BUY" && v10pPrice >= tp) { shouldClose = true; closeReason = "tp2"; }
          if (trade.direction === "SELL" && v10pPrice <= tp) { shouldClose = true; closeReason = "tp2"; }

          // 25-minute time stop
          if (elapsed > 25 * 60) { shouldClose = true; closeReason = "time_stop"; }
        }

        if (shouldClose) {
          await this.closeTrade(userId, state, trade, v10pPrice, closeReason);
          const state2 = this.bots.get(userId);
          if (state2) {
            state2.v10PrecisionCooldownUntil = Math.floor(Date.now() / 1000) + 3 * 60;
          }
        }
        continue;
      }

      // ── V10 trade monitoring ───────────────────────────────────────────
      if (trade.v10Trade) {
        const v10Price = derivService.getLatestTickForPair("R_10").price;
        trade.currentPrice = v10Price;

        // Live Deriv contract — settlement arrives via WebSocket callback.
        // Only apply an emergency time-stop (20 min) if the callback never fires.
        if (trade.precisionIsLive) {
          if (elapsed > 20 * 60) {
            logger.warn({ userId, tradeId: trade.id }, "V10 Range Scalper emergency time-stop: Deriv settlement never arrived");
            await this.handlePrecisionSettlement(userId, trade.id, {
              won: false,
              pnl: -trade.stake,
              exitSpot: v10Price,
              contractId: trade.precisionContractId ?? 0,
            });
          }
          continue;
        }

        const v10StopDist = Math.abs(trade.entryPrice - trade.stopLoss);
        const v10Pips = trade.direction === "BUY" ? v10Price - trade.entryPrice : trade.entryPrice - v10Price;
        if (state.tradingMode === "paper") {
          trade.pnl = Math.round(trade.stake * (v10StopDist > 0 ? v10Pips / v10StopDist : 0) * 0.85 * 100) / 100;
        } else {
          trade.pnl = v10Pips;
        }

        // SL
        if (trade.direction === "BUY" && v10Price <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
        if (trade.direction === "SELL" && v10Price >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }

        if (!shouldClose) {
          // TP — single target: middle Bollinger Band
          const tp = trade.v10TargetPrice ?? trade.takeProfit1;
          if (trade.direction === "BUY" && v10Price >= tp) { shouldClose = true; closeReason = "tp2"; }
          if (trade.direction === "SELL" && v10Price <= tp) { shouldClose = true; closeReason = "tp2"; }

          // 15-minute time stop
          if (elapsed > 15 * 60) { shouldClose = true; closeReason = "time_stop"; }
        }

        if (shouldClose) {
          await this.closeTrade(userId, state, trade, v10Price, closeReason);
          const state2 = this.bots.get(userId);
          if (state2) {
            state2.v10CooldownUntil = Math.floor(Date.now() / 1000) + 3 * 60;
          }
        }
        continue;
      }

      // ── Standard (sniper) trade monitoring ────────────────────────────

      // Live Deriv contract — settlement arrives via WebSocket callback.
      // Only apply an emergency time-stop (30 min) if the callback never fires.
      if (trade.precisionIsLive) {
        if (elapsed > 30 * 60) {
          logger.warn({ userId, tradeId: trade.id }, "V75 Sniper emergency time-stop: Deriv settlement never arrived");
          await this.handlePrecisionSettlement(userId, trade.id, {
            won: false,
            pnl: -trade.stake,
            exitSpot: currentPrice,
            contractId: trade.precisionContractId ?? 0,
          });
        }
        continue;
      }

      // Stop loss
      if (isBuy && currentPrice <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
      if (!isBuy && currentPrice >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }

      if (!shouldClose) {
        // Break even (profit >= 1× stop distance)
        if (!trade.breakEvenMoved && rawPips >= stopDistance) {
          trade.stopLoss = isBuy ? trade.entryPrice + 2 : trade.entryPrice - 2;
          trade.breakEvenMoved = true;
          this.broadcastToUser(userId, "trade", { action: "break_even", trade });
        }

        // TP1 partial close (profit >= 1.5× stop distance)
        if (!trade.partialClosed && rawPips >= stopDistance * 1.5) {
          trade.partialClosed = true;
          if (!trade.breakEvenMoved) {
            trade.stopLoss = isBuy ? trade.entryPrice + 2 : trade.entryPrice - 2;
            trade.breakEvenMoved = true;
          }
          this.broadcastToUser(userId, "trade", { action: "partial_close", trade });
        }

        // TP2 full close (profit >= 3× stop distance)
        if (trade.partialClosed && rawPips >= stopDistance * 3) {
          shouldClose = true;
          closeReason = "tp2";
        }

        // Time stop (45 min)
        if (elapsed > 45 * 60) { shouldClose = true; closeReason = "time_stop"; }
      }

      if (shouldClose) {
        await this.closeTrade(userId, state, trade, currentPrice, closeReason);
      }
    }
  }

  private async closeTrade(userId: string, state: BotState, trade: OpenTrade, exitPrice: number, reason: string) {
    const isBuy = trade.direction === "BUY";
    const rawPips = isBuy ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss) || 100;
    const now = Math.floor(Date.now() / 1000);
    const duration = Math.floor((now - trade.openedAt) / 60);

    let pnl: number;
    const isPaper = state.tradingMode === "paper";

    // V10 Precision paper trades use binary-options P&L (87% payout, not pip-based).
    // Also applies when live placement failed and bot fell back to paper monitoring.
    if (trade.v10PrecisionTrade && (isPaper || trade.precisionFallbackPaper)) {
      if (reason === "stop_loss") {
        pnl = -trade.stake;
      } else if (reason === "tp2") {
        pnl = Math.round(trade.stake * 0.87 * 100) / 100;
      } else if (reason === "time_stop") {
        // Partial: half-payout if moving in right direction, half-loss otherwise
        pnl = rawPips > 0
          ? Math.round(trade.stake * 0.87 * 0.5 * 100) / 100
          : -Math.round(trade.stake * 0.5 * 100) / 100;
      } else {
        pnl = rawPips > 0 ? Math.round(trade.stake * 0.87 * 100) / 100 : -trade.stake;
      }
    } else if (isPaper) {
      if (reason === "stop_loss") {
        pnl = -trade.stake;
      } else if (reason === "tp2") {
        pnl = trade.stake * 0.85;
      } else if (reason === "time_stop") {
        if (rawPips > 0) {
          const pct = Math.min(1, rawPips / (stopDistance * 3));
          pnl = Math.round(trade.stake * pct * 0.85 * 100) / 100;
        } else {
          const pct = Math.max(-1, rawPips / stopDistance);
          pnl = Math.round(trade.stake * pct * 100) / 100;
        }
      } else {
        pnl = rawPips > 0 ? trade.stake * 0.85 : -trade.stake;
      }
    } else {
      pnl = rawPips;
    }

    pnl = Math.round(pnl * 100) / 100;

    await db.update(tradesTable).set({
      exitPrice, pnl, status: "closed", closedAt: now, durationMinutes: duration,
      breakEvenMoved: trade.breakEvenMoved ? 1 : 0,
      partialClosed: trade.partialClosed ? 1 : 0,
    }).where(eq(tradesTable.id, trade.id));

    const isWin = pnl > 0;
    if (isWin) {
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
      if (state.consecutiveWins >= 5) state.winStreakCautionActive = true;
    } else {
      state.consecutiveLosses++;
      state.consecutiveWins = 0;
      state.winStreakCautionActive = false;
    }
    state.dailyPnl += pnl;
    state.openTrade = null;
    state.pauseReason = null;

    // Update user balance
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (user) {
      const newBalance = Math.round(((user.accountBalance || 100) + pnl) * 100) / 100;
      const newPeak = Math.max(user.peakBalance || newBalance, newBalance);
      state.currentDrawdown = (newPeak - newBalance) / newPeak;
      state.peakBalance = newPeak;

      // Recovery mode
      if (state.currentDrawdown >= 0.15 && !state.recoveryModeActive) {
        state.recoveryModeActive = true;
        this.broadcastToUser(userId, "alert", { level: "warning", message: "Recovery mode activated — stake reduced 50%" });
      }
      if (state.recoveryModeActive && newBalance >= newPeak * 0.95) {
        state.recoveryModeActive = false;
        this.broadcastToUser(userId, "alert", { level: "info", message: "Recovery complete — returning to normal stake" });
      }

      await db.update(usersTable).set({
        accountBalance: newBalance,
        peakBalance: newPeak,
      }).where(eq(usersTable.id, userId));

      // Async-confirm the balance from Deriv after writing the calculated value
      if (user.tradingMode !== "paper") {
        this.syncDerivBalanceBackground(userId, user.derivTokenEncrypted, state);
      }

      // Items 4+5: check capital preservation + hard stop after balance update
      const preservation = this.checkCapitalPreservation(newBalance, 16);
      state.capitalPreservationMode = preservation.active;
      await this.checkHardStop(userId, newBalance, newPeak, state);
    }

    this.broadcastToUser(userId, "trade", { action: "closed", result: isWin ? "win" : "loss", pnl, tradeId: trade.id, exitPrice });
    this.broadcastBotEvent(userId, state);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const closeReasonLabel = reason === "stop_loss" ? "Stop loss" : reason === "tp2" ? "Take profit" : reason === "time_stop" ? "Time stop" : reason;
    this.logActivity(userId, `Trade closed: ${closeReasonLabel} — ${pnlStr} — ${isWin ? "WIN" : "LOSS"}`, isWin ? "win" : "loss").catch(() => {});
    logger.info({ userId, tradeId: trade.id, pnl, reason }, "Trade closed");
  }

  // ── Post-settlement Deriv balance sync ───────────────────────────────────
  // Fires asynchronously after a live trade settles. The calculated P&L is
  // already written to DB — this overwrites it with the confirmed Deriv balance
  // so the displayed number is always authoritative. Failures are silent (the
  // calculated balance remains until the next sync).
  private syncDerivBalanceBackground(
    userId: string,
    encryptedToken: string | null | undefined,
    state: BotState,
  ): void {
    if (!encryptedToken) return;
    let rawToken: string;
    try { rawToken = decrypt(encryptedToken); } catch { return; }

    fetchDerivBalance(rawToken)
      .then(async (derivBalance) => {
        const newPeak = Math.max(state.peakBalance || derivBalance, derivBalance);
        await db.update(usersTable).set({
          accountBalance: derivBalance,
          peakBalance: newPeak,
        }).where(eq(usersTable.id, userId));
        state.peakBalance = newPeak;
        state.currentDrawdown = newPeak > 0 ? (newPeak - derivBalance) / newPeak : 0;
        this.broadcastBotEvent(userId, state);
        logger.info({ userId, derivBalance }, "Post-settlement Deriv balance confirmed");
      })
      .catch((err) => {
        logger.warn({ err, userId }, "Post-settlement Deriv balance sync failed — calculated balance retained");
      });
  }

  addSseClient(userId: string, fn: (data: string) => void) {
    if (!this.sseClients.has(userId)) this.sseClients.set(userId, new Set());
    this.sseClients.get(userId)!.add(fn);
    return () => this.sseClients.get(userId)?.delete(fn);
  }

  broadcastToUser(userId: string, type: string, payload: unknown) {
    const clients = this.sseClients.get(userId);
    if (!clients || clients.size === 0) return;
    const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
    clients.forEach((fn) => fn(msg));
  }

  broadcastBotEvent(userId: string, state: BotState) {
    this.broadcastToUser(userId, "bot", {
      status: state.isRunning ? "active" : "paused",
      isRunning: state.isRunning,
      pauseReason: state.pauseReason,
      killSwitchActive: state.killSwitchActive,
      openTrade: state.openTrade,
      consecutiveLosses: state.consecutiveLosses,
      consecutiveWins: state.consecutiveWins,
      todayTrades: state.todayTrades,
      thisHourTrades: state.thisHourTrades,
      recoveryMode: state.recoveryModeActive,
      winStreakCaution: state.winStreakCautionActive,
      spikeDetected: state.spikeDetected,
      consolidation: state.consolidationDetected,
      dailyLossHit: state.dailyLossHit,
      currentDrawdown: state.currentDrawdown,
      dailyPnl: state.dailyPnl,
      currentScore: state.currentScore,
      scoreBreakdown: state.scoreBreakdown,
      rangeContext: state.rangeContext,
      cooldownSecondsRemaining: state.cooldownSecondsRemaining,
      strategyCircuitBreakerActive: state.strategyCircuitBreakerActive,
      capitalPreservationMode: state.capitalPreservationMode,
      hardStopped: state.hardStopped,
      microStakeRecoveryMode: state.microStakeRecoveryMode,
    });
  }

  getOrCreate(userId: string, tradingMode: string): BotState {
    if (!this.bots.has(userId)) {
      this.bots.set(userId, {
        isRunning: false, killSwitchActive: false, tradingMode,
        todayTrades: 0, thisHourTrades: 0, consecutiveLosses: 0, consecutiveWins: 0,
        dailyPnl: 0, dailyStartBalance: 0, peakBalance: 0,
        currentDrawdown: 0, recoveryModeActive: false, winStreakCautionActive: false,
        dailyLossHit: false, sessionMultiplier: 1.0, adaptiveWeightsActive: false,
        pauseReason: null, lastSignalScore: null, lastSignalDirection: null, currentScore: null,
        openTrade: null, rangeContext: null, spikeDetected: false, consolidationDetected: false,
        firstCandleWaiting: false, strategyCircuitBreakerActive: false, cooldownSecondsRemaining: null,
        scoreBreakdown: null, lastScoreResult: null, lastTradeTime: null, spikeWaitCandles: 0,
        hourlyTradeReset: 0,
        swingConsolidation: null, swingBreakout: null, swingLastEval1hTime: 0,
        reversalCooldownUntil: null,
        v10CooldownUntil: null, v10CleanlinessScore: null, v10TrendRisk: false, v10Adx: null,
        v10PrecisionCooldownUntil: null,
        capitalPreservationMode: false, hardStopped: false, microStakeRecoveryMode: false,
      });
    }
    return this.bots.get(userId)!;
  }

  start(userId: string) {
    const state = this.bots.get(userId);
    if (state) {
      state.isRunning = true;
      state.killSwitchActive = false;
      state.pauseReason = null;
      state.dailyLossHit = false;
      this.broadcastBotEvent(userId, state);
      this.logActivity(userId, "Bot started", "info").catch(() => {});
      this.writeHeartbeat(userId).catch(() => {});
    }
  }

  stop(userId: string) {
    const state = this.bots.get(userId);
    if (state) {
      state.isRunning = false;
      this.broadcastBotEvent(userId, state);
      this.logActivity(userId, "Bot stopped", "info").catch(() => {});
      this.writeHeartbeat(userId).catch(() => {});
    }
  }

  kill(userId: string) {
    const state = this.bots.get(userId);
    if (state) {
      state.killSwitchActive = true;
      state.isRunning = false;
      state.pauseReason = "Kill switch active";
      this.broadcastBotEvent(userId, state);
      this.logActivity(userId, "Kill switch activated", "warning").catch(() => {});
      this.writeHeartbeat(userId).catch(() => {});
    }
  }

  pauseBot(userId: string, reason: string) {
    const state = this.bots.get(userId);
    if (state) {
      state.isRunning = false;
      state.pauseReason = reason;
      this.broadcastBotEvent(userId, state);
    }
  }

  resetKill(userId: string) {
    const state = this.bots.get(userId);
    if (state) {
      state.killSwitchActive = false;
      state.pauseReason = null;
      this.logActivity(userId, "Kill switch reset", "info").catch(() => {});
    }
  }

  get(userId: string): BotState | undefined {
    return this.bots.get(userId);
  }

  broadcastAll(type: string, payload: unknown) {
    for (const userId of this.sseClients.keys()) {
      this.broadcastToUser(userId, type, payload);
    }
  }

  async logActivity(userId: string, message: string, level: "info" | "win" | "loss" | "warning" | "error" = "info") {
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.insert(botActivityLogTable).values({
        id: randomUUID(), userId, message, level, createdAt: now,
      });
    } catch {}
    this.broadcastToUser(userId, "activity", { message, level, createdAt: now });
  }

  async logError(message: string, stack?: string) {
    try {
      await db.insert(systemErrorLogTable).values({
        id: randomUUID(), message, stack: stack || null, createdAt: Math.floor(Date.now() / 1000),
      });
    } catch {}
    logger.error({ message, stack }, "System error logged");
  }

  async writeHeartbeat(userId: string) {
    const state = this.bots.get(userId);
    if (!state) return;
    const now = Math.floor(Date.now() / 1000);
    const status = state.isRunning ? "running" : state.killSwitchActive ? "killed" : "idle";
    try {
      const existing = await db.select().from(botInstancesTable).where(eq(botInstancesTable.userId, userId)).limit(1);
      if (existing.length) {
        await db.update(botInstancesTable).set({
          status, lastHeartbeatAt: now, tradesToday: state.todayTrades,
        }).where(eq(botInstancesTable.userId, userId));
      } else {
        await db.insert(botInstancesTable).values({
          id: randomUUID(), userId, status, lastHeartbeatAt: now,
          tradesToday: state.todayTrades, createdAt: now,
        });
      }
    } catch {}
  }

  killAll() {
    for (const [userId, state] of this.bots.entries()) {
      if (state.isRunning || !state.killSwitchActive) {
        state.killSwitchActive = true;
        state.isRunning = false;
        state.pauseReason = "Kill switch active";
        this.broadcastBotEvent(userId, state);
      }
    }
  }

  countRunning(): number {
    let count = 0;
    for (const state of this.bots.values()) {
      if (state.isRunning) count++;
    }
    return count;
  }

  // ── Item 4: Capital Preservation ──────────────────────────────────────
  private checkCapitalPreservation(balance: number, currentThreshold: number) {
    const TRIGGER = 80;
    const EXIT = 100;
    const PRES_THRESHOLD = 23;
    if (balance <= TRIGGER) {
      return { active: true, stake: 1.00, scoreThreshold: PRES_THRESHOLD, message: `Capital preservation — balance $${balance.toFixed(2)} below $${TRIGGER}. Fixed $1 stake, score ${PRES_THRESHOLD}+ required.` };
    }
    if (balance > EXIT) {
      return { active: false, stake: balance * 0.01, scoreThreshold: currentThreshold, message: null };
    }
    return { active: true, stake: Math.max(1.00, balance * 0.01), scoreThreshold: PRES_THRESHOLD, message: null };
  }

  // ── Item 5: Hard Stop ─────────────────────────────────────────────────
  private async checkHardStop(userId: string, balance: number, peakBalance: number, state: BotState) {
    const drawdownFromPeak = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
    if (balance > 50 && drawdownFromPeak < 0.50) return;

    logger.warn({ userId, balance, peakBalance, drawdownFromPeak }, "Hard stop triggered");
    state.isRunning = false;
    state.hardStopped = true;
    state.pauseReason = `Hard stop — balance $${balance.toFixed(2)}`;

    const restartTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    try {
      await db.update(usersTable).set({ botHardStopped: 1, autoRestartAt: restartTime }).where(eq(usersTable.id, userId));
    } catch {}

    this.broadcastToUser(userId, "hard_stop", {
      balance, peakBalance, drawdown: drawdownFromPeak, restartAt: restartTime * 1000,
      message: `Bot stopped at $${balance.toFixed(2)}. Auto-restart in 24 hours with micro-stake recovery.`,
    });
    this.broadcastToUser(userId, "alert", {
      level: "error",
      message: `🛑 HARD STOP — Balance $${balance.toFixed(2)}. Bot stopped. Auto-restart in 24 hours.`,
    });
    this.broadcastBotEvent(userId, state);
    await this.logActivity(userId, `Hard stop triggered — balance $${balance.toFixed(2)}, drawdown ${(drawdownFromPeak * 100).toFixed(1)}%`, "error").catch(() => {});
  }

  async checkAutoRestart() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = await db.select().from(usersTable)
        .where(and(eq(usersTable.botHardStopped, 1)));
      const due = rows.filter(u => (u.autoRestartAt || 0) <= now && (u.autoRestartAt || 0) > 0);

      for (const user of due) {
        logger.info({ userId: user.id }, "Auto-restarting bot after hard stop");
        await db.update(usersTable).set({ botHardStopped: 0, autoRestartAt: null }).where(eq(usersTable.id, user.id));
        const state = this.bots.get(user.id);
        if (state) {
          this.startMicroStakeRecovery(user.id);
        }
      }
    } catch (err) {
      logger.error({ err }, "checkAutoRestart error");
    }
  }

  startMicroStakeRecovery(userId: string) {
    const state = this.bots.get(userId);
    if (!state) return;
    state.microStakeRecoveryMode = true;
    state.hardStopped = false;
    state.isRunning = true;
    state.pauseReason = null;
    state.dailyLossHit = false;
    this.broadcastBotEvent(userId, state);
    this.broadcastToUser(userId, "alert", { level: "info", message: "🔄 Bot auto-restarted in micro-stake recovery mode. $1 stake, score 23+ required." });
    this.logActivity(userId, "Micro-stake recovery mode started after hard stop", "info").catch(() => {});
  }

  // ── Item 6: Daily Compound ────────────────────────────────────────────
  private async runDailyCompound(userId: string) {
    try {
      const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      const user = users[0];
      if (!user) return;
      const balance = user.accountBalance || 0;
      const previousStake = user.stakeSize || 1.00;
      let riskPercent: number;
      if (balance < 200) { riskPercent = 0.01; }
      else if (balance < 500) { riskPercent = 0.015; }
      else if (balance < 1000) { riskPercent = 0.02; }
      else { riskPercent = 0.015; }
      const newStake = Math.max(1.00, Math.min(50.00, balance * riskPercent));
      await db.update(usersTable).set({ stakeSize: newStake, dailyStartBalance: balance }).where(eq(usersTable.id, userId));
      if (Math.abs(newStake - previousStake) >= 0.01) {
        this.broadcastToUser(userId, "alert", {
          level: "info",
          message: `💹 Daily compound: stake $${previousStake.toFixed(2)} → $${newStake.toFixed(2)} (${(riskPercent * 100).toFixed(1)}% of $${balance.toFixed(2)})`,
        });
        await this.logActivity(userId, `Daily compound: stake $${previousStake.toFixed(2)} → $${newStake.toFixed(2)}`, "info").catch(() => {});
      }
      logger.info({ userId, balance, newStake, riskPercent }, "Daily compound complete");
    } catch (err) {
      logger.error({ err, userId }, "Daily compound error");
    }
  }

  scheduleDailyCompound() {
    const msUntilMidnightUTC = () => {
      const now = new Date();
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      return midnight.getTime() - now.getTime();
    };
    const scheduleNext = () => {
      setTimeout(async () => {
        try {
          const activeUsers = await db.select().from(usersTable)
            .where(and(eq(usersTable.isActive, 1), eq(usersTable.autoCompoundEnabled, 1)));
          for (const u of activeUsers) { await this.runDailyCompound(u.id); }
        } catch (err) { logger.error({ err }, "Daily compound batch error"); }
        scheduleNext();
      }, msUntilMidnightUTC());
    };
    scheduleNext();
    const hrs = (msUntilMidnightUTC() / 3600000).toFixed(1);
    logger.info({ hoursUntilMidnight: hrs }, "Daily compound scheduled for midnight UTC");
  }

  // ── Item 7: Conviction Sizing ─────────────────────────────────────────
  private calculateConvictionStake(baseStake: number, score: number, maxScore: number, balance: number): number {
    const scorePercent = score / maxScore;
    let multiplier: number;
    if (scorePercent >= 0.96) { multiplier = 1.5; }
    else if (scorePercent >= 0.88) { multiplier = 1.25; }
    else if (scorePercent >= 0.80) { multiplier = 1.0; }
    else if (scorePercent >= 0.72) { multiplier = 0.75; }
    else { multiplier = 1.0; }
    const maxAllowed = Math.min(50.00, balance * 0.02);
    return Math.max(1.00, Math.min(baseStake * multiplier, maxAllowed));
  }

  // ── Item 3: Rejection Handler ─────────────────────────────────────────
  private async placeOrderWithRetry(direction: "BUY" | "SELL", stake: number, userId: string, token: string, state: BotState) {
    const MAX_RETRIES = 1;
    const RETRY_DELAY = 3000;
    const REJECTION_COOLDOWN = 5 * 60;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        logger.info({ userId, attempt, direction, stake }, "Placing Deriv order");
        const result = await derivService.placeOrder(direction, stake, token);
        if (result.success) return result;
        logger.warn({ userId, attempt, error: result.error }, "Deriv order rejected");
        if (attempt <= MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }
        state.isRunning = false;
        state.pauseReason = `Deriv rejected: ${result.error}`;
        this.broadcastBotEvent(userId, state);
        this.broadcastToUser(userId, "alert", { level: "error", message: `⚠️ Trade rejected by Deriv: ${result.error}. Bot paused — resume manually.` });
        await this.logActivity(userId, `Deriv order rejected: ${result.error} — bot paused`, "error").catch(() => {});
        try {
          await db.insert(authLogTable).values({
            id: randomUUID(), username: userId, event: "trade_rejected",
            details: JSON.stringify({ direction, stake, error: result.error, attempts: attempt }),
            timestamp: Math.floor(Date.now() / 1000),
          });
        } catch {}
        return { success: false, error: result.error };
      } catch (err) {
        if (attempt <= MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }
        state.isRunning = false;
        state.pauseReason = "Network error placing order";
        this.broadcastBotEvent(userId, state);
        return { success: false, error: String(err) };
      }
    }
    return { success: false, error: "Max retries exceeded" };
  }

  // ── Item 2: Contract Sync ─────────────────────────────────────────────
  async syncDerivContracts(userId: string) {
    try {
      const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      const user = users[0];
      if (!user || user.tradingMode === "paper") return;

      const dbOpenTrades = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.userId, userId), eq(tradesTable.status, "open"), eq(tradesTable.isPaper, 0)));

      if (dbOpenTrades.length === 0) return;

      let derivContracts: DerivContract[] = [];
      try {
        derivContracts = await derivService.getOpenContracts();
      } catch (err) {
        logger.error({ err, userId }, "Failed to fetch Deriv portfolio");
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      if (derivContracts.length === 0 && dbOpenTrades.length > 0) {
        for (const dbTrade of dbOpenTrades) {
          logger.warn({ userId, tradeId: dbTrade.id }, "Trade closed during disconnect");
          await db.update(tradesTable).set({
            status: "closed", closedAt: now, pnl: 0,
            exitPrice: dbTrade.entryPrice,
          }).where(eq(tradesTable.id, dbTrade.id));
          this.broadcastToUser(userId, "alert", {
            level: "warning",
            message: "⚠️ Trade closed while bot was disconnected. Check Deriv for final P&L.",
          });
          const state = this.bots.get(userId);
          if (state) { state.openTrade = null; }
        }
      }

      await db.update(usersTable).set({ lastContractSync: now }).where(eq(usersTable.id, userId));
      logger.info({ userId, dbTrades: dbOpenTrades.length, derivContracts: derivContracts.length }, "Contract sync complete");
    } catch (err) {
      logger.error({ err, userId }, "Contract sync error");
    }
  }
}

export const botManager = new BotManager();
