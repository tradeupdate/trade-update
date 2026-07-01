import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import { scoreV10 } from "./scoring-v10.js";
import { logger } from "../lib/logger.js";
import type { SwingBacktestResult, SwingTradeDetail } from "./swing-backtest-engine.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_10";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const PAYOUT_RATE = 0.87;

// ── Cache helpers ─────────────────────────────────────────────────────────────

function normalizeMidnightUTC(unix: number): number {
  const d = new Date(unix * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function normalizeEndOfDayUTC(unix: number): number {
  const d = new Date(unix * 1000);
  d.setUTCHours(23, 59, 59, 0);
  return Math.floor(d.getTime() / 1000);
}

function getCacheKey(dateFrom: number, dateTo: number): string {
  return `${SYMBOL}_5m_${normalizeMidnightUTC(dateFrom)}_${normalizeEndOfDayUTC(dateTo)}`;
}

function getCachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

interface V10Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function readCache(key: string): { candles: V10Candle[]; cachedAt: number } | null {
  const file = getCachePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { candles: data.candles, cachedAt: data.cachedAt };
  } catch { return null; }
}

function writeCache(key: string, candles: V10Candle[], dateFrom: number, dateTo: number): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = { symbol: SYMBOL, granularity: 300, dateFrom, dateTo, candles, cachedAt: Date.now(), count: candles.length };
  fs.writeFileSync(getCachePath(key), JSON.stringify(entry, null, 2));
}

// ── Deriv fetch ───────────────────────────────────────────────────────────────

function fetchOneChunk(symbol: string, granularity: number, count: number, endTime: number): Promise<V10Candle[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve([]); }, 20000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ ticks_history: symbol, style: "candles", granularity, count, end: endTime }));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.candles.map((c: Record<string, unknown>) => ({
            time: Number(c.epoch),
            open: parseFloat(String(c.open)),
            high: parseFloat(String(c.high)),
            low: parseFloat(String(c.low)),
            close: parseFloat(String(c.close)),
          })));
        } else if (msg.error) {
          clearTimeout(timeout); ws.close(); resolve([]);
        }
      } catch { /* skip */ }
    });

    ws.on("error", () => { clearTimeout(timeout); try { ws.terminate(); } catch {} resolve([]); });
  });
}

async function fetchFromDeriv(dateFrom: number, dateTo: number): Promise<V10Candle[]> {
  const CHUNK_SIZE = 5000;
  const GRANULARITY = 300;
  const MAX_CHUNKS = 10;
  const all: V10Candle[] = [];
  let currentEnd = dateTo;
  let chunks = 0;

  while (currentEnd > dateFrom && chunks < MAX_CHUNKS) {
    chunks++;
    const chunk = await fetchOneChunk(SYMBOL, GRANULARITY, CHUNK_SIZE, currentEnd);
    if (!chunk.length) break;
    all.push(...chunk);
    const earliest = Math.min(...chunk.map((c) => c.time));
    currentEnd = earliest - GRANULARITY;
    if (earliest <= dateFrom) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const filtered = all.filter((c) => c.time >= dateFrom && c.time <= dateTo);
  const sorted = filtered.sort((a, b) => a.time - b.time);
  return sorted.filter((c, i) => i === 0 || c.time !== sorted[i - 1]!.time);
}

// ── Candle builders ───────────────────────────────────────────────────────────

function build15mCandles(candles5m: V10Candle[]): V10Candle[] {
  const grouped: Record<number, V10Candle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 900) * 900;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary]!.push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([b, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return { time: parseInt(b), open: sorted[0]!.open, high: Math.max(...sorted.map(c => c.high)), low: Math.min(...sorted.map(c => c.low)), close: sorted[sorted.length - 1]!.close };
    }).sort((a, b) => a.time - b.time);
}

// ── P&L helpers ───────────────────────────────────────────────────────────────

