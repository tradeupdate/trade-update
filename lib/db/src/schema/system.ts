import { pgTable, text, integer } from "drizzle-orm/pg-core";

export const systemSettingsTable = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export type SystemSetting = typeof systemSettingsTable.$inferSelect;
