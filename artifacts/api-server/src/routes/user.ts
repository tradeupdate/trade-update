import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, tradesTable, signalLogTable, strategiesTable,
  sessionPerformanceTable, systemSettingsTable
} from "@workspace/db";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { derivService } from "../services/deriv.js";
import { botManager } from "../services/bot.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

// Dashboard overview
router.get("/dashboard", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todayTs = Math.floor(todayStart.getTime() / 1000);

    const recentTrades = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.openedAt)).limit(10);

    const todayTrades = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.openedAt, todayTs)));

    const sessionPerf = await db.select().from(sessionPerformanceTable)
      .where(eq(sessionPerformanceTable.userId, userId));

    const dailyPnl = todayTrades.filter(t => t.status === "closed").reduce((s, t) => s + (t.pnl || 0), 0);
    const todayWins = todayTrades.filter(t => t.status === "closed" && (t.pnl || 0) > 0).length;
    const todayTotal = todayTrades.filter(t => t.status === "closed").length;

    const bot = botManager.getOrCreate(userId, user.tradingMode || "paper");

    // Compute streaks from recent trades
    let winStreak = 0, lossStreak = 0;
    for (const t of recentTrades) {
      if (t.status !== "closed") continue;
      if ((t.pnl || 0) > 0) { winStreak++; lossStreak = 0; }
      else { lossStreak++; winStreak = 0; }
    }

    res.json({
      user: {
        id: user.id, username: user.username, tradingProfile: user.tradingProfile,
        tradingMode: user.tradingMode, accountBalance: user.accountBalance,
        peakBalance: user.peakBalance, hasDerivToken: !!user.derivTokenEncrypted,
        strategyId: user.strategyId, autoCompoundEnabled: user.autoCompoundEnabled === 1,
        adaptiveIntelligenceEnabled: user.adaptiveIntelligenceEnabled === 1,
      },
      botStatus: {
        isRunning: bot.isRunning, killSwitchActive: bot.killSwitchActive,
        currentScore: bot.currentScore, pauseReason: bot.pauseReason,
        openTrade: bot.openTrade, scoreBreakdown: bot.scoreBreakdown,
        spikeDetected: bot.spikeDetected, consolidationDetected: bot.consolidationDetected,
        strategyCircuitBreakerActive: bot.strategyCircuitBreakerActive,
        rangeContext: bot.rangeContext, cooldownSecondsRemaining: bot.cooldownSecondsRemaining,
        tradingMode: bot.tradingMode,
      },
      recentTrades,
      sessionPerformance: sessionPerf,
      dailyPnl,
      todayTrades: todayTotal,
      todayWins,
      winStreak,
      lossStreak,
    });
  } catch (err) {
    logger.error({ err }, "Dashboard error");
    res.status(500).json({ error: "Server error" });
  }
});

// Trades
router.get("/trades", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const page = parseInt(String(req.query["page"] || "1"));
    const limit = Math.min(parseInt(String(req.query["limit"] || "20")), 100);
    const offset = (page - 1) * limit;
    const filter = req.query["filter"] as string;

    let query = db.select().from(tradesTable).where(eq(tradesTable.userId, userId));
    const trades = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.openedAt))
      .limit(limit).offset(offset);

    const total = await db.select({ count: sql<number>`count(*)` }).from(tradesTable)
      .where(eq(tradesTable.userId, userId));

    res.json({ trades, total: Number(total[0]?.count || 0), page, limit });
  } catch (err) {
    logger.error({ err }, "Get trades error");
    res.status(500).json({ error: "Server error" });
  }
});

// Signals
router.get("/signals", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(parseInt(String(req.query["limit"] || "20")), 100);
    const signals = await db.select().from(signalLogTable)
      .where(eq(signalLogTable.userId, userId))
      .orderBy(desc(signalLogTable.timestamp)).limit(limit);
    res.json({ signals });
  } catch (err) {
    logger.error({ err }, "Get signals error");
    res.status(500).json({ error: "Server error" });
  }
});

