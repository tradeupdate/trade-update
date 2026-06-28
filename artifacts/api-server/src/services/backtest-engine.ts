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
  sessionFilterEnabled: boolean;
  sessionStartHour: number;
  sessionEndHour: number;
}

export interface FeatureImportance {
  trend: number;
  volatility: number;
  timing: number;
  pullback: number;
  risk: number;
}

export interface RegimeStats {
  trendingCandles: number;
  rangingCandles: number;
  trendingTrades: number;
  rangingTrades: number;
}

export interface ScoreHistogramBucket {
  bucket: string;
  count: number;
  trades: number;
  wins: number;
}

export interface PartialExitStats {
  tp1Hits: number;
  tp2Hits: number;
  beHits: number;
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
  featureImportance: FeatureImportance;
  regimeStats: RegimeStats;
  scoreHistogram: ScoreHistogramBucket[];
  partialExitStats: PartialExitStats;
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

// ─── Pearson Correlation ──────────────────────────────────────────────────────

function pearsonR(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : Math.round((num / denom) * 1000) / 1000;
}

// ─── Score Histogram ──────────────────────────────────────────────────────────

const HISTOGRAM_BUCKETS = [
  { label: "<20",   min: -Infinity, max: 20 },
  { label: "20-25", min: 20, max: 25 },
  { label: "25-30", min: 25, max: 30 },
  { label: "30-35", min: 30, max: 35 },
  { label: "35-40", min: 35, max: 40 },
  { label: "40-45", min: 40, max: 45 },
  { label: "45+",   min: 45, max: Infinity },
];

function getHistogramBucket(score: number): number {
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
    const b = HISTOGRAM_BUCKETS[i]!;
    if (score >= b.min && score < b.max) return i;
  }
  return HISTOGRAM_BUCKETS.length - 1;
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

  const { stopMultiplier: slMulti, tp1Multiplier: tp1Multi, tp2Multiplier: tp2Multi, scoreThreshold, maxRiskPercent, maxTradesDay, consecutiveLossStop } = config;

  // Session filter defaults
  const sessionEnabled = config.sessionFilterEnabled ?? true;
  const sessionStart = config.sessionStartHour ?? 6;
  const sessionEnd = config.sessionEndHour ?? 20;

  const WARMUP = 175;
  const MAX_HOLD_BARS = 12;

  interface OpenTrade {
    direction: "BUY" | "SELL";
    entryPrice: number;
    fullStake: number;
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
    entryTime: number;
    barsHeld: number;
    scoreVal: number;
    scoreBreakdown: { trend: number; volatility: number; timing: number; pullback: number; risk: number };
    regime: "TRENDING" | "RANGING";
    halfClosed: boolean;
    halfPnlLocked: number;
  }

  const tradeList: { pnl: number; duration: number; scoreVal: number; scoreBreakdown: { trend: number; volatility: number; timing: number; pullback: number; risk: number } }[] = [];
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
  let sessionFiltered = 0;
  let firstScoreLogged = false;

  // Lever 1: Score histogram
  const histogramCounts = HISTOGRAM_BUCKETS.map(b => ({ bucket: b.label, count: 0, trades: 0, wins: 0 }));

  // Lever 2 + 5: Regime stats
  const regimeStats: RegimeStats = { trendingCandles: 0, rangingCandles: 0, trendingTrades: 0, rangingTrades: 0 };

  // Lever 3: Partial exit stats
  const partialExitStats: PartialExitStats = { tp1Hits: 0, tp2Hits: 0, beHits: 0 };

  console.log(`=== BACKTEST STARTING ===`);
  console.log(`Total 5m candles: ${raw5m.length}  15m candles: ${all15m.length}  WARMUP: ${WARMUP}`);
  if (raw5m.length > 0) {
    console.log(`Date range: ${new Date(raw5m[0]!.time * 1000).toISOString()} → ${new Date(raw5m[raw5m.length - 1]!.time * 1000).toISOString()}`);
  }
  console.log(`Config: threshold=${scoreThreshold} risk=${maxRiskPercent}% slX=${slMulti} tp1X=${tp1Multi} tp2X=${tp2Multi} session=${sessionEnabled ? `${sessionStart}-${sessionEnd}UTC` : "off"}`);

