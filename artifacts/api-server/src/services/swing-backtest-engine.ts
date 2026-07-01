import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import { build4hCandles, calcATR } from "./swing-scoring.js";
import { logger } from "../lib/logger.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_75";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

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
  c1: number;
  c2: number;
  c3: number;
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
  funnel?: Record<string, number>;
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

function build1hCandles(candles5m: SwingCandle[]): SwingCandle[] {
  const grouped: Record<number, SwingCandle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 3600) * 3600;
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

// ── Indicator helpers ─────────────────────────────────────────────────────────

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  let avgGain = gains.reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.reduce((s, v) => s + v, 0) / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

// ── Signal generator (EMA trend + RSI pullback) ───────────────────────────────

function getSwingSignal(
  avail5m: SwingCandle[],
  avail1h: SwingCandle[],
  avail4h: SwingCandle[],
  candle: SwingCandle,
  idx: number
): "BUY" | "SELL" | "NONE" {
  if (avail4h.length < 5 || avail1h.length < 10 || avail5m.length < 25) return "NONE";

  const closes4h = avail4h.map(c => c.close);
  const closes1h = avail1h.map(c => c.close);
  const closes5m = avail5m.map(c => c.close);

  // 4h trend (EMA20 vs EMA50)
  const ema20_4h = calcEMA(closes4h, Math.min(20, closes4h.length));
  const ema50_4h = calcEMA(closes4h, Math.min(50, closes4h.length));
  const bull4h = ema20_4h > ema50_4h;
  const bear4h = ema20_4h < ema50_4h;

  // 1h momentum (EMA9 vs EMA21)
  const ema9_1h = calcEMA(closes1h, Math.min(9, closes1h.length));
  const ema21_1h = calcEMA(closes1h, Math.min(21, closes1h.length));
  const bull1h = ema9_1h > ema21_1h;
  const bear1h = ema9_1h < ema21_1h;

  // 5m pullback entry — price near EMA21 (within 0.5%)
  const ema21_5m = calcEMA(closes5m, Math.min(21, closes5m.length));
  const rsi5m = calcRSI(closes5m, 14);
  const price = candle.close;
  const nearEMA = Math.abs(price - ema21_5m) / ema21_5m < 0.005;

  // Log every 500 candles for diagnostics
  if (idx % 500 === 0) {
    console.log(`[SW] Eval i=${idx} price=${price.toFixed(2)} 4h:EMA20=${ema20_4h.toFixed(0)} EMA50=${ema50_4h.toFixed(0)} bull=${bull4h} | 1h:EMA9=${ema9_1h.toFixed(0)} EMA21=${ema21_1h.toFixed(0)} bull=${bull1h} | 5m:EMA21=${ema21_5m.toFixed(0)} RSI=${rsi5m.toFixed(1)} nearEMA=${nearEMA}`);
  }

  // BUY: 4h bullish + 1h bullish + price pulled back to 5m EMA21 + RSI not overbought
  if (bull4h && bull1h && nearEMA && rsi5m > 30 && rsi5m < 55) {
    console.log(`[SW] BUY SIGNAL at i=${idx} time=${new Date(candle.time * 1000).toISOString()} price=${price.toFixed(2)} EMA21_5m=${ema21_5m.toFixed(2)} RSI=${rsi5m.toFixed(1)}`);
    return "BUY";
  }

  // SELL: 4h bearish + 1h bearish + price rallied to 5m EMA21 + RSI not oversold
  if (bear4h && bear1h && nearEMA && rsi5m > 45 && rsi5m < 70) {
    console.log(`[SW] SELL SIGNAL at i=${idx} time=${new Date(candle.time * 1000).toISOString()} price=${price.toFixed(2)} EMA21_5m=${ema21_5m.toFixed(2)} RSI=${rsi5m.toFixed(1)}`);
    return "SELL";
  }

  return "NONE";
}

// ── Sharpe ratio ──────────────────────────────────────────────────────────────

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(252);
}

// ── Main Swing Backtest ───────────────────────────────────────────────────────

export type ProgressCallback = (p: {
  candleIndex: number; totalCandles: number; tradesExecuted: number;
  wins: number; currentBalance: number; phase: "fetching" | "running";
  funnel: Record<string, number>;
}) => void;

