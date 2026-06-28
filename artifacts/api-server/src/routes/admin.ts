import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, pendingSignupsTable, tradesTable, strategiesTable,
  tradingProfilesTable, copyTradesTable, backtestResultsTable,
  systemSettingsTable, authLogTable, signalLogTable,
  auditLogTable, globalConfigTable, botActivityLogTable,
  systemErrorLogTable, botInstancesTable
} from "@workspace/db";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth.js";
import { botManager } from "../services/bot.js";
import { sendApprovedEmail, sendRejectedEmail } from "../services/email.js";
import { derivService } from "../services/deriv.js";
import { runDeterministicBacktest, deleteCacheFile, getCacheStatus } from "../services/backtest-engine.js";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { logger } from "../lib/logger.js";
import { encrypt } from "../lib/crypto.js";

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

// Backtest — deterministic engine
router.post("/backtest/run", async (req, res) => {
  try {
    const { strategyId, dateFrom, dateTo, refreshData } = req.body;
    if (!strategyId) { res.status(400).json({ error: "strategyId required" }); return; }

    const strategyRows = await db.select().from(strategiesTable).where(eq(strategiesTable.id, strategyId)).limit(1);
    const strategy = strategyRows[0];
    if (!strategy) { res.status(404).json({ error: "Strategy not found" }); return; }

    const now = Math.floor(Date.now() / 1000);
    const from = dateFrom ?? now - 86400 * 7;
    const to = dateTo ?? now;

    const config = {
      scoreThreshold: strategy.scoreThreshold ?? 38,
      maxRiskPercent: strategy.maxRiskPercent ?? 1.0,
      stopMultiplier: strategy.stopMultiplier ?? 1.5,
      tp1Multiplier: strategy.tp1Multiplier ?? 1.5,
      tp2Multiplier: strategy.tp2Multiplier ?? 3.0,
      maxTradesDay: strategy.maxTradesDay ?? 4,
      consecutiveLossStop: strategy.consecutiveLossStop ?? 3,
    };

    const result = await runDeterministicBacktest(
      strategyId, config, from, to,
      req.user!.userId,
      !!refreshData,
      5000,
    );

    const id = randomUUID();
    await db.insert(backtestResultsTable).values({
      id,
      runId: result.runId,
      strategyId,
      runBy: req.user!.userId,
      dateFrom: from,
      dateTo: to,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      equityCurve: JSON.stringify(result.equityCurve),
      bestTrade: result.bestTrade,
      worstTrade: result.worstTrade,
      avgDurationMinutes: result.avgDurationMinutes,
      sharpeRatio: result.sharpeRatio,
      candlesUsed: result.candlesUsed,
      candleHash: result.candleHash,
      dataSource: result.dataSource,
      cacheFile: result.cacheFile,
      createdAt: now,
    });

    res.json({
      id,
      runId: result.runId,
      strategyId,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      totalPnl: result.totalPnl,
      equityCurve: result.equityCurve,
      bestTrade: result.bestTrade,
      worstTrade: result.worstTrade,
      avgDurationMinutes: result.avgDurationMinutes,
      sharpeRatio: result.sharpeRatio,
      candlesUsed: result.candlesUsed,
      candleHash: result.candleHash,
      dataSource: result.dataSource,
      dateFrom: from,
      dateTo: to,
    });
  } catch (err) {
    logger.error({ err }, "Backtest error");
    res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
  }
});

router.get("/backtest/results", async (_req, res) => {
  try {
    const results = await db.select().from(backtestResultsTable).orderBy(desc(backtestResultsTable.createdAt)).limit(50);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/backtest/cache", async (req, res) => {
  try {
    const dateFrom = parseInt(String(req.query["dateFrom"]));
    const dateTo = parseInt(String(req.query["dateTo"]));
    if (isNaN(dateFrom) || isNaN(dateTo)) {
      res.status(400).json({ error: "dateFrom and dateTo query params required" });
      return;
    }
    const deleted = deleteCacheFile(dateFrom, dateTo);
    res.json({ deleted, message: deleted ? "Cache cleared" : "No cache file found for that period" });
  } catch (err) {
    logger.error({ err }, "Clear backtest cache error");
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/backtest/cache-status", async (req, res) => {
  try {
    const dateFrom = parseInt(String(req.query["dateFrom"]));
    const dateTo = parseInt(String(req.query["dateTo"]));
    if (isNaN(dateFrom) || isNaN(dateTo)) {
      res.status(400).json({ error: "dateFrom and dateTo required" });
      return;
    }
    res.json(getCacheStatus(dateFrom, dateTo));
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

// PATCH user status (suspend/activate)
router.patch("/users/:userId/status", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      res.status(400).json({ error: "Status must be active or suspended" });
      return;
    }
    await db.update(usersTable).set({
      status,
      isActive: status === "active" ? 1 : 0,
    }).where(eq(usersTable.id, userId));
    if (status === "suspended") botManager.kill(userId);
    await db.insert(auditLogTable).values({
      id: randomUUID(), adminUserId: req.user!.userId, action: `user_${status}`,
      targetUserId: userId, details: `User status changed to ${status}`,
      createdAt: Math.floor(Date.now() / 1000),
    });
    res.json({ message: `User ${status}` });
  } catch (err) {
    logger.error({ err }, "User status update error");
    res.status(500).json({ error: "Server error" });
  }
});

// Bot instances
router.get("/bot-instances", async (_req, res) => {
  try {
    const users = await db.select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      tradingMode: usersTable.tradingMode,
    }).from(usersTable).where(eq(usersTable.isActive, 1));

    const instances = users.map(u => {
      const state = botManager.get(u.id);
      return {
        userId: u.id, username: u.username, email: u.email,
        tradingMode: u.tradingMode,
        status: state?.isRunning ? "running" : state?.killSwitchActive ? "killed" : "idle",
        tradesToday: state?.todayTrades || 0,
        dailyPnl: state?.dailyPnl || 0,
        consecutiveLosses: state?.consecutiveLosses || 0,
        openTrade: !!state?.openTrade,
        recoveryMode: state?.recoveryModeActive || false,
        dailyLossHit: state?.dailyLossHit || false,
      };
    });
    res.json({ instances });
  } catch (err) {
    logger.error({ err }, "Bot instances error");
    res.status(500).json({ error: "Server error" });
  }
});

