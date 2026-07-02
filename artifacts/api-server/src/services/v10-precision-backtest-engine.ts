import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import type { Candle } from "./deriv.js";
import { scoreV10Precision } from "./v10-precision-scoring.js";
import { logger } from "../lib/logger.js";
import type { SwingBacktestResult, SwingTradeDetail } from "./swing-backtest-engine.js";

const CACHE_DIR = path.join(process.cwd(), "data", "candle-cache");
const SYMBOL = "R_10";
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const PAYOUT_RATE = 0.87;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrecisionCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

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

function getCachePath(granularity: number, dateFrom: number, dateTo: number): string {
  const key = `${SYMBOL}_${granularity}s_${normalizeMidnightUTC(dateFrom)}_${normalizeEndOfDayUTC(dateTo)}`;
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(granularity: number, dateFrom: number, dateTo: number): PrecisionCandle[] | null {
  const file = getCachePath(granularity, dateFrom, dateTo);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.candles ?? null;
  } catch {
    return null;
  }
}

function writeCache(granularity: number, dateFrom: number, dateTo: number, candles: PrecisionCandle[]): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const entry = {
    symbol: SYMBOL,
    granularity,
    dateFrom,
    dateTo,
    candles,
    cachedAt: Date.now(),
    count: candles.length,
  };
  fs.writeFileSync(getCachePath(granularity, dateFrom, dateTo), JSON.stringify(entry, null, 2));
}

// ── Deriv fetch ───────────────────────────────────────────────────────────────

function fetchOneChunk(
  granularity: number,
  count: number,
  endTime: number
): Promise<PrecisionCandle[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve([]);
    }, 25000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          ticks_history: SYMBOL,
          style: "candles",
          granularity,
          count,
          end: endTime,
        })
      );
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          clearTimeout(timeout);
          ws.close();
          resolve(
            msg.candles.map((c: Record<string, unknown>) => ({
              time: Number(c["epoch"]),
              open: parseFloat(String(c["open"])),
              high: parseFloat(String(c["high"])),
              low: parseFloat(String(c["low"])),
              close: parseFloat(String(c["close"])),
            }))
          );
        } else if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          resolve([]);
        }
      } catch { /* skip */ }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      try { ws.terminate(); } catch {}
      resolve([]);
    });
  });
}

async function fetchCandles(
  granularity: number,
  dateFrom: number,
  dateTo: number,
  forceRefresh: boolean
): Promise<PrecisionCandle[]> {
  if (!forceRefresh) {
    const cached = readCache(granularity, dateFrom, dateTo);
    if (cached) {
      logger.info(
        { symbol: SYMBOL, granularity, count: cached.length },
        "V10P backtest: cache hit"
      );
      return cached;
    }
  }

  const CHUNK_SIZE = 4900;
  const MAX_CHUNKS = 12;
  const all: PrecisionCandle[] = [];
  let currentEnd = dateTo;
  let chunks = 0;

  while (currentEnd > dateFrom && chunks < MAX_CHUNKS) {
    chunks++;
    console.log(
      `V10P fetching ${granularity}s candles chunk ${chunks}, end=${new Date(currentEnd * 1000).toISOString()}`
    );
    const chunk = await fetchOneChunk(granularity, CHUNK_SIZE, currentEnd);
    if (!chunk.length) break;
    all.push(...chunk);
    const earliest = Math.min(...chunk.map((c) => c.time));
    currentEnd = earliest - granularity;
    if (earliest <= dateFrom) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const filtered = all
    .filter((c) => c.time >= dateFrom && c.time <= dateTo)
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1]!.time);

  writeCache(granularity, dateFrom, dateTo, filtered);
  logger.info(
    { symbol: SYMBOL, granularity, count: filtered.length },
    "V10P backtest: fetched from Deriv"
  );
  return filtered;
}

// ── Build 5m candles from 1m ─────────────────────────────────────────────────

function build5mFromMinute(candles1m: PrecisionCandle[]): PrecisionCandle[] {
  const grouped: Record<number, PrecisionCandle[]> = {};
  for (const c of candles1m) {
    const boundary = Math.floor(c.time / 300) * 300;
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
        high: Math.max(...sorted.map((c) => c.high)),
        low: Math.min(...sorted.map((c) => c.low)),
        close: sorted[sorted.length - 1]!.close,
      };
    })
    .sort((a, b) => a.time - b.time);
}

// ── P&L helpers ───────────────────────────────────────────────────────────────

