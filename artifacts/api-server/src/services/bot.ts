import { db } from "@workspace/db";
import {
  usersTable, tradesTable, signalLogTable, strategiesTable,
  adaptiveWeightsTable, sessionPerformanceTable, systemSettingsTable,
  botActivityLogTable, systemErrorLogTable, botInstancesTable
} from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { derivService } from "./deriv.js";
import { score, type ScoreResult } from "./scoring.js";
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
}

interface ScoreBreakdown {
  trend: number;
  volatility: number;
  timing: number;
  pullback: number;
  risk: number;
  total: number;
  direction: string;
  trendDirection: string;
  bandTouched: string;
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
    const balance = user.accountBalance || 5000;
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
    const maxLosses: Record<string, number> = { safe: 3, pro: 4, aggressive: 5 };
    const maxConsecLosses = maxLosses[user.tradingProfile || "safe"] || 3;
    if (state.consecutiveLosses >= maxConsecLosses) {
      state.isRunning = false;
      state.pauseReason = `${state.consecutiveLosses} consecutive losses — tap Resume to continue`;
      this.broadcastBotEvent(userId, state);
      return;
    }

    // CHECK 10 — Cooldown (10 minutes since last trade)
    if (state.lastTradeTime) {
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
    if (state.todayTrades >= (strategy.maxTradesDay || 6)) {
      state.pauseReason = "Daily trade limit reached";
      this.broadcastBotEvent(userId, state);
      return;
    }

    const hourStart = now - 3600;
    const hourTradesRes = await db.select({ count: sql<number>`count(*)` }).from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.openedAt, hourStart)));
    state.thisHourTrades = Number(hourTradesRes[0]?.count || 0);
    if (state.thisHourTrades >= (strategy.maxTradesHour || 2)) {
      state.pauseReason = "Hourly limit reached";
      this.broadcastBotEvent(userId, state);
      return;
    }

    // Run scoring engine
    const candles5m = derivService.getCandles("5m", 100);
    const candles15m = derivService.getCandles("15m", 60);

    const result = score(
      candles1m, candles5m, candles15m,
      state.dailyPnl, peak, balance,
      state.consecutiveLosses
    );

    if (!result) {
      const loaded = candles15m.length;
      state.pauseReason = null;
      state.currentScore = null;
      this.broadcastToUser(userId, "scores", {
        loading: true,
        message: "Gathering market data...",
        candlesLoaded: loaded
      });
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.currentScore = result.total;
    state.rangeContext = result.rangeContext;
    state.spikeDetected = result.spikeDetected;
    state.consolidationDetected = result.consolidationDetected;
    state.lastScoreResult = result;
    state.scoreBreakdown = {
      trend: result.trend,
      volatility: result.volatility,
      timing: result.timing,
      pullback: result.pullback,
      risk: result.risk,
      total: result.total,
      direction: result.direction,
      trendDirection: result.trendDirection,
      bandTouched: result.bandTouched,
    };

    // Broadcast scores via SSE
    this.broadcastToUser(userId, "scores", {
      total: result.total,
      trend: result.trend,
      volatility: result.volatility,
      timing: result.timing,
      pullback: result.pullback,
      risk: result.risk,
      signal: result.direction,
      direction: result.direction,
      loading: false,
      ema9: result.ema9,
      ema21: result.ema21,
      adx: result.adx,
      rsi: result.rsi,
      bbUpper: result.bbUpper,
      bbLower: result.bbLower,
      stochK: result.stochK,
      macdHistogram: result.macdHistogram,
      rangeContext: result.rangeContext,
      consolidation: result.consolidationDetected,
      spikeDetected: result.spikeDetected,
      trendDirection: result.trendDirection,
      bandTouched: result.bandTouched,
      pullbackZone: result.pullbackZoneActive,
      rejectionReason: null,
    });

    // Log signal
    const signalId = randomUUID();
    const threshold = strategy.scoreThreshold || 38;
    const action = result.total >= threshold && result.direction !== "NONE" ? "executed" : "rejected";
    const rejectionReason = action === "rejected"
      ? result.direction === "NONE" ? "No clear signal" : `Score ${result.total} < threshold ${threshold}`
      : null;

    await db.insert(signalLogTable).values({
      id: signalId, userId, strategyId: strategy.id, timestamp: now,
      scoreTotal: result.total, scoreTrend: result.trend, scoreVolatility: result.volatility,
      scoreTiming: result.timing, scorePullback: result.pullback, scoreRisk: result.risk,
      direction: result.direction, action, rejectionReason,
      ema9: result.ema9, ema21: result.ema21, rsi: result.rsi,
      rangeContext: result.rangeContext, sessionName: currentSession?.name || null,
      consolidationDetected: result.consolidationDetected ? 1 : 0,
      spikeDetected: result.spikeDetected ? 1 : 0,
    });

    if (action !== "executed" || result.direction === "NONE") {
      state.pauseReason = rejectionReason;
      this.broadcastBotEvent(userId, state);
      return;
    }

    state.pauseReason = null;
    await this.executeTrade(userId, user, strategy, result, currentSession?.name || null, state);
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
    const balance = user.accountBalance || 5000;
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
      scoreTotal: result.total, scoreTrend: result.trend,
      scoreVolatility: result.volatility, scoreTiming: result.timing,
      scorePullback: result.pullback, scoreRisk: result.risk,
      isCopyTrade: 0, isPaper: user.tradingMode === "paper" ? 1 : 0,
      isDemo: isDemo ? 1 : 0,
      symbol: "R_75",
      tradingMode: user.tradingMode || "paper", status: "open",
      stopLoss, takeProfit1, takeProfit2,
      recoveryModeActive: state.recoveryModeActive ? 1 : 0,
      winStreakCautionActive: state.winStreakCautionActive ? 1 : 0,
      sessionName, rangeContext: result.rangeContext,
      openedAt: now,
      rsiAtEntry: result.rsi, stochAtEntry: result.stochK, macdAtEntry: result.macdHistogram,
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
          // Move stop to break even if not already
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
        const elapsed = Math.floor(Date.now() / 1000) - trade.openedAt;
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

    if (isPaper) {
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
      const newBalance = Math.round(((user.accountBalance || 5000) + pnl) * 100) / 100;
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
    }

    this.broadcastToUser(userId, "trade", { action: "closed", result: isWin ? "win" : "loss", pnl, tradeId: trade.id, exitPrice });
    this.broadcastBotEvent(userId, state);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const closeReasonLabel = reason === "stop_loss" ? "Stop loss" : reason === "tp2" ? "Take profit" : reason === "time_stop" ? "Time stop" : reason;
    this.logActivity(userId, `Trade closed: ${closeReasonLabel} — ${pnlStr} — ${isWin ? "WIN" : "LOSS"}`, isWin ? "win" : "loss").catch(() => {});
    logger.info({ userId, tradeId: trade.id, pnl, reason }, "Trade closed");
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
}

export const botManager = new BotManager();