// Kill all bots
router.post("/kill-all", async (req, res) => {
  try {
    botManager.killAll();
    botManager.broadcastAll("maintenance", { active: true, message: "All bots paused by administrator" });
    await db.insert(auditLogTable).values({
      id: randomUUID(), adminUserId: req.user!.userId, action: "kill_all",
      targetUserId: null, details: `All bots killed by ${req.user!.username}`,
      createdAt: Math.floor(Date.now() / 1000),
    });
    logger.warn({ by: req.user!.username }, "Kill all bots triggered");
    res.json({ message: "All bots killed" });
  } catch (err) {
    logger.error({ err }, "Kill all error");
    res.status(500).json({ error: "Server error" });
  }
});

// Global config
router.get("/config", async (_req, res) => {
  try {
    const config = await db.select().from(globalConfigTable);
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/config", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) { res.status(400).json({ error: "key and value required" }); return; }
    const now = Math.floor(Date.now() / 1000);
    const existing = await db.select().from(globalConfigTable).where(eq(globalConfigTable.key, key)).limit(1);
    if (existing.length) {
      await db.update(globalConfigTable).set({ value: String(value), updatedAt: now }).where(eq(globalConfigTable.key, key));
    } else {
      await db.insert(globalConfigTable).values({ id: randomUUID(), key, value: String(value), updatedAt: now });
    }
    await db.insert(auditLogTable).values({
      id: randomUUID(), adminUserId: req.user!.userId, action: "config_update",
      targetUserId: null, details: `${key}=${value}`, createdAt: now,
    });
    res.json({ message: "Config updated", key, value });
  } catch (err) {
    logger.error({ err }, "Config update error");
    res.status(500).json({ error: "Server error" });
  }
});

// Audit log
router.get("/audit-log", async (req, res) => {
  try {
    const page = parseInt(String(req.query["page"] || "1"));
    const limit = parseInt(String(req.query["limit"] || "20"));
    const logs = await db.select().from(auditLogTable)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit).offset((page - 1) * limit);
    const total = await db.select({ count: sql<number>`count(*)` }).from(auditLogTable);
    res.json({ logs, total: Number(total[0]?.count || 0) });
  } catch (err) {
    logger.error({ err }, "Audit log error");
    res.status(500).json({ error: "Server error" });
  }
});

// System health
router.get("/system-health", async (_req, res) => {
  try {
    const errors = await db.select().from(systemErrorLogTable)
      .orderBy(desc(systemErrorLogTable.createdAt)).limit(20);
    res.json({
      uptime: Math.floor(process.uptime()),
      activeBotsCount: botManager.countRunning(),
      memUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      nodeEnv: process.env["NODE_ENV"] || "development",
      errors,
    });
  } catch (err) {
    logger.error({ err }, "System health error");
    res.status(500).json({ error: "Server error" });
  }
});

// Token overview
router.get("/tokens", async (_req, res) => {
  try {
    const users = await db.select({
      id: usersTable.id, username: usersTable.username,
      email: usersTable.email, derivTokenEncrypted: usersTable.derivTokenEncrypted,
    }).from(usersTable);
    const tokens = users.map(u => ({
      userId: u.id, username: u.username, email: u.email,
      hasToken: !!u.derivTokenEncrypted,
      maskedToken: u.derivTokenEncrypted ? "••••" + u.derivTokenEncrypted.slice(-6) : null,
    }));
    res.json({ tokens });
  } catch (err) {
    logger.error({ err }, "Tokens overview error");
    res.status(500).json({ error: "Server error" });
  }
});

// Revoke token
router.delete("/users/:userId/token", async (req, res) => {
  try {
    const { userId } = req.params;
    await db.update(usersTable).set({ derivTokenEncrypted: null }).where(eq(usersTable.id, userId));
    await db.insert(auditLogTable).values({
      id: randomUUID(), adminUserId: req.user!.userId, action: "revoke_token",
      targetUserId: userId, details: "Deriv token revoked", createdAt: Math.floor(Date.now() / 1000),
    });
    res.json({ message: "Token revoked" });
  } catch (err) {
    logger.error({ err }, "Revoke token error");
    res.status(500).json({ error: "Server error" });
  }
});

// Set token for user
router.patch("/users/:userId/token", async (req, res) => {
  try {
    const { userId } = req.params;
    const { token } = req.body;
    if (!token) { res.status(400).json({ error: "Token required" }); return; }
    const encrypted = encrypt(token);
    await db.update(usersTable).set({ derivTokenEncrypted: encrypted }).where(eq(usersTable.id, userId));
    await db.insert(auditLogTable).values({
      id: randomUUID(), adminUserId: req.user!.userId, action: "set_token",
      targetUserId: userId, details: "Deriv token set by admin", createdAt: Math.floor(Date.now() / 1000),
    });
    res.json({ message: "Token set" });
  } catch (err) {
    logger.error({ err }, "Set token error");
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
