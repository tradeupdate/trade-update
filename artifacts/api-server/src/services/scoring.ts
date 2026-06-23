import type { Candle } from "./deriv.js";

export interface ScoreResult {
  total: number;
  trend: number;
  volatility: number;
  timing: number;
  pullback: number;
  risk: number;
  direction: "BUY" | "SELL" | "NONE";
  trendDirection: "BULL" | "BEAR" | "NEUTRAL";
  bandTouched: "UPPER" | "LOWER" | "NONE";
  ema9: number;
  ema21: number;
  ema50: number;
  adx: number;
  rsi: number;
  stochK: number;
  macdHistogram: number;
  bbUpper: number;
  bbLower: number;
  bbWidth: number;
  atrValue: number;
  rangeContext: "top" | "middle" | "bottom";
  consolidationDetected: boolean;
  spikeDetected: boolean;
  smcBos: boolean;
  smcChoch: boolean;
  orderBlockNearby: boolean;
  fvgNearby: boolean;
  pullbackZoneActive: boolean;
  ready: boolean;
}

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...new Array(period - 1).fill(NaN), prev);
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function rsi(closes: number[], period = 14): number[] {
  const result: number[] = new Array(period).fill(NaN);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function atr(candles: Candle[], period = 14): number[] {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
  const result: number[] = new Array(period - 1).fill(NaN);
  let avg = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(avg);
  for (let i = period; i < tr.length; i++) {
    avg = (avg * (period - 1) + tr[i]) / period;
    result.push(avg);
  }
  return result;
}

function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2) return 0;
  const last = candles.slice(-period * 2);
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i < last.length; i++) {
    const upMove = last[i].high - last[i - 1].high;
    const downMove = last[i - 1].low - last[i].low;
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
    trSum += Math.max(last[i].high - last[i].low, Math.abs(last[i].high - last[i - 1].close), Math.abs(last[i].low - last[i - 1].close));
  }
  if (trSum === 0) return 0;
  const plusDI = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  const dx = plusDI + minusDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  return dx;
}

function bollingerBands(closes: number[], period = 20, sigma = 2) {
  const result = closes.map((_, i) => {
    if (i < period - 1) return { upper: NaN, lower: NaN, mid: NaN, width: NaN };
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    const upper = mean + sigma * std;
    const lower = mean - sigma * std;
    return { upper, lower, mid: mean, width: (upper - lower) / mean };
  });
  return result;
}

function stochastic(candles: Candle[], k = 5, d = 3): { k: number; d: number }[] {
  const result: { k: number; d: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < k - 1) { result.push({ k: NaN, d: NaN }); continue; }
    const slice = candles.slice(i - k + 1, i + 1);
    const highest = Math.max(...slice.map((c) => c.high));
    const lowest = Math.min(...slice.map((c) => c.low));
    const kVal = highest === lowest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100;
    const dSlice = result.slice(-d + 1).map((r) => r.k).filter((v) => !isNaN(v));
    dSlice.push(kVal);
    result.push({ k: kVal, d: dSlice.length ? dSlice.reduce((a, b) => a + b, 0) / dSlice.length : kVal });
  }
  return result;
}

function macd(closes: number[]): { histogram: number }[] {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = closes.map((_, i) => (isNaN(fast[i]) || isNaN(slow[i])) ? NaN : fast[i] - slow[i]);
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalFull = ema(validMacd, 9);
  const histogram: number[] = [];
  let sigIdx = 0;
  macdLine.forEach((m) => {
    if (isNaN(m)) { histogram.push(NaN); return; }
    const s = signalFull[sigIdx++] ?? NaN;
    histogram.push(isNaN(s) ? NaN : m - s);
  });
  return histogram.map((h) => ({ histogram: h }));
}

