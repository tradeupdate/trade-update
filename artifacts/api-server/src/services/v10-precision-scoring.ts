import type { Candle } from "./deriv.js";

// ── Result types ─────────────────────────────────────────────────────────────

export interface BBResult {
  upper: number;
  middle: number;
  lower: number;
  upperMid: number;
  lowerMid: number;
  /** 1σ inner bands — used as TP targets (higher hit probability than 0σ middle) */
  inner1sigmaUpper: number; // SMA + 1σ
  inner1sigmaLower: number; // SMA - 1σ
  width: number;
}

export interface V10PrecisionSignalResult {
  signal: "BUY" | "SELL" | "NONE";
  reason: string;
  total: number;
  c1: number; // BB position 0-8
  c2: number; // RSI(7)   0-7
  c3: number; // Stoch    0-5
  bbMiddle: number;
  bbUpper: number;
  bbLower: number;
  entryPrice: number;
  stopDistance: number;
  stopLoss: number;
  takeProfit: number;
  atrValue: number;
}

// ── Math utilities ────────────────────────────────────────────────────────────

function calculateBB20(candles: Candle[]): BBResult {
  const last20 = candles.slice(-20);
  const closes = last20.map((c) => c.close);
  const sma = closes.reduce((a, b) => a + b, 0) / 20;
  const variance = closes.reduce((s, c) => s + Math.pow(c - sma, 2), 0) / 20;
  const std = Math.sqrt(variance);
  return {
    upper: sma + 2 * std,
    middle: sma,
    lower: sma - 2 * std,
    upperMid: sma + 1.5 * std,
    lowerMid: sma - 1.5 * std,
    inner1sigmaUpper: sma + std,
    inner1sigmaLower: sma - std,
    width: std > 0 ? (4 * std) / sma * 100 : 0,
  };
}

function calculateRSI7(candles: Candle[]): number {
  const period = 7;
  if (candles.length < period + 1) return 50;

  const closes = candles.map((c) => c.close);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.max(0, Math.min(100, 100 - 100 / (1 + rs)));
}

function rawStochK(slice: Candle[]): number {
  const period5 = slice.slice(-5);
  const high = Math.max(...period5.map((c) => c.high));
  const low = Math.min(...period5.map((c) => c.low));
  const close = slice[slice.length - 1]!.close;
  if (high === low) return 50;
  return ((close - low) / (high - low)) * 100;
}

interface StochResult {
  k: number;
  d: number;
  prevK: number;
  prevD: number;
}

function calculateStoch533(candles: Candle[]): StochResult {
  if (candles.length < 8) return { k: 50, d: 50, prevK: 50, prevD: 50 };

  // Current %K (3-period SMA of raw K)
  const rawKCurrent: number[] = [];
  for (let i = candles.length - 3; i < candles.length; i++) {
    rawKCurrent.push(rawStochK(candles.slice(0, i + 1)));
  }
  const k = rawKCurrent.reduce((a, b) => a + b, 0) / 3;

  // Previous %K
  const rawKPrev: number[] = [];
  for (let i = candles.length - 4; i < candles.length - 1; i++) {
    rawKPrev.push(rawStochK(candles.slice(0, i + 1)));
  }
  const prevK = rawKPrev.reduce((a, b) => a + b, 0) / 3;

  // %K two periods ago
  const rawKPrevPrev: number[] = [];
  for (let i = candles.length - 5; i < candles.length - 2; i++) {
    rawKPrevPrev.push(rawStochK(candles.slice(0, i + 1)));
  }
  const prevPrevK = rawKPrevPrev.reduce((a, b) => a + b, 0) / 3;

  // %D = 3-period SMA of %K
  const d = (k + prevK + prevPrevK) / 3;
  const prevD =
    (prevK + prevPrevK + rawStochK(candles.slice(0, candles.length - 4))) / 3;

  return { k, d, prevK, prevD };
}

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 2) {
    return (candles[candles.length - 1]?.close ?? 0) * 0.001 || 1;
  }
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

