import { pgTable, text, real, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  strategyId: text("strategy_id"),
  direction: text("direction"),
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  stake: real("stake"),
  pnl: real("pnl"),
  pips: real("pips"),
  durationMinutes: integer("duration_minutes"),
  scoreTotal: real("score_total"),
  scoreTrend: real("score_trend"),
  scoreVolatility: real("score_volatility"),
  scoreTiming: real("score_timing"),
  scorePullback: real("score_pullback"),
  scoreRisk: real("score_risk"),
  isCopyTrade: integer("is_copy_trade").default(0),
  copyForceOverridden: integer("copy_force_overridden").default(0),
  isPaper: integer("is_paper").default(1),
  tradingMode: text("trading_mode"),
  status: text("status"),
  contractId: text("contract_id"),
  stopLoss: real("stop_loss"),
  takeProfit1: real("take_profit_1"),
  takeProfit2: real("take_profit_2"),
  breakEvenMoved: integer("break_even_moved").default(0),
  partialClosed: integer("partial_closed").default(0),
  momentumExtensionActive: integer("momentum_extension_active").default(0),
  recoveryModeActive: integer("recovery_mode_active").default(0),
  winStreakCautionActive: integer("win_streak_caution_active").default(0),
  sessionName: text("session_name"),
  sessionWeight: real("session_weight"),
  rangeContext: text("range_context"),
  spikeFilterTriggered: integer("spike_filter_triggered").default(0),
  rsiAtEntry: real("rsi_at_entry"),
  stochAtEntry: real("stoch_at_entry"),
  macdAtEntry: real("macd_at_entry"),
  bbPosition: text("bb_position"),
  smcStructure: text("smc_structure"),
  pullbackZoneActive: integer("pullback_zone_active").default(0),
  openedAt: integer("opened_at"),
  closedAt: integer("closed_at"),
  tp1HitAt: integer("tp1_hit_at"),
  tp2HitAt: integer("tp2_hit_at"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
