import { db } from "@workspace/db";
import {
  usersTable, tradesTable, signalLogTable, strategiesTable,
  adaptiveWeightsTable, sessionPerformanceTable, systemSettingsTable
} from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { derivService } from "./deriv.js";
import { score } from "./scoring.js";
import { getCurrentSession, isInSession } from "./sessions.js";
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
  currentDrawdown: number;
  recoveryModeActive: boolean;
  winStreakCautionActive: boolean;
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
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startGlobalLoop();
  }

  private startGlobalLoop() {
    // Check on every new 1m candle close (poll tick every 5s, check 5m candles)
    this.monitorInterval = setInterval(() => {
      this.monitorOpenTrades();
      this.checkNewCandle();
    }, 5000);
  }

  private async checkNewCandle() {
    const candles1m = derivService.getCandles("1m", 5);
    if (!candles1m.length) return;
    const latest = candles1m[candles1m.length - 1];
    if (latest.time === this.lastCandleTime) return;
    this.lastCandleTime = latest.time;

    // Run evaluation for each active bot
    for (const [userId, state] of this.bots.entries()) {
      if (!state.isRunning || state.killSwitchActive) continue;
      if (state.openTrade) continue; // already in trade
      try {
        await this.evaluateSignal(userId, state);
      } catch (err) {
        logger.error({ err, userId }, "Bot evaluation error");
      }
    }
  }

  private async evaluateSignal(userId: string, state: BotState) {
    // Check master stop
    const ms = await db.select().from(systemSettingsTable).where(eq(systemSettingsTable.key, "master_stop")).limit(1);
    if (ms[0]?.value === "true") {
      state.pauseReason = "Master stop active";
      return;
    }

    // Get user and strategy
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user || !user.strategyId) return;

    const strats = await db.select().from(strategiesTable).where(eq(strategiesTable.id, user.strategyId)).limit(1);
    const strategy = strats[0];
    if (!strategy || strategy.status !== "active") return;

    state.strategyCircuitBreakerActive = strategy.circuitBreakerActive === 1;
    if (state.strategyCircuitBreakerActive) {
      state.pauseReason = "Strategy circuit breaker active";
      return;
    }

    // Session check
    const sessionsEnabled = JSON.parse(strategy.sessionsEnabled || "[]") as string[];
    const currentSession = getCurrentSession();
    if (sessionsEnabled.length > 0 && !isInSession(sessionsEnabled)) {
      state.pauseReason = `Outside trading sessions`;
      return;
    }
    state.pauseReason = null;

    // Trade limit checks
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTrades = await db.select({ count: sql<number>`count(*)` }).from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.openedAt, Math.floor(todayStart.getTime() / 1000))));
    state.todayTrades = Number(todayTrades[0]?.count || 0);
    if (state.todayTrades >= (strategy.maxTradesDay || 6)) {
      state.pauseReason = "Daily trade limit reached";
      return;
    }

    // Run scoring engine
    const candles1m = derivService.getCandles("1m", 200);
    const candles5m = derivService.getCandles("5m", 100);
    const candles15m = derivService.getCandles("15m", 60);

    const result = score(
      candles1m, candles5m, candles15m,
      state.dailyPnl, user.peakBalance || 5000, user.accountBalance || 5000,
      state.consecutiveLosses
    );

    if (!result) {
      state.pauseReason = "Gathering market data...";
      state.currentScore = null;
      return;
    }

    state.currentScore = result.total;
    state.rangeContext = result.rangeContext;
    state.spikeDetected = result.spikeDetected;
    state.consolidationDetected = result.consolidationDetected;
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

    // Log signal
    const signalId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
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

    if (action !== "executed" || result.direction === "NONE") return;

    // Execute trade
    await this.executeTrade(userId, user, strategy, result, currentSession?.name || null, state);
  }

  private async executeTrade(userId: string, user: any, strategy: any, result: any, sessionName: string | null, state: BotState) {
    const balance = user.accountBalance || 5000;
    const profile = user.tradingProfile || "safe";
    const riskMap: Record<string, number> = { safe: 1.0, pro: 1.5, aggressive: 2.0 };
    const riskPct = riskMap[profile] || 1.0;
    let stake = (balance * riskPct) / 100;
    if (state.winStreakCautionActive) stake *= 0.8;
    if (state.recoveryModeActive) stake *= 0.5;
    stake = Math.max(1, Math.min(50, Math.round(stake * 100) / 100));

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

    this.broadcast(userId, { type: "trade_opened", tradeId, direction: result.direction, entryPrice, stake });
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
      trade.pnl = isBuy ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;

      let shouldClose = false;
      let closeReason = "";

      // Stop loss
      if (isBuy && currentPrice <= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }
      if (!isBuy && currentPrice >= trade.stopLoss) { shouldClose = true; closeReason = "stop_loss"; }

      // TP1
      if (!trade.partialClosed) {
        if (isBuy && currentPrice >= trade.takeProfit1) { trade.partialClosed = true; closeReason = "tp1"; }
        if (!isBuy && currentPrice <= trade.takeProfit1) { trade.partialClosed = true; closeReason = "tp1"; }
      }

      // Break even
      if (!trade.breakEvenMoved && trade.partialClosed) {
        trade.stopLoss = trade.entryPrice;
        trade.breakEvenMoved = true;
      }

      // TP2
      if (trade.partialClosed) {
        if (isBuy && currentPrice >= trade.takeProfit2) { shouldClose = true; closeReason = "tp2"; }
        if (!isBuy && currentPrice <= trade.takeProfit2) { shouldClose = true; closeReason = "tp2"; }
      }

      // Time stop (45 min)
      const elapsed = Math.floor(Date.now() / 1000) - trade.openedAt;
      if (elapsed > 45 * 60) { shouldClose = true; closeReason = "time_stop"; }

      if (shouldClose) {
        await this.closeTrade(userId, state, trade, currentPrice, closeReason);
      }
    }
  }

  private async closeTrade(userId: string, state: BotState, trade: OpenTrade, exitPrice: number, reason: string) {
    const pnl = trade.direction === "BUY" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    const now = Math.floor(Date.now() / 1000);
    const duration = Math.floor((now - trade.openedAt) / 60);

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

    // Update user balance
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (user) {
      const newBalance = (user.accountBalance || 5000) + pnl;
      await db.update(usersTable).set({ accountBalance: newBalance }).where(eq(usersTable.id, userId));
    }

    this.broadcast(userId, { type: "trade_closed", tradeId: trade.id, pnl, reason, exitPrice });
    logger.info({ userId, tradeId: trade.id, pnl, reason }, "Trade closed");
  }

  addSseClient(userId: string, fn: (data: string) => void) {
    if (!this.sseClients.has(userId)) this.sseClients.set(userId, new Set());
    this.sseClients.get(userId)!.add(fn);
    return () => this.sseClients.get(userId)?.delete(fn);
  }

  private broadcast(userId: string, data: unknown) {
    const clients = this.sseClients.get(userId);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach((fn) => fn(msg));
  }

  getOrCreate(userId: string, tradingMode: string): BotState {
    if (!this.bots.has(userId)) {
      this.bots.set(userId, {
        isRunning: false, killSwitchActive: false, tradingMode,
        todayTrades: 0, thisHourTrades: 0, consecutiveLosses: 0, consecutiveWins: 0,
        dailyPnl: 0, currentDrawdown: 0, recoveryModeActive: false, winStreakCautionActive: false,
        sessionMultiplier: 1.0, adaptiveWeightsActive: false, pauseReason: null,
        lastSignalScore: null, lastSignalDirection: null, currentScore: null,
        openTrade: null, rangeContext: null, spikeDetected: false, consolidationDetected: false,
        firstCandleWaiting: false, strategyCircuitBreakerActive: false, cooldownSecondsRemaining: null,
        scoreBreakdown: null,
      });
    }
    return this.bots.get(userId)!;
  }

  start(userId: string) {
    const state = this.bots.get(userId);
    if (state) { state.isRunning = true; state.killSwitchActive = false; state.pauseReason = null; }
  }

  stop(userId: string) {
    const state = this.bots.get(userId);
    if (state) { state.isRunning = false; }
  }

  kill(userId: string) {
    const state = this.bots.get(userId);
    if (state) { state.killSwitchActive = true; state.isRunning = false; state.pauseReason = "Kill switch active"; }
  }

  resetKill(userId: string) {
    const state = this.bots.get(userId);
    if (state) { state.killSwitchActive = false; }
  }

  get(userId: string): BotState | undefined {
    return this.bots.get(userId);
  }
}

export const botManager = new BotManager();
