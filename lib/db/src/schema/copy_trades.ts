import { pgTable, text, real, integer } from "drizzle-orm/pg-core";

export const copyTradesTable = pgTable("copy_trades", {
  id: text("id").primaryKey(),
  adminId: text("admin_id"),
  direction: text("direction"),
  riskMultiplier: real("risk_multiplier").default(1.25),
  forceOverride: integer("force_override").default(0),
  status: text("status"),
  usersTargeted: text("users_targeted").default("[]"),
  usersReceived: text("users_received").default("[]"),
  usersSkipped: text("users_skipped").default("[]"),
  skipReasons: text("skip_reasons").default("{}"),
  createdAt: integer("created_at"),
  executedAt: integer("executed_at"),
});

export type CopyTrade = typeof copyTradesTable.$inferSelect;