function calculatePrecisionPnL(
  outcome: "TP_HIT" | "STOP_LOSS" | "TIME_STOP",
  stake: number,
  direction: string,
  entryPrice: number,
  closePrice: number
): number {
  const priceMoved =
    direction === "BUY" ? closePrice - entryPrice : entryPrice - closePrice;

  console.log(
    `[V10P] P&L CALC: outcome=${outcome} stake=$${stake} dir=${direction} entry=${entryPrice.toFixed(4)} close=${closePrice.toFixed(4)} moved=${priceMoved.toFixed(4)}`
  );

  if (outcome === "TP_HIT") {
    const pnl = Math.round(stake * PAYOUT_RATE * 100) / 100;
    console.log(`[V10P] WIN: +$${pnl}`);
    return pnl;
  }

  if (outcome === "STOP_LOSS") {
    const pnl = -stake;
    console.log(`[V10P] LOSS: $${pnl}`);
    return pnl;
  }

  // TIME_STOP — half payout based on direction
  const profitable = priceMoved > 0;
  const pnl = profitable
    ? Math.round(stake * PAYOUT_RATE * 0.5 * 100) / 100
    : -Math.round(stake * 0.5 * 100) / 100;
  console.log(`[V10P] TIME STOP ${profitable ? "WIN" : "LOSS"}: $${pnl}`);
  return pnl;
}

// ── Outcome checker ───────────────────────────────────────────────────────────

function checkPrecisionOutcome(
  direction: string,
  stopLoss: number,
  takeProfit: number,
  candle: PrecisionCandle
): "TP_HIT" | "STOP_LOSS" | null {
  if (direction === "BUY") {
    if (candle.low <= stopLoss) {
      console.log(
        `[V10P] BUY STOP HIT: low=${candle.low.toFixed(4)} <= stop=${stopLoss.toFixed(4)}`
      );
      return "STOP_LOSS";
    }
    if (candle.high >= takeProfit) {
      console.log(
        `[V10P] BUY TP HIT: high=${candle.high.toFixed(4)} >= tp=${takeProfit.toFixed(4)}`
      );
      return "TP_HIT";
    }
  } else {
    if (candle.high >= stopLoss) {
      console.log(
        `[V10P] SELL STOP HIT: high=${candle.high.toFixed(4)} >= stop=${stopLoss.toFixed(4)}`
      );
      return "STOP_LOSS";
    }
    if (candle.low <= takeProfit) {
      console.log(
        `[V10P] SELL TP HIT: low=${candle.low.toFixed(4)} <= tp=${takeProfit.toFixed(4)}`
      );
      return "TP_HIT";
    }
  }
  return null;
}

// ── Sharpe ratio ──────────────────────────────────────────────────────────────

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(252);
}

// ── Progress callback ─────────────────────────────────────────────────────────

export type PrecisionProgressCallback = (p: {
  candleIndex: number;
  totalCandles: number;
  tradesExecuted: number;
  wins: number;
  currentBalance: number;
  phase: "fetching" | "running";
  funnel: Record<string, number>;
}) => void;

// ── Main backtest ─────────────────────────────────────────────────────────────