function calcEMA(data: number[], period: number): number {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = data[0]!;
  for (let i = 1; i < data.length; i++) {
    ema = data[i]! * k + ema * (1 - k);
  }
  return ema;
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

// ── Component 1: Band Position (0-8) ─────────────────────────────────────────

function scoreBandV10(
  candles1m: Candle[],
  direction: "BUY" | "SELL"
): { score: number; signal: string; bb: BBResult } {
  const bb = calculateBB20(candles1m);
  const price = candles1m[candles1m.length - 1]!.close;
  const range = bb.upper - bb.lower;
  const position = range > 0 ? (price - bb.lower) / range : 0.5;

  let score = 0;
  let signal = "NONE";

  if (direction === "BUY") {
    if (price < bb.lower) {
      score = 8;
      signal = "EXTREME_LOW";
    } else if (price <= bb.lowerMid) {
      score = 6;
      signal = "STRONG_LOW";
    } else if (position < 0.2) {
      score = 4;
      signal = "LOW_ZONE";
    } else if (position < 0.3) {
      score = 2;
      signal = "NEAR_LOW";
    }
  } else {
    if (price > bb.upper) {
      score = 8;
      signal = "EXTREME_HIGH";
    } else if (price >= bb.upperMid) {
      score = 6;
      signal = "STRONG_HIGH";
    } else if (position > 0.8) {
      score = 4;
      signal = "HIGH_ZONE";
    } else if (position > 0.7) {
      score = 2;
      signal = "NEAR_HIGH";
    }
  }

  return { score, signal, bb };
}

// ── Component 2: RSI(7) (0-7) ────────────────────────────────────────────────

function scoreRSI7V10(candles1m: Candle[], direction: "BUY" | "SELL"): number {
  const rsi = calculateRSI7(candles1m);
  const rsiPrev = calculateRSI7(candles1m.slice(0, -1));
  const slope = rsi - rsiPrev;

  let score = 0;

  if (direction === "BUY") {
    if (rsi < 15) score = 7;
    else if (rsi < 20) score = 6;
    else if (rsi < 25) score = 4;
    else if (rsi < 30) score = 3;
    else if (rsi < 35 && slope < -1) score = 2;
    if (rsi < 30 && slope > 0) score = Math.min(7, score + 1);
  } else {
    if (rsi > 85) score = 7;
    else if (rsi > 80) score = 6;
    else if (rsi > 75) score = 4;
    else if (rsi > 70) score = 3;
    else if (rsi > 65 && slope > 1) score = 2;
    if (rsi > 70 && slope < 0) score = Math.min(7, score + 1);
  }

  return score;
}

// ── Component 3: Stochastic Timing (0-5) ─────────────────────────────────────

function scoreStochV10(candles1m: Candle[], direction: "BUY" | "SELL"): number {
  const s = calculateStoch533(candles1m);
  const crossingUp = s.prevK <= s.prevD && s.k > s.d;
  const crossingDown = s.prevK >= s.prevD && s.k < s.d;

  let score = 0;

  if (direction === "BUY") {
    if (s.k < 20 && crossingUp) score = 5;
    else if (s.k < 20 && s.k > s.d) score = 4;
    else if (s.k < 25 && crossingUp) score = 3;
    else if (s.k < 30) score = 2;
    else if (crossingUp && s.k < 40) score = 1;
  } else {
    if (s.k > 80 && crossingDown) score = 5;
    else if (s.k > 80 && s.k < s.d) score = 4;
    else if (s.k > 75 && crossingDown) score = 3;
    else if (s.k > 70) score = 2;
    else if (crossingDown && s.k > 60) score = 1;
  }

  return score;
}

// ── 5m Trend Safety Veto ─────────────────────────────────────────────────────

function check5mVeto(candles5m: Candle[], direction: "BUY" | "SELL"): string | null {
  if (candles5m.length < 22) return null;

  const closes = candles5m.map((c) => c.close);
  const ema9 = calcEMA(closes.slice(-9), 9);
  const ema21 = calcEMA(closes.slice(-21), 21);
  const adx = calcADX(candles5m, 14);

  // Only veto if STRONGLY trending (ADX > 30)
  if (adx > 30) {
    const bullTrend = ema9 > ema21;
    if (direction === "BUY" && !bullTrend) {
      return `BUY vetoed: strong bear trend ADX=${adx.toFixed(0)}`;
    }
    if (direction === "SELL" && bullTrend) {
      return `SELL vetoed: strong bull trend ADX=${adx.toFixed(0)}`;
    }
  }
  return null;
}

// ── Main Signal Generator ─────────────────────────────────────────────────────

export function scoreV10Precision(
  candles1m: Candle[],
  candles5m: Candle[]
): V10PrecisionSignalResult | null {
  if (candles1m.length < 30) return null;

  const price = candles1m[candles1m.length - 1]!.close;
  const atr = calcATR(candles1m.slice(-50), 14);

  // ── Try BUY ──────────────────────────────────────────────────────────────
  // Require price strictly OUTSIDE the lower Bollinger Band (BB score = 8)
  // for genuine oversold mean-reversion entries on V10 1m. "Near-band"
  // entries (scores 2-6) generate too many marginal signals.
  const buyBand = scoreBandV10(candles1m, "BUY");
  if (buyBand.score >= 8) {
    const veto = check5mVeto(candles5m, "BUY");
    if (!veto) {
      const c2 = scoreRSI7V10(candles1m, "BUY");
      const c3 = scoreStochV10(candles1m, "BUY");
      const total = buyBand.score + c2 + c3;

      console.log(
        `V10P BUY eval: Band=${buyBand.score} RSI=${c2} Stoch=${c3} Total=${total}/20 Signal=${buyBand.signal} Price=${price.toFixed(4)}`
      );

      if (total >= 15) {
        const stopDistance = Math.max(3, Math.min(20, atr * 1.5));
        const stopLoss = price - stopDistance;
        // TP = 50% of SL distance in the mean-reversion direction.
        // Rationale: P(TP first) = SL/(SL+TP) = 1/(1+0.5) = 66.7% on V10's
        // random-walk 1m price action — within the 62-70% win rate target.
        // Negative R:R is acceptable for binary options at 87% payout since
        // EV = 0.667×0.87 - 0.333 = +24.7% per trade.
        const tpDistance = Math.round(stopDistance * 0.5 * 10000) / 10000;
        const takeProfit = price + tpDistance;

        // Validate levels — stop must be below entry, TP above
        if (stopLoss >= price) {
          console.log(`V10P BUY rejected: stop (${stopLoss.toFixed(4)}) >= entry (${price.toFixed(4)})`);
        } else {
          console.log(
            `V10P LEVELS: Direction=BUY Entry=${price.toFixed(4)} Stop=${stopLoss.toFixed(4)} (${stopDistance.toFixed(3)} pips away) TP=${takeProfit.toFixed(4)} (${tpDistance.toFixed(3)} pips away) R:R=1:${(tpDistance / stopDistance).toFixed(2)} Stop correct side: ${stopLoss < price} TP correct side: ${takeProfit > price}`
          );
          return {
            signal: "BUY",
            reason: buyBand.signal,
            total,
            c1: buyBand.score,
            c2,
            c3,
            bbMiddle: buyBand.bb.middle,
            bbUpper: buyBand.bb.upper,
            bbLower: buyBand.bb.lower,
            entryPrice: price,
            stopDistance,
            stopLoss,
            takeProfit,
            atrValue: atr,
          };
        }
      }
    } else {
      console.log(`V10P BUY vetoed: ${veto}`);
    }
  }

  // ── Try SELL ─────────────────────────────────────────────────────────────
  const sellBand = scoreBandV10(candles1m, "SELL");
  if (sellBand.score >= 8) {
    const veto = check5mVeto(candles5m, "SELL");
    if (!veto) {
      const c2 = scoreRSI7V10(candles1m, "SELL");
      const c3 = scoreStochV10(candles1m, "SELL");
      const total = sellBand.score + c2 + c3;

      console.log(
        `V10P SELL eval: Band=${sellBand.score} RSI=${c2} Stoch=${c3} Total=${total}/20 Signal=${sellBand.signal} Price=${price.toFixed(4)}`
      );

      if (total >= 15) {
        const stopDistance = Math.max(3, Math.min(20, atr * 1.5));
        const stopLoss = price + stopDistance;
        // TP = 50% of SL distance — same rationale as BUY.
        const tpDistance = Math.round(stopDistance * 0.5 * 10000) / 10000;
        const takeProfit = price - tpDistance;

        // Validate levels — stop must be above entry, TP below
        if (stopLoss <= price) {
          console.log(`V10P SELL rejected: stop (${stopLoss.toFixed(4)}) <= entry (${price.toFixed(4)})`);
        } else {
          console.log(
            `V10P LEVELS: Direction=SELL Entry=${price.toFixed(4)} Stop=${stopLoss.toFixed(4)} (${stopDistance.toFixed(3)} pips away) TP=${takeProfit.toFixed(4)} (${tpDistance.toFixed(3)} pips away) R:R=1:${(tpDistance / stopDistance).toFixed(2)} Stop correct side: ${stopLoss > price} TP correct side: ${takeProfit < price}`
          );
          return {
            signal: "SELL",
            reason: sellBand.signal,
            total,
            c1: sellBand.score,
            c2,
            c3,
            bbMiddle: sellBand.bb.middle,
            bbUpper: sellBand.bb.upper,
            bbLower: sellBand.bb.lower,
            entryPrice: price,
            stopDistance,
            stopLoss,
            takeProfit,
            atrValue: atr,
          };
        }
      }
    } else {
      console.log(`V10P SELL vetoed: ${veto}`);
    }
  }

  return {
    signal: "NONE",
    reason: "No confluence at band extreme",
    total: 0,
    c1: 0,
    c2: 0,
    c3: 0,
    bbMiddle: 0,
    bbUpper: 0,
    bbLower: 0,
    entryPrice: price,
    stopDistance: 0,
    stopLoss: 0,
    takeProfit: 0,
    atrValue: atr,
  };
}
