import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, pendingSignupsTable, authLogTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { createToken, requireAuth } from "../middleware/auth.js";
import { sendSignupReceivedEmail, sendApprovedEmail, sendRejectedEmail } from "../services/email.js";
import fs from "fs";
import path from "path";
import { logger } from "../lib/logger.js";

const router = Router();

// Signup CSV path
const signupsCsvPath = path.join(process.cwd(), "signups.csv");
function appendSignupCsv(username: string, email: string, country: string, date: string, status: string) {
  const line = `${username},${email},${country},${date},${status}\n`;
  try {
    if (!fs.existsSync(signupsCsvPath)) fs.writeFileSync(signupsCsvPath, "username,email,country,signup_date,status\n");
    fs.appendFileSync(signupsCsvPath, line);
  } catch {}
}

// Failed login tracking (in-memory)
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function logAuth(username: string, event: string, ip: string, details?: string) {
  db.insert(authLogTable).values({
    id: randomUUID(), username, event, ip, details: details || null,
    timestamp: Math.floor(Date.now() / 1000),
  }).catch(() => {});
}

router.post("/signup", async (req, res) => {
  try {
    const { username, email, country, password } = req.body;

    if (!username || !email || !country || !password) {
      res.status(400).json({ error: "All fields required" });
      return;
    }
    if (!/^[a-zA-Z0-9]{3,20}$/.test(username)) {
      res.status(400).json({ error: "Username must be 3-20 alphanumeric characters" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    // Check duplicates
    const existingUser = await db.select().from(usersTable).where(
      or(eq(usersTable.username, username), eq(usersTable.email, email))
    ).limit(1);
    if (existingUser.length) {
      res.status(400).json({ error: "Username or email already taken" });
      return;
    }

    const existingSignup = await db.select().from(pendingSignupsTable).where(
      or(eq(pendingSignupsTable.username, username), eq(pendingSignupsTable.email, email))
    ).limit(1);
    if (existingSignup.length) {
      res.status(400).json({ error: "Application already submitted" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();

    await db.insert(pendingSignupsTable).values({
      id, username, email, country, passwordHash, status: "pending", requestedAt: now,
    });

    const dateStr = new Date().toISOString().split("T")[0] || "";
    appendSignupCsv(username, email, country, dateStr, "pending");

    await sendSignupReceivedEmail(email, username, country).catch(() => {});

    res.json({ message: "Application submitted successfully", success: true });
  } catch (err) {
    logger.error({ err }, "Signup error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || "unknown";

  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  // Check lockout
  const attempts = loginAttempts.get(username);
  if (attempts && attempts.lockedUntil > Date.now()) {
    res.status(429).json({ error: "Account locked for 15 minutes due to too many failed attempts" });
    return;
  }

  try {
    // Check pending_signups first
    const pendingSignup = await db.select().from(pendingSignupsTable).where(
      eq(pendingSignupsTable.username, username)
    ).limit(1);

    if (pendingSignup.length) {
      if (pendingSignup[0]!.status === "pending") {
        res.status(403).json({ status: "pending" });
        return;
      }
      if (pendingSignup[0]!.status === "rejected") {
        res.status(403).json({ status: "rejected" });
        return;
      }
    }

    const users = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
    const user = users[0];

    if (!user) {
      const att = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
      att.count++;
      if (att.count >= 5) att.lockedUntil = Date.now() + 15 * 60 * 1000;
      loginAttempts.set(username, att);
      logAuth(username, "login_failed", ip, "User not found");
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    if (user.status === "pending") {
      res.status(403).json({ status: "pending" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const att = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
      att.count++;
      if (att.count >= 5) att.lockedUntil = Date.now() + 15 * 60 * 1000;
      loginAttempts.set(username, att);
      logAuth(username, "login_failed", ip, "Wrong password");
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    // Reset attempts
    loginAttempts.delete(username);

    // Update last login
    await db.update(usersTable).set({ lastLogin: Math.floor(Date.now() / 1000) }).where(eq(usersTable.id, user.id));

    const token = createToken({ userId: user.id, username: user.username, role: user.role });
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });

    logAuth(username, "login_success", ip);

    res.json({
      role: user.role,
      username: user.username,
      mustChangePassword: user.forcePasswordChange === 1,
      hasProfile: !!user.tradingProfile,
      hasToken: !!user.derivTokenEncrypted,
    });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("auth_token");
  res.json({ message: "Logged out" });
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(401).json({ error: "User not found" }); return; }

    res.json({
      id: user.id, username: user.username, role: user.role, status: user.status,
      email: user.email, tradingProfile: user.tradingProfile, strategyId: user.strategyId,
      accountBalance: user.accountBalance, peakBalance: user.peakBalance,
      dailyStartBalance: user.dailyStartBalance,
      autoCompoundEnabled: user.autoCompoundEnabled === 1,
      adaptiveIntelligenceEnabled: user.adaptiveIntelligenceEnabled === 1,
      copyTradingEnabled: user.copyTradingEnabled === 1,
      mustChangePassword: user.forcePasswordChange === 1,
      hasDerivToken: !!user.derivTokenEncrypted,
      tradingMode: user.tradingMode,
    });
  } catch (err) {
    logger.error({ err }, "Get me error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Both passwords required" });
      return;
    }
    const users = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId)).limit(1);
    const user = users[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) { res.status(400).json({ error: "Current password incorrect" }); return; }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.update(usersTable).set({ passwordHash: newHash, forcePasswordChange: 0 }).where(eq(usersTable.id, user.id));
    res.json({ message: "Password changed successfully" });
  } catch (err) {
    logger.error({ err }, "Change password error");
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