// Stats
router.get("/stats", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const allTrades = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), eq(tradesTable.status, "closed")));

    const wins = allTrades.filter(t => (t.pnl || 0) > 0);
    const losses = allTrades.filter(t => (t.pnl || 0) <= 0);
    const totalPnl = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
    const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
    const winRate = allTrades.length ? (wins.length / allTrades.length) * 100 : 0;
    const avgScore = allTrades.length ? allTrades.reduce((s, t) => s + (t.scoreTotal || 0), 0) / allTrades.length : 0;

    // Build equity curve (daily)
    const equityCurveMap = new Map<string, number>();
    let running = 5000;
    for (const t of allTrades.sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0))) {
      const date = new Date((t.openedAt || 0) * 1000).toISOString().split("T")[0] as string;
      running += (t.pnl || 0);
      equityCurveMap.set(date, running);
    }
    const equityCurve = Array.from(equityCurveMap.entries()).map(([date, value]) => ({ date, value }));

    // Session breakdown
    const sessionPerf = await db.select().from(sessionPerformanceTable)
      .where(eq(sessionPerformanceTable.userId, userId));

    // Score range performance
    const scoreRanges = [
      { label: "38-42", min: 38, max: 42 },
      { label: "42-46", min: 42, max: 46 },
      { label: "46-50", min: 46, max: 50 },
    ];
    const scoreRangePerformance = scoreRanges.map(range => {
      const rangeT = allTrades.filter(t => (t.scoreTotal || 0) >= range.min && (t.scoreTotal || 0) < range.max);
      const w = rangeT.filter(t => (t.pnl || 0) > 0).length;
      return { label: range.label, trades: rangeT.length, winRate: rangeT.length ? (w / rangeT.length) * 100 : 0 };
    });

    // Indicator accuracy
    const indicatorAccuracy = {
      rsi: computeIndicatorAccuracy(allTrades, "rsiAtEntry", wins.map(t => t.id)),
      stoch: computeIndicatorAccuracy(allTrades, "stochAtEntry", wins.map(t => t.id)),
    };

    // Win/loss streak
    let winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
    for (const t of allTrades.sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0))) {
      if ((t.pnl || 0) > 0) { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
      else { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
    }

    res.json({
      totalTrades: allTrades.length, wins: wins.length, losses: losses.length,
      winRate: Math.round(winRate * 10) / 10, profitFactor: Math.round(profitFactor * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100, avgScore: Math.round(avgScore * 10) / 10,
      equityCurve, sessionPerformance: sessionPerf,
      scoreRangePerformance, indicatorAccuracy,
      winStreak: maxWin, lossStreak: maxLoss,
    });
  } catch (err) {
    logger.error({ err }, "Get stats error");
    res.status(500).json({ error: "Server error" });
  }
});

function computeIndicatorAccuracy(trades: any[], field: string, winIds: string[]): number {
  const withField = trades.filter(t => t[field] !== null);
  if (!withField.length) return 0;
  const wins = withField.filter(t => winIds.includes(t.id)).length;
  return Math.round((wins / withField.length) * 100 * 10) / 10;
}

