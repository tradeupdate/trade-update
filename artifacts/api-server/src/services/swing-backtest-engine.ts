import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import {
  build4hCandles,
  detectConsolidationRange,
  detectBreakout,
  detectRetest,
  score4hTrendBT,
  score1hMomentumBT,
  scoreBreakoutQualityBT,
  calcATR,
  type ConsolidationRange,
  type BreakoutResult,
} from "./swing-scoring.js";
import { logger } from "../lib/logger.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_75";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

// Min/max stop pips for swing
const MIN_STOP_PIPS = 80;
const MAX_STOP_PIPS = 350;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SwingCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SwingBacktestConfig {
  scoreThreshold: number;
  maxRiskPercent: number;
  stopMultiplier: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
  maxTradesDay: number;
  consecutiveLossStop: number;
}

interface OpenSwingTrade {
  direction: "BUY" | "SELL";
  entryPrice: number;
  stage1Price: number;
  stage1Stake: number;
  stage2Price: number | null;
  stage2Stake: number | null;
  totalStake: number;
  slPrice: number;
  originalSl: number;
  tp1Price: number;
  tp2Price: number;
  stopDistance: number;
  halfClosed: boolean;
  halfPnlLocked: number;
  beTriggered: boolean;
  stage2Added: boolean;
  barsHeld: number;
  entryTime: number;
  retestLevel: number;
  rangeHigh: number;
  rangeLow: number;
  scoreVal: number;
  c1: number; c2: number; c3: number;
  trailingActive: boolean;
  trailStopPrice: number;
}

export interface SwingTradeDetail {
  tradeNum: number;
  direction: "BUY" | "SELL";
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  exitPrice: number;
  closeReason: "sl" | "tp2" | "session_end" | "time_stop" | "end_of_data";
  pnl: number;
  durationMinutes: number;
  entryTime: number;
  exitTime: number;
  score: number;
  c1: number; c2: number; c3: number;
  stage2Added: boolean;
}

export interface SwingBacktestResult {
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
  partialExitStats: { tp1Hits: number; tp2Hits: number; beHits: number; stage2Hits: number };
  trades: SwingTradeDetail[];
}

// ── Cache helpers (same format as sniper engine) ───────────────────────────────

function getCacheKey(dateFrom: number, dateTo: number): string {
  return `${SYMBOL}_5m_${dateFrom}_${dateTo}`;
}
function getCachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}
function readCache(key: string): { candles: SwingCandle[]; cachedAt: number } | null {
  const file = getCachePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { candles: data.candles, cachedAt: data.cachedAt };
  } catch { return null; }
}
function writeCache(key: string, candles: SwingCandle[], dateFrom: number, dateTo: number): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = { symbol: SYMBOL, granularity: 300, dateFrom, dateTo, candles, cachedAt: Date.now(), count: candles.length };
  fs.writeFileSync(getCachePath(key), JSON.stringify(entry, null, 2));
}

// ── Deriv fetch ───────────────────────────────────────────────────────────────

async function fetchFromDeriv(dateFrom: number, dateTo: number): Promise<SwingCandle[]> {
  const CHUNK_SIZE = 5000;
  const GRANULARITY = 300;
  const MAX_CHUNKS = 10;
  const all: SwingCandle[] = [];
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
): Promise<SwingCandle[]> {
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

// ── Candle builders ───────────────────────────────────────────────────────────

function build15mCandles(candles5m: SwingCandle[]): SwingCandle[] {
  const grouped: Record<number, SwingCandle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 900) * 900;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary].push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([b, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return { time: parseInt(b), open: sorted[0].open, high: Math.max(...sorted.map(c => c.high)), low: Math.min(...sorted.map(c => c.low)), close: sorted[sorted.length - 1].close };
    }).sort((a, b) => a.time - b.time);
}

