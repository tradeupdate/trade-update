import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import { score } from "./scoring.js";
import { logger } from "../lib/logger.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_75";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacktestCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestStrategyConfig {
  scoreThreshold: number;
  maxRiskPercent: number;
  stopMultiplier: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
  maxTradesDay: number;
  consecutiveLossStop: number;
}

export interface BacktestRunResult {
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
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  symbol: string;
  granularity: number;
  dateFrom: number;
  dateTo: number;
  candles: BacktestCandle[];
  cachedAt: number;
  count: number;
}

function getCacheKey(dateFrom: number, dateTo: number): string {
  return `${SYMBOL}_5m_${dateFrom}_${dateTo}`;
}

function getCachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string): { candles: BacktestCandle[]; cachedAt: number } | null {
  const file = getCachePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as CacheEntry;
    return { candles: data.candles, cachedAt: data.cachedAt };
  } catch {
    return null;
  }
}

function writeCache(key: string, candles: BacktestCandle[], dateFrom: number, dateTo: number): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry: CacheEntry = {
    symbol: SYMBOL,
    granularity: 300,
    dateFrom,
    dateTo,
    candles,
    cachedAt: Date.now(),
    count: candles.length,
  };
  fs.writeFileSync(getCachePath(key), JSON.stringify(entry, null, 2));
}

