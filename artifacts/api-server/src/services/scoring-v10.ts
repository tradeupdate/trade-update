import type { Candle } from "./deriv.js";
import { logger } from "../lib/logger.js";

export interface V10ScoreResult {
  total: number;
  c1: number;
  c2: number;
  c3: number;
  direction: "BUY" | "SELL" | "NONE";
  atrValue: number;
  ready: boolean;
  cleanlinessScore: number;
  rangeHigh: number;
  rangeLow: number;
  midpoint: number;
  stopDistance: number;
  takeProfit: number;
  stopLoss: number;
  trendRisk: boolean;
  adx: number;
  rsi: number;
  rejectionReason: string | null;
  entryPrice: number;
  /** T1 = high-conviction BB extreme (full size). T2 = BB approach (half size). */
  tier?: "T1" | "T2";
}

interface RangeQualityResult {
  cleanlinessScore: number;
  rangeHigh: number;
  rangeLow: number;
  midpoint: number;
  tradeable: boolean;
}

interface TrendRiskResult {
  adx: number;
  trendRisk: boolean;
  safe: boolean;
}

// ── Math utilities ───────────────────────────────────────────────────────────

function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  const initGains: number[] = [];
  const initLosses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    initGains.push(Math.max(0, d));
    initLosses.push(Math.max(0, -d));
  }
  let avgGain = initGains.reduce((s, v) => s + v, 0) / period;
  let avgLoss = initLosses.reduce((s, v) => s + v, 0) / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 2) return (candles[candles.length - 1]?.close ?? 0) * 0.001 || 1;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i]!.high - candles[i]!.low;
    const hc = Math.abs(candles[i]!.high - candles[i - 1]!.close);
    const lc = Math.abs(candles[i]!.low - candles[i - 1]!.close);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length < period) return trs.reduce((s, v) => s + v, 0) / trs.length;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

function calcADX(candles: Candle[], period: number): number {
  if (candles.length < period * 2 + 1) return 0;
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close)
    );
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    trs.push(tr);
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let smoothTR = trs.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothPlus = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothMinus = minusDM.slice(0, period).reduce((s, v) => s + v, 0);
  const dxVals: number[] = [];
  const pushDX = (tr: number, p: number, m: number) => {
    const diP = tr > 0 ? (p / tr) * 100 : 0;
    const diM = tr > 0 ? (m / tr) * 100 : 0;
    const sum = diP + diM;
    dxVals.push(sum > 0 ? (Math.abs(diP - diM) / sum) * 100 : 0);
  };
  pushDX(smoothTR, smoothPlus, smoothMinus);
  for (let i = period; i < trs.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trs[i]!;
    smoothPlus = smoothPlus - smoothPlus / period + plusDM[i]!;
    smoothMinus = smoothMinus - smoothMinus / period + minusDM[i]!;
    pushDX(smoothTR, smoothPlus, smoothMinus);
  }
  if (dxVals.length < period) return 0;
  return dxVals.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function calcBB(candles: Candle[], period: number, sigma: number): { upper: number; middle: number; lower: number } {
  if (candles.length < period) {
    const c = candles[candles.length - 1]?.close ?? 0;
    return { upper: c, middle: c, lower: c };
  }
  const closes = candles.slice(-period).map((c) => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + sigma * std, middle: mean, lower: mean - sigma * std };
}

function calcStochastic(candles: Candle[], kPeriod: number, dPeriod: number): { k: number; d: number } {
  if (candles.length < kPeriod) return { k: 50, d: 50 };
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map((c) => c.high));
    const lowest = Math.min(...slice.map((c) => c.low));
    const current = candles[i]!.close;
    const k = highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }
  const lastK = kValues[kValues.length - 1] ?? 50;
  const dSlice = kValues.slice(-dPeriod);
  const d = dSlice.length > 0 ? dSlice.reduce((s, v) => s + v, 0) / dSlice.length : 50;
  return { k: lastK, d };
}

// ── Part 5: Range Cleanliness Detector ───────────────────────────────────────