function calculateV10PnL(
  outcome: "TP_HIT" | "STOP_LOSS" | "TIME_STOP",
  stake: number,
  direction: string,
  entryPrice: number,
  closePrice: number
): number {
  const priceMoved = direction === "BUY" ? closePrice - entryPrice : entryPrice - closePrice;

  console.log(`[V10] P&L CALC: outcome=${outcome} stake=$${stake} dir=${direction} entry=${entryPrice.toFixed(4)} close=${closePrice.toFixed(4)} moved=${priceMoved.toFixed(4)}`);

  if (outcome === "TP_HIT") {
    const pnl = Math.round(stake * PAYOUT_RATE * 100) / 100;
    console.log(`[V10] WIN: +$${pnl}`);
    return pnl;
  }

  if (outcome === "STOP_LOSS") {
    const pnl = -stake;
    console.log(`[V10] LOSS: $${pnl}`);
    return pnl;
  }

  // TIME_STOP — half payout based on direction
  const profitable = priceMoved > 0;
  const pnl = profitable
    ? Math.round(stake * PAYOUT_RATE * 0.5 * 100) / 100
    : -Math.round(stake * 0.5 * 100) / 100;
  console.log(`[V10] TIME STOP ${profitable ? "WIN" : "LOSS"}: $${pnl}`);
  return pnl;
}

// ── Outcome checker ───────────────────────────────────────────────────────────

function checkV10Outcome(
  direction: string,
  stopLoss: number,
  takeProfit: number,
  candle: V10Candle
): "TP_HIT" | "STOP_LOSS" | null {

  if (direction === "BUY") {
    if (candle.low <= stopLoss) {
      console.log(`[V10] BUY STOP HIT: low=${candle.low.toFixed(4)} <= stop=${stopLoss.toFixed(4)}`);
      return "STOP_LOSS";
    }
    if (candle.high >= takeProfit) {
      console.log(`[V10] BUY TP HIT: high=${candle.high.toFixed(4)} >= tp=${takeProfit.toFixed(4)}`);
      return "TP_HIT";
    }
  } else {
    if (candle.high >= stopLoss) {
      console.log(`[V10] SELL STOP HIT: high=${candle.high.toFixed(4)} >= stop=${stopLoss.toFixed(4)}`);
      return "STOP_LOSS";
    }
    if (candle.low <= takeProfit) {
      console.log(`[V10] SELL TP HIT: low=${candle.low.toFixed(4)} <= tp=${takeProfit.toFixed(4)}`);
      return "TP_HIT";
    }
  }

  return null;
}

// ── Sharpe ratio ──────────────────────────────────────────────────────────────

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(252);
}

// ── Main V10 Backtest ─────────────────────────────────────────────────────────

export type ProgressCallback = (p: {
  candleIndex: number; totalCandles: number; tradesExecuted: number;
  wins: number; currentBalance: number; phase: "fetching" | "running";
  funnel: Record<string, number>;
}) => void;