  for (let i = WARMUP; i < raw5m.length; i++) {
    const candle = raw5m[i];
    if (!candle) continue;

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

    // ── Lever 3: Handle open trade with partial exit logic ─────────────────
    if (openTrade) {
      let closed = false;
      let closePnl = 0;

      if (!openTrade.halfClosed) {
        // Phase 1: check TP1 (partial close) and full SL
        const tp1Hit = openTrade.direction === "BUY"
          ? candle.high >= openTrade.tp1Price
          : candle.low <= openTrade.tp1Price;
        const slHit = openTrade.direction === "BUY"
          ? candle.low <= openTrade.slPrice
          : candle.high >= openTrade.slPrice;

        if (tp1Hit && !slHit) {
          // Partial exit: close 50% at TP1, move SL to breakeven
          const rr1 = tp1Multi / slMulti;
          const halfPnl = Math.round(openTrade.fullStake * 0.5 * rr1 * 100) / 100;
          balance = Math.round((balance + halfPnl) * 100) / 100;
          if (balance > peak) peak = balance;
          openTrade.halfClosed = true;
          openTrade.halfPnlLocked = halfPnl;
          openTrade.slPrice = openTrade.entryPrice; // move SL to breakeven
          partialExitStats.tp1Hits++;
          console.log(`[BT] TP1 partial exit i=${i} dir=${openTrade.direction} halfPnl=+${halfPnl} slMovedToBE=${openTrade.entryPrice.toFixed(2)}`);
        } else if (slHit) {
          closePnl = -openTrade.fullStake;
          closed = true;
        }
      } else {
        // Phase 2: already closed half; check TP2 or breakeven SL
        const tp2Hit = openTrade.direction === "BUY"
          ? candle.high >= openTrade.tp2Price
          : candle.low <= openTrade.tp2Price;
        const slHit = openTrade.direction === "BUY"
          ? candle.low <= openTrade.slPrice // slPrice = entryPrice (BE)
          : candle.high >= openTrade.slPrice;

        if (tp2Hit) {
          const rr2 = tp2Multi / slMulti;
          closePnl = Math.round(openTrade.fullStake * 0.5 * rr2 * 100) / 100;
          closed = true;
          partialExitStats.tp2Hits++;
        } else if (slHit) {
          closePnl = 0; // breakeven on remaining half
          closed = true;
          partialExitStats.beHits++;
        }
      }

      // Time-based exit
      if (!closed && openTrade.barsHeld >= MAX_HOLD_BARS) {
        const remainingStake = openTrade.halfClosed ? openTrade.fullStake * 0.5 : openTrade.fullStake;
        const inProfit = openTrade.direction === "BUY"
          ? candle.close > openTrade.entryPrice
          : candle.close < openTrade.entryPrice;
        closePnl = inProfit
          ? Math.round(remainingStake * 0.3 * 100) / 100
          : -Math.round(remainingStake * 0.3 * 100) / 100;
        closed = true;
      }

      if (closed) {
        balance = Math.round((balance + closePnl) * 100) / 100;
        const totalTradePnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
        dailyPnl += totalTradePnl;
        tradeList.push({ pnl: totalTradePnl, duration: (openTrade.barsHeld + 1) * 5, scoreVal: openTrade.scoreVal, scoreBreakdown: openTrade.scoreBreakdown });
        returns.push(totalTradePnl / startingBalance);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
        consLosses = totalTradePnl > 0 ? 0 : consLosses + 1;
        equityCurve.push({ index: tradeList.length - 1, value: balance });

        // Update histogram with trade outcome
        const bucketIdx = getHistogramBucket(openTrade.scoreVal);
        if (histogramCounts[bucketIdx]) {
          histogramCounts[bucketIdx]!.trades++;
          if (totalTradePnl > 0) histogramCounts[bucketIdx]!.wins++;
        }

        console.log(`[BT] TRADE CLOSE i=${i} pnl=${totalTradePnl} (locked=${openTrade.halfPnlLocked} + close=${closePnl}) balance=${balance}`);
        openTrade = null;
      } else {
        openTrade.barsHeld++;
      }

      if (balance <= 0) break;
      continue;
    }

    // ── Lever 4: Session filter ────────────────────────────────────────────
    if (sessionEnabled) {
      const utcHour = Math.floor((candle.time % 86400) / 3600);
      if (utcHour < sessionStart || utcHour >= sessionEnd) {
        sessionFiltered++;
        continue;
      }
    }

    if (tradesToday >= maxTradesDay) { tradeDailyLimit++; continue; }
    if (consLosses >= consecutiveLossStop) { tradeConsLossLimit++; continue; }
    if (dailyPnl <= -(balance * 0.05)) continue;

    // Build scoring windows
    const window5m = raw5m.slice(Math.max(0, i - 49), i + 1);
    const window15m = all15m.filter(c => c.time <= candle.time).slice(-60);
    const synth1m = synthetic1mFrom5m(window5m.slice(-6));

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

    // Lever 1: Score histogram (all scored candles)
    const bucketIdx = getHistogramBucket(result.total);
    if (histogramCounts[bucketIdx]) histogramCounts[bucketIdx]!.count++;

    // Lever 2: Regime tracking
    if (result.regime === "RANGING") regimeStats.rangingCandles++;
    else regimeStats.trendingCandles++;

    if (!firstScoreLogged) {
      firstScoreLogged = true;
      console.log(`[BT] First valid score at i=${i}: total=${result.total} direction=${result.direction} regime=${result.regime} trend=${result.trendDirection} adx=${result.adx} rsi=${result.rsi}`);
    }
    if (i % 500 === 0) {
      console.log(`[BT] Score sample i=${i}: total=${result.total} dir=${result.direction} regime=${result.regime} adx=${result.adx} rsi=${result.rsi}`);
    }

    if (result.total < scoreThreshold) { scoreBelowThreshold++; continue; }
    if (result.direction === "NONE") {
      scoreDirectionNone++;
      if (scoreDirectionNone <= 5) {
        console.log(`[BT] Direction=NONE at i=${i}: total=${result.total} regime=${result.regime} adx=${result.adx} rsi=${result.rsi} band=${result.bandTouched}`);
      }
      continue;
    }

    const stake = Math.round(balance * (maxRiskPercent / 100) * 100) / 100;
    if (stake <= 0) continue;

    const atrVal = result.atrValue > 0 ? result.atrValue : candle.close * 0.001;

    const slDist = atrVal * slMulti;
    const tp1Dist = atrVal * tp1Multi;
    // Lever 2: Ranging mode uses tp1 as final TP (mean-reversion targets midline, smaller move)
    const tp2Dist = result.regime === "RANGING" ? atrVal * tp1Multi : atrVal * tp2Multi;

    const slPrice = result.direction === "BUY"
      ? candle.close - slDist
      : candle.close + slDist;
    const tp1Price = result.direction === "BUY"
      ? candle.close + tp1Dist
      : candle.close - tp1Dist;
    const tp2Price = result.direction === "BUY"
      ? candle.close + tp2Dist
      : candle.close - tp2Dist;

    console.log(`[BT] TRADE ENTRY i=${i} dir=${result.direction} regime=${result.regime} score=${result.total} close=${candle.close} sl=${slPrice.toFixed(2)} tp1=${tp1Price.toFixed(2)} tp2=${tp2Price.toFixed(2)} stake=${stake}`);

    openTrade = {
      direction: result.direction,
      entryPrice: candle.close,
      fullStake: stake,
      slPrice,
      tp1Price,
      tp2Price,
      entryTime: candle.time,
      barsHeld: 0,
      scoreVal: result.total,
      scoreBreakdown: { trend: result.trend, volatility: result.volatility, timing: result.timing, pullback: result.pullback, risk: result.risk },
      regime: result.regime,
      halfClosed: false,
      halfPnlLocked: 0,
    };
    tradesToday++;

    // Lever 2: Track regime of trade entry
    if (result.regime === "RANGING") regimeStats.rangingTrades++;
    else regimeStats.trendingTrades++;
  }

