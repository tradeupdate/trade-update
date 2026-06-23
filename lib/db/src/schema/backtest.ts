import { pgTable, text, real, integer } from "drizzle-orm/pg-core";

export const backtestResultsTable = pgTable("backtest_results", {
  id: text("id").primaryKey(),
  strategyId: text("strategy_id"),
  runBy: text("run_by"),
  dateFrom: integer("date_from"),
  dateTo: integer("date_to"),
  totalTrades: integer("total_trades"),
  wins: integer("wins"),
  losses: integer("losses"),
  winRate: real("win_rate"),
  profitFactor: real("profit_factor"),
  maxDrawdown: real("max_drawdown"),
  totalPnl: real("total_pnl"),
  equityCurve: text("equity_curve").default("[]"),
  sessionBreakdown: text("session_breakdown").default("{}"),
  indicatorAccuracy: text("indicator_accuracy").default("{}"),
  scoreRangePerformance: text("score_range_performance").default("{}"),
  bestTrade: real("best_trade"),
  worstTrade: real("worst_trade"),
  avgDurationMinutes: real("avg_duration_minutes"),
  sharpeRatio: real("sharpe_ratio"),
  createdAt: integer("created_at"),
});

export type BacktestResult = typeof backtestResultsTable.$inferSelect;