export function deleteCacheFile(dateFrom: number, dateTo: number): boolean {
  const key = getCacheKey(dateFrom, dateTo);
  const file = getCachePath(key);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

export function getCacheStatus(dateFrom: number, dateTo: number): { exists: boolean; cachedAt?: number; file?: string } {
  const key = getCacheKey(dateFrom, dateTo);
  const cached = readCache(key);
  if (!cached) return { exists: false };
  return { exists: true, cachedAt: cached.cachedAt, file: getCachePath(key) };
}

// ─── Deriv Fetch ──────────────────────────────────────────────────────────────

function fetchFromDeriv(dateFrom: number, dateTo: number): Promise<BacktestCandle[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error("Deriv historical fetch timed out after 30s"));
    }, 30000);

    const ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: "candles",
        granularity: 300,
        start: dateFrom,
        end: dateTo,
        count: 5000,
        req_id: 1,
      }));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          clearTimeout(timeout);
          ws.close();
          const candles: BacktestCandle[] = msg.candles.map((c: Record<string, unknown>) => ({
            time: Number(c.epoch),
            open: parseFloat(String(c.open)),
            high: parseFloat(String(c.high)),
            low: parseFloat(String(c.low)),
            close: parseFloat(String(c.close)),
          }));
          resolve(candles);
        } else if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Deriv error: ${String(msg.error?.message ?? msg.error)}`));
        }
      } catch { /* skip parse errors */ }
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      try { ws.terminate(); } catch { /* ignore */ }
      reject(err);
    });
  });
}

// ─── Normalize ────────────────────────────────────────────────────────────────

function normalizeCandles(raw: BacktestCandle[]): BacktestCandle[] {
  const valid = raw.filter(c =>
    !isNaN(c.time) && !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close) &&
    c.high >= c.low && c.high >= c.open && c.high >= c.close &&
    c.low <= c.open && c.low <= c.close && c.close > 0
  );

  const sorted = [...valid].sort((a, b) => a.time - b.time);

  const seen = new Set<number>();
  const deduped = sorted.filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  if (deduped.length > 0) {
    logger.info({
      raw: raw.length, valid: valid.length, deduped: deduped.length,
      first: new Date(deduped[0]!.time * 1000).toISOString(),
      last: new Date(deduped[deduped.length - 1]!.time * 1000).toISOString(),
    }, "Backtest: candle normalization");
  }

  return deduped;
}

// ─── Deterministic Candle Building ────────────────────────────────────────────

function build15mFromFiveMin(candles5m: BacktestCandle[]): BacktestCandle[] {
  const grouped: Record<number, BacktestCandle[]> = {};
  for (const c of candles5m) {
    const boundary = Math.floor(c.time / 900) * 900;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary]!.push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([boundary, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return {
        time: parseInt(boundary),
        open: sorted[0]!.open,
        high: Math.max(...sorted.map(c => c.high)),
        low: Math.min(...sorted.map(c => c.low)),
        close: sorted[sorted.length - 1]!.close,
      };
    })
    .sort((a, b) => a.time - b.time);
}

function synthetic1mFrom5m(candles5m: BacktestCandle[]): Candle[] {
  const result: Candle[] = [];
  for (const c of candles5m) {
    for (let i = 0; i < 5; i++) {
      result.push({
        time: (c.time + i * 60) * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: i === 4 ? c.close : c.open,
        volume: 0,
      });
    }
  }
  return result;
}

// ─── Checksum ─────────────────────────────────────────────────────────────────

export function candleChecksum(candles: BacktestCandle[]): string {
  const sum = candles.reduce((acc, c) => acc + c.close, 0);
  return `${candles.length}:${sum.toFixed(2)}`;
}

// ─── Get Historical Candles (with cache) ──────────────────────────────────────

export async function getHistoricalCandles(
  dateFrom: number,
  dateTo: number,
  forceRefresh = false,
): Promise<{ candles: BacktestCandle[]; dataSource: "cache" | "deriv_fresh"; cacheFile: string; cachedAt?: number }> {
  const key = getCacheKey(dateFrom, dateTo);
  const cacheFile = getCachePath(key);

  if (!forceRefresh) {
    const cached = readCache(key);
    if (cached) {
      logger.info({ key, count: cached.candles.length }, "Backtest: cache hit");
      return { candles: cached.candles, dataSource: "cache", cacheFile, cachedAt: cached.cachedAt };
    }
  } else {
    deleteCacheFile(dateFrom, dateTo);
  }

  logger.info({ key }, "Backtest: fetching from Deriv");
  const raw = await fetchFromDeriv(dateFrom, dateTo);
  const candles = normalizeCandles(raw);

  writeCache(key, candles, dateFrom, dateTo);
  logger.info({ key, count: candles.length }, "Backtest: candles cached to disk");

  return { candles, dataSource: "deriv_fresh", cacheFile };
}

// ─── Sharpe Ratio ─────────────────────────────────────────────────────────────

function calcSharpeRatio(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return mean > 0 ? 3.0 : 0;
  return parseFloat(((mean / std) * Math.sqrt(252)).toFixed(3));
}

// ─── Run Deterministic Backtest ───────────────────────────────────────────────

export async function runDeterministicBacktest(
  strategyId: string,
  config: BacktestStrategyConfig,
  dateFrom: number,
  dateTo: number,
  runBy: string,
  forceRefresh = false,
  startingBalance = 5000,
): Promise<BacktestRunResult> {
  const runId = `BT_${Date.now()}_${runBy}`;
  logger.info({ runId, strategyId, dateFrom, dateTo }, "Backtest started");

  const { candles: raw5m, dataSource, cacheFile, cachedAt } = await getHistoricalCandles(dateFrom, dateTo, forceRefresh);

  if (raw5m.length < 60) {
    throw new Error(`Insufficient candle data: only ${raw5m.length} candles available. Try a longer date range.`);
  }

  const all15m = build15mFromFiveMin(raw5m);
  const candleHash = candleChecksum(raw5m);

  logger.info({ runId, candles5m: raw5m.length, candles15m: all15m.length, hash: candleHash, dataSource, cachedAt }, "Backtest: candles ready");

  const { stopMultiplier: slMulti, tp2Multiplier: tp2Multi, scoreThreshold, maxRiskPercent, maxTradesDay, consecutiveLossStop } = config;
  const rr = tp2Multi / slMulti;

  // FIX: WARMUP must be >= 170 so that 50+ 15m candles exist before scoring.
  // At 5m granularity: 170 × 5m = 850 min = 14.2 hours → ~56 15m candles.
  // Previous value of 60 only produced 20 15m candles → score() always returned null.
  const WARMUP = 175;
  const MAX_HOLD_BARS = 12;

  interface OpenTrade {
    direction: "BUY" | "SELL";
    entryPrice: number;
    stake: number;
    slPrice: number;
    tpPrice: number;
    entryTime: number;
    barsHeld: number;
    scoreVal: number;
  }

  const tradeList: { pnl: number; duration: number; scoreVal: number }[] = [];
  const returns: number[] = [];
  const equityCurve: { index: number; value: number }[] = [];

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDD = 0;
  let openTrade: OpenTrade | null = null;
  let consLosses = 0;
  let dailyPnl = 0;
  let tradesToday = 0;
  let lastDayTs = 0;

  // Diagnostic counters
  let scoreNullCount = 0;
  let scoreBelowThreshold = 0;
  let scoreDirectionNone = 0;
  let scoreErrors = 0;
  let tradeDailyLimit = 0;
  let tradeConsLossLimit = 0;
  let firstScoreLogged = false;

  console.log(`=== BACKTEST STARTING ===`);
  console.log(`Total 5m candles: ${raw5m.length}  15m candles: ${all15m.length}  WARMUP: ${WARMUP}`);
  if (raw5m.length > 0) {
    console.log(`Date range: ${new Date(raw5m[0]!.time * 1000).toISOString()} → ${new Date(raw5m[raw5m.length - 1]!.time * 1000).toISOString()}`);
    console.log(`First candle: time=${raw5m[0]!.time} close=${raw5m[0]!.close}`);
  }
  console.log(`Config: threshold=${scoreThreshold} risk=${maxRiskPercent}% slX=${slMulti} tp2X=${tp2Multi} maxDayTrades=${maxTradesDay} consLossStop=${consecutiveLossStop}`);

  for (let i = WARMUP; i < raw5m.length; i++) {
    const candle = raw5m[i];
    if (!candle) continue;

    // Diagnostic: log every 200th candle
    if (i % 200 === 0) {
      console.log(`[BT] Candle ${i}/${raw5m.length} time=${new Date(candle.time * 1000).toISOString()} close=${candle.close} balance=${balance} trades=${tradeList.length}`);
    }

    const dayTs = Math.floor(candle.time / 86400) * 86400;
    if (dayTs !== lastDayTs) {
      dailyPnl = 0;
      tradesToday = 0;
      lastDayTs = dayTs;
      if (consLosses >= consecutiveLossStop) consLosses = 0;
    }

    if (openTrade) {
      let closed = false;
      let pnl = 0;

      if (openTrade.direction === "BUY") {
        const slHit = candle.low <= openTrade.slPrice;
        const tpHit = candle.high >= openTrade.tpPrice;
        if (slHit) { pnl = -openTrade.stake; closed = true; }
        else if (tpHit) { pnl = Math.round(openTrade.stake * rr * 100) / 100; closed = true; }
      } else {
        const slHit = candle.high >= openTrade.slPrice;
        const tpHit = candle.low <= openTrade.tpPrice;
        if (slHit) { pnl = -openTrade.stake; closed = true; }
        else if (tpHit) { pnl = Math.round(openTrade.stake * rr * 100) / 100; closed = true; }
      }

      if (!closed && openTrade.barsHeld >= MAX_HOLD_BARS) {
        const inProfit = openTrade.direction === "BUY"
          ? candle.close > openTrade.entryPrice
          : candle.close < openTrade.entryPrice;
        pnl = inProfit
          ? Math.round(openTrade.stake * 0.3 * 100) / 100
          : -Math.round(openTrade.stake * 0.3 * 100) / 100;
        closed = true;
      }

      if (closed) {
        balance = Math.round((balance + pnl) * 100) / 100;
        dailyPnl += pnl;
        tradeList.push({ pnl, duration: (openTrade.barsHeld + 1) * 5, scoreVal: openTrade.scoreVal });
        returns.push(pnl / startingBalance);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
        consLosses = pnl > 0 ? 0 : consLosses + 1;
        equityCurve.push({ index: tradeList.length - 1, value: balance });
        openTrade = null;
      } else {
        openTrade.barsHeld++;
      }

      if (balance <= 0) break;
      continue;
    }

    if (tradesToday >= maxTradesDay) { tradeDailyLimit++; continue; }
    if (consLosses >= consecutiveLossStop) { tradeConsLossLimit++; continue; }
    if (dailyPnl <= -(balance * 0.05)) continue;

    // Build scoring windows — use larger history for better indicator quality
    // FIX: pass 50 5m candles (not 30) and 6 candles for synthetic 1m (30 1m candles instead of 20)
    const window5m = raw5m.slice(Math.max(0, i - 49), i + 1);
    const window15m = all15m.filter(c => c.time <= candle.time).slice(-60);
    const synth1m = synthetic1mFrom5m(window5m.slice(-6)); // 6×5 = 30 synthetic 1m candles

    const score5m: Candle[] = window5m.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 }));
    const score15m: Candle[] = window15m.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 }));

    let result;
    try {
      result = score(synth1m, score5m, score15m, dailyPnl, peak, balance, consLosses);
    } catch (err) {
      scoreErrors++;
      if (scoreErrors <= 3) console.error(`[BT] Score error at candle ${i}:`, err);
      continue;
    }

    if (!result || !result.ready) {
      scoreNullCount++;
      if (scoreNullCount <= 3) {
        console.log(`[BT] score() returned null at i=${i}: 1m=${synth1m.length} 5m=${score5m.length} 15m=${score15m.length}`);
      }
      continue;
    }

    // Log first few score results for diagnostics
    if (!firstScoreLogged) {
      firstScoreLogged = true;
      console.log(`[BT] First valid score at i=${i}: total=${result.total} direction=${result.direction} trend=${result.trendDirection} adx=${result.adx} rsi=${result.rsi} threshold=${scoreThreshold}`);
    }
    if (i % 500 === 0) {
      console.log(`[BT] Score sample i=${i}: total=${result.total} dir=${result.direction} trend=${result.trendDirection} adx=${result.adx} rsi=${result.rsi}`);
    }

    if (result.total < scoreThreshold) { scoreBelowThreshold++; continue; }
    if (result.direction === "NONE") {
      scoreDirectionNone++;
      if (scoreDirectionNone <= 5) {
        console.log(`[BT] Direction=NONE at i=${i}: total=${result.total} adx=${result.adx} trend=${result.trendDirection} rsi=${result.rsi} band=${result.bandTouched}`);
      }
      continue;
    }

    const stake = Math.round(balance * (maxRiskPercent / 100) * 100) / 100;
    if (stake <= 0) continue;

    const atrVal = result.atrValue > 0 ? result.atrValue : candle.close * 0.001;
    const slPrice = result.direction === "BUY"
      ? candle.close - atrVal * slMulti
      : candle.close + atrVal * slMulti;
    const tpPrice = result.direction === "BUY"
      ? candle.close + atrVal * tp2Multi
      : candle.close - atrVal * tp2Multi;

    console.log(`[BT] TRADE ENTRY i=${i} dir=${result.direction} score=${result.total} close=${candle.close} sl=${slPrice.toFixed(2)} tp=${tpPrice.toFixed(2)} stake=${stake}`);

    openTrade = {
      direction: result.direction,
      entryPrice: candle.close,
      stake,
      slPrice,
      tpPrice,
      entryTime: candle.time,
      barsHeld: 0,
      scoreVal: result.total,
    };
    tradesToday++;
  }

  console.log(`=== BACKTEST COMPLETE ===`);
  console.log(`Candles processed: ${raw5m.length - WARMUP}  Trades: ${tradeList.length}`);
  console.log(`scoreNull=${scoreNullCount} belowThreshold=${scoreBelowThreshold} dirNone=${scoreDirectionNone} errors=${scoreErrors} dailyLimit=${tradeDailyLimit} consLoss=${tradeConsLossLimit}`);

  if (openTrade) {
    const last = raw5m[raw5m.length - 1];
    if (last) {
      const inProfit = openTrade.direction === "BUY" ? last.close > openTrade.entryPrice : last.close < openTrade.entryPrice;
      const pnl = inProfit
        ? Math.round(openTrade.stake * 0.3 * 100) / 100
        : -Math.round(openTrade.stake * 0.3 * 100) / 100;
      balance = Math.round((balance + pnl) * 100) / 100;
      tradeList.push({ pnl, duration: openTrade.barsHeld * 5, scoreVal: openTrade.scoreVal });
      returns.push(pnl / startingBalance);
      if (balance > peak) peak = balance;
      equityCurve.push({ index: tradeList.length - 1, value: balance });
    }
  }

  const wins = tradeList.filter(t => t.pnl > 0);
  const losses = tradeList.filter(t => t.pnl <= 0);
  const totalPnl = Math.round(tradeList.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  const winRate = tradeList.length ? Math.round((wins.length / tradeList.length) * 1000) / 10 : 0;
  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = Math.round((lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 9.99 : 0) * 100) / 100;
  const bestTrade = tradeList.length ? Math.max(...tradeList.map(t => t.pnl)) : 0;
  const worstTrade = tradeList.length ? Math.min(...tradeList.map(t => t.pnl)) : 0;
  const avgDuration = tradeList.length
    ? Math.round(tradeList.reduce((s, t) => s + t.duration, 0) / tradeList.length * 10) / 10
    : 0;

  logger.info({ runId, trades: tradeList.length, winRate, totalPnl, hash: candleHash, dataSource }, "Backtest complete");

  return {
    runId,
    totalTrades: tradeList.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    maxDrawdown: Math.round(maxDD * 10000) / 10000,
    totalPnl,
    equityCurve,
    bestTrade,
    worstTrade,
    avgDurationMinutes: avgDuration,
    sharpeRatio: Math.round(calcSharpeRatio(returns) * 100) / 100,
    candlesUsed: raw5m.length,
    candleHash,
    dataSource,
    cacheFile,
  };
}