export async function runV10PrecisionBacktest(
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
  onProgress?: PrecisionProgressCallback
): Promise<SwingBacktestResult> {
  const runId = `V10P_${Date.now()}_${strategyId}`;

  // ── Fetch 1m candles (primary loop) ──────────────────────────────────────
  console.log("\nV10 Precision Scalper Backtest");
  console.log(
    `Period: ${new Date(dateFrom * 1000).toDateString()} - ${new Date(dateTo * 1000).toDateString()}`
  );

  onProgress?.({
    candleIndex: 0,
    totalCandles: 0,
    tradesExecuted: 0,
    wins: 0,
    currentBalance: startingBalance,
    phase: "fetching",
    funnel: {},
  });

  const candles1m = await fetchCandles(60, dateFrom, dateTo, forceRefresh);
  console.log(`1m candles: ${candles1m.length}`);

  if (candles1m.length < 100) {
    throw new Error(
      `Insufficient 1m candle data: ${candles1m.length} candles`
    );
  }

  // Build 5m candles from 1m
  const all5m = build5mFromMinute(candles1m);
  console.log(`5m candles: ${all5m.length}`);

  const hashSum = candles1m.slice(0, 10).reduce((s, c) => s + c.close, 0);
  const candleHash = `${candles1m.length}:${hashSum.toFixed(2)}`;
  const cacheFile = getCachePath(60, dateFrom, dateTo);

  // ── Config ────────────────────────────────────────────────────────────────
  const WARMUP = 100; // need 30+ 1m candles for scoring
  const MAX_HOLD_MINUTES = 25; // 25-minute time stop
  const COOLDOWN_MINUTES = 3; // 3-minute cooldown between trades
  const MAX_TRADES_DAY = config.maxTradesDay ?? 20;
  const MAX_TRADES_HOUR = 4;
  const CONS_LOSS_STOP = config.consecutiveLossStop ?? 5;
  const MAX_RISK = (config.maxRiskPercent ?? 0.5) / 100;
  const DAILY_LOSS_CAP_PCT = 0.06; // 6% daily loss cap

  console.log(
    `Config: threshold=15/20 risk=${config.maxRiskPercent}% maxDay=${MAX_TRADES_DAY} maxHour=${MAX_TRADES_HOUR} consLoss=${CONS_LOSS_STOP} payout=${PAYOUT_RATE}`
  );

  // ── State ─────────────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peak = balance;
  let maxDD = 0;
  const tradeList: SwingTradeDetail[] = [];
  const equityCurve: { index: number; value: number }[] = [
    { index: 0, value: balance },
  ];
  const returns: number[] = [];

  interface OpenPrecisionTrade {
    direction: "BUY" | "SELL";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    stake: number;
    openIdx: number;
    openTime: number;
    minutesHeld: number;
    scoreVal: number;
    c1: number;
    c2: number;
    c3: number;
  }

  let openTrade: OpenPrecisionTrade | null = null;
  let consLosses = 0;
  let todayTrades = 0;
  let todayStartBalance = startingBalance;
  let currentDay = "";
  let lastTradeCloseTime = 0;
  let hourlyTrades: number[] = []; // timestamps of recent trades
  let signalEvalCount = 0; // for logging first 50

  // Funnel counters
  let noSignal = 0;
  let vetoFiltered = 0;
  let dailyLimitBlocked = 0;
  let hourlyLimitBlocked = 0;
  let consLossBlocked = 0;
  let cooldownBlocked = 0;
  let dailyLossBlocked = 0;
  let tradesExecuted = 0;
  let wins = 0;

  // 5m pointer
  let m5Ptr = 0;

  for (let i = WARMUP; i < candles1m.length; i++) {
    const candle = candles1m[i]!;

    if (i % 1000 === 0) {
      console.log(
        `V10P progress: ${i}/${candles1m.length} Trades: ${tradesExecuted} | Balance: $${balance.toFixed(2)}`
      );
      onProgress?.({
        candleIndex: i,
        totalCandles: candles1m.length,
        tradesExecuted,
        wins,
        currentBalance: balance,
        phase: "running",
        funnel: {
          noSignal,
          vetoed: vetoFiltered,
          dailyLimit: dailyLimitBlocked,
          hourlyLimit: hourlyLimitBlocked,
          consLoss: consLossBlocked,
          cooldown: cooldownBlocked,
          executed: tradesExecuted,
        },
      });
    }

    // Daily reset
    const day = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      todayTrades = 0;
      todayStartBalance = balance;
      consLosses = 0; // reset daily
    }

    // Advance 5m pointer
    while (m5Ptr + 1 < all5m.length && all5m[m5Ptr + 1]!.time <= candle.time) {
      m5Ptr++;
    }

    // ── Manage open trade ─────────────────────────────────────────────────
    if (openTrade) {
      const outcome = checkPrecisionOutcome(
        openTrade.direction,
        openTrade.stopLoss,
        openTrade.takeProfit,
        candle
      );

      const timeStop = openTrade.minutesHeld >= MAX_HOLD_MINUTES;

      if (outcome || timeStop) {
        const closeOutcome = outcome ?? "TIME_STOP";
        const closePrice =
          outcome === "TP_HIT"
            ? openTrade.takeProfit
            : outcome === "STOP_LOSS"
            ? openTrade.stopLoss
            : candle.close;

        const pnl = calculatePrecisionPnL(
          closeOutcome,
          openTrade.stake,
          openTrade.direction,
          openTrade.entryPrice,
          closePrice
        );

        balance = Math.round((balance + pnl) * 100) / 100;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;

        consLosses = pnl > 0 ? 0 : consLosses + 1;
        if (pnl > 0) wins++;

        const tradeDetail: SwingTradeDetail = {
          tradeNum: tradeList.length + 1,
          direction: openTrade.direction,
          entryPrice: openTrade.entryPrice,
          slPrice: openTrade.stopLoss,
          tp1Price: openTrade.takeProfit,
          tp2Price: openTrade.takeProfit,
          exitPrice: closePrice,
          closeReason:
            outcome === "TP_HIT"
              ? "tp2"
              : outcome === "STOP_LOSS"
              ? "sl"
              : "time_stop",
          pnl,
          durationMinutes: openTrade.minutesHeld,
          entryTime: openTrade.openTime,
          exitTime: candle.time,
          score: openTrade.scoreVal,
          c1: openTrade.c1,
          c2: openTrade.c2,
          c3: openTrade.c3,
          stage2Added: false,
        };

        tradeList.push(tradeDetail);
        returns.push(pnl / startingBalance);
        equityCurve.push({ index: tradeList.length - 1, value: balance });
        lastTradeCloseTime = candle.time;

        console.log(
          `[V10P] <<< TRADE CLOSE #${tradeDetail.tradeNum} reason=${closeOutcome} dir=${openTrade.direction} entry=${openTrade.entryPrice.toFixed(4)} exit=${closePrice.toFixed(4)} pnl=$${pnl.toFixed(2)} balance=$${balance.toFixed(2)}`
        );
        openTrade = null;
      } else {
        openTrade.minutesHeld++;
      }
    }

    if (openTrade) continue;

    // ── Filters ───────────────────────────────────────────────────────────
    // Daily loss cap
    const dailyLoss = (todayStartBalance - balance) / todayStartBalance;
    if (dailyLoss >= DAILY_LOSS_CAP_PCT) {
      dailyLossBlocked++;
      continue;
    }

    // Daily trade limit
    if (todayTrades >= MAX_TRADES_DAY) {
      dailyLimitBlocked++;
      continue;
    }

    // Consecutive loss stop
    if (consLosses >= CONS_LOSS_STOP) {
      consLossBlocked++;
      continue;
    }

    // Cooldown (3 minutes)
    if (lastTradeCloseTime > 0 && candle.time - lastTradeCloseTime < COOLDOWN_MINUTES * 60) {
      cooldownBlocked++;
      continue;
    }

    // Hourly limit (sliding window)
    const oneHourAgo = candle.time - 3600;
    hourlyTrades = hourlyTrades.filter((t) => t > oneHourAgo);
    if (hourlyTrades.length >= MAX_TRADES_HOUR) {
      hourlyLimitBlocked++;
      continue;
    }

    // ── Build scoring windows ─────────────────────────────────────────────
    const window1m = candles1m.slice(Math.max(0, i - 99), i + 1) as Candle[];
    const window5m = all5m.slice(Math.max(0, m5Ptr - 49), m5Ptr + 1) as Candle[];

    // Cast to Candle (add volume=0 since precision candles lack volume)
    const window1mC: Candle[] = window1m.map((c) => ({
      ...c,
      volume: (c as any).volume ?? 0,
    }));
    const window5mC: Candle[] = window5m.map((c) => ({
      ...c,
      volume: (c as any).volume ?? 0,
    }));

    // ── Score ─────────────────────────────────────────────────────────────
    let result;
    try {
      result = scoreV10Precision(window1mC, window5mC);
    } catch (err) {
      noSignal++;
      continue;
    }

    if (!result) {
      noSignal++;
      continue;
    }

    // Count ADX veto separately from "no signal" for funnel accuracy
    if (result.signal === "NONE" && result.reason && result.reason.includes("veto")) {
      vetoFiltered++;
      continue;
    }

    // Log first 50 signal evaluations
    if (signalEvalCount < 50) {
      console.log(
        `[V10P] Signal eval #${signalEvalCount + 1} i=${i}: signal=${result.signal} total=${result.total}/20 c1=${result.c1} c2=${result.c2} c3=${result.c3} price=${candle.close.toFixed(4)}`
      );
      signalEvalCount++;
    }

    if (result.signal === "NONE") {
      noSignal++;
      continue;
    }

    // ── Validate and open trade ───────────────────────────────────────────
    let { stopLoss, takeProfit, stopDistance } = result;
    const entryPrice = candle.close;
    const atr = result.atrValue;

    // Hard validation of stop placement
    if (result.signal === "BUY" && stopLoss >= entryPrice) {
      console.error(
        `[V10P] BUG: BUY stop (${stopLoss.toFixed(4)}) >= entry (${entryPrice.toFixed(4)}) — correcting`
      );
      stopDistance = Math.max(3, atr * 1.5);
      stopLoss = entryPrice - stopDistance;
    }
    if (result.signal === "SELL" && stopLoss <= entryPrice) {
      console.error(
        `[V10P] BUG: SELL stop (${stopLoss.toFixed(4)}) <= entry (${entryPrice.toFixed(4)}) — correcting`
      );
      stopDistance = Math.max(3, atr * 1.5);
      stopLoss = entryPrice + stopDistance;
    }
    if (result.signal === "BUY" && takeProfit <= entryPrice) {
      console.log(`[V10P] BUY TP validation failed — skipping trade`);
      continue;
    }
    if (result.signal === "SELL" && takeProfit >= entryPrice) {
      console.log(`[V10P] SELL TP validation failed — skipping trade`);
      continue;
    }

    // Stake calculation: balance * 0.5% per spec
    const rawStake = Math.max(1.0, balance * MAX_RISK);
    const stake = Math.min(5.0, Math.round(rawStake * 100) / 100); // max $5 per trade

    openTrade = {
      direction: result.signal,
      entryPrice,
      stopLoss,
      takeProfit,
      stake,
      openIdx: i,
      openTime: candle.time,
      minutesHeld: 0,
      scoreVal: result.total,
      c1: result.c1,
      c2: result.c2,
      c3: result.c3,
    };

    todayTrades++;
    tradesExecuted++;
    hourlyTrades.push(candle.time);

    console.log(
      `[V10P] >>> TRADE ENTRY #${tradesExecuted} dir=${result.signal} score=${result.total}/20 (${result.c1}/${result.c2}/${result.c3}) entry=${entryPrice.toFixed(4)} sl=${stopLoss.toFixed(4)} tp=${takeProfit.toFixed(4)} stake=$${stake} reason=${result.reason}`
    );
  }

  // Close any still-open trade at end of data
  if (openTrade) {
    const last = candles1m[candles1m.length - 1]!;
    const pnl = calculatePrecisionPnL(
      "TIME_STOP",
      openTrade.stake,
      openTrade.direction,
      openTrade.entryPrice,
      last.close
    );
    balance = Math.round((balance + pnl) * 100) / 100;
    if (balance > peak) peak = balance;
    if (pnl > 0) wins++;

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
      durationMinutes: openTrade.minutesHeld,
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

  // ── Final stats ───────────────────────────────────────────────────────────
  const total = tradeList.length;
  const losses = tradeList.filter((t) => t.pnl <= 0).length;
  const winRate =
    total > 0 ? Math.round(((wins / total) * 100) * 10) / 10 : 0;
  const totalPnl = Math.round(
    tradeList.reduce((s, t) => s + t.pnl, 0) * 100
  ) / 100;
  const grossWin = tradeList
    .filter((t) => t.pnl > 0)
    .reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(
    tradeList.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)
  );
  const profitFactor =
    grossLoss > 0
      ? Math.round((grossWin / grossLoss) * 100) / 100
      : grossWin > 0
      ? 99
      : 0;
  const bestTrade = total > 0 ? Math.max(...tradeList.map((t) => t.pnl)) : 0;
  const worstTrade = total > 0 ? Math.min(...tradeList.map((t) => t.pnl)) : 0;
  const avgDuration =
    total > 0
      ? Math.round(
          tradeList.reduce((s, t) => s + t.durationMinutes, 0) / total
        )
      : 0;

  console.log(`\n=== V10 PRECISION SCALPER BACKTEST COMPLETE ===`);
  console.log(`Total trades: ${total}`);
  console.log(`Wins: ${wins} | Losses: ${losses}`);
  console.log(`Win rate: ${winRate.toFixed(1)}%`);
  console.log(`Profit factor: ${profitFactor}`);
  console.log(`Total P&L: $${totalPnl.toFixed(2)}`);
  console.log(`Avg duration: ${avgDuration}m`);
  console.log(
    `Funnel: noSignal=${noSignal} vetoed=${vetoFiltered} dailyLimit=${dailyLimitBlocked} hourlyLimit=${hourlyLimitBlocked} consLoss=${consLossBlocked} cooldown=${cooldownBlocked} dailyLoss=${dailyLossBlocked} executed=${tradesExecuted}`
  );

  logger.info(
    { runId, total, wins, winRate, totalPnl, candleHash },
    "V10 Precision backtest complete"
  );

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
    candlesUsed: candles1m.length,
    candleHash,
    dataSource: "deriv_fresh",
    cacheFile,
    partialExitStats: { tp1Hits: 0, tp2Hits: wins, beHits: 0, stage2Hits: 0 },
    trades: tradeList,
    funnel: {
      noSignal,
      vetoed: vetoFiltered,
      dailyLimit: dailyLimitBlocked,
      hourlyLimit: hourlyLimitBlocked,
      consLoss: consLossBlocked,
      cooldown: cooldownBlocked,
      executed: tradesExecuted,
      totalProcessed: candles1m.length - WARMUP,
    },
  };
}
