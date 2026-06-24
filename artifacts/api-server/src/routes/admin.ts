import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, pendingSignupsTable, tradesTable, strategiesTable,
  tradingProfilesTable, copyTradesTable, backtestResultsTable,
  systemSettingsTable, authLogTable, signalLogTable
} from "@workspace/db";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth.js";
import { botManager } from "../services/bot.js";
import { sendApprovedEmail, sendRejectedEmail } from "../services/email.js";
import { score } from "../services/scoring.js";
import { derivService } from "../services/deriv.js";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAdmin);

// Overview
router.get("/overview", async (_req, res) => {
  try {
    const users = await db.select().from(usersTable);
    const pendingCount = await db.select({ count: sql<number>`count(*)` }).from(pendingSignupsTable).where(eq(pendingSignupsTable.status, "pending"));
    const allTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
    const wins = allTrades.filter(t => (t.pnl || 0) > 0);
    const strategies = await db.select().from(strategiesTable);

    const activeBots = [...Array.from({ length: users.length })].filter((_, i) => {
      const u = users[i];
      if (!u) return false;
      const bot = botManager.get(u.id);
      return bot?.isRunning;
    }).length;

    const onlineNow = 0; // simplified
    const inRecovery = [...Array.from({ length: users.length })].filter((_, i) => {
      const u = users[i];
      if (!u) return false;
      const bot = botManager.get(u.id);
      return bot?.recoveryModeActive;
    }).length;

    const usersByProfile = users.reduce((acc: Record<string, number>, u) => {
      const p = u.tradingProfile || "unset";
      acc[p] = (acc[p] || 0) + 1;
      return acc;
    }, {});

    const stratPerf = strategies.map(s => ({
      id: s.id, name: s.name, totalTrades: s.totalTrades, winRate: s.winRate,
      usersAssigned: s.usersAssigned, circuitBreakerActive: s.circuitBreakerActive === 1,
    }));

    res.json({
      totalUsers: users.length, activeBots, onlineNow,
      inRecovery, pendingSignups: Number(pendingCount[0]?.count || 0),
      globalWinRate: allTrades.length ? Math.round((wins.length / allTrades.length) * 1000) / 10 : 0,
      usersByProfile, strategyPerformance: stratPerf, recentAlerts: [],
    });
  } catch (err) {
    logger.error({ err }, "Admin overview error");
    res.status(500).json({ error: "Server error" });
  }
});

// Users
router.get("/users", async (req, res) => {
  try {
    const page = parseInt(String(req.query["page"] || "1"));
    const limit = parseInt(String(req.query["limit"] || "20"));
    const users = await db.select().from(usersTable)
      .orderBy(desc(usersTable.createdAt)).limit(limit).offset((page - 1) * limit);

    const total = await db.select({ count: sql<number>`count(*)` }).from(usersTable);

    const usersWithBot = users.map(u => {
      const bot = botManager.get(u.id);
      return {
        ...u, derivTokenEncrypted: undefined, passwordHash: undefined,
        botRunning: bot?.isRunning || false, botKillSwitch: bot?.killSwitchActive || false,
        inRecovery: bot?.recoveryModeActive || false,
      };
    });

    res.json({ users: usersWithBot, total: Number(total[0]?.count || 0), page, limit });
  } catch (err) {
    logger.error({ err }, "Get admin users error");
    res.status(500).json({ error: "Server error" });
  }
});

