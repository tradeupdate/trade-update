import type { Candle } from "./deriv.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConsolidationRange {
  high: number;
  low: number;
  midpoint: number;
  size: number;
  duration: number;
  confirmed: boolean;
}

export interface BreakoutResult {
  direction: "BUY" | "SELL";
  breakoutPrice: number;
  retestLevel: number;
  stopLevel: number;
  breakoutCandle: { open: number; high: number; low: number; close: number; time: number };
}

export interface RetestResult {
  atLevel: boolean;
  rejected: boolean;
  distancePct: number;
  readyToEnter: boolean;
}

export interface SwingScoreResult {
  total: number;
  c1: number;     // 4h trend 0-10
  c2: number;     // 1h momentum 0-10
  c3: number;     // breakout quality 0-5
  direction: "BUY" | "SELL" | "NONE";
  ema20_4h: number;
  ema50_4h: number;
  ema9_1h: number;
  ema21_1h: number;
  rsi1h: number;
  adx1h: number;
  consolidation: ConsolidationRange | null;
  breakout: BreakoutResult | null;
  retest: RetestResult | null;
  atrValue: number;
  currentPrice: number;
  ready: boolean;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  if (data.length < period) return data.map(() => NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(NaN);
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function lastEMA(data: number[], period: number): number {
  if (data.length < period) return NaN;
  const arr = calcEMA(data, period);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isFinite(arr[i])) return arr[i];
  }
  return NaN;
}

function emaAtOffset(data: number[], period: number, offset: number): number {
  const slice = data.slice(0, data.length - offset);
  return lastEMA(slice, period);
}

function calcRSI(candles: Candle[], period = 14): number {
  const closes = candles.map(c => c.close);
  if (closes.length < period + 1) return 50;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const avgGain = gains.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgLoss = losses.slice(-period).reduce((s, v) => s + v, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const upMove = c.high - p.high, downMove = p.low - c.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const avgTR = trs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgPlusDM = plusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgMinusDM = minusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;
  if (avgTR === 0) return 0;
  const plusDI = (avgPlusDM / avgTR) * 100;
  const minusDI = (avgMinusDM / avgTR) * 100;
  const dxSum = plusDI + minusDI;
  if (dxSum === 0) return 0;
  return (Math.abs(plusDI - minusDI) / dxSum) * 100;
}

export function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 100;
  const slice = candles.slice(-(period + 1));
  let total = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return total / period;
}

// ── 4H Candle Builder ─────────────────────────────────────────────────────────

export function build4hCandles(candles1h: Candle[]): Candle[] {
  const grouped: Record<number, Candle[]> = {};
  for (const c of candles1h) {
    const boundary = Math.floor(c.time / 14400) * 14400;
    if (!grouped[boundary]) grouped[boundary] = [];
    grouped[boundary].push(c);
  }
  return Object.entries(grouped)
    .filter(([, g]) => g.length > 0)
    .map(([boundary, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time);
      return {
        time: parseInt(boundary),
        open: sorted[0].open,
        high: Math.max(...sorted.map(c => c.high)),
        low: Math.min(...sorted.map(c => c.low)),
        close: sorted[sorted.length - 1].close,
        volume: sorted.reduce((s, c) => s + (c.volume ?? 0), 0),
      };
    })
    .sort((a, b) => a.time - b.time);
}

// ── Consolidation Detector ────────────────────────────────────────────────────

