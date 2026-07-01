import type { Candle } from "./deriv.js";
import { logger } from "../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionMoveResult {
  sessionOpenPrice: number;
  currentMove: number;
  moveDirection: "UP" | "DOWN" | "NONE";
  sufficientMove: boolean;
}

export interface DivergenceResult {
  bullish: boolean;
  bearish: boolean;
  currentRsi: number;
}

export interface BBExtremeResult {
  aboveUpper: boolean;
  belowLower: boolean;
  above25sigma: boolean;
  below25sigma: boolean;
  premiumSell: boolean;
  premiumBuy: boolean;
  middle: number;
  upper: number;
  lower: number;
}

export interface ReversalScoreResult {
  total: number;
  c1: number;  // Session exhaustion 0-10
  c2: number;  // Divergence strength 0-10
  c3: number;  // BB breach quality 0-5
  direction: "BUY" | "SELL" | "NONE";
  sessionMove: SessionMoveResult;
  divergence5m: DivergenceResult;
  divergence15m: DivergenceResult;
  bbExtreme: BBExtremeResult;
  confirmed1m: boolean;
  isPremium: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  stopDistance: number;
  rr: number;
  rejectionReason: string | null;
}

// ── RSI Array (value for every candle) ───────────────────────────────────────

function calculateRSIArray(candles: Candle[], period = 14): number[] {
  const closes = candles.map(c => c.close);
  if (closes.length < period + 1) {
    return closes.map(() => 50);
  }
  const result: number[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(0, diff);
    avgLoss += Math.max(0, -diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = 0; i < period; i++) result.push(50);
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

function calculateBB(candles: Candle[], period = 20, sigma = 2.0): { upper: number; middle: number; lower: number } {
  if (candles.length < period) {
    const close = candles[candles.length - 1]?.close ?? 0;
    return { upper: close, middle: close, lower: close };
  }
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  return {
    upper: mean + sigma * stddev,
    middle: mean,
    lower: mean - sigma * stddev,
  };
}

// ── Session Move Calculator ───────────────────────────────────────────────────

export function calculateSessionMove(
  candles5m: Candle[],
  currentTime: number
): SessionMoveResult {
  const utcHour = new Date(currentTime * 1000).getUTCHours();

  let sessionOpenHour: number;
  if (utcHour >= 0 && utcHour < 7) sessionOpenHour = 0;
  else if (utcHour >= 7 && utcHour < 12) sessionOpenHour = 7;
  else if (utcHour >= 12 && utcHour < 17) sessionOpenHour = 12;
  else sessionOpenHour = 0;

  const sessionOpenTime = new Date(currentTime * 1000);
  sessionOpenTime.setUTCHours(sessionOpenHour, 0, 0, 0);
  const sessionOpenUnix = sessionOpenTime.getTime() / 1000;

  const sessionCandles = candles5m.filter(
    c => c.time >= sessionOpenUnix && c.time <= currentTime
  );

  if (sessionCandles.length === 0) {
    return { sessionOpenPrice: 0, currentMove: 0, moveDirection: "NONE", sufficientMove: false };
  }

  const sessionOpenPrice = sessionCandles[0]!.open;
  const currentPrice = sessionCandles[sessionCandles.length - 1]!.close;
  const rawMove = currentPrice - sessionOpenPrice;
  const moveInPips = Math.abs(rawMove);
  const moveDirection: "UP" | "DOWN" = rawMove > 0 ? "UP" : "DOWN";

  logger.debug({
    sessionOpenPrice, currentPrice,
    movePips: moveInPips.toFixed(2),
    moveDirection,
    sufficient: moveInPips >= 220,
  }, "Reversal: session move calculation");

  return {
    sessionOpenPrice,
    currentMove: moveInPips,
    moveDirection,
    sufficientMove: moveInPips >= 220,
  };
}

// ── Divergence Detector ───────────────────────────────────────────────────────

export function detectDivergence(
  candles: Candle[],
  lookback = 10
): DivergenceResult {
  if (candles.length < lookback + 14) {
    return { bullish: false, bearish: false, currentRsi: 50 };
  }

  const recent = candles.slice(-lookback);
  const rsiValues = calculateRSIArray(candles, 14).slice(-lookback);
  const closes = recent.map(c => c.close);

  let priceHighIdx = 0;
  let priceLowIdx = 0;
  let rsiHighIdx = 0;
  let rsiLowIdx = 0;

  for (let i = 1; i < recent.length - 1; i++) {
    if (closes[i]! > closes[priceHighIdx]!) priceHighIdx = i;
    if (closes[i]! < closes[priceLowIdx]!) priceLowIdx = i;
    if (rsiValues[i]! > rsiValues[rsiHighIdx]!) rsiHighIdx = i;
    if (rsiValues[i]! < rsiValues[rsiLowIdx]!) rsiLowIdx = i;
  }

  const lastPriceHigh = closes[priceHighIdx]!;
  const prevCloses = closes.slice(0, priceHighIdx);
  const prevPriceHigh = prevCloses.length > 0 ? Math.max(...prevCloses) : lastPriceHigh;
  const lastRsiHigh = rsiValues[rsiHighIdx]!;
  const prevRsiSlice = rsiValues.slice(0, rsiHighIdx);
  const prevRsiHigh = prevRsiSlice.length > 0 ? Math.max(...prevRsiSlice) : lastRsiHigh;

  const lastPriceLow = closes[priceLowIdx]!;
  const prevClosesLow = closes.slice(0, priceLowIdx);
  const prevPriceLow = prevClosesLow.length > 0 ? Math.min(...prevClosesLow) : lastPriceLow;
  const lastRsiLow = rsiValues[rsiLowIdx]!;
  const prevRsiSliceLow = rsiValues.slice(0, rsiLowIdx);
  const prevRsiLow = prevRsiSliceLow.length > 0 ? Math.min(...prevRsiSliceLow) : lastRsiLow;

  const currentRsi = rsiValues[rsiValues.length - 1]!;

  // Bearish divergence: price makes higher high but RSI makes lower high
  const bearishDivergence =
    lastPriceHigh > prevPriceHigh &&
    lastRsiHigh < prevRsiHigh &&
    currentRsi > 65;

  // Bullish divergence: price makes lower low but RSI makes higher low
  const bullishDivergence =
    lastPriceLow < prevPriceLow &&
    lastRsiLow > prevRsiLow &&
    currentRsi < 35;

  return { bullish: bullishDivergence, bearish: bearishDivergence, currentRsi };
}

// ── BB Extreme Detector ───────────────────────────────────────────────────────

export function detectBBExtreme(candles5m: Candle[]): BBExtremeResult {
  const bb = calculateBB(candles5m, 20, 2.0);
  const bb25 = calculateBB(candles5m, 20, 2.5);
  const currentPrice = candles5m[candles5m.length - 1]!.close;

  return {
    aboveUpper: currentPrice > bb.upper,
    belowLower: currentPrice < bb.lower,
    above25sigma: currentPrice > bb25.upper,
    below25sigma: currentPrice < bb25.lower,
    premiumSell: currentPrice > bb25.upper,
    premiumBuy: currentPrice < bb25.lower,
    middle: bb.middle,
    upper: bb.upper,
    lower: bb.lower,
  };
}

// ── 1m Confirmation ───────────────────────────────────────────────────────────

export function check1mConfirmation(
  candles1m: Candle[],
  direction: "BUY" | "SELL"
): boolean {
  if (candles1m.length < 2) return false;

  const last = candles1m[candles1m.length - 1]!;
  const prev = candles1m[candles1m.length - 2]!;

  const candleBody = Math.abs(last.close - last.open);
  const candleRange = last.high - last.low;
  if (candleRange === 0) return false;
  const bodyRatio = candleBody / candleRange;

  if (direction === "BUY") {
    const isGreen = last.close > last.open;
    const abovePrevMid = last.close > (prev.high + prev.low) / 2;
    const bodyDominated = bodyRatio > 0.5;
    const lowerWick = last.open - last.low;
    const upperBody = last.close - last.open;
    const wickNotTooLarge = upperBody > 0 ? lowerWick < upperBody * 2 : true;
    const confirmed = isGreen && abovePrevMid && bodyDominated && wickNotTooLarge;

    logger.debug({ isGreen, abovePrevMid, bodyDominated, wickNotTooLarge, confirmed }, "Reversal: 1m BUY confirmation");
    return confirmed;
  }

  if (direction === "SELL") {
    const isRed = last.close < last.open;
    const belowPrevMid = last.close < (prev.high + prev.low) / 2;
    const bodyDominated = bodyRatio > 0.5;
    const upperWick = last.high - last.open;
    const lowerBody = last.open - last.close;
    const wickNotTooLarge = lowerBody > 0 ? upperWick < lowerBody * 2 : true;
    const confirmed = isRed && belowPrevMid && bodyDominated && wickNotTooLarge;

    logger.debug({ isRed, belowPrevMid, bodyDominated, wickNotTooLarge, confirmed }, "Reversal: 1m SELL confirmation");
    return confirmed;
  }

  return false;
}

// ── Scoring Components ────────────────────────────────────────────────────────

function scoreSessionExhaustion(
  sessionMove: SessionMoveResult,
  direction: "BUY" | "SELL"
): number {
  const move = sessionMove.currentMove;
  const moveDir = sessionMove.moveDirection;

  if (direction === "BUY" && moveDir !== "DOWN") return 0;
  if (direction === "SELL" && moveDir !== "UP") return 0;

  if (move >= 600) return 10;
  if (move >= 500) return 9;
  if (move >= 450) return 8;
  if (move >= 400) return 7;
  if (move >= 375) return 6;
  if (move >= 350) return 5;
  if (move >= 300) return 4;
  if (move >= 260) return 3;
  if (move >= 220) return 2;
  return 0;
}

function scoreDivergenceStrength(
  div5m: DivergenceResult,
  div15m: DivergenceResult,
  direction: "BUY" | "SELL"
): number {
  let s = 0;
  if (direction === "BUY") {
    if (div5m.bullish) s += 4;
    if (div15m.bullish) s += 4;
    if (div5m.currentRsi < 25) s += 2;
    else if (div5m.currentRsi < 30) s += 1;
  }
  if (direction === "SELL") {
    if (div5m.bearish) s += 4;
    if (div15m.bearish) s += 4;
    if (div5m.currentRsi > 75) s += 2;
    else if (div5m.currentRsi > 70) s += 1;
  }
  return Math.min(s, 10);
}

function scoreBBBreach(
  bbExtreme: BBExtremeResult,
  direction: "BUY" | "SELL"
): number {
  if (direction === "BUY") {
    if (bbExtreme.below25sigma) return 5;
    if (bbExtreme.belowLower) return 3;
    return 1;
  }
  if (direction === "SELL") {
    if (bbExtreme.above25sigma) return 5;
    if (bbExtreme.aboveUpper) return 3;
    return 1;
  }
  return 0;
}

// ── Main Reversal Scorer ──────────────────────────────────────────────────────

export function scoreReversal(
  candles1m: Candle[],
  candles5m: Candle[],
  candles15m: Candle[],
  threshold = 20
): ReversalScoreResult | null {
  if (candles5m.length < 30 || candles15m.length < 30 || candles1m.length < 5) return null;

  const now = Math.floor(Date.now() / 1000);

  // Step 1 — Session move
  const sessionMove = calculateSessionMove(candles5m, now);

  logger.debug({
    movePips: sessionMove.currentMove.toFixed(0),
    direction: sessionMove.moveDirection,
    sufficient: sessionMove.sufficientMove,
  }, "Reversal: session move");

  if (!sessionMove.sufficientMove) {
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE",
      sessionMove, divergence5m: { bullish: false, bearish: false, currentRsi: 50 },
      divergence15m: { bullish: false, bearish: false, currentRsi: 50 },
      bbExtreme: detectBBExtreme(candles5m),
      confirmed1m: false, isPremium: false,
      entryPrice: 0, stopLoss: 0, takeProfit: 0, stopDistance: 0, rr: 0,
      rejectionReason: `Insufficient session move: ${sessionMove.currentMove.toFixed(0)} pips (need 220)`,
    };
  }

  // Step 2 — Dual-timeframe divergence
  const divergence5m  = detectDivergence(candles5m, 10);
  const divergence15m = detectDivergence(candles15m, 10);

  logger.debug({ divergence5m, divergence15m }, "Reversal: divergence detection");

  // Moderate unlock: allow either 5m OR 15m divergence (not both required)
  const buyReversal  = divergence5m.bullish  || divergence15m.bullish;
  const sellReversal = divergence5m.bearish  || divergence15m.bearish;

  if (!buyReversal && !sellReversal) {
    const bbExtreme = detectBBExtreme(candles5m);
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m: false, isPremium: false,
      entryPrice: 0, stopLoss: 0, takeProfit: 0, stopDistance: 0, rr: 0,
      rejectionReason: "No divergence signal (neither 5m nor 15m)",
    };
  }

  const direction: "BUY" | "SELL" = buyReversal ? "BUY" : "SELL";

  // Step 3 — BB extreme
  const bbExtreme = detectBBExtreme(candles5m);

  // Must have at least standard BB breach
  const hasBreachedBB = direction === "BUY" ? bbExtreme.belowLower : bbExtreme.aboveUpper;
  if (!hasBreachedBB) {
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m: false, isPremium: false,
      entryPrice: 0, stopLoss: 0, takeProfit: 0, stopDistance: 0, rr: 0,
      rejectionReason: "Price not beyond Bollinger Band",
    };
  }

  // Step 4 — 1m confirmation
  const confirmed1m = check1mConfirmation(candles1m, direction);

  if (!confirmed1m) {
    const c1 = scoreSessionExhaustion(sessionMove, direction);
    const c2 = scoreDivergenceStrength(divergence5m, divergence15m, direction);
    const c3 = scoreBBBreach(bbExtreme, direction);
    return {
      total: c1 + c2 + c3, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m: false, isPremium: false,
      entryPrice: 0, stopLoss: 0, takeProfit: 0, stopDistance: 0, rr: 0,
      rejectionReason: "1m confirmation candle not satisfied",
    };
  }

  // Step 5 — Score
  const c1 = scoreSessionExhaustion(sessionMove, direction);
  const c2 = scoreDivergenceStrength(divergence5m, divergence15m, direction);
  const c3 = scoreBBBreach(bbExtreme, direction);
  const total = c1 + c2 + c3;

  const isPremium = direction === "BUY" ? bbExtreme.premiumBuy : bbExtreme.premiumSell;

  logger.debug({ c1, c2, c3, total, threshold, direction, isPremium }, "Reversal: score computed");

  if (total < threshold) {
    return {
      total, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m, isPremium,
      entryPrice: 0, stopLoss: 0, takeProfit: 0, stopDistance: 0, rr: 0,
      rejectionReason: `Score ${total} < threshold ${threshold}`,
    };
  }

  // Step 6 — Entry / SL / TP
  const isBuy = direction === "BUY";
  const last1m = candles1m[candles1m.length - 1]!;
  const entryPrice = last1m.close;
  const last3x5m = candles5m.slice(-3);
  const rawStop = isBuy
    ? Math.min(...last3x5m.map(c => c.low)) - 5
    : Math.max(...last3x5m.map(c => c.high)) + 5;
  const stopDistance = Math.abs(entryPrice - rawStop);

  // Validate stop distance
  if (stopDistance > 80) {
    return {
      total, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m, isPremium,
      entryPrice, stopLoss: rawStop, takeProfit: 0, stopDistance, rr: 0,
      rejectionReason: `Reversal stop too wide: ${stopDistance.toFixed(0)} pips (max 80)`,
    };
  }
  if (stopDistance < 20) {
    return {
      total, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m, isPremium,
      entryPrice, stopLoss: rawStop, takeProfit: 0, stopDistance, rr: 0,
      rejectionReason: `Stop too tight: ${stopDistance.toFixed(0)} pips (min 20)`,
    };
  }

  const takeProfit = bbExtreme.middle;
  const tpDistance = Math.abs(takeProfit - entryPrice);

  if (tpDistance < 30) {
    return {
      total, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m, isPremium,
      entryPrice, stopLoss: rawStop, takeProfit, stopDistance, rr: 0,
      rejectionReason: `Target too close: ${tpDistance.toFixed(0)} pips to middle BB (min 30)`,
    };
  }

  const rr = tpDistance / stopDistance;
  if (rr < 1.5) {
    return {
      total, c1, c2, c3,
      direction: "NONE",
      sessionMove, divergence5m, divergence15m, bbExtreme,
      confirmed1m, isPremium,
      entryPrice, stopLoss: rawStop, takeProfit, stopDistance, rr,
      rejectionReason: `R:R ${rr.toFixed(2)} below 1.5 minimum`,
    };
  }

  return {
    total, c1, c2, c3,
    direction,
    sessionMove, divergence5m, divergence15m, bbExtreme,
    confirmed1m, isPremium,
    entryPrice, stopLoss: rawStop, takeProfit, stopDistance, rr,
    rejectionReason: null,
  };
}