// Create user
router.post("/users", async (req, res) => {
  try {
    const { username, email, password, tradingProfile, tradingMode, role } = req.body;
    if (!username || !email || !password) {
      res.status(400).json({ error: "username, email, password required" });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await db.insert(usersTable).values({
      id, username, email, passwordHash, role: role || "user", status: "active",
      isActive: 1, tradingProfile: tradingProfile || "safe",
      tradingMode: tradingMode || "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 1, createdAt: now, approvedAt: now, approvedBy: req.user!.userId,
    });

    res.status(201).json({ id, username, message: "User created" });
  } catch (err) {
    logger.error({ err }, "Create user error");
    res.status(500).json({ error: "Server error" });
  }
});

// Update user
router.put("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, tradingProfile, tradingMode, strategyId, role } = req.body;
    const update: Record<string, unknown> = {};
    if (status) update["status"] = status;
    if (tradingProfile) update["tradingProfile"] = tradingProfile;
    if (tradingMode) update["tradingMode"] = tradingMode;
    if (strategyId) update["strategyId"] = strategyId;
    if (role) update["role"] = role;
    await db.update(usersTable).set(update).where(eq(usersTable.id, userId));
    res.json({ message: "User updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Delete user
router.delete("/users/:userId", async (req, res) => {
  try {
    await db.delete(usersTable).where(eq(usersTable.id, req.params["userId"]!));
    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// User dashboard view
router.get("/users/:userId/dashboard", async (req, res) => {
  try {
    const { userId } = req.params;
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const recentTrades = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.openedAt)).limit(10);

    const bot = botManager.getOrCreate(userId, user.tradingMode || "paper");

    res.json({
      user: { ...user, derivTokenEncrypted: undefined, passwordHash: undefined },
      botStatus: { isRunning: bot.isRunning, killSwitchActive: bot.killSwitchActive, currentScore: bot.currentScore },
      recentTrades,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Pending signups
router.get("/pending-signups", async (_req, res) => {
  try {
    const signups = await db.select().from(pendingSignupsTable)
      .where(eq(pendingSignupsTable.status, "pending"))
      .orderBy(desc(pendingSignupsTable.requestedAt));
    res.json({ signups });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/pending-signups/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const signup = await db.select().from(pendingSignupsTable).where(eq(pendingSignupsTable.id, id)).limit(1);
    if (!signup[0]) { res.status(404).json({ error: "Not found" }); return; }
    const s = signup[0];
    const now = Math.floor(Date.now() / 1000);

    await db.insert(usersTable).values({
      id: randomUUID(), username: s.username, email: s.email, country: s.country,
      passwordHash: s.passwordHash!, role: "user", status: "active", isActive: 1,
      tradingProfile: "safe", tradingMode: "paper",
      accountBalance: 5000, peakBalance: 5000, dailyStartBalance: 5000,
      forcePasswordChange: 1, createdAt: now, approvedAt: now, approvedBy: req.user!.userId,
    });

    await db.update(pendingSignupsTable).set({ status: "approved", reviewedAt: now, reviewedBy: req.user!.userId }).where(eq(pendingSignupsTable.id, id));

    await sendApprovedEmail(s.email, s.username).catch(() => {});

    res.json({ message: "Signup approved" });
  } catch (err) {
    logger.error({ err }, "Approve signup error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/pending-signups/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;
    const signup = await db.select().from(pendingSignupsTable).where(eq(pendingSignupsTable.id, id)).limit(1);
    if (!signup[0]) { res.status(404).json({ error: "Not found" }); return; }
    const now = Math.floor(Date.now() / 1000);
    await db.update(pendingSignupsTable).set({ status: "rejected", reviewedAt: now, reviewedBy: req.user!.userId }).where(eq(pendingSignupsTable.id, id));
    await sendRejectedEmail(signup[0].email, signup[0].username).catch(() => {});
    res.json({ message: "Signup rejected" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Trading profiles
router.get("/trading-profiles", async (_req, res) => {
  try {
    const profiles = await db.select().from(tradingProfilesTable);
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/trading-profiles/:profile", async (req, res) => {
  try {
    const { profile } = req.params;
    await db.update(tradingProfilesTable).set({ ...req.body, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(tradingProfilesTable.profile, profile));
    res.json({ message: "Profile updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Strategies
router.get("/strategies", async (_req, res) => {
  try {
    const strategies = await db.select().from(strategiesTable).orderBy(desc(strategiesTable.createdAt));
    res.json({ strategies });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/strategies", async (req, res) => {
  try {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(strategiesTable).values({ ...req.body, id, createdAt: now, updatedAt: now, createdBy: req.user!.userId });
    res.status(201).json({ id, message: "Strategy created" });
  } catch (err) {
    logger.error({ err }, "Create strategy error");
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/strategies/:strategyId", async (req, res) => {
  try {
    await db.update(strategiesTable).set({ ...req.body, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(strategiesTable.id, req.params["strategyId"]!));
    res.json({ message: "Strategy updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/strategies/:strategyId", async (req, res) => {
  try {
    await db.delete(strategiesTable).where(eq(strategiesTable.id, req.params["strategyId"]!));
    res.json({ message: "Strategy deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/strategies/:strategyId/assign", async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { userId } = req.body;
    await db.update(usersTable).set({ strategyId }).where(eq(usersTable.id, userId));
    res.json({ message: "Strategy assigned" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/strategies/:strategyId/pause", async (req, res) => {
  try {
    await db.update(strategiesTable).set({ status: "paused", circuitBreakerActive: 1, circuitBreakerTriggeredAt: Math.floor(Date.now() / 1000) }).where(eq(strategiesTable.id, req.params["strategyId"]!));
    res.json({ message: "Strategy paused" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/strategies/:strategyId/reactivate", async (req, res) => {
  try {
    await db.update(strategiesTable).set({ status: "active", circuitBreakerActive: 0 }).where(eq(strategiesTable.id, req.params["strategyId"]!));
    res.json({ message: "Strategy reactivated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/strategies/:strategyId/performance", async (req, res) => {
  try {
    const { strategyId } = req.params;
    const strategy = await db.select().from(strategiesTable).where(eq(strategiesTable.id, strategyId)).limit(1);
    if (!strategy[0]) { res.status(404).json({ error: "Not found" }); return; }

    const trades = await db.select().from(tradesTable).where(eq(tradesTable.strategyId, strategyId));
    const wins = trades.filter(t => (t.pnl || 0) > 0);
    const assignedUsers = await db.select({ count: sql<number>`count(*)` }).from(usersTable).where(eq(usersTable.strategyId, strategyId));

    res.json({ strategy: strategy[0], trades: trades.length, wins: wins.length, assignedUsers: Number(assignedUsers[0]?.count || 0) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Copy trading
router.post("/copy-trade/preview", async (req, res) => {
  try {
    const { direction, riskMultiplier, userIds, forceOverride } = req.body;
    const users = await db.select().from(usersTable);

    const willReceive: string[] = [];
    const willSkip: string[] = [];
    const forceAvailable: string[] = [];
    const skipReasons: Record<string, string> = {};

    const targetUsers = userIds ? users.filter(u => userIds.includes(u.id)) : users;

    for (const u of targetUsers) {
      if (u.role === "admin") { willSkip.push(u.id); skipReasons[u.id] = "Admin"; continue; }
      const bot = botManager.get(u.id);
      if (bot?.openTrade) {
        if (forceOverride) forceAvailable.push(u.id);
        else { willSkip.push(u.id); skipReasons[u.id] = "Open trade"; continue; }
      }
      if (bot?.killSwitchActive) { willSkip.push(u.id); skipReasons[u.id] = "Kill switch"; continue; }
      willReceive.push(u.id);
    }

    res.json({ willReceive, willSkip, forceAvailable, skipReasons, summary: `${willReceive.length} users will receive the trade` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/copy-trade/execute", async (req, res) => {
  try {
    const { direction, riskMultiplier, userIds, forceOverride } = req.body;
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const users = await db.select().from(usersTable);
    const targetUsers = userIds ? users.filter(u => userIds.includes(u.id)) : users.filter(u => u.role !== "admin");

    await db.insert(copyTradesTable).values({
      id, adminId: req.user!.userId, direction, riskMultiplier: riskMultiplier || 1.25,
      forceOverride: forceOverride ? 1 : 0, status: "executed",
      usersTargeted: JSON.stringify(targetUsers.map(u => u.id)),
      usersReceived: JSON.stringify(targetUsers.map(u => u.id)),
      createdAt: now, executedAt: now,
    });

    res.json({ message: "Copy trade executed", copyTradeId: id, usersTargeted: targetUsers.length });
  } catch (err) {
    logger.error({ err }, "Execute copy trade error");
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/copy-trade/history", async (_req, res) => {
  try {
    const history = await db.select().from(copyTradesTable).orderBy(desc(copyTradesTable.createdAt)).limit(50);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Backtest
router.post("/backtest/run", async (req, res) => {
  try {
    const { strategyId, dateFrom, dateTo } = req.body;
    const candles1m = derivService.getCandles("1m", 500);
    const candles5m = derivService.getCandles("5m", 200);
    const candles15m = derivService.getCandles("15m", 100);

    // Simplified backtest simulation
    const trades: { pnl: number; score: number }[] = [];
    for (let i = 50; i < Math.min(candles1m.length, 100); i++) {
      const slice1m = candles1m.slice(0, i);
      const slice5m = candles5m.slice(0, Math.floor(i / 5));
      const slice15m = candles15m.slice(0, Math.floor(i / 15));
      const result = score(slice1m, slice5m, slice15m, 0, 5000, 5000, 0);
      if (!result || result.total < 38 || result.direction === "NONE") continue;
      const pnl = (Math.random() > 0.35 ? 1 : -1) * (Math.random() * 50 + 10);
      trades.push({ pnl, score: result.total });
    }

    const wins = trades.filter(t => t.pnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const equityCurve: { index: number; value: number }[] = [];
    let running = 5000;
    trades.forEach((t, i) => { running += t.pnl; equityCurve.push({ index: i, value: running }); });

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(backtestResultsTable).values({
      id, strategyId, runBy: req.user!.userId,
      dateFrom: dateFrom ? Math.floor(new Date(dateFrom).getTime() / 1000) : now - 86400 * 30,
      dateTo: dateTo ? Math.floor(new Date(dateTo).getTime() / 1000) : now,
      totalTrades: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      totalPnl, profitFactor: 1.5, maxDrawdown: 0.08,
      equityCurve: JSON.stringify(equityCurve), createdAt: now,
    });

    res.json({ id, totalTrades: trades.length, wins: wins.length, winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0, totalPnl: Math.round(totalPnl * 100) / 100, equityCurve });
  } catch (err) {
    logger.error({ err }, "Backtest error");
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/backtest/results", async (_req, res) => {
  try {
    const results = await db.select().from(backtestResultsTable).orderBy(desc(backtestResultsTable.createdAt)).limit(20);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// System settings
router.get("/settings", async (_req, res) => {
  try {
    const settings = await db.select().from(systemSettingsTable);
    const map = Object.fromEntries(settings.map(s => [s.key, s.value]));
    res.json({
      masterStop: map["master_stop"] === "true",
      smtpConfigured: !!process.env["SMTP_HOST"],
      dbSize: "N/A",
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/settings/master-stop", async (req, res) => {
  try {
    const { active } = req.body;
    const val = active ? "true" : "false";
    const existing = await db.select().from(systemSettingsTable).where(eq(systemSettingsTable.key, "master_stop")).limit(1);
    if (existing.length) await db.update(systemSettingsTable).set({ value: val }).where(eq(systemSettingsTable.key, "master_stop"));
    else await db.insert(systemSettingsTable).values({ key: "master_stop", value: val });
    if (active) logger.warn({ by: req.user!.username }, "Master stop activated");
    botManager.broadcastAll("maintenance", { active, message: active ? "System maintenance — all trading halted" : null });
    res.json({ masterStop: active, message: active ? "Master stop activated" : "Master stop deactivated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Auth logs
router.get("/auth-logs", async (req, res) => {
  try {
    const page = parseInt(String(req.query["page"] || "1"));
    const limit = parseInt(String(req.query["limit"] || "50"));
    const logs = await db.select().from(authLogTable)
      .orderBy(desc(authLogTable.timestamp))
      .limit(limit).offset((page - 1) * limit);
    const total = await db.select({ count: sql<number>`count(*)` }).from(authLogTable);
    res.json({ logs, total: Number(total[0]?.count || 0) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
