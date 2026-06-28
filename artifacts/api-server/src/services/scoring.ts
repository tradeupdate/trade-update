import type { Candle } from "./deriv.js";

export interface ScoreResult {
  total: number;        // 0-25 (c1 0-10 + c2 -2..5 + c3 0-10)
  c1: number;           // 1h trend 0-10 (hard filter: must be >= 6)
  c2: number;           // 15m bonus: +0..5 if confirms, -2 if contradicts (soft, no veto)
  c3: number;           // 5m entry timing 0-10
  direction: "BUY" | "SELL" | "NONE";
  atrValue: number;     // ATR(14) on 5m for SL/TP calculation
  ready: boolean;
  // Diagnostics
  ema20_1h: number;
  ema50_1h: number;
  ema9_15m: number;
  ema21_15m: number;
  adx15m: number;
  rsi5m: number;
  ema21_5m: number;
  currentPrice: number;
}

// ── Math utilities ─────────────────────────────────────────────────────────────

function calcEMA(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  if (data.length < period) return data.map(() => NaN);
  const k = 2 / (period + 1);
  const result: number[] = [];
  for (let i = 0; i < period - 1; i++) result.push(NaN);
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i]! * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcATR(candles: Candle[], period: number): number[] {
  if (candles.length < 2) return candles.map(() => NaN);
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i]!.high - candles[i]!.low;
    const hc = Math.abs(candles[i]!.high - candles[i - 1]!.close);
    const lc = Math.abs(candles[i]!.low - candles[i - 1]!.close);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length < period) return candles.map(() => NaN);
  const result: number[] = [NaN];
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = 0; i < period - 1; i++) result.push(NaN);
  result.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    result.push(atr);
  }
  return result;
}

function calcRSI(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return closes.map(() => NaN);
  const result: number[] = [];
  for (let i = 0; i < period; i++) result.push(NaN);
  const initGains: number[] = [];
  const initLosses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    initGains.push(Math.max(0, d));
    initLosses.push(Math.max(0, -d));
  }
  let avgGain = initGains.reduce((s, v) => s + v, 0) / period;
  let avgLoss = initLosses.reduce((s, v) => s + v, 0) / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
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

// ── Component 1: 1h trend alignment (0-10) — hard filter, must be >= 6 ────────

function score1hTrend(
  candles1h: Candle[],
  direction: "BUY" | "SELL"
): { pts: number; ema20: number; ema50: number } {
  const closes = candles1h.map(c => c.close);
  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema20 = ema20Arr[ema20Arr.length - 1] ?? NaN;
  const ema50 = ema50Arr[ema50Arr.length - 1] ?? NaN;

  if (!isFinite(ema20) || !isFinite(ema50)) return { pts: 0, ema20: 0, ema50: 0 };

  const last = candles1h[candles1h.length - 1]!;
  const ema20_5ago = ema20Arr[ema20Arr.length - 6] ?? NaN;

  if (direction === "BUY") {
    if (ema20 <= ema50) return { pts: 0, ema20, ema50 };
    let pts = 6;
    if (last.close > ema20) pts += 2;
    if (isFinite(ema20_5ago) && ema20 > ema20_5ago) pts += 2;
    return { pts: Math.min(10, pts), ema20, ema50 };
  } else {
    if (ema20 >= ema50) return { pts: 0, ema20, ema50 };
    let pts = 6;
    if (last.close < ema20) pts += 2;
    if (isFinite(ema20_5ago) && ema20 < ema20_5ago) pts += 2;
    return { pts: Math.min(10, pts), ema20, ema50 };
  }
}

// ── Component 2: 15m soft bonus (−2 to +5) — no longer vetoes trades ─────────

function score15mConfirmation(
  candles15m: Candle[],
  direction: "BUY" | "SELL"
): { pts: number; ema9: number; ema21: number; adx: number } {
  const closes = candles15m.map(c => c.close);
  const ema9Arr = calcEMA(closes, 9);
  const ema21Arr = calcEMA(closes, 21);
  const ema9 = ema9Arr[ema9Arr.length - 1] ?? NaN;
  const ema21 = ema21Arr[ema21Arr.length - 1] ?? NaN;
  const adx = calcADX(candles15m, 14);

  if (!isFinite(ema9) || !isFinite(ema21)) return { pts: 0, ema9: 0, ema21: 0, adx };

  const last = candles15m[candles15m.length - 1]!;

  if (direction === "BUY") {
    if (ema9 <= ema21) return { pts: 0, ema9, ema21, adx };
    let pts = 4;
    if (adx >= 20) pts += 3;
    else if (adx >= 15) pts += 1;
    if (last.close > ema9) pts += 3;
    return { pts: Math.min(10, pts), ema9, ema21, adx };
  } else {
    if (ema9 >= ema21) return { pts: 0, ema9, ema21, adx };
    let pts = 4;
    if (adx >= 20) pts += 3;
    else if (adx >= 15) pts += 1;
    if (last.close < ema9) pts += 3;
    return { pts: Math.min(10, pts), ema9, ema21, adx };
  }
}