  console.log(`=== BACKTEST COMPLETE ===`);
  console.log(`Candles processed: ${raw5m.length - WARMUP}  Trades: ${tradeList.length}`);
  console.log(`scoreNull=${scoreNullCount} belowThreshold=${scoreBelowThreshold} dirNone=${scoreDirectionNone} errors=${scoreErrors} dailyLimit=${tradeDailyLimit} consLoss=${tradeConsLossLimit} sessionFiltered=${sessionFiltered}`);
  console.log(`Regime: trending=${regimeStats.trendingCandles} ranging=${regimeStats.rangingCandles} | trades: trending=${regimeStats.trendingTrades} ranging=${regimeStats.rangingTrades}`);
  console.log(`Partial exits: tp1=${partialExitStats.tp1Hits} tp2=${partialExitStats.tp2Hits} be=${partialExitStats.beHits}`);

  // Close any open trade at end of data
  if (openTrade) {
    const last = raw5m[raw5m.length - 1];
    if (last) {
      const remainingStake = openTrade.halfClosed ? openTrade.fullStake * 0.5 : openTrade.fullStake;
      const inProfit = openTrade.direction === "BUY" ? last.close > openTrade.entryPrice : last.close < openTrade.entryPrice;
      const closePnl = inProfit
        ? Math.round(remainingStake * 0.3 * 100) / 100
        : -Math.round(remainingStake * 0.3 * 100) / 100;
      const totalTradePnl = Math.round((openTrade.halfPnlLocked + closePnl) * 100) / 100;
      balance = Math.round((balance + closePnl) * 100) / 100;
      tradeList.push({ pnl: totalTradePnl, duration: openTrade.barsHeld * 5, scoreVal: openTrade.scoreVal, scoreBreakdown: openTrade.scoreBreakdown });
      returns.push(totalTradePnl / startingBalance);
      if (balance > peak) peak = balance;
      equityCurve.push({ index: tradeList.length - 1, value: balance });
    }
  }