function build1hCandles(candles5m: SwingCandle[]): SwingCandle[] {
  const grouped: Record<number, SwingCandle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 3600) * 3600;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary].push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([b, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return { time: parseInt(b), open: sorted[0].open, high: Math.max(...sorted.map(c => c.high)), low: Math.min(...sorted.map(c => c.low)), close: sorted[sorted.length - 1].close };
    }).sort((a, b) => a.time - b.time);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcHM(time: number): { h: number; m: number; totalMinutes: number } {
  const d = new Date(time * 1000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return { h, m, totalMinutes: h * 60 + m };
}

function isInBlackout(time: number): boolean {
  const { totalMinutes } = utcHM(time);
  const londonBlackout = totalMinutes >= 6 * 60 + 45 && totalMinutes <= 7 * 60 + 15;
  const nyBlackout = totalMinutes >= 12 * 60 + 45 && totalMinutes <= 13 * 60 + 15;
  return londonBlackout || nyBlackout;
}

// Is it a session-end check candle? (closes at or just after 15:00 or 10:00 UTC)
function isSessionEndCandle(time: number): boolean {
  const { h } = utcHM(time);
  return h === 15 || h === 10;
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(252);
}

// ── Main Swing Backtest ───────────────────────────────────────────────────────

export async function runSwingBacktest(
  strategyId: string,
  config: SwingBacktestConfig,
  dateFrom: number,
  dateTo: number,
  runBy: string,
  forceRefresh: boolean,
  startingBalance: number
): Promise<SwingBacktestResult> {
  const runId = `SW_${Date.now()}_${strategyId}`;

  // ── Fetch / cache 5m candles ──────────────────────────────────────────────
  const cacheKey = getCacheKey(dateFrom, dateTo);
  let candles5m: SwingCandle[];
  let dataSource: "cache" | "deriv_fresh" = "cache";
  let cacheFile = getCachePath(cacheKey);

  const cached = !forceRefresh ? readCache(cacheKey) : null;
  if (cached) {
    candles5m = cached.candles;
    logger.info({ runId, key: cacheKey, count: candles5m.length }, "Swing backtest: cache hit");
  } else {
    candles5m = await fetchFromDeriv(dateFrom, dateTo);
    writeCache(cacheKey, candles5m, dateFrom, dateTo);
    dataSource = "deriv_fresh";
    logger.info({ runId, count: candles5m.length }, "Swing backtest: fetched from Deriv");
  }

  if (candles5m.length < 100) throw new Error("Not enough candle data for swing backtest");

  // ── Build higher timeframe candles ────────────────────────────────────────
  const all15m = build15mCandles(candles5m);
  const all1h = build1hCandles(candles5m);
  const all4h = build4hCandles(all1h as Candle[]) as SwingCandle[];

  const hashSum = candles5m.slice(0, 10).reduce((s, c) => s + c.close, 0);
  const candleHash = `${candles5m.length}:${hashSum.toFixed(2)}`;

  // Warmup: need 200 1h candles (guarantees 50 4h candles for EMA50)
  const WARMUP_1H = 200;
  if (all1h.length < WARMUP_1H + 1) {
    throw new Error(`Not enough 1h candles for warmup. Have ${all1h.length}, need ${WARMUP_1H}`);
  }

  const threshold = config.scoreThreshold ?? 20;
  const maxRisk = (config.maxRiskPercent ?? 1.0) / 100;

  console.log(`\n=== SWING BACKTEST STARTING ===`);
  console.log(`1h candles: ${all1h.length}  4h: ${all4h.length}  WARMUP: ${WARMUP_1H}`);
  console.log(`Date range: ${new Date(dateFrom * 1000).toISOString()} → ${new Date(dateTo * 1000).toISOString()}`);
  console.log(`Config: threshold=${threshold} risk=${config.maxRiskPercent}% sl=range±10% tp1=${config.tp1Multiplier}× tp2=${config.tp2Multiplier}× maxStop=${MAX_STOP_PIPS}pip`);

  // ── State ─────────────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peak = balance;
  let maxDD = 0;
  let openTrade: OpenSwingTrade | null = null;
  let consolidation: ConsolidationRange | null = null;
  let breakout: BreakoutResult | null = null;
  let consLosses = 0;
  let dailyTrades = 0;
  let lastTradeDay = "";
  const tradeList: SwingTradeDetail[] = [];
  const equityCurve: { index: number; value: number }[] = [{ index: 0, value: balance }];
  const returns: number[] = [];
  const partialStats = { tp1Hits: 0, tp2Hits: 0, beHits: 0, stage2Hits: 0 };
  let breakoutInvalidatedAt = 0;

  let scoreNullCount = 0, belowThreshold = 0, dirNone = 0, noBreakout = 0;
  let sessionFiltered = 0, stopTooWide = 0, consLossBlocked = 0, dailyLimitBlocked = 0;

  // ── Main loop on 1h candles ───────────────────────────────────────────────
  for (let i = WARMUP_1H; i < all1h.length; i++) {
    const candle1h = all1h[i];

    // Reset daily counter
    const dayStr = new Date(candle1h.time * 1000).toISOString().slice(0, 10);
    if (dayStr !== lastTradeDay) { dailyTrades = 0; lastTradeDay = dayStr; }

    // ── Manage open trade ──────────────────────────────────────────────────
    if (openTrade) {
      const isBuy = openTrade.direction === "BUY";
      openTrade.barsHeld++;

      // Check if stage 2 should be added this bar
      if (!openTrade.stage2Added) {
        const distFromRetest = Math.abs(candle1h.close - openTrade.retestLevel);
        const distPct = distFromRetest / openTrade.retestLevel * 100;
        const atRetest = distPct < 0.15;

        const profitPips = isBuy
          ? candle1h.high - openTrade.stage1Price
          : openTrade.stage1Price - candle1h.low;
        const movedOneStop = profitPips >= openTrade.stopDistance;

        if (atRetest || movedOneStop) {
          const stake2 = Math.round(balance * maxRisk * 0.5 * 100) / 100;
          const addPrice = candle1h.close;
          openTrade.stage2Price = addPrice;
          openTrade.stage2Stake = stake2;
          openTrade.totalStake = openTrade.stage1Stake + stake2;
          const avgEntry = (openTrade.stage1Price + addPrice) / 2;
          openTrade.entryPrice = avgEntry;
          openTrade.tp1Price = isBuy ? avgEntry + openTrade.stopDistance * (config.tp1Multiplier ?? 2) : avgEntry - openTrade.stopDistance * (config.tp1Multiplier ?? 2);
          openTrade.tp2Price = isBuy ? avgEntry + openTrade.stopDistance * (config.tp2Multiplier ?? 4) : avgEntry - openTrade.stopDistance * (config.tp2Multiplier ?? 4);
          openTrade.stage2Added = true;
          partialStats.stage2Hits++;
          console.log(`[SW] Stage 2 added i=${i} price=${addPrice.toFixed(2)} avgEntry=${avgEntry.toFixed(2)} reason=${atRetest ? "retest" : "momentum"}`);
        }
      }

      // Session-end protection: at 15:00 or 10:00 UTC
      if (isSessionEndCandle(candle1h.time)) {
        const profitPips = isBuy
          ? candle1h.close - openTrade.entryPrice
          : openTrade.entryPrice - candle1h.close;
        if (profitPips >= openTrade.stopDistance) {
          // Profitable enough — move to break even
          if (!openTrade.beTriggered) {
            openTrade.slPrice = isBuy ? openTrade.entryPrice + 5 : openTrade.entryPrice - 5;
            openTrade.beTriggered = true;
            console.log(`[SW] Session-end: BE moved i=${i} profit=${profitPips.toFixed(0)}pip`);
          }
        } else {
          // Not in sufficient profit — close
          const closePnl = calcPnl(openTrade, candle1h.close, balance);
          const totalPnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
          balance = Math.round((balance + closePnl) * 100) / 100;
          closeTrade(openTrade, candle1h, totalPnl, "session_end", tradeList, equityCurve, returns, startingBalance);
          if (totalPnl > 0) { consLosses = 0; } else { consLosses++; }
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak;
          if (dd > maxDD) maxDD = dd;
          openTrade = null;
          console.log(`[SW] Session-end closure i=${i} pnl=${totalPnl.toFixed(2)}`);
          continue;
        }
      }

      // 6-hour max hold = 6 1h bars
      let closed = false, closePnl = 0;
      let exitPrice = candle1h.close;
      let closeReason: SwingTradeDetail["closeReason"] = "time_stop";

      if (!openTrade.halfClosed) {
        const tp1Hit = isBuy ? candle1h.high >= openTrade.tp1Price : candle1h.low <= openTrade.tp1Price;
        const slHit = isBuy ? candle1h.low <= openTrade.slPrice : candle1h.high >= openTrade.slPrice;

        if (tp1Hit && !slHit) {
          const rr1 = (config.tp1Multiplier ?? 2.0);
          const halfPnl = Math.round(openTrade.totalStake * 0.5 * rr1 * 0.85 * 100) / 100;
          balance = Math.round((balance + halfPnl) * 100) / 100;
          openTrade.halfClosed = true;
          openTrade.halfPnlLocked = halfPnl;
          partialStats.tp1Hits++;
          // Move BE after TP1
          if (!openTrade.beTriggered) {
            openTrade.slPrice = isBuy ? openTrade.entryPrice + 5 : openTrade.entryPrice - 5;
            openTrade.beTriggered = true;
          }
          exitPrice = openTrade.tp1Price;
          console.log(`[SW] TP1 partial i=${i} dir=${openTrade.direction} halfPnl=+${halfPnl} BE set`);
        } else if (slHit) {
          closePnl = -openTrade.totalStake;
          closed = true;
          exitPrice = openTrade.slPrice;
          closeReason = "sl";
        }
      } else {
        // After TP1: check BE trigger at 1.5× stop
        if (!openTrade.beTriggered) {
          const pips = isBuy ? candle1h.high - openTrade.entryPrice : openTrade.entryPrice - candle1h.low;
          if (pips >= openTrade.stopDistance * 1.5) {
            openTrade.slPrice = isBuy ? openTrade.entryPrice + 5 : openTrade.entryPrice - 5;
            openTrade.beTriggered = true;
            partialStats.beHits++;
          }
        }

        // Trailing stop for momentum extension (post-TP2 if conditions met)
        if (openTrade.trailingActive) {
          const atr1h = calcATR(all1h.slice(Math.max(0, i - 20), i + 1) as Candle[], 14);
          const newTrail = isBuy ? candle1h.high - atr1h * 2 : candle1h.low + atr1h * 2;
          if (isBuy && newTrail > openTrade.trailStopPrice) openTrade.trailStopPrice = newTrail;
          if (!isBuy && newTrail < openTrade.trailStopPrice) openTrade.trailStopPrice = newTrail;
          openTrade.slPrice = openTrade.trailStopPrice;
        }

        const tp2Hit = isBuy ? candle1h.high >= openTrade.tp2Price : candle1h.low <= openTrade.tp2Price;
        const slHit = isBuy ? candle1h.low <= openTrade.slPrice : candle1h.high >= openTrade.slPrice;

        if (tp2Hit) {
          const rr2 = config.tp2Multiplier ?? 4.0;
          closePnl = Math.round(openTrade.totalStake * 0.5 * rr2 * 0.85 * 100) / 100;
          closed = true;
          exitPrice = openTrade.tp2Price;
          closeReason = "tp2";
          partialStats.tp2Hits++;
        } else if (slHit) {
          if (openTrade.beTriggered) {
            closePnl = 0;
            closeReason = "sl"; // at BE
            partialStats.beHits++;
          } else {
            closePnl = -Math.round(openTrade.totalStake * 0.5 * 100) / 100;
            closeReason = "sl";
          }
          closed = true;
          exitPrice = openTrade.slPrice;
        }
      }

      // 6h time stop
      if (!closed && openTrade.barsHeld >= 6) {
        const profitPips = isBuy ? candle1h.close - openTrade.entryPrice : openTrade.entryPrice - candle1h.close;
        const remainingStake = openTrade.halfClosed ? openTrade.totalStake * 0.5 : openTrade.totalStake;
        closePnl = openTrade.stopDistance > 0
          ? Math.round(Math.max(-remainingStake, remainingStake * Math.min(0.85, profitPips / openTrade.stopDistance)) * 100) / 100
          : 0;
        closed = true;
        closeReason = "time_stop";
        exitPrice = candle1h.close;
        console.log(`[SW] 6h time stop i=${i} pnl=${closePnl.toFixed(2)}`);
      }

      if (closed) {
        balance = Math.round((balance + closePnl) * 100) / 100;
        const totalPnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
        closeTrade(openTrade, candle1h, totalPnl, closeReason, tradeList, equityCurve, returns, startingBalance);
        if (totalPnl > 0) { consLosses = 0; } else { consLosses++; }
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
        openTrade = null;
        console.log(`[SW] TRADE CLOSE i=${i} reason=${closeReason} pnl=${totalPnl.toFixed(2)} balance=${balance.toFixed(2)}`);
      }

      if (openTrade) continue; // Don't enter a new trade while one is open
    }

    // ── Check if we can trade ─────────────────────────────────────────────
    if (consLosses >= (config.consecutiveLossStop ?? 2)) { consLossBlocked++; continue; }
    if (dailyTrades >= (config.maxTradesDay ?? 3)) { dailyLimitBlocked++; continue; }
    if (isInBlackout(candle1h.time)) { sessionFiltered++; continue; }

    // ── Update candle slices ───────────────────────────────────────────────
    const candles1hSlice = all1h.slice(0, i + 1) as Candle[];
    const candles4hSlice = build4hCandles(candles1hSlice) as Candle[];
    const candles15mSlice = all15m.filter(c => c.time <= candle1h.time) as Candle[];

    // ── Detect consolidation if no breakout pending ────────────────────────
    if (!breakout) {
      if (!consolidation) {
        const newConsolidation = detectConsolidationRange(candles1hSlice);
        if (newConsolidation) {
          consolidation = newConsolidation;
          console.log(`[SW] Consolidation i=${i} high=${consolidation.high.toFixed(2)} low=${consolidation.low.toFixed(2)} size=${consolidation.size.toFixed(0)}pip`);
        }
      } else {
        // Check if price has broken out of existing consolidation
        const newBreakout = detectBreakout(candles1hSlice, consolidation);
        if (newBreakout) {
          breakout = newBreakout;
          breakoutInvalidatedAt = 0;
          console.log(`[SW] Breakout i=${i} dir=${breakout.direction} at ${breakout.breakoutPrice.toFixed(2)} retestLevel=${breakout.retestLevel.toFixed(2)}`);
        } else {
          // Check if consolidation has been invalidated by extreme range expansion
          const latestRange = detectConsolidationRange(candles1hSlice);
          if (!latestRange) {
            // Range broke down — reset
            consolidation = null;
          }
        }
      }
    }

    // ── Watch for retest entry if breakout is active ───────────────────────
    if (breakout && consolidation) {
      // Invalidate breakout if price closes back inside the range (false breakout)
      const isBuy = breakout.direction === "BUY";
      const falseBreakout = isBuy
        ? candle1h.close < consolidation.high
        : candle1h.close > consolidation.low;
      if (falseBreakout && breakoutInvalidatedAt === 0) {
        breakoutInvalidatedAt = i;
      }
      if (breakoutInvalidatedAt > 0 && i - breakoutInvalidatedAt >= 2) {
        console.log(`[SW] Breakout invalidated at i=${i} — resetting`);
        breakout = null;
        consolidation = null;
        breakoutInvalidatedAt = 0;
        noBreakout++;
        continue;
      }

      // Score the swing
      if (candles4hSlice.length < 10) { scoreNullCount++; continue; }

      const t1 = score4hTrendBT(candles4hSlice, breakout.direction);
      if (t1.pts === 0) { dirNone++; continue; } // Hard filter: 4h trend must align

      const t2 = score1hMomentumBT(candles1hSlice, breakout.direction);
      const c3 = scoreBreakoutQualityBT(breakout, consolidation);
      const total = t1.pts + t2.pts + c3;

      if (total < threshold) { belowThreshold++; continue; }

      // Check retest
      const retest = detectRetest(candle1h.close, breakout, candles15mSlice.slice(-3));
      if (!retest.readyToEnter) { noBreakout++; continue; }

      // Calculate stop
      const stopDist = isBuy
        ? candle1h.close - (consolidation.low - consolidation.size * 0.1)
        : (consolidation.high + consolidation.size * 0.1) - candle1h.close;
      const slPrice = isBuy
        ? consolidation.low - consolidation.size * 0.1
        : consolidation.high + consolidation.size * 0.1;

      if (stopDist < MIN_STOP_PIPS) {
        console.log(`[SW] Stop too narrow: ${stopDist.toFixed(0)} < ${MIN_STOP_PIPS} pip — skip`);
        stopTooWide++;
        continue;
      }
      if (stopDist > MAX_STOP_PIPS) {
        console.log(`[SW] Stop too wide: ${stopDist.toFixed(0)} > ${MAX_STOP_PIPS} pip — skip`);
        stopTooWide++;
        continue;
      }

      // Stage 1 entry
      const stake1 = Math.round(balance * maxRisk * 0.5 * 100) / 100;
      const entryPrice = candle1h.close;
      const tp1Price = isBuy ? entryPrice + stopDist * (config.tp1Multiplier ?? 2.0) : entryPrice - stopDist * (config.tp1Multiplier ?? 2.0);
      const tp2Price = isBuy ? entryPrice + stopDist * (config.tp2Multiplier ?? 4.0) : entryPrice - stopDist * (config.tp2Multiplier ?? 4.0);

      openTrade = {
        direction: breakout.direction,
        entryPrice,
        stage1Price: entryPrice,
        stage1Stake: stake1,
        stage2Price: null,
        stage2Stake: null,
        totalStake: stake1,
        slPrice,
        originalSl: slPrice,
        tp1Price,
        tp2Price,
        stopDistance: stopDist,
        halfClosed: false,
        halfPnlLocked: 0,
        beTriggered: false,
        stage2Added: false,
        barsHeld: 0,
        entryTime: candle1h.time,
        retestLevel: breakout.retestLevel,
        rangeHigh: consolidation.high,
        rangeLow: consolidation.low,
        scoreVal: total,
        c1: t1.pts, c2: t2.pts, c3,
        trailingActive: false,
        trailStopPrice: slPrice,
      };

      dailyTrades++;
      // Reset state — breakout consumed
      breakout = null;
      consolidation = null;
      breakoutInvalidatedAt = 0;

      console.log(`[SW] STAGE 1 ENTRY i=${i} dir=${openTrade.direction} score=${total}(${t1.pts}/${t2.pts}/${c3}) price=${entryPrice.toFixed(2)} sl=${slPrice.toFixed(2)} tp1=${tp1Price.toFixed(2)} tp2=${tp2Price.toFixed(2)} stake=${stake1.toFixed(2)}`);
    }
  }

  // Close any open trade at end of data
  if (openTrade) {
    const lastCandle = all1h[all1h.length - 1];
    const closePnl = calcPnl(openTrade, lastCandle.close, balance);
    const totalPnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
    balance = Math.round((balance + closePnl) * 100) / 100;
    closeTrade(openTrade, lastCandle, totalPnl, "end_of_data", tradeList, equityCurve, returns, startingBalance);
  }

  console.log(`\n=== SWING BACKTEST COMPLETE ===`);
  console.log(`1h candles processed: ${all1h.length - WARMUP_1H}  Trades: ${tradeList.length}`);
  console.log(`scoreNull=${scoreNullCount} belowThreshold=${belowThreshold} dirNone=${dirNone} noBreakout=${noBreakout} stopTooWide=${stopTooWide}`);
  console.log(`sessionFiltered=${sessionFiltered} consLoss=${consLossBlocked} dailyLimit=${dailyLimitBlocked}`);
  console.log(`Partial exits: tp1=${partialStats.tp1Hits} tp2=${partialStats.tp2Hits} be=${partialStats.beHits} stage2=${partialStats.stage2Hits}`);

  const wins = tradeList.filter(t => t.pnl > 0).length;
  const losses = tradeList.filter(t => t.pnl <= 0).length;
  const winRate = tradeList.length > 0 ? Math.round((wins / tradeList.length) * 100 * 10) / 10 : 0;
  const totalPnl = Math.round((balance - startingBalance) * 100) / 100;
  const grossWin = tradeList.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeList.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0;
  const avgDurationMinutes = tradeList.length > 0 ? Math.round(tradeList.reduce((s, t) => s + t.durationMinutes, 0) / tradeList.length) : 0;
  const bestTrade = tradeList.length > 0 ? Math.max(...tradeList.map(t => t.pnl)) : 0;
  const worstTrade = tradeList.length > 0 ? Math.min(...tradeList.map(t => t.pnl)) : 0;

  return {
    runId,
    totalTrades: tradeList.length,
    wins, losses, winRate,
    profitFactor,
    maxDrawdown: Math.round(maxDD * 10000) / 100,
    totalPnl,
    equityCurve,
    bestTrade: Math.round(bestTrade * 100) / 100,
    worstTrade: Math.round(worstTrade * 100) / 100,
    avgDurationMinutes,
    sharpeRatio: Math.round(calcSharpe(returns) * 100) / 100,
    candlesUsed: all1h.length - WARMUP_1H,
    candleHash,
    dataSource,
    cacheFile,
    partialExitStats: partialStats,
    trades: tradeList,
  };
}

// ── Helper functions ──────────────────────────────────────────────────────────

function calcPnl(trade: OpenSwingTrade, exitPrice: number, balance: number): number {
  const isBuy = trade.direction === "BUY";
  const rawPips = isBuy ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  const remainingStake = trade.halfClosed ? trade.totalStake * 0.5 : trade.totalStake;
  if (trade.stopDistance === 0) return 0;
  return Math.round(Math.max(-remainingStake, remainingStake * 0.85 * (rawPips / trade.stopDistance)) * 100) / 100;
}

function closeTrade(
  trade: OpenSwingTrade,
  candle: SwingCandle,
  totalPnl: number,
  reason: SwingTradeDetail["closeReason"],
  tradeList: SwingTradeDetail[],
  equityCurve: { index: number; value: number }[],
  returns: number[],
  startingBalance: number
): void {
  tradeList.push({
    tradeNum: tradeList.length + 1,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    slPrice: trade.originalSl,
    tp1Price: trade.tp1Price,
    tp2Price: trade.tp2Price,
    exitPrice: candle.close,
    closeReason: reason,
    pnl: totalPnl,
    durationMinutes: trade.barsHeld * 60,
    entryTime: trade.entryTime,
    exitTime: candle.time,
    score: trade.scoreVal,
    c1: trade.c1, c2: trade.c2, c3: trade.c3,
    stage2Added: trade.stage2Added,
  });
  returns.push(totalPnl / startingBalance);
  equityCurve.push({ index: tradeList.length - 1, value: Math.round((startingBalance + tradeList.reduce((s, t) => s + t.pnl, 0)) * 100) / 100 });
}