export function detectRangeCleanliness(candles5m: Candle[]): RangeQualityResult {
  if (candles5m.length < 30) {
    return { cleanlinessScore: 0, rangeHigh: 0, rangeLow: 0, midpoint: 0, tradeable: false };
  }

  const last30 = candles5m.slice(-30);

  const highs = last30.map((c) => c.high);
  const lows = last30.map((c) => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const midpoint = (rangeHigh + rangeLow) / 2;

  const candlesInRange = last30.filter(
    (c) => c.high <= rangeHigh * 1.002 && c.low >= rangeLow * 0.998
  ).length;
  const rangeRespect = candlesInRange / 30;

  let totalWickSize = 0;
  let totalBodySize = 0;
  last30.forEach((c) => {
    const body = Math.abs(c.close - c.open);
    const wick = c.high - c.low - body;
    totalWickSize += wick;
    totalBodySize += body;
  });
  const wickToBodyRatio = totalWickSize / (totalBodySize || 1);

  const bb = calcBB(last30, 20, 2.0);
  const upperTouches = last30.filter((c) => c.high >= bb.upper * 0.998).length;
  const lowerTouches = last30.filter((c) => c.low <= bb.lower * 1.002).length;

  let cleanlinessScore = 0;

  if (rangeRespect >= 0.85) cleanlinessScore += 4;
  else if (rangeRespect >= 0.70) cleanlinessScore += 2;

  if (wickToBodyRatio < 1.5) cleanlinessScore += 3;
  else if (wickToBodyRatio < 2.5) cleanlinessScore += 1;

  if (upperTouches >= 1 && lowerTouches >= 1) cleanlinessScore += 3;
  else if (upperTouches >= 1 || lowerTouches >= 1) cleanlinessScore += 1;

  logger.debug(
    `V10 range cleanliness: respect=${(rangeRespect * 100).toFixed(0)}% wick/body=${wickToBodyRatio.toFixed(2)} upperTouches=${upperTouches} lowerTouches=${lowerTouches} score=${cleanlinessScore}/10`
  );

  return {
    cleanlinessScore,
    rangeHigh,
    rangeLow,
    midpoint,
    tradeable: cleanlinessScore >= 4,
  };
}

// ── Part 6: Trend Detection Safety Filter ────────────────────────────────────

export function detectV10TrendRisk(candles15m: Candle[]): TrendRiskResult {
  if (candles15m.length < 30) {
    return { adx: 0, trendRisk: false, safe: false };
  }

  const adx = calcADX(candles15m, 14);
  const last10 = candles15m.slice(-10);
  const bullish = last10.filter((c) => c.close > c.open).length;
  const bearish = 10 - bullish;
  const strongDirectional = bullish >= 9 || bearish >= 9;
  const trendRisk = adx > 38 || strongDirectional;

  logger.debug(
    `V10 trend risk: ADX=${adx.toFixed(1)} directional=${Math.max(bullish, bearish)}/10 trendRisk=${trendRisk}`
  );

  return {
    adx,
    trendRisk,
    safe: adx < 20 && !strongDirectional,
  };
}

// ── Part 7 C2: BB Extreme + RSI + Stochastic Confluence (0-10) ───────────────

function scoreV10Entry(candles5m: Candle[], direction: "BUY" | "SELL"): number {
  const bb = calcBB(candles5m, 20, 2.0);
  const rsi = calcRSI(candles5m.map((c) => c.close), 14);
  const currentPrice = candles5m[candles5m.length - 1]!.close;
  const stoch = calcStochastic(candles5m, 5, 3);

  let score = 0;

  if (direction === "BUY") {
    const belowLowerBand = currentPrice < bb.lower;
    const atLowerBand = currentPrice <= bb.lower * 1.001;
    if (belowLowerBand) score += 4;
    else if (atLowerBand) score += 3;

    if (rsi < 25) score += 3;
    else if (rsi < 30) score += 2;
    else if (rsi < 35) score += 1;

    if (stoch.k < 20 && stoch.k > stoch.d) score += 3;
    else if (stoch.k < 25) score += 1;
  } else {
    const aboveUpperBand = currentPrice > bb.upper;
    const atUpperBand = currentPrice >= bb.upper * 0.999;
    if (aboveUpperBand) score += 4;
    else if (atUpperBand) score += 3;

    if (rsi > 75) score += 3;
    else if (rsi > 70) score += 2;
    else if (rsi > 65) score += 1;

    if (stoch.k > 80 && stoch.k < stoch.d) score += 3;
    else if (stoch.k > 75) score += 1;
  }

  return Math.min(score, 10);
}

// ── Part 7 C3: Rejection Confirmation (0-5) ───────────────────────────────────

function scoreRejection(candles1m: Candle[], direction: "BUY" | "SELL"): number {
  if (!candles1m.length) return 0;
  const last = candles1m[candles1m.length - 1]!;
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (direction === "BUY") {
    const lowerWick = last.open < last.close ? last.open - last.low : last.close - last.low;
    const wickRatio = lowerWick / (range || 1);
    if (wickRatio > 0.6 && last.close > last.open) return 5;
    if (wickRatio > 0.4) return 3;
    if (last.close > last.open) return 2;
    return 0;
  }

  const upperWick = last.close < last.open ? last.open - last.high : last.close - last.high;
  const wickRatio = Math.abs(upperWick) / (range || 1);
  if (wickRatio > 0.6 && last.close < last.open) return 5;
  if (wickRatio > 0.4) return 3;
  if (last.close < last.open) return 2;
  return 0;
}

// ── Part 8: Signal Generation ────────────────────────────────────────────────

export function scoreV10(
  candles1m: Candle[],
  candles5m: Candle[],
  candles15m: Candle[]
): V10ScoreResult | null {
  if (candles5m.length < 30 || candles15m.length < 30 || candles1m.length < 1) return null;

  const currentPrice = candles5m[candles5m.length - 1]!.close;
  const atrValue = calcATR(candles5m, 14);

  // Step 1: Trend risk check
  const trendCheck = detectV10TrendRisk(candles15m);
  if (trendCheck.trendRisk) {
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE", atrValue, ready: true,
      cleanlinessScore: 0, rangeHigh: 0, rangeLow: 0, midpoint: 0,
      stopDistance: 0, takeProfit: 0, stopLoss: 0,
      trendRisk: true, adx: trendCheck.adx, rsi: 50,
      rejectionReason: `V10 trending — mean reversion paused (ADX ${trendCheck.adx.toFixed(1)})`,
      entryPrice: currentPrice,
    };
  }

  // Step 2: Range cleanliness
  const rangeQuality = detectRangeCleanliness(candles5m);
  if (!rangeQuality.tradeable) {
    return {
      total: 0, c1: rangeQuality.cleanlinessScore, c2: 0, c3: 0,
      direction: "NONE", atrValue, ready: true,
      cleanlinessScore: rangeQuality.cleanlinessScore,
      rangeHigh: rangeQuality.rangeHigh, rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
      stopDistance: 0, takeProfit: 0, stopLoss: 0,
      trendRisk: false, adx: trendCheck.adx, rsi: 50,
      rejectionReason: `Range too noisy — cleanliness ${rangeQuality.cleanlinessScore}/10, need 4+`,
      entryPrice: currentPrice,
    };
  }

  const c1 = rangeQuality.cleanlinessScore;
  const rsi = calcRSI(candles5m.map((c) => c.close), 14);
  const bb = calcBB(candles5m, 20, 2.0);

  // ── Tier 1: BB extreme entries (full position size) ──────────────────────

  // Step 3: Try T1 BUY
  const buyC2 = scoreV10Entry(candles5m, "BUY");
  if (buyC2 >= 3) {
    const buyC3 = scoreRejection(candles1m, "BUY");
    const buyTotal = c1 + buyC2 + buyC3;
    if (buyTotal >= 8) {
      const stopDist = Math.max(15, Math.min(50, atrValue * 0.8));
      const sl = currentPrice - stopDist;
      const tp = bb.middle;
      const tpDist = Math.abs(tp - currentPrice);
      const rr = tpDist / stopDist;
      if (tpDist >= 5 && rr >= 0.8) {
        logger.info(`V10 [T1] BUY: score=${buyTotal}/25 c1=${c1} c2=${buyC2} c3=${buyC3} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)} tp=${tp.toFixed(4)} RR=${rr.toFixed(2)}`);
        return {
          total: buyTotal, c1, c2: buyC2, c3: buyC3,
          direction: "BUY", atrValue, ready: true,
          cleanlinessScore: c1, rangeHigh: rangeQuality.rangeHigh,
          rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
          stopDistance: stopDist, takeProfit: tp, stopLoss: sl,
          trendRisk: false, adx: trendCheck.adx, rsi,
          rejectionReason: null, entryPrice: currentPrice, tier: "T1",
        };
      }
    }
  }

  // Step 4: Try T1 SELL
  const sellC2 = scoreV10Entry(candles5m, "SELL");
  if (sellC2 >= 3) {
    const sellC3 = scoreRejection(candles1m, "SELL");
    const sellTotal = c1 + sellC2 + sellC3;
    if (sellTotal >= 8) {
      const stopDist = Math.max(15, Math.min(50, atrValue * 0.8));
      const sl = currentPrice + stopDist;
      const tp = bb.middle;
      const tpDist = Math.abs(currentPrice - tp);
      const rr = tpDist / stopDist;
      if (tpDist >= 5 && rr >= 0.8) {
        logger.info(`V10 [T1] SELL: score=${sellTotal}/25 c1=${c1} c2=${sellC2} c3=${sellC3} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)} tp=${tp.toFixed(4)} RR=${rr.toFixed(2)}`);
        return {
          total: sellTotal, c1, c2: sellC2, c3: sellC3,
          direction: "SELL", atrValue, ready: true,
          cleanlinessScore: c1, rangeHigh: rangeQuality.rangeHigh,
          rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
          stopDistance: stopDist, takeProfit: tp, stopLoss: sl,
          trendRisk: false, adx: trendCheck.adx, rsi,
          rejectionReason: null, entryPrice: currentPrice, tier: "T1",
        };
      }
    }
  }

  // ── Tier 2: Near-miss T1 entries (half position size) ────────────────────
  // Same BB scoring as T1 but lower conviction bar (buyC2 >= 2, total >= 6).
  // These are "almost T1" setups — price is at/near the band but hasn't fully
  // confirmed. Win rate estimated 55–62%, break-even on V10 binary is 53.5%.

  // At this point buyC2 + sellC2 are already computed from the T1 checks above.
  // Compute C3 only if needed (when C2 >= 2 for that direction).

  const hasT2BuyDir  = buyC2 >= 2 && buyC2 >= sellC2;
  const hasT2SellDir = sellC2 >= 2 && sellC2 > buyC2;

  if (hasT2BuyDir) {
    const buyC3t2 = scoreRejection(candles1m, "BUY");
    const t2Total = c1 + buyC2 + buyC3t2;
    if (t2Total >= 6) {
      const stopDist = Math.max(18, Math.min(55, atrValue * 0.9));
      const sl = currentPrice - stopDist;
      const tp = bb.middle;
      const tpDist = Math.abs(tp - currentPrice);
      const rr = tpDist / stopDist;
      if (tpDist >= 5 && rr >= 0.6) {
        logger.info(`V10 [T2] BUY: score=${t2Total}/25 c1=${c1} c2=${buyC2} c3=${buyC3t2} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)} tp=${tp.toFixed(4)} RR=${rr.toFixed(2)}`);
        return {
          total: t2Total, c1, c2: buyC2, c3: buyC3t2,
          direction: "BUY", atrValue, ready: true,
          cleanlinessScore: c1, rangeHigh: rangeQuality.rangeHigh,
          rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
          stopDistance: stopDist, takeProfit: tp, stopLoss: sl,
          trendRisk: false, adx: trendCheck.adx, rsi,
          rejectionReason: null, entryPrice: currentPrice, tier: "T2",
        };
      }
    }
  }

  if (hasT2SellDir) {
    const sellC3t2 = scoreRejection(candles1m, "SELL");
    const t2Total = c1 + sellC2 + sellC3t2;
    if (t2Total >= 6) {
      const stopDist = Math.max(18, Math.min(55, atrValue * 0.9));
      const sl = currentPrice + stopDist;
      const tp = bb.middle;
      const tpDist = Math.abs(currentPrice - tp);
      const rr = tpDist / stopDist;
      if (tpDist >= 5 && rr >= 0.6) {
        logger.info(`V10 [T2] SELL: score=${t2Total}/25 c1=${c1} c2=${sellC2} c3=${sellC3t2} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)} tp=${tp.toFixed(4)} RR=${rr.toFixed(2)}`);
        return {
          total: t2Total, c1, c2: sellC2, c3: sellC3t2,
          direction: "SELL", atrValue, ready: true,
          cleanlinessScore: c1, rangeHigh: rangeQuality.rangeHigh,
          rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
          stopDistance: stopDist, takeProfit: tp, stopLoss: sl,
          trendRisk: false, adx: trendCheck.adx, rsi,
          rejectionReason: null, entryPrice: currentPrice, tier: "T2",
        };
      }
    }
  }

  // No qualifying setup in either tier
  const bestC2 = Math.max(buyC2, sellC2);
  const bestC3 = scoreRejection(candles1m, buyC2 >= sellC2 ? "BUY" : "SELL");
  const bestTotal = c1 + bestC2 + bestC3;
  return {
    total: bestTotal, c1, c2: bestC2, c3: bestC3,
    direction: "NONE", atrValue, ready: true,
    cleanlinessScore: c1, rangeHigh: rangeQuality.rangeHigh,
    rangeLow: rangeQuality.rangeLow, midpoint: rangeQuality.midpoint,
    stopDistance: 0, takeProfit: 0, stopLoss: 0,
    trendRisk: false, adx: trendCheck.adx, rsi,
    rejectionReason: `No qualifying setup — best C2: ${Math.max(buyC2, sellC2)}/10`,
    entryPrice: currentPrice,
  };
}