// ── Component 3: 5m entry timing (0-10) ──────────────────────────────────────

function score5mEntry(
  candles5m: Candle[],
  direction: "BUY" | "SELL"
): { pts: number; ema21: number; rsi: number } {
  const closes = candles5m.map(c => c.close);
  const ema21Arr = calcEMA(closes, 21);
  const rsiArr = calcRSI(closes, 14);
  const ema21 = ema21Arr[ema21Arr.length - 1] ?? NaN;
  const rsi = rsiArr[rsiArr.length - 1] ?? NaN;

  if (!isFinite(ema21) || !isFinite(rsi)) return { pts: 0, ema21: 0, rsi: 50 };

  const last = candles5m[candles5m.length - 1]!;

  if (direction === "BUY") {
    let pts = 0;
    if (last.close > ema21) pts += 4;
    if (rsi >= 50 && rsi < 70) pts += 4;
    else if (rsi >= 45) pts += 2;
    if (last.close > last.open) pts += 2;
    return { pts: Math.min(10, pts), ema21, rsi };
  } else {
    let pts = 0;
    if (last.close < ema21) pts += 4;
    if (rsi <= 50 && rsi > 30) pts += 4;
    else if (rsi <= 55) pts += 2;
    if (last.close < last.open) pts += 2;
    return { pts: Math.min(10, pts), ema21, rsi };
  }
}

// ── Main score function ────────────────────────────────────────────────────────
// Scoring: C1 (0-10, hard ≥6) + C2 (-2..+5 soft) + C3 (0-10) = 0-25
// Hard requirements: C1 >= 6 (1h trend must be aligned)
// Soft: C2 adds bonus if 15m confirms (+0-5), penalises if contradicts (-2)
// Threshold: 16/25
// Requires: ≥55 1h candles, ≥25 15m candles, ≥50 5m candles.
// Returns null when insufficient data.

export function score(
  candles1h: Candle[],
  candles15m: Candle[],
  candles5m: Candle[]
): ScoreResult | null {
  if (candles1h.length < 55 || candles15m.length < 25 || candles5m.length < 50) return null;

  const atrArr = calcATR(candles5m, 14);
  const lastAtr = atrArr[atrArr.length - 1];
  const atrValue = isFinite(lastAtr ?? NaN) && (lastAtr ?? 0) > 0
    ? lastAtr!
    : candles5m[candles5m.length - 1]!.close * 0.001;
  const currentPrice = candles5m[candles5m.length - 1]!.close;

  // 1h conditions are mutually exclusive: EMA20>EMA50 means BUY passes, SELL fails
  for (const dir of ["BUY", "SELL"] as const) {
    const t1 = score1hTrend(candles1h, dir);
    if (t1.pts === 0) continue; // 1h hard filter: EMA20/50 must be aligned (returns 6-10 or 0)

    // 15m is now a SOFT bonus only — does not veto the trade
    const t2 = score15mConfirmation(candles15m, dir);
    const c2Bonus = t2.pts > 0
      ? Math.min(5, Math.round(t2.pts / 2))   // confirms: +0 to +5
      : -2;                                     // contradicts: -2 penalty

    const t3 = score5mEntry(candles5m, dir);
    const total = t1.pts + c2Bonus + t3.pts;   // max 10 + 5 + 10 = 25

    return {
      total,
      c1: t1.pts,
      c2: c2Bonus,
      c3: t3.pts,
      direction: total >= 16 ? dir : "NONE",
      atrValue,
      ready: true,
      ema20_1h: t1.ema20,
      ema50_1h: t1.ema50,
      ema9_15m: t2.ema9,
      ema21_15m: t2.ema21,
      adx15m: t2.adx,
      rsi5m: t3.rsi,
      ema21_5m: t3.ema21,
      currentPrice,
    };
  }

  // Neither direction has an aligned 1h trend — return NONE with diagnostics
  const t1d = score1hTrend(candles1h, "BUY");
  const t2d = score15mConfirmation(candles15m, "BUY");
  const t3d = score5mEntry(candles5m, "BUY");
  return {
    total: 0,
    c1: 0,
    c2: 0,
    c3: 0,
    direction: "NONE",
    atrValue,
    ready: true,
    ema20_1h: t1d.ema20,
    ema50_1h: t1d.ema50,
    ema9_15m: t2d.ema9,
    ema21_15m: t2d.ema21,
    adx15m: t2d.adx,
    rsi5m: t3d.rsi,
    ema21_5m: t3d.ema21,
    currentPrice,
  };
}
