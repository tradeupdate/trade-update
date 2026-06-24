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
import { getCurrentSession, getNextSession, SESSIONS } from "../services/sessions.js";
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

    res.json({
      user: {
        id: user.id, username: user.username, tradingProfile: user.tradingProfile,
        tradingMode: user.tradingMode, accountBalance: user.accountBalance,
        peakBalance: user.peakBalance, hasDerivToken: !!user.derivTokenEncrypted,
        strategyId: user.strategyId, autoCompoundEnabled: user.autoCompoundEnabled === 1,
        adaptiveIntelligenceEnabled: user.adaptiveIntelligenceEnabled === 1,
        copyTradingEnabled: user.copyTradingEnabled === 1,
      },
      botStatus: {
        isRunning: bot.isRunning, killSwitchActive: bot.killSwitchActive,
        currentScore: bot.currentScore, pauseReason: bot.pauseReason,
        openTrade: bot.openTrade, scoreBreakdown: bot.scoreBreakdown,
        spikeDetected: bot.spikeDetected, consolidationDetected: bot.consolidationDetected,
        strategyCircuitBreakerActive: bot.strategyCircuitBreakerActive,
        rangeContext: bot.rangeContext, cooldownSecondsRemaining: bot.cooldownSecondsRemaining,
        tradingMode: bot.tradingMode, consecutiveLosses: bot.consecutiveLosses,
        consecutiveWins: bot.consecutiveWins, dailyPnl: bot.dailyPnl,
        todayTrades: bot.todayTrades, recoveryModeActive: bot.recoveryModeActive,
        winStreakCautionActive: bot.winStreakCautionActive,
        lastSignalScore: bot.lastSignalScore,
      },
      recentTrades,
      sessionPerformance: sessionPerf,
      dailyPnl,
      todayTrades: todayTotal,
      todayWins,
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

    let whereClause: any = eq(tradesTable.userId, userId);
    if (filter === "win") {
      whereClause = and(eq(tradesTable.userId, userId), sql`pnl > 0`);
    } else if (filter === "loss") {
      whereClause = and(eq(tradesTable.userId, userId), sql`pnl < 0`);
    } else if (filter === "paper") {
      whereClause = and(eq(tradesTable.userId, userId), eq(tradesTable.isPaper, 1));
    } else if (filter === "copy") {
      whereClause = and(eq(tradesTable.userId, userId), eq(tradesTable.isCopyTrade, 1));
    }

    const trades = await db.select().from(tradesTable)
      .where(whereClause)
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

    // Build equity curve
    const sorted = [...allTrades].sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
    let running = 5000;
    const equityCurve = sorted.map(t => {
      running += (t.pnl || 0);
      return {
        time: t.closedAt || t.openedAt || 0,
        balance: Math.round(running * 100) / 100,
        date: new Date((t.closedAt || t.openedAt || 0) * 1000).toISOString().split("T")[0]
      };
    });

    const sessionPerf = await db.select().from(sessionPerformanceTable)
      .where(eq(sessionPerformanceTable.userId, userId));

    // Session breakdown from trades
    const sessionBreakdown: Record<string, { trades: number; wins: number; totalPnl: number }> = {};
    for (const t of allTrades) {
      const sn = t.sessionName || "Unknown";
      if (!sessionBreakdown[sn]) sessionBreakdown[sn] = { trades: 0, wins: 0, totalPnl: 0 };
      sessionBreakdown[sn].trades++;
      if ((t.pnl || 0) > 0) sessionBreakdown[sn].wins++;
      sessionBreakdown[sn].totalPnl += t.pnl || 0;
    }
    const sessionStats = Object.entries(sessionBreakdown).map(([name, d]) => ({
      name, trades: d.trades, wins: d.wins,
      winRate: d.trades ? Math.round((d.wins / d.trades) * 100 * 10) / 10 : 0,
      avgPnl: d.trades ? Math.round((d.totalPnl / d.trades) * 100) / 100 : 0,
    }));

    const avgDuration = allTrades.length ? allTrades.reduce((s, t) => s + (t.durationMinutes || 0), 0) / allTrades.length : 0;
    const largestWin = wins.length ? Math.max(...wins.map(t => t.pnl || 0)) : 0;
    const largestLoss = losses.length ? Math.min(...losses.map(t => t.pnl || 0)) : 0;
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? -grossLoss / losses.length : 0;

    res.json({
      totalTrades: allTrades.length, wins: wins.length, losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(profitFactor * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgScore: Math.round(avgScore * 10) / 10,
      avgDuration: Math.round(avgDuration * 10) / 10,
      largestWin: Math.round(largestWin * 100) / 100,
      largestLoss: Math.round(largestLoss * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      equityCurve, sessionPerformance: sessionPerf, sessionStats,
    });
  } catch (err) {
    logger.error({ err }, "Get stats error");
    res.status(500).json({ error: "Server error" });
  }
});

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
      consecutiveLosses: state.consecutiveLosses, consecutiveWins: state.consecutiveWins,
      dailyPnl: state.dailyPnl, currentDrawdown: state.currentDrawdown,
      recoveryModeActive: state.recoveryModeActive, winStreakCautionActive: state.winStreakCautionActive,
      pauseReason: state.pauseReason, currentScore: state.currentScore,
      openTrade: state.openTrade, scoreBreakdown: state.scoreBreakdown,
      spikeDetected: state.spikeDetected, consolidationDetected: state.consolidationDetected,
      strategyCircuitBreakerActive: state.strategyCircuitBreakerActive,
      cooldownSecondsRemaining: state.cooldownSecondsRemaining,
      sessionMultiplier: state.sessionMultiplier, rangeContext: state.rangeContext,
      lastSignalScore: state.lastSignalScore,
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
  res.json({
    price: tick.price,
    timestamp: tick.timestamp,
    direction: "up",
  });
});

