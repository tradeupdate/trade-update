import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import {
  calculateSessionMove,
  detectDivergence,
  detectBBExtreme,
  check1mConfirmation,
} from "./reversal-scoring.js";
import { logger } from "../lib/logger.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_75";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

const MIN_STOP_PIPS = 10;
const MAX_STOP_PIPS = 150;
const MIN_TP_PIPS   = 10;
const MIN_RR        = 0.8;
const SESSION_MOVE_THRESHOLD = 50;
const TIME_STOP_BARS_5M = 4;  // 4 × 5m = 20 minutes
const COOLDOWN_BARS_5M  = 6;  // 6 × 5m = 30 minutes
const MAX_TRADES_DAY    = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BTCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReversalBacktestConfig {
  scoreThreshold: number;
  maxRiskPercent: number;
  maxTradesDay: number;
  consecutiveLossStop: number;
}

interface OpenReversalTrade {
  direction: "BUY" | "SELL";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  stake: number;
  barsHeld: number;
  entryTime: number;
  score: number;
  c1: number;
  c2: number;
  c3: number;
  isPremium: boolean;
}

export interface ReversalTradeDetail {
  tradeNum: number;
  direction: "BUY" | "SELL";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  closeReason: "sl" | "tp" | "time_stop" | "end_of_data";
  pnl: number;
  durationMinutes: number;
  entryTime: number;
  exitTime: number;
  score: number;
  c1: number;
  c2: number;
  c3: number;
  isPremium: boolean;
  sessionMovePips: number;
  rr: number;
}

export interface ReversalBacktestResult {
  runId: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  totalPnl: number;
  equityCurve: { index: number; value: number }[];
  bestTrade: number;
  worstTrade: number;
  avgDurationMinutes: number;
  sharpeRatio: number;
  candlesUsed: number;
  candleHash: string;
  dataSource: "cache" | "deriv_fresh";
  cacheFile: string;
  trades: ReversalTradeDetail[];
  rejectionStats: {
    insufficientMove: number;
    noDivergence: number;
    noBBBreach: number;
    stopTooWide: number;
    stopTooTight: number;
    tpTooClose: number;
    rrTooLow: number;
    belowThreshold: number;
    cooldown: number;
    dailyLimit: number;
    consLossBlocked: number;
  };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function normalizeMidnightUTC(unix: number): number {
  const d = new Date(unix * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function getCacheKey(dateFrom: number, dateTo: number): string {
  return `${SYMBOL}_5m_${normalizeMidnightUTC(dateFrom)}_${normalizeMidnightUTC(dateTo)}`;
}
function getCachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}
function readCache(key: string): { candles: BTCandle[]; cachedAt: number } | null {
  const file = getCachePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { candles: data.candles, cachedAt: data.cachedAt };
  } catch { return null; }
}
function writeCache(key: string, candles: BTCandle[], dateFrom: number, dateTo: number): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = { symbol: SYMBOL, granularity: 300, dateFrom, dateTo, candles, cachedAt: Date.now(), count: candles.length };
  fs.writeFileSync(getCachePath(key), JSON.stringify(entry, null, 2));
}

// ── Deriv fetch ───────────────────────────────────────────────────────────────

async function fetchFromDeriv(dateFrom: number, dateTo: number): Promise<BTCandle[]> {
  const CHUNK_SIZE = 5000;
  const GRANULARITY = 300;
  const MAX_CHUNKS = 10;
  const all: BTCandle[] = [];
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

function fetchOneChunk(
  symbol: string,
  granularity: number,
  count: number,
  endTime: number
): Promise<BTCandle[]> {
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

// ── Timeframe builders ────────────────────────────────────────────────────────

function build15mCandles(candles5m: BTCandle[]): BTCandle[] {
  const grouped: Record<number, BTCandle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 900) * 900;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary]!.push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([b, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return {
        time: parseInt(b),
        open: sorted[0]!.open,
        high: Math.max(...sorted.map(c => c.high)),
        low: Math.min(...sorted.map(c => c.low)),
        close: sorted[sorted.length - 1]!.close,
      };
    }).sort((a, b) => a.time - b.time);
}