export function score(
  candles1m: Candle[],
  candles5m: Candle[],
  candles15m: Candle[],
  dailyPnl: number,
  peakBalance: number,
  currentBalance: number,
  consecutiveLosses: number
): ScoreResult | null {
  if (candles15m.length < 50 || candles5m.length < 30 || candles1m.length < 20) return null;

  const closes15m = candles15m.map((c) => c.close);
  const closes5m = candles5m.map((c) => c.close);
  const closes1m = candles1m.map((c) => c.close);

  // Layer 1 — Trend (15m)
  const ema9_15 = ema(closes15m, 9);
  const ema21_15 = ema(closes15m, 21);
  const ema50_15 = ema(closes15m, 50);
  const lastEma9 = ema9_15[ema9_15.length - 1];
  const lastEma21 = ema21_15[ema21_15.length - 1];
  const lastEma50 = ema50_15[ema50_15.length - 1];
  const adxVal = adx(candles15m);
  let trendScore = 0;
  let trendDirection: "BULL" | "BEAR" | "NEUTRAL" = "NEUTRAL";

  if (lastEma9 > lastEma21 && lastEma21 > lastEma50 && adxVal > 30) { trendScore = 10; trendDirection = "BULL"; }
  else if (lastEma9 < lastEma21 && lastEma21 < lastEma50 && adxVal > 30) { trendScore = 10; trendDirection = "BEAR"; }
  else if (lastEma9 > lastEma21 && adxVal >= 25) { trendScore = 8; trendDirection = "BULL"; }
  else if (lastEma9 < lastEma21 && adxVal >= 25) { trendScore = 8; trendDirection = "BEAR"; }
  else if (lastEma9 > lastEma21 && adxVal >= 20) { trendScore = 6; trendDirection = "BULL"; }
  else if (lastEma9 < lastEma21 && adxVal >= 20) { trendScore = 6; trendDirection = "BEAR"; }
  else if (adxVal < 20) { trendScore = 0; trendDirection = "NEUTRAL"; }
  else { trendScore = 3; }

  // SMC bonus (up to +2)
  let smcBonus = 0;
  const smcBos = false;
  const smcChoch = false;
  const orderBlockNearby = false;
  const fvgNearby = false;
  // Simplified: check if structure aligns
  if (trendDirection !== "NEUTRAL") smcBonus = 1;
  trendScore = Math.min(12, trendScore + smcBonus);

  // Layer 3 — Volatility (5m)
  const bb5m = bollingerBands(closes5m, 20, 2);
  const atr5m = atr(candles5m, 14);
  const lastBb = bb5m[bb5m.length - 1];
  const prevBb = bb5m[Math.max(0, bb5m.length - 11)];
  const lastAtr = atr5m[atr5m.length - 1];
  const prevAtr = atr5m[atr5m.length - 2] || lastAtr;
  const currentPrice = closes5m[closes5m.length - 1];
  let volatilityScore = 5;
  let bandTouched: "UPPER" | "LOWER" | "NONE" = "NONE";

  if (!isNaN(lastBb.width) && !isNaN(prevBb.width) && prevBb.width > 0) {
    const widthChange = (lastBb.width - prevBb.width) / prevBb.width;
    const nearUpper = Math.abs(currentPrice - lastBb.upper) / (lastBb.upper - lastBb.lower) < 0.15;
    const nearLower = Math.abs(currentPrice - lastBb.lower) / (lastBb.upper - lastBb.lower) < 0.15;

    if (nearUpper) bandTouched = "UPPER";
    if (nearLower) bandTouched = "LOWER";

    if (widthChange > 0.08 && (nearUpper || nearLower) && lastAtr > prevAtr) volatilityScore = 10;
    else if (widthChange > 0.04 && (nearUpper || nearLower)) volatilityScore = 8;
    else if (widthChange < 0) volatilityScore = 2;
    else if (Math.abs(widthChange) < 0.01) volatilityScore = 0;
  }

  // Layer 4 — Entry Timing (5m)
  const rsi5m = rsi(closes5m, 14);
  const stoch5m = stochastic(candles5m, 5, 3);
  const macd5m = macd(closes5m);
  const lastRsi = rsi5m[rsi5m.length - 1] || 50;
  const lastStoch = stoch5m[stoch5m.length - 1] || { k: 50, d: 50 };
  const prevStoch = stoch5m[stoch5m.length - 2] || { k: 50, d: 50 };
  const lastMacd = macd5m[macd5m.length - 1]?.histogram || 0;
  const prevMacd = macd5m[macd5m.length - 2]?.histogram || 0;

  let rsiScore = 0;
  if (lastRsi > 72 || lastRsi < 28) rsiScore = 3.5;
  else if (lastRsi > 65 || lastRsi < 35) rsiScore = 2;

  let stochScore = 0;
  const stochCrossedUp = prevStoch.k < prevStoch.d && lastStoch.k > lastStoch.d;
  const stochCrossedDown = prevStoch.k > prevStoch.d && lastStoch.k < lastStoch.d;
  if ((lastStoch.k > 82 && stochCrossedDown) || (lastStoch.k < 18 && stochCrossedUp)) stochScore = 3;
  else if (lastStoch.k > 75 || lastStoch.k < 25) stochScore = 1.5;

  let macdScore = 0;
  const macdCrossedUp = prevMacd < 0 && lastMacd > 0;
  const macdCrossedDown = prevMacd > 0 && lastMacd < 0;
  if (macdCrossedUp || macdCrossedDown) macdScore = 3.5;
  else if (!isNaN(lastMacd)) macdScore = 2;

  const timingScore = Math.min(10, rsiScore + stochScore + macdScore);

  // Layer 5 — Pullback (1m + 5m)
  const ema21_5m = ema(closes5m, 21);
  const lastEma21_5m = ema21_5m[ema21_5m.length - 1];
  const curPrice1m = closes1m[closes1m.length - 1];
  const priceVsEma21 = Math.abs(curPrice1m - lastEma21_5m) / lastEma21_5m;
  const priceVsMidBb = lastBb.mid ? Math.abs(curPrice1m - lastBb.mid) / lastBb.mid : 1;
  const inPullbackZone = priceVsEma21 < 0.001 || priceVsMidBb < 0.001;
  let pullbackScore = 0;
  if (inPullbackZone) {
    const lastC = candles1m[candles1m.length - 1];
    const wickRatio = lastC.open > lastC.close
      ? (lastC.high - lastC.open) / Math.max(lastC.open - lastC.close, 1)
      : (lastC.close - lastC.low) / Math.max(lastC.close - lastC.open, 1);
    pullbackScore = wickRatio >= 2 ? 10 : 7;
  } else if (priceVsEma21 < 0.003) {
    pullbackScore = 4;
  }

  // Layer 6 — Candle Pattern (1m)
  const last3 = candles1m.slice(-3);
  let patternFound = false;
  if (last3.length >= 2) {
    const c = last3[last3.length - 1];
    const p = last3[last3.length - 2];
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const prevBody = Math.abs(p.close - p.open);
    if (body >= prevBody * 0.9) patternFound = true; // engulfing approx
    if (upperWick >= body * 2 || lowerWick >= body * 2) patternFound = true; // pin bar
  }

  // Layer 7 — Risk
  const dailyLossLimit = peakBalance * 0.05;
  const drawdown = (peakBalance - currentBalance) / peakBalance;
  let riskScore = 10;
  if (Math.abs(dailyPnl) >= dailyLossLimit) riskScore = 0;
  else if (consecutiveLosses >= 2) riskScore = 0;
  else if (consecutiveLosses === 1) riskScore = 7;
  else if (Math.abs(dailyPnl) >= dailyLossLimit * 0.7) riskScore = 5;
  else if (drawdown >= 0.15) riskScore = 2;

  // Range context (simplified 30-day using available candles)
  const allCloses = candles1m.map((c) => c.close);
  const rangeHigh = Math.max(...allCloses);
  const rangeLow = Math.min(...allCloses);
  const rangePos = (curPrice1m - rangeLow) / (rangeHigh - rangeLow);
  let rangeContext: "top" | "middle" | "bottom" = "middle";
  if (rangePos > 0.8) rangeContext = "top";
  else if (rangePos < 0.2) rangeContext = "bottom";

  // Apply range context adjustments
  let adjustedTrend = trendScore;
  let adjustedVolatility = volatilityScore;
  if (rangeContext === "top") {
    adjustedTrend = trendDirection === "BULL" ? adjustedTrend * 0.85 : adjustedTrend * 1.1;
  } else if (rangeContext === "bottom") {
    adjustedTrend = trendDirection === "BEAR" ? adjustedTrend * 0.85 : adjustedTrend * 1.1;
  }

  const totalRaw = adjustedTrend + adjustedVolatility + timingScore + pullbackScore + riskScore;
  const total = Math.min(50, Math.max(0, patternFound ? totalRaw : Math.min(25, totalRaw)));

  // Signal direction
  let direction: "BUY" | "SELL" | "NONE" = "NONE";
  const buyConditions = trendDirection === "BULL" && bandTouched === "LOWER" && lastRsi < 40 && lastStoch.k < 30 && pullbackScore >= 4 && patternFound;
  const sellConditions = trendDirection === "BEAR" && bandTouched === "UPPER" && lastRsi > 60 && lastStoch.k > 70 && pullbackScore >= 4 && patternFound;
  if (buyConditions) direction = "BUY";
  else if (sellConditions) direction = "SELL";

  // Spike detection
  const lastAtr1m = atr(candles1m.slice(-20), 14).slice(-1)[0] || 100;
  const lastC1m = candles1m[candles1m.length - 1];
  const spikeDetected = lastC1m ? (lastC1m.high - lastC1m.low) > 3 * lastAtr1m : false;

  // Consolidation (last 8 candles on 5m)
  const last8_5m = candles5m.slice(-8);
  const atr5mLast = atr5m[atr5m.length - 1] || 1;
  const consolidationDetected = last8_5m.length >= 8 &&
    Math.max(...last8_5m.map((c) => c.high)) - Math.min(...last8_5m.map((c) => c.low)) < 1.5 * atr5mLast;

  return {
    total: Math.round(total * 10) / 10,
    trend: Math.round(adjustedTrend * 10) / 10,
    volatility: Math.round(volatilityScore * 10) / 10,
    timing: Math.round(timingScore * 10) / 10,
    pullback: Math.round(pullbackScore * 10) / 10,
    risk: Math.round(riskScore * 10) / 10,
    direction,
    trendDirection,
    bandTouched,
    ema9: Math.round(lastEma9 * 100) / 100,
    ema21: Math.round(lastEma21 * 100) / 100,
    ema50: Math.round(lastEma50 * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(lastRsi * 10) / 10,
    stochK: Math.round(lastStoch.k * 10) / 10,
    macdHistogram: Math.round(lastMacd * 100) / 100,
    bbUpper: Math.round(lastBb.upper * 100) / 100,
    bbLower: Math.round(lastBb.lower * 100) / 100,
    bbWidth: Math.round(lastBb.width * 10000) / 10000,
    atrValue: Math.round(atr5mLast * 100) / 100,
    rangeContext,
    consolidationDetected,
    spikeDetected,
    smcBos,
    smcChoch,
    orderBlockNearby,
    fvgNearby,
    pullbackZoneActive: inPullbackZone,
    ready: true,
  };
}
