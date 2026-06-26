import { pgTable, text, integer, real } from "drizzle-orm/pg-core";

export const systemSettingsTable = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export type SystemSetting = typeof systemSettingsTable.$inferSelect;

export const botActivityLogTable = pgTable("bot_activity_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  message: text("message"),
  level: text("level").default("info"),
  createdAt: integer("created_at"),
});

export type BotActivityLog = typeof botActivityLogTable.$inferSelect;

export const systemErrorLogTable = pgTable("system_error_log", {
  id: text("id").primaryKey(),
  message: text("message"),
  stack: text("stack"),
  createdAt: integer("created_at"),
});

export type SystemErrorLog = typeof systemErrorLogTable.$inferSelect;

export const auditLogTable = pgTable("audit_log", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id"),
  action: text("action"),
  targetUserId: text("target_user_id"),
  details: text("details"),
  createdAt: integer("created_at"),
});

export type AuditLog = typeof auditLogTable.$inferSelect;

export const globalConfigTable = pgTable("global_config", {
  id: text("id").primaryKey(),
  key: text("key").unique(),
  value: text("value"),
  updatedAt: integer("updated_at"),
});

export type GlobalConfig = typeof globalConfigTable.$inferSelect;

export const botInstancesTable = pgTable("bot_instances", {
  id: text("id").primaryKey(),
  userId: text("user_id").unique(),
  status: text("status").default("idle"),
  lastHeartbeatAt: integer("last_heartbeat_at"),
  tradesToday: integer("trades_today").default(0),
  createdAt: integer("created_at"),
});

export type BotInstance = typeof botInstancesTable.$inferSelect;