// ── RSI helpers (needed for session move calc which uses current time) ─────────

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(252);
}

// ── Scoring helpers (inline, backtest-safe) ───────────────────────────────────

function calcRSIArray(candles: BTCandle[], period = 14): number[] {
  const closes = candles.map(c => c.close);
  if (closes.length < period + 1) return closes.map(() => 50);
  const result: number[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain += Math.max(0, diff);
    avgLoss += Math.max(0, -diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = 0; i < period; i++) result.push(50);
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function detectDivergenceBT(candles: BTCandle[], lookback = 14): { bullish: boolean; bearish: boolean; currentRsi: number } {
  if (candles.length < lookback + 14) return { bullish: false, bearish: false, currentRsi: 50 };
  const rsiAll = calcRSIArray(candles as Candle[], 14);
  if (rsiAll.length < lookback + 1) return { bullish: false, bearish: false, currentRsi: 50 };

  const currentClose = candles[candles.length - 1]!.close;
  const currentRsi   = rsiAll[rsiAll.length - 1]!;

  // Look at the prior lookback bars (not including current)
  const priorCloses = candles.slice(-(lookback + 1), -1).map(c => c.close);
  const priorRsi    = rsiAll.slice(-(lookback + 1), -1);

  // Bullish divergence: current price ≤ prior low, but current RSI > RSI at that prior low
  const priorLow    = Math.min(...priorCloses);
  const priorLowIdx = priorCloses.indexOf(priorLow);
  const rsiAtLow    = priorRsi[priorLowIdx] ?? currentRsi;
  const bullish     = currentClose <= priorLow * 1.002 && currentRsi > rsiAtLow + 2;

  // Bearish divergence: current price ≥ prior high, but current RSI < RSI at that prior high
  const priorHigh    = Math.max(...priorCloses);
  const priorHighIdx = priorCloses.indexOf(priorHigh);
  const rsiAtHigh    = priorRsi[priorHighIdx] ?? currentRsi;
  const bearish      = currentClose >= priorHigh * 0.998 && currentRsi < rsiAtHigh - 2;

  return { bullish, bearish, currentRsi };
}

function calcBBBT(candles: BTCandle[], period = 20, sigma = 2.0): { upper: number; middle: number; lower: number } {
  if (candles.length < period) {
    const c = candles[candles.length - 1]?.close ?? 0;
    return { upper: c, middle: c, lower: c };
  }
  const closes = candles.slice(-period).map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const stddev = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + sigma * stddev, middle: mean, lower: mean - sigma * stddev };
}

function scoreSessionExhaustionBT(movePips: number, moveDir: "UP" | "DOWN" | "NONE", direction: "BUY" | "SELL"): number {
  const aligned = (direction === "BUY" && moveDir === "DOWN") || (direction === "SELL" && moveDir === "UP");
  const base = aligned ? 0 : -2;
  if (movePips >= 400) return Math.max(0, 10 + base);
  if (movePips >= 300) return Math.max(0, 8 + base);
  if (movePips >= 200) return Math.max(0, 6 + base);
  if (movePips >= 150) return Math.max(0, 5 + base);
  if (movePips >= 100) return Math.max(0, 4 + base);
  if (movePips >= 50)  return Math.max(0, 2 + base);
  return 1;
}

function scoreDivBT(d5: { bullish: boolean; bearish: boolean; currentRsi: number }, d15: { bullish: boolean; bearish: boolean; currentRsi: number }, dir: "BUY" | "SELL"): number {
  let s = 0;
  if (dir === "BUY") {
    if (d5.bullish) s += 4;
    if (d15.bullish) s += 4;
    if (d5.currentRsi < 25) s += 2;
    else if (d5.currentRsi < 30) s += 1;
  } else {
    if (d5.bearish) s += 4;
    if (d15.bearish) s += 4;
    if (d5.currentRsi > 75) s += 2;
    else if (d5.currentRsi > 70) s += 1;
  }
  return Math.min(s, 10);
}

function scoreBBBT(belowLower: boolean, aboveUpper: boolean, below25: boolean, above25: boolean, dir: "BUY" | "SELL"): number {
  if (dir === "BUY") {
    if (below25) return 5;
    if (belowLower) return 3;
    return 1;
  }
  if (above25) return 5;
  if (aboveUpper) return 3;
  return 1;
}

// ── Backtest session move (uses candle time, not Date.now) ────────────────────

function calcSessionMoveBT(candles5m: BTCandle[], currentTime: number): { movePips: number; moveDir: "UP" | "DOWN" | "NONE" } {
  const utcHour = new Date(currentTime * 1000).getUTCHours();
  let sessionOpenHour = 0;
  if (utcHour >= 0 && utcHour < 7) sessionOpenHour = 0;
  else if (utcHour >= 7 && utcHour < 12) sessionOpenHour = 7;
  else if (utcHour >= 12 && utcHour < 17) sessionOpenHour = 12;
  const sessionOpenTime = new Date(currentTime * 1000);
  sessionOpenTime.setUTCHours(sessionOpenHour, 0, 0, 0);
  const sessionOpenUnix = sessionOpenTime.getTime() / 1000;
  const sessionCandles = candles5m.filter(c => c.time >= sessionOpenUnix && c.time <= currentTime);
  if (sessionCandles.length === 0) return { movePips: 0, moveDir: "NONE" };
  const openPrice = sessionCandles[0]!.open;
  const closePrice = sessionCandles[sessionCandles.length - 1]!.close;
  const rawMove = closePrice - openPrice;
  return { movePips: Math.abs(rawMove), moveDir: rawMove > 0 ? "UP" : "DOWN" };
}

// ── Main Reversal Backtest ────────────────────────────────────────────────────

export type ProgressCallback = (p: {
  candleIndex: number; totalCandles: number; tradesExecuted: number;
  wins: number; currentBalance: number; phase: "fetching" | "running";
  funnel: Record<string, number>;
}) => void;

export async function runReversalBacktest(
  strategyId: string,
  config: ReversalBacktestConfig,
  dateFrom: number,
  dateTo: number,
  runBy: string,
  forceRefresh: boolean,
  startingBalance: number,
  onProgress?: ProgressCallback,
): Promise<ReversalBacktestResult> {
  const runId = `REV_${Date.now()}_${strategyId}`;

  // ── Fetch / cache ─────────────────────────────────────────────────────────
  const cacheKey = getCacheKey(dateFrom, dateTo);
  let candles5m: BTCandle[];
  let dataSource: "cache" | "deriv_fresh" = "cache";
  const cacheFile = getCachePath(cacheKey);

  const cached = !forceRefresh ? readCache(cacheKey) : null;
  if (cached) {
    candles5m = cached.candles;
    logger.info({ runId, key: cacheKey, count: candles5m.length }, "Reversal backtest: cache hit");
  } else {
    candles5m = await fetchFromDeriv(dateFrom, dateTo);
    writeCache(cacheKey, candles5m, dateFrom, dateTo);
    dataSource = "deriv_fresh";
    logger.info({ runId, count: candles5m.length }, "Reversal backtest: fetched from Deriv");
  }

  if (candles5m.length < 100) throw new Error("Not enough candle data for reversal backtest");

  const all15m = build15mCandles(candles5m);
  const hashSum = candles5m.slice(0, 10).reduce((s, c) => s + c.close, 0);
  const candleHash = `${candles5m.length}:${hashSum.toFixed(2)}`;

  // Warmup: need enough bars for indicators (RSI 14 + BB 20 + divergence lookback)
  const WARMUP = 50;

  const threshold = config.scoreThreshold ?? 8;
  const maxRiskPct = (config.maxRiskPercent ?? 1.0) / 100;
  const maxTradesDay = config.maxTradesDay ?? MAX_TRADES_DAY;
  const consLossStop = config.consecutiveLossStop ?? 3;

  console.log(`\n=== REVERSAL BACKTEST STARTING ===`);
  console.log(`5m candles: ${candles5m.length}  15m: ${all15m.length}  WARMUP: ${WARMUP}`);
  console.log(`Date range: ${new Date(dateFrom * 1000).toISOString()} → ${new Date(dateTo * 1000).toISOString()}`);
  console.log(`Config: threshold=${threshold} risk=${config.maxRiskPercent}% maxPerDay=${maxTradesDay} consLossStop=${consLossStop}`);

  // ── State ─────────────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peak = balance;
  let maxDD = 0;
  let openTrade: OpenReversalTrade | null = null;
  let consLosses = 0;
  let dailyTrades = 0;
  let lastTradeDay = "";
  let cooldownUntilIdx = -1;
  let tradeNum = 0;
  const tradeList: ReversalTradeDetail[] = [];
  const equityCurve: { index: number; value: number }[] = [{ index: 0, value: balance }];
  const returns: number[] = [];

  const rej = {
    insufficientMove: 0, noDivergence: 0, noBBBreach: 0,
    stopTooWide: 0, stopTooTight: 0, tpTooClose: 0, rrTooLow: 0,
    belowThreshold: 0, cooldown: 0, dailyLimit: 0, consLossBlocked: 0,
  };
  let sessionMoveDebugLogs = 0;
  let divergenceDebugLogs = 0;

  // ── Main loop ─────────────────────────────────────────────────────────────
  let revWins = 0;
  for (let i = WARMUP; i < candles5m.length; i++) {
    const candle = candles5m[i]!;

    if (i % 200 === 0) {
      onProgress?.({
        candleIndex: i, totalCandles: candles5m.length,
        tradesExecuted: tradeList.length, wins: revWins,
        currentBalance: balance, phase: "running",
        funnel: { ...rej },
      });
    }

    const dayStr = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (dayStr !== lastTradeDay) { dailyTrades = 0; lastTradeDay = dayStr; }

    // ── Manage open trade ─────────────────────────────────────────────────
    if (openTrade) {
      openTrade.barsHeld++;
      const isBuy = openTrade.direction === "BUY";

      let shouldClose = false;
      let closeReason: ReversalTradeDetail["closeReason"] = "time_stop";
      let exitPrice = candle.close;

      // SL hit
      if (isBuy && candle.low <= openTrade.stopLoss) {
        shouldClose = true; closeReason = "sl"; exitPrice = openTrade.stopLoss;
      } else if (!isBuy && candle.high >= openTrade.stopLoss) {
        shouldClose = true; closeReason = "sl"; exitPrice = openTrade.stopLoss;
      }

      // TP hit (middle BB at entry)
      if (!shouldClose) {
        if (isBuy && candle.high >= openTrade.takeProfit) {
          shouldClose = true; closeReason = "tp"; exitPrice = openTrade.takeProfit;
        } else if (!isBuy && candle.low <= openTrade.takeProfit) {
          shouldClose = true; closeReason = "tp"; exitPrice = openTrade.takeProfit;
        }
      }

      // 20-minute time stop (4 × 5m bars)
      if (!shouldClose && openTrade.barsHeld >= TIME_STOP_BARS_5M) {
        shouldClose = true; closeReason = "time_stop"; exitPrice = candle.close;
      }

      if (shouldClose) {
        const rawPips = isBuy ? exitPrice - openTrade.entryPrice : openTrade.entryPrice - exitPrice;
        const stopDist = Math.abs(openTrade.entryPrice - openTrade.stopLoss);
        let pnl: number;
        if (closeReason === "sl") {
          pnl = -openTrade.stake;
        } else if (closeReason === "tp") {
          pnl = openTrade.isPremium
            ? Math.round(openTrade.stake * (rawPips / stopDist) * 0.85 * 100) / 100
            : Math.round(openTrade.stake * (rawPips / stopDist) * 0.85 * 100) / 100;
          pnl = Math.max(0, pnl);
        } else {
          // Time stop — proportional
          if (rawPips > 0) {
            pnl = Math.round(openTrade.stake * (rawPips / stopDist) * 0.85 * 100) / 100;
          } else {
            pnl = Math.round(openTrade.stake * (rawPips / stopDist) * 100) / 100;
          }
        }
        pnl = Math.round(pnl * 100) / 100;
        balance = Math.round((balance + pnl) * 100) / 100;

        if (pnl > 0) { consLosses = 0; } else { consLosses++; }
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;

        const rr = Math.abs(openTrade.takeProfit - openTrade.entryPrice) / Math.abs(openTrade.entryPrice - openTrade.stopLoss);

        tradeNum++;
        if (pnl > 0) revWins++;
        tradeList.push({
          tradeNum,
          direction: openTrade.direction,
          entryPrice: openTrade.entryPrice,
          stopLoss: openTrade.stopLoss,
          takeProfit: openTrade.takeProfit,
          exitPrice,
          closeReason,
          pnl,
          durationMinutes: openTrade.barsHeld * 5,
          entryTime: openTrade.entryTime,
          exitTime: candle.time,
          score: openTrade.score,
          c1: openTrade.c1,
          c2: openTrade.c2,
          c3: openTrade.c3,
          isPremium: openTrade.isPremium,
          sessionMovePips: 0,
          rr,
        });
        equityCurve.push({ index: tradeNum, value: balance });
        returns.push(pnl / startingBalance);

        console.log(`[REV #${tradeNum}] ${openTrade.direction} ${closeReason} pnl=${pnl.toFixed(2)} bars=${openTrade.barsHeld} balance=${balance.toFixed(2)}`);

        // Set 30-minute cooldown (6 × 5m bars)
        cooldownUntilIdx = i + COOLDOWN_BARS_5M;
        openTrade = null;
      }
      continue;
    }

    // ── Skip entry if in cooldown ─────────────────────────────────────────
    if (i < cooldownUntilIdx) { rej.cooldown++; continue; }

    // ── Daily limit ───────────────────────────────────────────────────────
    if (dailyTrades >= maxTradesDay) { rej.dailyLimit++; continue; }

    // ── Consecutive loss stop ─────────────────────────────────────────────
    if (consLosses >= consLossStop) { rej.consLossBlocked++; continue; }

    // ── Build indicator windows ───────────────────────────────────────────
    const window5m  = candles5m.slice(Math.max(0, i - 49), i + 1);
    const window15m = all15m.filter(c => c.time <= candle.time).slice(-30);
    if (window5m.length < 30 || window15m.length < 14) continue;

    // ── Session move — use full 5m slice so session open is always reachable ──
    const candles5mUpToNow = candles5m.slice(0, i + 1);
    const { movePips, moveDir } = calcSessionMoveBT(candles5mUpToNow, candle.time);
    if (sessionMoveDebugLogs < 20) {
      const utcHour = new Date(candle.time * 1000).getUTCHours();
      console.log(`[REV-DBG] SessionMove i=${i} utcH=${utcHour} move=${movePips.toFixed(1)}pip dir=${moveDir} threshold=${SESSION_MOVE_THRESHOLD} passed=${movePips >= SESSION_MOVE_THRESHOLD}`);
      sessionMoveDebugLogs++;
    }
    if (movePips < SESSION_MOVE_THRESHOLD) { rej.insufficientMove++; continue; }

    // ── Divergence — EITHER 5m OR 15m + RSI at extreme ───────────────────
    const div5m  = detectDivergenceBT(window5m, 10);
    const div15m = detectDivergenceBT(window15m, 10);
    if (divergenceDebugLogs < 30) {
      console.log(`[REV-DBG] Div i=${i} 5m.bull=${div5m.bullish} 5m.bear=${div5m.bearish} 5m.rsi=${div5m.currentRsi.toFixed(1)} 15m.bull=${div15m.bullish} 15m.bear=${div15m.bearish}`);
      divergenceDebugLogs++;
    }
    const buyRev  = (div5m.bullish || div15m.bullish) && div5m.currentRsi < 45;
    const sellRev = (div5m.bearish || div15m.bearish) && div5m.currentRsi > 55;
    if (!buyRev && !sellRev) { rej.noDivergence++; continue; }
    const direction: "BUY" | "SELL" = buyRev ? "BUY" : "SELL";
    const isBuy = direction === "BUY";

    // ── BB extreme ────────────────────────────────────────────────────────
    const bb2  = calcBBBT(window5m, 20, 2.0);
    const bb25 = calcBBBT(window5m, 20, 2.5);
    const aboveUpper = candle.close > bb2.upper;
    const belowLower = candle.close < bb2.lower;
    const above25 = candle.close > bb25.upper;
    const below25 = candle.close < bb25.lower;
    const hasBreachedBB = isBuy ? belowLower : aboveUpper;
    const isPremium = isBuy ? below25 : above25;

    // ── 1m confirmation — use last 5m bar body as proxy in backtest ───────
    const prevCandle = candles5m[i - 1]!;
    const bodyRatio = Math.abs(candle.close - candle.open) / Math.max(0.0001, candle.high - candle.low);
    const abovePrevMid = isBuy ? candle.close > (prevCandle.high + prevCandle.low) / 2 : candle.close < (prevCandle.high + prevCandle.low) / 2;
    const confirmedDirection = isBuy ? candle.close > candle.open : candle.close < candle.open;
    if (!confirmedDirection || bodyRatio < 0.2) continue;

    // ── Score ─────────────────────────────────────────────────────────────
    const c1 = scoreSessionExhaustionBT(movePips, moveDir, direction);
    const c2 = scoreDivBT(div5m, div15m, direction);
    const c3 = scoreBBBT(belowLower, aboveUpper, below25, above25, direction);
    const total = c1 + c2 + c3;
    if (total < threshold) { rej.belowThreshold++; continue; }

    // ── Entry / SL / TP ───────────────────────────────────────────────────
    const entryPrice = candle.close;
    const last3 = candles5m.slice(Math.max(0, i - 2), i + 1);
    const rawStop = isBuy
      ? Math.min(...last3.map(c => c.low)) - 5
      : Math.max(...last3.map(c => c.high)) + 5;
    const stopDistance = Math.abs(entryPrice - rawStop);

    if (stopDistance > MAX_STOP_PIPS) { rej.stopTooWide++; continue; }
    if (stopDistance < MIN_STOP_PIPS) { rej.stopTooTight++; continue; }

    const takeProfit = bb2.middle;
    const tpDistance = Math.abs(takeProfit - entryPrice);
    if (tpDistance < MIN_TP_PIPS) { rej.tpTooClose++; continue; }

    const rr = tpDistance / stopDistance;
    if (rr < MIN_RR) { rej.rrTooLow++; continue; }

    const stake = isPremium
      ? Math.max(0.5, Math.round(balance * maxRiskPct * 1.25 * 100) / 100)
      : Math.max(0.5, Math.round(balance * maxRiskPct * 100) / 100);

    openTrade = {
      direction,
      entryPrice,
      stopLoss: rawStop,
      takeProfit,
      stake,
      barsHeld: 0,
      entryTime: candle.time,
      score: total,
      c1, c2, c3,
      isPremium,
    };
    dailyTrades++;

    console.log(`[REV] Entry #${tradeNum + 1} ${direction} @ ${entryPrice.toFixed(2)} SL=${rawStop.toFixed(2)} TP=${takeProfit.toFixed(2)} score=${total} premium=${isPremium} move=${movePips.toFixed(0)}pip`);
  }

  // ── Close any still-open trade ────────────────────────────────────────────
  if (openTrade && candles5m.length > 0) {
    const lastCandle = candles5m[candles5m.length - 1]!;
    const exitPrice = lastCandle.close;
    const isBuy = openTrade.direction === "BUY";
    const rawPips = isBuy ? exitPrice - openTrade.entryPrice : openTrade.entryPrice - exitPrice;
    const pnl = rawPips > 0
      ? Math.round(openTrade.stake * 0.85 * 100) / 100
      : Math.round(-openTrade.stake * 100) / 100;
    balance = Math.round((balance + pnl) * 100) / 100;
    tradeNum++;
    tradeList.push({
      tradeNum, direction: openTrade.direction, entryPrice: openTrade.entryPrice,
      stopLoss: openTrade.stopLoss, takeProfit: openTrade.takeProfit,
      exitPrice, closeReason: "end_of_data",
      pnl, durationMinutes: openTrade.barsHeld * 5,
      entryTime: openTrade.entryTime, exitTime: lastCandle.time,
      score: openTrade.score, c1: openTrade.c1, c2: openTrade.c2, c3: openTrade.c3,
      isPremium: openTrade.isPremium, sessionMovePips: 0,
      rr: Math.abs(openTrade.takeProfit - openTrade.entryPrice) / Math.max(1, Math.abs(openTrade.entryPrice - openTrade.stopLoss)),
    });
    equityCurve.push({ index: tradeNum, value: balance });
  }

  // ── Aggregate results ─────────────────────────────────────────────────────
  const wins   = tradeList.filter(t => t.pnl > 0).length;
  const losses = tradeList.filter(t => t.pnl <= 0).length;
  const totalPnl = Math.round((balance - startingBalance) * 100) / 100;
  const winRate = tradeList.length > 0 ? (wins / tradeList.length) * 100 : 0;

  const grossWin  = tradeList.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeList.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 1) : grossWin / grossLoss;

  const bestTrade  = tradeList.length ? Math.max(...tradeList.map(t => t.pnl)) : 0;
  const worstTrade = tradeList.length ? Math.min(...tradeList.map(t => t.pnl)) : 0;
  const avgDurationMinutes = tradeList.length
    ? tradeList.reduce((s, t) => s + t.durationMinutes, 0) / tradeList.length
    : 0;
  const sharpeRatio = calcSharpe(returns);

  console.log(`\n=== REVERSAL BACKTEST COMPLETE ===`);
  console.log(`Trades: ${tradeList.length}  Wins: ${wins}  Losses: ${losses}  WR: ${winRate.toFixed(1)}%`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}  PF: ${profitFactor.toFixed(2)}  MaxDD: ${(maxDD * 100).toFixed(2)}%`);
  console.log(`Rejected — insuffMove: ${rej.insufficientMove} noDiv: ${rej.noDivergence} noBB: ${rej.noBBBreach} score: ${rej.belowThreshold} cooldown: ${rej.cooldown} dayLimit: ${rej.dailyLimit}`);

  return {
    runId,
    totalTrades: tradeList.length,
    wins,
    losses,
    winRate,
    profitFactor,
    maxDrawdown: maxDD * 100,
    totalPnl,
    equityCurve,
    bestTrade,
    worstTrade,
    avgDurationMinutes,
    sharpeRatio,
    candlesUsed: candles5m.length,
    candleHash,
    dataSource,
    cacheFile,
    trades: tradeList,
    rejectionStats: rej,
  };
}