// SSE stream — full real-time feed
router.get("/stream", async (req, res) => {
  const userId = req.user!.userId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Register as SSE client for bot broadcasts
  const removeClient = botManager.addSseClient(userId, (data) => {
    try { res.write(data); } catch {}
  });

  // Initialise bot state
  let user: any = null;
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    user = rows[0];
    if (user) botManager.getOrCreate(userId, user.tradingMode || "paper");
  } catch {}

  // Tick broadcast — throttle to 1 per second
  let lastTickPrice = 0;
  const tickInterval = setInterval(() => {
    try {
      const tick = derivService.getLatestTick();
      const direction = tick.price >= lastTickPrice ? "up" : "down";
      const payload = { price: tick.price, direction, time: tick.timestamp };
      res.write(`data: ${JSON.stringify({ type: "tick", payload })}\n\n`);
      lastTickPrice = tick.price;
    } catch {}
  }, 1000);

  // Bot state + scores broadcast every 5 seconds
  const stateInterval = setInterval(() => {
    try {
      const state = botManager.get(userId);
      if (!state) return;

      botManager.broadcastBotEvent(userId, state);

      if (state.lastScoreResult) {
        const r = state.lastScoreResult;
        botManager.broadcastToUser(userId, "scores", {
          total: r.total, trend: r.trend, volatility: r.volatility,
          timing: r.timing, pullback: r.pullback, risk: r.risk,
          signal: r.direction, direction: r.direction, loading: false,
          ema9: r.ema9, ema21: r.ema21, adx: r.adx, rsi: r.rsi,
          bbUpper: r.bbUpper, bbLower: r.bbLower, stochK: r.stochK,
          macdHistogram: r.macdHistogram, rangeContext: r.rangeContext,
          consolidation: r.consolidationDetected, spikeDetected: r.spikeDetected,
          trendDirection: r.trendDirection, bandTouched: r.bandTouched,
          pullbackZone: r.pullbackZoneActive, rejectionReason: state.pauseReason,
        });
      } else if (state.isRunning) {
        const loaded = derivService.getCandles("15m", 200).length;
        botManager.broadcastToUser(userId, "scores", {
          loading: true, message: "Gathering market data...", candlesLoaded: loaded
        });
      }
    } catch {}
  }, 5000);

  // Session info broadcast every 10 seconds
  const sessionInterval = setInterval(() => {
    try {
      const current = getCurrentSession();
      const next = getNextSession();
      const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
      const all = SESSIONS.map(s => ({
        name: s.name, quality: s.quality,
        isActive: nowUtcH >= s.startUtcHour && nowUtcH < s.endUtcHour,
        startUtcHour: s.startUtcHour, endUtcHour: s.endUtcHour,
      }));
      botManager.broadcastToUser(userId, "session", {
        current: current ? { name: current.name, quality: current.quality } : null,
        next: next ? { name: next.session.name, minutesUntil: next.minutesUntil } : null,
        all,
      });
    } catch {}
  }, 10000);

  // Stats broadcast every 15 seconds
  const statsInterval = setInterval(async () => {
    try {
      const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      const u = rows[0];
      const state = botManager.get(userId);
      if (!u) return;
      const balance = u.accountBalance || 5000;
      const peak = u.peakBalance || balance;
      const drawdown = (peak - balance) / peak;
      botManager.broadcastToUser(userId, "stats", {
        balance, equity: balance + (state?.openTrade?.pnl || 0),
        dailyPnl: state?.dailyPnl || 0,
        dailyPnlPercent: peak > 0 ? (state?.dailyPnl || 0) / peak * 100 : 0,
        peakBalance: peak, currentDrawdown: drawdown,
      });
    } catch {}
  }, 15000);

  // Keepalive
  const keepalive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 20000);

  // Send initial session + connection-established immediately
  setTimeout(() => {
    try {
      const current = getCurrentSession();
      const next = getNextSession();
      const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
      const all = SESSIONS.map(s => ({
        name: s.name, quality: s.quality,
        isActive: nowUtcH >= s.startUtcHour && nowUtcH < s.endUtcHour,
        startUtcHour: s.startUtcHour, endUtcHour: s.endUtcHour,
      }));
      res.write(`data: ${JSON.stringify({ type: "session", payload: {
        current: current ? { name: current.name, quality: current.quality } : null,
        next: next ? { name: next.session.name, minutesUntil: next.minutesUntil } : null,
        all,
      }})}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "connected", payload: { userId } })}\n\n`);
    } catch {}
  }, 100);

  req.on("close", () => {
    removeClient();
    clearInterval(tickInterval);
    clearInterval(stateInterval);
    clearInterval(sessionInterval);
    clearInterval(statsInterval);
    clearInterval(keepalive);
  });
});

export default router;
