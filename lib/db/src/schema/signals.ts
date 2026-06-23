import { pgTable, text, real, integer } from "drizzle-orm/pg-core";

export const signalLogTable = pgTable("signal_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  strategyId: text("strategy_id"),
  timestamp: integer("timestamp"),
  scoreTotal: real("score_total"),
  scoreTrend: real("score_trend"),
  scoreVolatility: real("score_volatility"),
  scoreTiming: real("score_timing"),
  scorePullback: real("score_pullback"),
  scoreRisk: real("score_risk"),
  direction: text("direction"),
  action: text("action"),
  rejectionReason: text("rejection_reason"),
  ema9: real("ema9"),
  ema21: real("ema21"),
  ema50: real("ema50"),
  adx: real("adx"),
  rsi: real("rsi"),
  bbUpper: real("bb_upper"),
  bbLower: real("bb_lower"),
  bbWidth: real("bb_width"),
  stochK: real("stoch_k"),
  macdHistogram: real("macd_histogram"),
  rangeContext: text("range_context"),
  sessionName: text("session_name"),
  consolidationDetected: integer("consolidation_detected"),
  spikeDetected: integer("spike_detected"),
  firstCandleWaiting: integer("first_candle_waiting"),
  smcBos: integer("smc_bos"),
  smcChoch: integer("smc_choch"),
  orderBlockNearby: integer("order_block_nearby"),
  fvgNearby: integer("fvg_nearby"),
});

export type SignalLog = typeof signalLogTable.$inferSelect;

export const adaptiveWeightsTable = pgTable("adaptive_weights", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  strategyId: text("strategy_id"),
  tradesAnalyzed: integer("trades_analyzed").default(0),
  weightRsi: real("weight_rsi").default(1.0),
  weightStoch: real("weight_stoch").default(1.0),
  weightMacd: real("weight_macd").default(1.0),
  weightPullback: real("weight_pullback").default(1.0),
  weightSmc: real("weight_smc").default(1.0),
  weightTrend: real("weight_trend").default(1.0),
  weightVolatility: real("weight_volatility").default(1.0),
  lastUpdated: integer("last_updated"),
});

export type AdaptiveWeights = typeof adaptiveWeightsTable.$inferSelect;

export const sessionPerformanceTable = pgTable("session_performance", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  sessionName: text("session_name"),
  totalTrades: integer("total_trades").default(0),
  wins: integer("wins").default(0),
  losses: integer("losses").default(0),
  winRate: real("win_rate").default(0),
  sessionMultiplier: real("session_multiplier").default(1.0),
  lastUpdated: integer("last_updated"),
});

export type SessionPerformance = typeof sessionPerformanceTable.$inferSelect;