export async function runV10Backtest(
  strategyId: string,
  config: {
    scoreThreshold: number;
    maxRiskPercent: number;
    maxTradesDay: number;
    consecutiveLossStop: number;
  },
  dateFrom: number,
  dateTo: number,
  runBy: string,
  forceRefresh: boolean,
  startingBalance: number,
  onProgress?: ProgressCallback,
): Promise<SwingBacktestResult> {
  const runId = `V10_${Date.now()}_${strategyId}`;

  // ── Fetch candles (R_10) ──────────────────────────────────────────────────
  const cacheKey = getCacheKey(dateFrom, dateTo);
  let candles5m: V10Candle[];
  let dataSource: "cache" | "deriv_fresh" = "cache";
  const cacheFile = getCachePath(cacheKey);

  const cached = !forceRefresh ? readCache(cacheKey) : null;
  if (cached) {
    candles5m = cached.candles;
    logger.info({ runId, key: cacheKey, count: candles5m.length }, "V10 backtest: cache hit");
  } else {
    candles5m = await fetchFromDeriv(dateFrom, dateTo);
    writeCache(cacheKey, candles5m, dateFrom, dateTo);
    dataSource = "deriv_fresh";
    logger.info({ runId, count: candles5m.length }, "V10 backtest: fetched from Deriv");
  }

  if (candles5m.length < 50) throw new Error(`Insufficient V10 candle data: ${candles5m.length} candles`);

  // ── Build 15m candles ─────────────────────────────────────────────────────
  const all15m = build15mCandles(candles5m);

  const hashSum = candles5m.slice(0, 10).reduce((s, c) => s + c.close, 0);
  const candleHash = `${candles5m.length}:${hashSum.toFixed(2)}`;

  // Warmup: need at least 50 5m candles (30 for range check + buffer)
  const WARMUP = 50;
  // Time stop: 24 x 5m bars = 2 hours (V10 is a short-duration mean reversion strategy)
  const MAX_HOLD_BARS = 24;
  const SCORE_THRESHOLD = config.scoreThreshold ?? 8;
  const MAX_RISK = (config.maxRiskPercent ?? 1.0) / 100;
  const MAX_TRADES_DAY = config.maxTradesDay ?? 4;
  const CONS_LOSS_STOP = config.consecutiveLossStop ?? 3;

  console.log(`\n=== V10 BACKTEST STARTING ===`);
  console.log(`Symbol: ${SYMBOL}  5m candles: ${candles5m.length}  15m: ${all15m.length}  WARMUP: ${WARMUP}`);
  console.log(`Date range: ${new Date(dateFrom * 1000).toISOString()} → ${new Date(dateTo * 1000).toISOString()}`);
  console.log(`Config: threshold=${SCORE_THRESHOLD} risk=${config.maxRiskPercent}% maxDay=${MAX_TRADES_DAY} consLoss=${CONS_LOSS_STOP} payout=${PAYOUT_RATE}`);

  // ── State ─────────────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peak = balance;
  let maxDD = 0;
  const tradeList: SwingTradeDetail[] = [];
  const equityCurve: { index: number; value: number }[] = [{ index: 0, value: balance }];
  const returns: number[] = [];

  interface OpenV10Trade {
    direction: "BUY" | "SELL";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    stake: number;
    openIdx: number;
    openTime: number;
    barsHeld: number;
    scoreVal: number;
    c1: number;
    c2: number;
    c3: number;
    tier: "T1" | "T2";
  }

  let openTrade: OpenV10Trade | null = null;
  let consLosses = 0;
  let todayTrades = 0;
  let currentDay = "";

  // Funnel counters
  let scoreNullCount = 0;
  let trendRiskFiltered = 0;
  let belowThreshold = 0;
  let dirNone = 0;
  let tradesExecuted = 0;
  let t1Executed = 0;
  let t2Executed = 0;
  let dailyLimitBlocked = 0;
  let consLossBlocked = 0;

  // Advance 15m pointer
  let m15Ptr = 0;

  let v10Wins = 0;
  for (let i = WARMUP; i < candles5m.length; i++) {
    const candle = candles5m[i]!;

    if (i % 200 === 0) {
      onProgress?.({
        candleIndex: i, totalCandles: candles5m.length,
        tradesExecuted: tradesExecuted, wins: v10Wins,
        currentBalance: balance, phase: "running",
        funnel: { scoreNull: scoreNullCount, trendRisk: trendRiskFiltered, belowThreshold, dirNone, dailyLimit: dailyLimitBlocked, consLoss: consLossBlocked },
      });
    }

    // Daily reset
    const day = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      todayTrades = 0;
    }

    // Advance 15m pointer
    while (m15Ptr + 1 < all15m.length && all15m[m15Ptr + 1]!.time <= candle.time) m15Ptr++;

    // ── Manage open trade ────────────────────────────────────────────────
    if (openTrade) {
      const outcome = checkV10Outcome(openTrade.direction, openTrade.stopLoss, openTrade.takeProfit, candle);

      const timeStop = openTrade.barsHeld >= MAX_HOLD_BARS;

      if (outcome || timeStop) {
        const closeOutcome = outcome ?? "TIME_STOP";
        const closePrice = outcome === "TP_HIT"
          ? openTrade.takeProfit
          : outcome === "STOP_LOSS"
          ? openTrade.stopLoss
          : candle.close;

        const pnl = calculateV10PnL(closeOutcome, openTrade.stake, openTrade.direction, openTrade.entryPrice, closePrice);

        balance = Math.round((balance + pnl) * 100) / 100;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;

        consLosses = pnl > 0 ? 0 : consLosses + 1;

        const tradeDetail: SwingTradeDetail = {
          tradeNum: tradeList.length + 1,
          direction: openTrade.direction,
          entryPrice: openTrade.entryPrice,
          slPrice: openTrade.stopLoss,
          tp1Price: openTrade.takeProfit,
          tp2Price: openTrade.takeProfit,
          exitPrice: closePrice,
          closeReason: outcome === "TP_HIT" ? "tp2" : outcome === "STOP_LOSS" ? "sl" : "time_stop",
          pnl,
          durationMinutes: openTrade.barsHeld * 5,
          entryTime: openTrade.openTime,
          exitTime: candle.time,
          score: openTrade.scoreVal,
          c1: openTrade.c1,
          c2: openTrade.c2,
          c3: openTrade.c3,
          stage2Added: false,
        };
        if (pnl > 0) v10Wins++;
        tradeList.push(tradeDetail);
        returns.push(pnl / startingBalance);
        equityCurve.push({ index: tradeList.length - 1, value: balance });

        console.log(`[V10] <<< TRADE CLOSE #${tradeDetail.tradeNum} reason=${closeOutcome} dir=${openTrade.direction} entry=${openTrade.entryPrice.toFixed(4)} exit=${closePrice.toFixed(4)} pnl=$${pnl.toFixed(2)} balance=$${balance.toFixed(2)}`);
        openTrade = null;
      } else {
        openTrade.barsHeld++;
      }
    }

    if (openTrade) continue;

    // ── Filters ──────────────────────────────────────────────────────────
    if (todayTrades >= MAX_TRADES_DAY) { dailyLimitBlocked++; continue; }
    if (consLosses >= CONS_LOSS_STOP) { consLossBlocked++; continue; }

    // ── Build scoring windows ──────────────────────────────────────────
    const window5m = candles5m.slice(Math.max(0, i - 49), i + 1) as Candle[];
    const window15m = all15m.slice(Math.max(0, m15Ptr - 49), m15Ptr + 1) as Candle[];

    // Use last 5m candle as 1m proxy (for rejection pattern)
    const window1m: Candle[] = [{ ...candle, time: candle.time * 1000, volume: 0 }];
    const window5mForScore: Candle[] = window5m.map(c => ({ ...c, time: c.time * 1000, volume: 0 }));
    const window15mForScore: Candle[] = window15m.map(c => ({ ...c, time: c.time * 1000, volume: 0 }));

    // ── Score ────────────────────────────────────────────────────────────
    let v10Result;
    try {
      v10Result = scoreV10(window1m, window5mForScore, window15mForScore);
    } catch (err) {
      scoreNullCount++;
      continue;
    }

    if (!v10Result || !v10Result.ready) { scoreNullCount++; continue; }

    if (v10Result.trendRisk) {
      trendRiskFiltered++;
      if (trendRiskFiltered <= 5) console.log(`[V10] Trend risk filtered: ADX=${v10Result.adx.toFixed(1)}`);
      continue;
    }

    if (i % 500 === 0) {
      console.log(`[V10] Score sample i=${i}: total=${v10Result.total} dir=${v10Result.direction} c1=${v10Result.c1} c2=${v10Result.c2} c3=${v10Result.c3} price=${candle.close.toFixed(4)}`);
    }

    // T1 quality gate lives inside scoreV10 itself (returns direction=NONE if not qualified).
    // T2 has its own threshold (lower conviction, half size).
    // SCORE_THRESHOLD from config is no longer used — it duplicates the internal gate.
    const tradeTier = v10Result.tier ?? "T1";
    const T2_SCORE_THRESHOLD = 6;
    if (v10Result.direction === "NONE") { dirNone++; continue; }
    if (tradeTier === "T2" && v10Result.total < T2_SCORE_THRESHOLD) { belowThreshold++; continue; }

    // ── Validate stop/TP levels ───────────────────────────────────────────
    let { stopLoss, takeProfit } = v10Result;
    const entryPrice = candle.close;
    const atr = v10Result.atrValue;

    console.log(`[V10] TRADE LEVELS:
  Direction: ${v10Result.direction}
  Entry: ${entryPrice.toFixed(4)}
  Stop Loss: ${stopLoss.toFixed(4)}
  Take Profit: ${takeProfit.toFixed(4)}
  Stop BELOW entry (BUY): ${v10Result.direction === "BUY" ? stopLoss < entryPrice : "N/A"}
  Stop ABOVE entry (SELL): ${v10Result.direction === "SELL" ? stopLoss > entryPrice : "N/A"}
  TP ABOVE entry (BUY): ${v10Result.direction === "BUY" ? takeProfit > entryPrice : "N/A"}
  TP BELOW entry (SELL): ${v10Result.direction === "SELL" ? takeProfit < entryPrice : "N/A"}`);

    if (v10Result.direction === "BUY") {
      if (stopLoss >= entryPrice) {
        console.error(`[V10] BUG FIXED: BUY stop (${stopLoss.toFixed(4)}) was >= entry (${entryPrice.toFixed(4)}) — correcting`);
        stopLoss = entryPrice - Math.max(5, atr * 0.8);
      }
      if (takeProfit <= entryPrice) {
        console.error(`[V10] BUG FIXED: BUY TP (${takeProfit.toFixed(4)}) was <= entry (${entryPrice.toFixed(4)}) — correcting`);
        takeProfit = entryPrice + Math.max(10, atr * 1.0);
      }
    } else {
      if (stopLoss <= entryPrice) {
        console.error(`[V10] BUG FIXED: SELL stop (${stopLoss.toFixed(4)}) was <= entry (${entryPrice.toFixed(4)}) — correcting`);
        stopLoss = entryPrice + Math.max(5, atr * 0.8);
      }
      if (takeProfit >= entryPrice) {
        console.error(`[V10] BUG FIXED: SELL TP (${takeProfit.toFixed(4)}) was >= entry (${entryPrice.toFixed(4)}) — correcting`);
        takeProfit = entryPrice - Math.max(10, atr * 1.0);
      }
    }

    // ── Open trade ────────────────────────────────────────────────────────
    // T2 trades use half position size (lower conviction approach signal)
    const tierRiskMultiplier = tradeTier === "T2" ? 0.5 : 1.0;
    const stake = Math.max(1, Math.round(balance * MAX_RISK * tierRiskMultiplier * 100) / 100);

    openTrade = {
      direction: v10Result.direction,
      entryPrice,
      stopLoss,
      takeProfit,
      stake,
      openIdx: i,
      openTime: candle.time,
      barsHeld: 0,
      scoreVal: v10Result.total,
      c1: v10Result.c1,
      c2: v10Result.c2,
      c3: v10Result.c3,
      tier: tradeTier,
    };

    todayTrades++;
    tradesExecuted++;
    if (tradeTier === "T1") t1Executed++; else t2Executed++;

    console.log(`[V10] >>> TRADE ENTRY #${tradesExecuted} [${tradeTier}] dir=${v10Result.direction} score=${v10Result.total}(${v10Result.c1}/${v10Result.c2}/${v10Result.c3}) entry=${entryPrice.toFixed(4)} sl=${stopLoss.toFixed(4)} tp=${takeProfit.toFixed(4)} stake=$${stake}`);
  }

  // Close any open trade at end of data
  if (openTrade) {
    const last = candles5m[candles5m.length - 1]!;
    const pnl = calculateV10PnL("TIME_STOP", openTrade.stake, openTrade.direction, openTrade.entryPrice, last.close);
    balance = Math.round((balance + pnl) * 100) / 100;
    if (balance > peak) peak = balance;

    tradeList.push({
      tradeNum: tradeList.length + 1,
      direction: openTrade.direction,
      entryPrice: openTrade.entryPrice,
      slPrice: openTrade.stopLoss,
      tp1Price: openTrade.takeProfit,
      tp2Price: openTrade.takeProfit,
      exitPrice: last.close,
      closeReason: "end_of_data",
      pnl,
      durationMinutes: openTrade.barsHeld * 5,
      entryTime: openTrade.openTime,
      exitTime: last.time,
      score: openTrade.scoreVal,
      c1: openTrade.c1,
      c2: openTrade.c2,
      c3: openTrade.c3,
      stage2Added: false,
    });
    returns.push(pnl / startingBalance);
    equityCurve.push({ index: tradeList.length - 1, value: balance });
  }

  // ── Final stats ────────────────────────────────────────────────────────
  console.log(`\n=== V10 BACKTEST COMPLETE ===`);
  console.log(`5m candles: ${candles5m.length - WARMUP} processed`);
  console.log(`scoreNull=${scoreNullCount} trendRisk=${trendRiskFiltered} belowThreshold=${belowThreshold} dirNone=${dirNone} dailyLimit=${dailyLimitBlocked} consLoss=${consLossBlocked}`);
  console.log(`Tier breakdown: T1=${t1Executed} (full size) T2=${t2Executed} (half size)`);

  const wins = tradeList.filter(t => t.pnl > 0).length;
  const losses = tradeList.filter(t => t.pnl <= 0).length;
  const total = tradeList.length;
  const winRate = total > 0 ? Math.round((wins / total * 100) * 10) / 10 : 0;
  const totalPnl = Math.round(tradeList.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  const grossWin = tradeList.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeList.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0;
  const bestTrade = total > 0 ? Math.max(...tradeList.map(t => t.pnl)) : 0;
  const worstTrade = total > 0 ? Math.min(...tradeList.map(t => t.pnl)) : 0;
  const avgDuration = total > 0 ? Math.round(tradeList.reduce((s, t) => s + t.durationMinutes, 0) / total) : 0;

  console.log(`V10 Final Results:
  Total trades: ${total}
  Wins: ${wins}
  Losses: ${losses}
  Win rate: ${winRate.toFixed(1)}%
  Total P&L: $${totalPnl.toFixed(2)}
  Profit factor: ${profitFactor}`);

  logger.info({ runId, total, wins, winRate, totalPnl, hash: candleHash }, "V10 backtest complete");

  return {
    runId,
    totalTrades: total,
    wins,
    losses,
    winRate,
    profitFactor,
    maxDrawdown: Math.round(maxDD * 10000) / 100,
    totalPnl,
    equityCurve,
    bestTrade: Math.round(bestTrade * 100) / 100,
    worstTrade: Math.round(worstTrade * 100) / 100,
    avgDurationMinutes: avgDuration,
    sharpeRatio: Math.round(calcSharpe(returns) * 100) / 100,
    candlesUsed: candles5m.length,
    candleHash,
    dataSource,
    cacheFile,
    partialExitStats: { tp1Hits: 0, tp2Hits: wins, beHits: 0, stage2Hits: 0 },
    trades: tradeList,
    funnel: {
      scoreNull: scoreNullCount,
      trendRisk: trendRiskFiltered,
      belowThreshold,
      dirNone,
      dailyLimit: dailyLimitBlocked,
      consLoss: consLossBlocked,
      executed: tradesExecuted,
      t1Executed,
      t2Executed,
      totalProcessed: candles5m.length - WARMUP,
    },
  };
}