// Bot status
router.get("/bot/status", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    const state = botManager.getOrCreate(userId, user?.tradingMode || "paper");

    res.json({
      isRunning: state.isRunning, killSwitchActive: state.killSwitchActive,
      tradingMode: state.tradingMode, todayTrades: state.todayTrades,
      consecutiveLosses: state.consecutiveLosses, dailyPnl: state.dailyPnl,
      currentDrawdown: state.currentDrawdown, recoveryModeActive: state.recoveryModeActive,
      winStreakCautionActive: state.winStreakCautionActive,
      pauseReason: state.pauseReason, currentScore: state.currentScore,
      openTrade: state.openTrade, scoreBreakdown: state.scoreBreakdown,
      spikeDetected: state.spikeDetected, consolidationDetected: state.consolidationDetected,
      strategyCircuitBreakerActive: state.strategyCircuitBreakerActive,
      cooldownSecondsRemaining: state.cooldownSecondsRemaining,
      sessionMultiplier: state.sessionMultiplier, rangeContext: state.rangeContext,
    });
  } catch (err) {
    logger.error({ err }, "Bot status error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/bot/toggle", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { running } = req.body;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (!user.strategyId) { res.status(400).json({ error: "No strategy assigned" }); return; }

    botManager.getOrCreate(userId, user.tradingMode || "paper");
    if (running) botManager.start(userId);
    else botManager.stop(userId);

    res.json({ isRunning: running, message: running ? "Bot started" : "Bot stopped" });
  } catch (err) {
    logger.error({ err }, "Toggle bot error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/bot/kill", async (req, res) => {
  try {
    const userId = req.user!.userId;
    botManager.kill(userId);
    res.json({ message: "Kill switch activated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/bot/reset-kill", async (req, res) => {
  try {
    const userId = req.user!.userId;
    botManager.resetKill(userId);
    res.json({ message: "Kill switch reset" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Deriv token
router.post("/deriv/token", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { token } = req.body;
    if (!token) { res.status(400).json({ error: "Token required" }); return; }
    const encrypted = encrypt(token);
    await db.update(usersTable).set({ derivTokenEncrypted: encrypted }).where(eq(usersTable.id, userId));
    res.json({ message: "Deriv token saved", hasToken: true });
  } catch (err) {
    logger.error({ err }, "Save Deriv token error");
    res.status(500).json({ error: "Server error" });
  }
});

// Trading profile
router.post("/trading-profile", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { profile } = req.body;
    const valid = ["safe", "pro", "aggressive"];
    if (!valid.includes(profile)) { res.status(400).json({ error: "Invalid profile" }); return; }
    await db.update(usersTable).set({ tradingProfile: profile }).where(eq(usersTable.id, userId));
    res.json({ tradingProfile: profile, message: "Profile updated" });
  } catch (err) {
    logger.error({ err }, "Update profile error");
    res.status(500).json({ error: "Server error" });
  }
});

// Auto compound
router.post("/auto-compound/toggle", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const next = user.autoCompoundEnabled === 1 ? 0 : 1;
    await db.update(usersTable).set({ autoCompoundEnabled: next }).where(eq(usersTable.id, userId));
    res.json({ autoCompoundEnabled: next === 1 });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Adaptive intelligence
router.post("/adaptive-intelligence/toggle", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const next = user.adaptiveIntelligenceEnabled === 1 ? 0 : 1;
    await db.update(usersTable).set({ adaptiveIntelligenceEnabled: next }).where(eq(usersTable.id, userId));
    res.json({ adaptiveIntelligenceEnabled: next === 1 });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Candles
router.get("/candles", (req, res) => {
  const tf = (req.query["timeframe"] as string) || "1m";
  const count = Math.min(parseInt(String(req.query["count"] || "200")), 500);
  const candles = derivService.getCandles(tf as "1m" | "5m" | "15m", count);
  res.json({ candles, timeframe: tf });
});

// Latest tick
router.get("/tick", (_req, res) => {
  const tick = derivService.getLatestTick();
  const prev = tick.price - (Math.random() - 0.5) * 20;
  res.json({
    price: tick.price,
    timestamp: tick.timestamp,
    change: Math.round((tick.price - prev) * 100) / 100,
    direction: tick.price >= prev ? "up" : "down",
  });
});

// SSE stream
router.get("/stream", (req, res) => {
  const userId = req.user!.userId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const removeClient = botManager.addSseClient(userId, (data) => res.write(data));

  // Send tick updates
  const removeTick = derivService.onTick((tick) => {
    res.write(`data: ${JSON.stringify({ type: "tick", ...tick })}\n\n`);
  });

  // Keepalive
  const keepalive = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    removeClient();
    removeTick();
    clearInterval(keepalive);
  });
});

export default router;