  // ── Lever 5: Feature importance via Pearson correlation ──────────────────
  const featureImportance: FeatureImportance = { trend: 0, volatility: 0, timing: 0, pullback: 0, risk: 0 };
  if (tradeList.length >= 2) {
    const outcomes = tradeList.map(t => t.pnl > 0 ? 1 : -1);
    featureImportance.trend     = pearsonR(tradeList.map(t => t.scoreBreakdown.trend), outcomes);
    featureImportance.volatility = pearsonR(tradeList.map(t => t.scoreBreakdown.volatility), outcomes);
    featureImportance.timing    = pearsonR(tradeList.map(t => t.scoreBreakdown.timing), outcomes);
    featureImportance.pullback  = pearsonR(tradeList.map(t => t.scoreBreakdown.pullback), outcomes);
    featureImportance.risk      = pearsonR(tradeList.map(t => t.scoreBreakdown.risk), outcomes);
    console.log(`[BT] Feature importance: trend=${featureImportance.trend} vol=${featureImportance.volatility} timing=${featureImportance.timing} pullback=${featureImportance.pullback} risk=${featureImportance.risk}`);
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

  logger.info({ runId, trades: tradeList.length, winRate, totalPnl, hash: candleHash, dataSource, trendingTrades: regimeStats.trendingTrades, rangingTrades: regimeStats.rangingTrades }, "Backtest complete");

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
    featureImportance,
    regimeStats,
    scoreHistogram: histogramCounts,
    partialExitStats,
  };
}