export function detectConsolidationRange(candles1h: Candle[]): ConsolidationRange | null {
  const last20 = candles1h.slice(-20);
  if (last20.length < 20) return null;

  const highs = last20.map(c => c.high);
  const lows = last20.map(c => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeSize = rangeHigh - rangeLow;
  const midpoint = (rangeHigh + rangeLow) / 2;
  const rangePct = (rangeSize / midpoint) * 100;

  const candlesInRange = last20.filter(
    c => c.high <= rangeHigh * 1.001 && c.low >= rangeLow * 0.999
  ).length;

  const isConsolidating = rangePct < 2.5 && candlesInRange >= 8;
  if (!isConsolidating) return null;

  return {
    high: rangeHigh,
    low: rangeLow,
    midpoint,
    size: rangeSize,
    duration: last20.length,
    confirmed: true,
  };
}

// ── Breakout Detector ─────────────────────────────────────────────────────────

export function detectBreakout(candles1h: Candle[], range: ConsolidationRange): BreakoutResult | null {
  if (candles1h.length < 2) return null;
  const lastCandle = candles1h[candles1h.length - 1];
  const prevCandle = candles1h[candles1h.length - 2];

  const bullBreakout =
    lastCandle.close > range.high &&
    lastCandle.close > prevCandle.close &&
    (lastCandle.high - lastCandle.low) > range.size * 0.15;

  const bearBreakout =
    lastCandle.close < range.low &&
    lastCandle.close < prevCandle.close &&
    (lastCandle.high - lastCandle.low) > range.size * 0.15;

  if (bullBreakout) {
    return {
      direction: "BUY",
      breakoutPrice: lastCandle.close,
      retestLevel: range.high,
      stopLevel: range.low,
      breakoutCandle: lastCandle,
    };
  }
  if (bearBreakout) {
    return {
      direction: "SELL",
      breakoutPrice: lastCandle.close,
      retestLevel: range.low,
      stopLevel: range.high,
      breakoutCandle: lastCandle,
    };
  }
  return null;
}

// ── Retest Detector ───────────────────────────────────────────────────────────

export function detectRetest(currentPrice: number, breakout: BreakoutResult, candles15m: Candle[]): RetestResult {
  const retestLevel = breakout.retestLevel;
  const direction = breakout.direction;
  const distanceFromLevel = Math.abs(currentPrice - retestLevel);
  const distancePct = (distanceFromLevel / retestLevel) * 100;
  const atRetestLevel = distancePct < 0.3;

  let rejectionConfirmed = false;
  if (atRetestLevel && candles15m.length >= 1) {
    const lastCandle = candles15m[candles15m.length - 1];
    if (direction === "BUY") {
      rejectionConfirmed =
        lastCandle.low <= retestLevel * 1.001 &&
        lastCandle.close > retestLevel &&
        lastCandle.close > lastCandle.open;
    } else {
      rejectionConfirmed =
        lastCandle.high >= retestLevel * 0.999 &&
        lastCandle.close < retestLevel &&
        lastCandle.close < lastCandle.open;
    }
  }

  return {
    atLevel: atRetestLevel,
    rejected: rejectionConfirmed,
    distancePct,
    readyToEnter: atRetestLevel && rejectionConfirmed,
  };
}

// ── 4H Trend Scoring (0-10) ───────────────────────────────────────────────────

export function score4hTrendBT(candles4h: Candle[], direction: "BUY" | "SELL"): { pts: number; ema20: number; ema50: number } {
  const closes = candles4h.map(c => c.close);
  if (closes.length < 50) return { pts: 0, ema20: 0, ema50: 0 };

  const ema20 = lastEMA(closes, 20);
  const ema50 = lastEMA(closes, 50);
  const currentPrice = closes[closes.length - 1];
  const ema20_3ago = emaAtOffset(closes, 20, 3);
  const ema20Slope = isFinite(ema20_3ago) ? ema20 - ema20_3ago : 0;

  if (!isFinite(ema20) || !isFinite(ema50)) return { pts: 0, ema20: 0, ema50: 0 };

  let pts = 0;
  if (direction === "BUY") {
    if (ema20 > ema50 && currentPrice > ema20 && ema20Slope > 0) pts = 10;
    else if (ema20 > ema50 && currentPrice > ema50) pts = 7;
    else if (ema20 > ema50) pts = 4;
    else pts = 0;
  } else {
    if (ema20 < ema50 && currentPrice < ema20 && ema20Slope < 0) pts = 10;
    else if (ema20 < ema50 && currentPrice < ema50) pts = 7;
    else if (ema20 < ema50) pts = 4;
    else pts = 0;
  }

  return { pts, ema20, ema50 };
}

// ── 1H Momentum Scoring (0-10) ────────────────────────────────────────────────

export function score1hMomentumBT(candles1h: Candle[], direction: "BUY" | "SELL"): { pts: number; ema9: number; ema21: number; rsi: number; adx: number } {
  const closes = candles1h.map(c => c.close);
  if (closes.length < 21) return { pts: 0, ema9: 0, ema21: 0, rsi: 50, adx: 0 };

  const ema9 = lastEMA(closes, 9);
  const ema21 = lastEMA(closes, 21);
  const rsi = calcRSI(candles1h, 14);
  const adx = calcADX(candles1h, 14);

  let pts = 0;
  if (direction === "BUY") {
    const trendAligned = ema9 > ema21;
    const momentumHealthy = rsi > 40 && rsi < 65;
    const trendStrong = adx > 20;
    if (trendAligned && momentumHealthy && trendStrong) pts = 10;
    else if (trendAligned && trendStrong) pts = 7;
    else if (trendAligned) pts = 4;
    else pts = 0;
  } else {
    const trendAligned = ema9 < ema21;
    const momentumHealthy = rsi > 35 && rsi < 60;
    const trendStrong = adx > 20;
    if (trendAligned && momentumHealthy && trendStrong) pts = 10;
    else if (trendAligned && trendStrong) pts = 7;
    else if (trendAligned) pts = 4;
    else pts = 0;
  }

  return { pts, ema9, ema21, rsi, adx };
}

// ── Breakout Quality Scoring (0-5) ────────────────────────────────────────────

export function scoreBreakoutQualityBT(breakout: BreakoutResult, range: ConsolidationRange): number {
  const c = breakout.breakoutCandle;
  const candleBody = Math.abs(c.close - c.open);
  const candleRange = c.high - c.low;
  if (candleRange === 0) return 1;
  const bodyRatio = candleBody / candleRange;

  if (bodyRatio > 0.7 && candleRange > range.size * 0.5) return 5;
  if (bodyRatio > 0.5) return 3;
  if (bodyRatio > 0.3) return 2;
  return 1;
}

// ── Main Swing Score ──────────────────────────────────────────────────────────

export function scoreSwing(
  candles4h: Candle[],
  candles1h: Candle[],
  candles15m: Candle[],
  consolidation: ConsolidationRange | null,
  breakout: BreakoutResult | null,
  currentPrice: number,
  threshold = 20
): SwingScoreResult | null {
  if (candles4h.length < 10) return null;
  if (candles1h.length < 55) return null;

  const atr = calcATR(candles1h, 14);

  const closes4h = candles4h.map(c => c.close);
  const ema20_4h = lastEMA(closes4h, 20) || 0;
  const ema50_4h = lastEMA(closes4h, 50) || 0;
  const closes1h = candles1h.map(c => c.close);
  const ema9_1h = lastEMA(closes1h, 9) || 0;
  const ema21_1h = lastEMA(closes1h, 21) || 0;
  const rsi1h = calcRSI(candles1h, 14);
  const adx1h = calcADX(candles1h, 14);

  if (!consolidation || !breakout) {
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE",
      ema20_4h, ema50_4h, ema9_1h, ema21_1h, rsi1h, adx1h,
      consolidation, breakout, retest: null,
      atrValue: atr, currentPrice, ready: false,
    };
  }

  const dir = breakout.direction;

  const t1 = score4hTrendBT(candles4h, dir);
  if (t1.pts === 0) {
    return {
      total: 0, c1: 0, c2: 0, c3: 0,
      direction: "NONE",
      ema20_4h: t1.ema20, ema50_4h: t1.ema50,
      ema9_1h, ema21_1h, rsi1h, adx1h,
      consolidation, breakout, retest: null,
      atrValue: atr, currentPrice, ready: false,
    };
  }

  const t2 = score1hMomentumBT(candles1h, dir);
  const c3 = scoreBreakoutQualityBT(breakout, consolidation);
  const total = t1.pts + t2.pts + c3;

  const retest = detectRetest(currentPrice, breakout, candles15m);
  const ready = total >= threshold && retest.readyToEnter;

  return {
    total,
    c1: t1.pts,
    c2: t2.pts,
    c3,
    direction: ready ? dir : "NONE",
    ema20_4h: t1.ema20,
    ema50_4h: t1.ema50,
    ema9_1h: t2.ema9,
    ema21_1h: t2.ema21,
    rsi1h: t2.rsi,
    adx1h: t2.adx,
    consolidation,
    breakout,
    retest,
    atrValue: atr,
    currentPrice,
    ready,
  };
}
