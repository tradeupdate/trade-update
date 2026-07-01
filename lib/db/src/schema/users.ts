import { pgTable, text, real, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").default("user").notNull(),
  status: text("status").default("pending").notNull(),
  isActive: integer("is_active").default(0).notNull(),
  tradingProfile: text("trading_profile"),
  strategyId: text("strategy_id"),
  derivTokenEncrypted: text("deriv_token_encrypted"),
  accountBalance: real("account_balance").default(0),
  peakBalance: real("peak_balance").default(0),
  dailyStartBalance: real("daily_start_balance").default(0),
  forcePasswordChange: integer("force_password_change").default(1),
  email: text("email").unique().notNull(),
  country: text("country"),
  copyTradingEnabled: integer("copy_trading_enabled").default(0),
  autoCompoundEnabled: integer("auto_compound_enabled").default(1),
  adaptiveIntelligenceEnabled: integer("adaptive_intelligence_enabled").default(1),
  tradingMode: text("trading_mode").default("paper"),
  activePair: text("active_pair").default("R_75"),
  createdAt: integer("created_at"),
  lastLogin: integer("last_login"),
  approvedAt: integer("approved_at"),
  approvedBy: text("approved_by"),
  demoMode: integer("demo_mode").default(0),
  stakeSize: real("stake_size"),
  maxDailyLoss: real("max_daily_loss"),
  botHardStopped: integer("bot_hard_stopped").default(0),
  autoRestartAt: integer("auto_restart_at"),
  lastContractSync: integer("last_contract_sync"),
  lastKeepAlivePing: integer("last_keep_alive_ping"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

export const pendingSignupsTable = pgTable("pending_signups", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  email: text("email").unique().notNull(),
  country: text("country"),
  passwordHash: text("password_hash"),
  status: text("status").default("pending"),
  requestedAt: integer("requested_at"),
  reviewedAt: integer("reviewed_at"),
  reviewedBy: text("reviewed_by"),
});

export type PendingSignup = typeof pendingSignupsTable.$inferSelect;

export const tradingProfilesTable = pgTable("trading_profiles", {
  profile: text("profile").primaryKey(),
  minBalance: real("min_balance"),
  maxRiskPercent: real("max_risk_percent"),
  maxTradesDay: integer("max_trades_day"),
  scoreThreshold: integer("score_threshold"),
  consecutiveLossStop: integer("consecutive_loss_stop"),
  maxTradesHour: integer("max_trades_hour"),
  sessionsEnabled: text("sessions_enabled"),
  updatedAt: integer("updated_at"),
});

export type TradingProfile = typeof tradingProfilesTable.$inferSelect;

export const authLogTable = pgTable("auth_log", {
  id: text("id").primaryKey(),
  username: text("username"),
  event: text("event"),
  ip: text("ip"),
  details: text("details"),
  timestamp: integer("timestamp"),
});

export type AuthLog = typeof authLogTable.$inferSelect;

export const notificationsLogTable = pgTable("notifications_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  type: text("type"),
  title: text("title"),
  body: text("body"),
  read: integer("read").default(0),
  createdAt: integer("created_at"),
});