export async function runSwingBacktest(
  strategyId: string,
  config: SwingBacktestConfig,
  dateFrom: number,
  dateTo: number,
  runBy: string,
  forceRefresh: boolean,
  startingBalance: number,
  onProgress?: ProgressCallback,
): Promise<SwingBacktestResult> {
  const runId = `SW_${Date.now()}_${strategyId}`;

  // ── Fetch / cache 5m candles ──────────────────────────────────────────────
  const cacheKey = getCacheKey(dateFrom, dateTo);
  let candles5m: SwingCandle[];
  let dataSource: "cache" | "deriv_fresh" = "cache";
  const cacheFile = getCachePath(cacheKey);

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
  const all1h = build1hCandles(candles5m);
  const all4h = build4hCandles(all1h as Candle[]) as SwingCandle[];

  const hashSum = candles5m.slice(0, 10).reduce((s, c) => s + c.close, 0);
  const candleHash = `${candles5m.length}:${hashSum.toFixed(2)}`;

  // Warmup: 200 5m candles (~17h) — enough for 1h and 4h indicator history
  const WARMUP = 200;
  // Time stop: 72 x 5m = 6 hours
  const MAX_HOLD_BARS = 72;
  const MAX_RISK = (config.maxRiskPercent ?? 1.0) / 100;
  const MAX_TRADES_DAY = config.maxTradesDay ?? 3;
  const CONS_LOSS_STOP = config.consecutiveLossStop ?? 2;

  console.log(`\n=== SWING BACKTEST START ===`);
  console.log(`5m candles: ${candles5m.length}  1h: ${all1h.length}  4h: ${all4h.length}  WARMUP: ${WARMUP}`);
  console.log(`Date range: ${new Date(dateFrom * 1000).toISOString()} → ${new Date(dateTo * 1000).toISOString()}`);
  console.log(`Config: risk=${config.maxRiskPercent}% maxDay=${MAX_TRADES_DAY} consLoss=${CONS_LOSS_STOP} timeStop=${MAX_HOLD_BARS * 5}min`);

  // ── State ─────────────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peak = balance;
  let maxDD = 0;
  const tradeList: SwingTradeDetail[] = [];
  const equityCurve: { index: number; value: number }[] = [{ index: 0, value: balance }];
  const returns: number[] = [];
  const partialStats = { tp1Hits: 0, tp2Hits: 0, beHits: 0, stage2Hits: 0 };

  interface OpenSwingTrade {
    direction: "BUY" | "SELL";
    entryPrice: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    stopDistance: number;
    stake: number;
    halfClosed: boolean;
    halfPnlLocked: number;
    barsHeld: number;
    openTime: number;
    openIdx: number;
  }

  let openTrade: OpenSwingTrade | null = null;
  let consLosses = 0;
  let todayTrades = 0;
  let currentDay = "";

  // Pointers to advance 1h and 4h alongside 5m
  let h1Ptr = 0;
  let h4Ptr = 0;

  let swingWins = 0;
  for (let i = WARMUP; i < candles5m.length; i++) {
    const candle = candles5m[i]!;

    if (i % 200 === 0) {
      onProgress?.({
        candleIndex: i, totalCandles: candles5m.length,
        tradesExecuted: tradeList.length, wins: swingWins,
        currentBalance: balance, phase: "running",
        funnel: { todayTrades, consLosses },
      });
    }

    // Daily reset
    const day = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      todayTrades = 0;
    }

    // Advance pointers
    while (h1Ptr + 1 < all1h.length && all1h[h1Ptr + 1]!.time <= candle.time) h1Ptr++;
    while (h4Ptr + 1 < all4h.length && all4h[h4Ptr + 1]!.time <= candle.time) h4Ptr++;

    // ── Manage open trade ────────────────────────────────────────────────
    if (openTrade) {
      const isBuy = openTrade.direction === "BUY";
      let closed = false;
      let closePnl = 0;
      let exitPrice = candle.close;
      let closeReason: SwingTradeDetail["closeReason"] = "time_stop";

      if (!openTrade.halfClosed) {
        const tp1Hit = isBuy ? candle.high >= openTrade.takeProfit1 : candle.low <= openTrade.takeProfit1;
        const slHit = isBuy ? candle.low <= openTrade.stopLoss : candle.high >= openTrade.stopLoss;

        if (tp1Hit && !slHit) {
          // Partial TP1 — close half at 2x RR
          const halfPnl = Math.round(openTrade.stake * 0.5 * 0.85 * (config.tp1Multiplier ?? 2.0) * 100) / 100;
          balance = Math.round((balance + halfPnl) * 100) / 100;
          if (balance > peak) peak = balance;
          openTrade.halfClosed = true;
          openTrade.halfPnlLocked = halfPnl;
          partialStats.tp1Hits++;
          console.log(`[SW] TP1 partial i=${i} dir=${openTrade.direction} halfPnl=+$${halfPnl.toFixed(2)}`);
        } else if (slHit) {
          closePnl = -openTrade.stake;
          closed = true;
          exitPrice = openTrade.stopLoss;
          closeReason = "sl";
        }
      } else {
        const tp2Hit = isBuy ? candle.high >= openTrade.takeProfit2 : candle.low <= openTrade.takeProfit2;
        const slHit = isBuy ? candle.low <= openTrade.stopLoss : candle.high >= openTrade.stopLoss;

        if (tp2Hit) {
          closePnl = Math.round(openTrade.stake * 0.5 * 0.85 * (config.tp2Multiplier ?? 3.0) * 100) / 100;
          closed = true;
          exitPrice = openTrade.takeProfit2;
          closeReason = "tp2";
          partialStats.tp2Hits++;
        } else if (slHit) {
          closePnl = -Math.round(openTrade.stake * 0.5 * 100) / 100;
          closed = true;
          exitPrice = openTrade.stopLoss;
          closeReason = "sl";
        }
      }

      // Time stop (6h = 72 x 5m bars)
      if (!closed && openTrade.barsHeld >= MAX_HOLD_BARS) {
        const profitPips = isBuy ? candle.close - openTrade.entryPrice : openTrade.entryPrice - candle.close;
        const remainingStake = openTrade.halfClosed ? openTrade.stake * 0.5 : openTrade.stake;
        const profitable = profitPips > 0;
        closePnl = profitable
          ? Math.round(remainingStake * 0.4 * 100) / 100
          : -Math.round(remainingStake * 0.4 * 100) / 100;
        closed = true;
        exitPrice = candle.close;
        closeReason = "time_stop";
        console.log(`[SW] Time stop i=${i} pnl=${closePnl.toFixed(2)} dir=${openTrade.direction} profitPips=${profitPips.toFixed(2)}`);
      }

      if (closed) {
        balance = Math.round((balance + closePnl) * 100) / 100;
        const totalPnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
        consLosses = totalPnl > 0 ? 0 : consLosses + 1;
        if (totalPnl > 0) swingWins++;

        tradeList.push({
          tradeNum: tradeList.length + 1,
          direction: openTrade.direction,
          entryPrice: openTrade.entryPrice,
          slPrice: openTrade.stopLoss,
          tp1Price: openTrade.takeProfit1,
          tp2Price: openTrade.takeProfit2,
          exitPrice,
          closeReason,
          pnl: totalPnl,
          durationMinutes: openTrade.barsHeld * 5,
          entryTime: openTrade.openTime,
          exitTime: candle.time,
          score: 0,
          c1: 0,
          c2: 0,
          c3: 0,
          stage2Added: false,
        });
        returns.push(totalPnl / startingBalance);
        equityCurve.push({ index: tradeList.length - 1, value: balance });

        console.log(`[SW] <<< TRADE CLOSE #${tradeList.length} reason=${closeReason} dir=${openTrade.direction} pnl=$${totalPnl.toFixed(2)} balance=$${balance.toFixed(2)}`);
        openTrade = null;
      } else {
        openTrade.barsHeld++;
      }
    }

    if (openTrade) continue;

    // ── Entry filters ─────────────────────────────────────────────────────
    if (todayTrades >= MAX_TRADES_DAY) continue;
    if (consLosses >= CONS_LOSS_STOP) continue;

    // ── Build available windows (take last N from pre-built arrays) ────────
    const avail5m = candles5m.slice(Math.max(0, i - 199), i + 1);
    const avail1h = all1h.slice(Math.max(0, h1Ptr - 99), h1Ptr + 1);
    const avail4h = all4h.slice(Math.max(0, h4Ptr - 99), h4Ptr + 1);

    if (avail4h.length < 5 || avail1h.length < 10) continue;

    // ── Get signal ────────────────────────────────────────────────────────
    const signal = getSwingSignal(avail5m, avail1h, avail4h, candle, i);
    if (signal === "NONE") continue;

    // ── Calculate ATR-based stop ──────────────────────────────────────────
    const atr5m = calcATR(avail5m.slice(-20) as Candle[], 14);
    const stopDistance = Math.max(80, atr5m * 2);
    const entryPrice = candle.close;
    const isBuy = signal === "BUY";

    const stopLoss = isBuy ? entryPrice - stopDistance : entryPrice + stopDistance;
    const tp1 = isBuy ? entryPrice + stopDistance * (config.tp1Multiplier ?? 2.0) : entryPrice - stopDistance * (config.tp1Multiplier ?? 2.0);
    const tp2 = isBuy ? entryPrice + stopDistance * (config.tp2Multiplier ?? 3.0) : entryPrice - stopDistance * (config.tp2Multiplier ?? 3.0);
    const stake = Math.max(1, Math.round(balance * MAX_RISK * 100) / 100);

    openTrade = {
      direction: signal,
      entryPrice,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      stopDistance,
      stake,
      halfClosed: false,
      halfPnlLocked: 0,
      barsHeld: 0,
      openTime: candle.time,
      openIdx: i,
    };

    todayTrades++;

    console.log(`[SW] >>> TRADE ENTRY #${tradeList.length + 1} dir=${signal} entry=${entryPrice.toFixed(2)} sl=${stopLoss.toFixed(2)} tp1=${tp1.toFixed(2)} tp2=${tp2.toFixed(2)} stake=$${stake.toFixed(2)} atr=${atr5m.toFixed(2)}`);
  }

  // Close any open trade at end of data
  if (openTrade) {
    const last = candles5m[candles5m.length - 1]!;
    const isBuy = openTrade.direction === "BUY";
    const profitPips = isBuy ? last.close - openTrade.entryPrice : openTrade.entryPrice - last.close;
    const remainingStake = openTrade.halfClosed ? openTrade.stake * 0.5 : openTrade.stake;
    const closePnl = profitPips > 0
      ? Math.round(remainingStake * 0.3 * 100) / 100
      : -Math.round(remainingStake * 0.3 * 100) / 100;
    const totalPnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
    balance = Math.round((balance + closePnl) * 100) / 100;

    tradeList.push({
      tradeNum: tradeList.length + 1,
      direction: openTrade.direction,
      entryPrice: openTrade.entryPrice,
      slPrice: openTrade.stopLoss,
      tp1Price: openTrade.takeProfit1,
      tp2Price: openTrade.takeProfit2,
      exitPrice: last.close,
      closeReason: "end_of_data",
      pnl: totalPnl,
      durationMinutes: openTrade.barsHeld * 5,
      entryTime: openTrade.openTime,
      exitTime: last.time,
      score: 0,
      c1: 0,
      c2: 0,
      c3: 0,
      stage2Added: false,
    });
    returns.push(totalPnl / startingBalance);
    equityCurve.push({ index: tradeList.length - 1, value: balance });
  }

  console.log(`\n=== SWING BACKTEST COMPLETE ===`);
  console.log(`5m processed: ${candles5m.length - WARMUP}  Trades: ${tradeList.length}`);
  console.log(`Partial exits: tp1=${partialStats.tp1Hits} tp2=${partialStats.tp2Hits} be=${partialStats.beHits}`);

  const wins = tradeList.filter(t => t.pnl > 0).length;
  const losses = tradeList.filter(t => t.pnl <= 0).length;
  const winRate = tradeList.length > 0 ? Math.round((wins / tradeList.length) * 100 * 10) / 10 : 0;
  const totalPnl = Math.round((balance - startingBalance) * 100) / 100;
  const grossWin = tradeList.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeList.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0;
  const avgDuration = tradeList.length > 0 ? Math.round(tradeList.reduce((s, t) => s + t.durationMinutes, 0) / tradeList.length) : 0;
  const bestTrade = tradeList.length > 0 ? Math.max(...tradeList.map(t => t.pnl)) : 0;
  const worstTrade = tradeList.length > 0 ? Math.min(...tradeList.map(t => t.pnl)) : 0;

  console.log(`Total trades: ${tradeList.length}  Wins: ${wins}  WR: ${winRate}%  P&L: $${totalPnl}`);

  logger.info({ runId, trades: tradeList.length, wins, winRate, totalPnl, hash: candleHash }, "Swing backtest complete");

  return {
    runId,
    totalTrades: tradeList.length,
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
    partialExitStats: partialStats,
    trades: tradeList,
  };
}
