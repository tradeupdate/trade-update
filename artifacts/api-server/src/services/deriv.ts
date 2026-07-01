import { WebSocket } from "ws";
import { logger } from "../lib/logger.js";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  price: number;
  timestamp: number;
}

export interface DerivContract {
  contract_id: number;
  contract_type: string;
  entry_spot: number;
  buy_price: number;
  symbol: string;
}

export interface PlaceOrderResult {
  success: boolean;
  contractId?: number;
  entrySpot?: number;
  buyPrice?: number;
  error?: string;
}

interface InProgressCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type TickListener = (tick: Tick, symbol: string) => void;
type CandleListener = (candle: Candle, tf: "1m" | "5m" | "15m", symbol: string) => void;
type ReconnectListener = () => void;

const SYMBOL_R75 = "R_75";
const SYMBOL_R10 = "R_10";
const PRICE_BOUNDS: Record<string, { min: number; max: number }> = {
  R_75: { min: 20000, max: 80000 },
  R_10: { min: 3000, max: 20000 },
};
const WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const PING_INTERVAL = 25000;
const BACKOFF = [3000, 6000, 12000, 30000];

// Payout rate cache per pair
const payoutCache: Record<string, { rate: number; updatedAt: number }> = {};
const PAYOUT_CACHE_DURATION = 30 * 60 * 1000;

class DerivService {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private hasConnectedOnce = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // R_75 candle stores
  private candles1m: Candle[] = [];
  private candles5m: Candle[] = [];
  private candles15m: Candle[] = [];
  private candles1h: Candle[] = [];
  private currentCandle: InProgressCandle | null = null;
  private latestTick: Tick = { price: 39500, timestamp: Date.now() };

  // R_10 candle stores
  private candles1m_r10: Candle[] = [];
  private candles5m_r10: Candle[] = [];
  private candles15m_r10: Candle[] = [];
  private candles1h_r10: Candle[] = [];
  private currentCandle_r10: InProgressCandle | null = null;
  private latestTick_r10: Tick = { price: 8000, timestamp: Date.now() };
  private r10PriceObserved = false;

  private tickListeners: Set<TickListener> = new Set();
  private candleListeners: Set<CandleListener> = new Set();
  private reconnectListeners: Set<ReconnectListener> = new Set();
  private proposalCallbacks: Map<string, (id: string, price: number, payout: number) => void> = new Map();
  private buyCallbacks: Map<string, (result: PlaceOrderResult) => void> = new Map();
  private portfolioCallbacks: Array<(contracts: DerivContract[]) => void> = [];
  private payoutCallbacks: Map<number, (rate: number) => void> = new Map();
  private payoutReqIdCounter = 1000;

  constructor() {
    this.connect();
  }

  private connect() {
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on("open", () => {
        this.connected = true;
        const isReconnect = this.hasConnectedOnce;
        this.reconnectAttempts = 0;
        this.hasConnectedOnce = true;
        logger.info("Deriv WebSocket connected");
        this.subscribe(isReconnect);
        this.startPing();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {}
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.cleanup();
        logger.warn("Deriv WebSocket closed, reconnecting...");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        logger.error({ err }, "Deriv WebSocket error");
        this.ws?.terminate();
      });
    } catch (err) {
      logger.error({ err }, "Failed to connect to Deriv");
      this.scheduleReconnect();
    }
  }

  private subscribe(isReconnect = false) {
    // R_75 subscriptions (req_id 1=1m, 5=5m, 15=15m, 60=1h)
    this.send({ ticks: SYMBOL_R75, subscribe: 1 });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 60, count: 200, end: "latest", subscribe: 1, req_id: 1 });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 300, count: 120, end: "latest", req_id: 5 });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 900, count: 80, end: "latest", req_id: 15 });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 3600, count: 120, end: "latest", req_id: 60 });

    // R_10 subscriptions (req_id 101=1m, 105=5m, 115=15m, 160=1h)
    this.send({ ticks: SYMBOL_R10, subscribe: 1 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 60, count: 200, end: "latest", subscribe: 1, req_id: 101 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 300, count: 120, end: "latest", req_id: 105 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 900, count: 80, end: "latest", req_id: 115 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 3600, count: 120, end: "latest", req_id: 160 });

    if (isReconnect) {
      this.reconnectListeners.forEach((fn) => { try { fn(); } catch {} });
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.connected) this.send({ ping: 1 });
    }, PING_INTERVAL);
  }

  private cleanup() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private scheduleReconnect() {
    const delay = BACKOFF[Math.min(this.reconnectAttempts, BACKOFF.length - 1)];
    this.reconnectAttempts++;
    if (this.reconnectAttempts > 5) { logger.error("Deriv: too many reconnect attempts"); return; }
    setTimeout(() => this.connect(), delay);
  }

  private handleMessage(msg: Record<string, unknown>) {
    // ── Tick messages (both R_75 and R_10 arrive as "tick") ──
    if (msg.msg_type === "tick") {
      const tick = msg.tick as Record<string, unknown>;
      const price = Number(tick?.quote);
      const symbol = String(tick?.symbol || "R_75");
      const bounds = PRICE_BOUNDS[symbol] || PRICE_BOUNDS["R_75"]!;

      if (price < bounds.min || price > bounds.max) {
        logger.warn({ price, symbol }, "Price out of expected range — may be normal for V10 first connect");
        return;
      }

      const ts = Math.floor((Number(tick?.epoch) || Date.now() / 1000) * 1000);

      if (symbol === SYMBOL_R10) {
        this.latestTick_r10 = { price, timestamp: ts };
        this.updateCurrentCandle_r10(price, ts);
        if (!this.r10PriceObserved) {
          this.r10PriceObserved = true;
          logger.info({ price }, "V10 first tick observed");
        }
      } else {
        this.latestTick = { price, timestamp: ts };
        this.updateCurrentCandle(price, ts);
      }

      this.tickListeners.forEach((fn) => fn({ price, timestamp: ts }, symbol));
    }

    // ── Candle history messages ──
    if (msg.msg_type === "candles" || msg.msg_type === "ohlc") {
      const reqId = Number(msg.req_id);
      const isR10 = reqId >= 100;

      const history = msg.candles as Array<Record<string, unknown>>;
      if (history && Array.isArray(history)) {
        const mapped: Candle[] = history.map((c) => ({
          time: Number(c.epoch) * 1000,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: 0,
        }));

        if (isR10) {
          if (reqId === 105) { this.candles5m_r10 = mapped; logger.info(`Deriv: seeded ${mapped.length} V10 5m candles`); }
          else if (reqId === 115) { this.candles15m_r10 = mapped; logger.info(`Deriv: seeded ${mapped.length} V10 15m candles`); }
          else if (reqId === 160) { this.candles1h_r10 = mapped; logger.info(`Deriv: seeded ${mapped.length} V10 1h candles`); }
          else { this.candles1m_r10 = mapped; this.buildHigherTimeframes_r10(); logger.info(`Deriv: seeded ${mapped.length} V10 1m candles`); }
        } else {
          if (reqId === 5) { this.candles5m = mapped; logger.info(`Deriv: seeded ${mapped.length} 5m candles`); }
          else if (reqId === 15) { this.candles15m = mapped; logger.info(`Deriv: seeded ${mapped.length} 15m candles`); }
          else if (reqId === 60) { this.candles1h = mapped; logger.info(`Deriv: seeded ${mapped.length} 1h candles`); }
          else { this.candles1m = mapped; this.buildHigherTimeframes(); }
        }
      }

      const ohlc = msg.ohlc as Record<string, unknown>;
      if (ohlc) {
        const candle: Candle = {
          time: Number(ohlc.open_time) * 1000,
          open: Number(ohlc.open),
          high: Number(ohlc.high),
          low: Number(ohlc.low),
          close: Number(ohlc.close),
          volume: 0,
        };
        const symbol = String(ohlc.symbol || "R_75");

        if (symbol === SYMBOL_R10) {
          const existing = this.candles1m_r10.findIndex((c) => c.time === candle.time);
          if (existing >= 0) this.candles1m_r10[existing] = candle;
          else { this.candles1m_r10.push(candle); if (this.candles1m_r10.length > 500) this.candles1m_r10.shift(); }
          this.buildHigherTimeframes_r10();
          this.candleListeners.forEach((fn) => fn(candle, "1m", SYMBOL_R10));
        } else {
          const existing = this.candles1m.findIndex((c) => c.time === candle.time);
          if (existing >= 0) this.candles1m[existing] = candle;
          else { this.candles1m.push(candle); if (this.candles1m.length > 500) this.candles1m.shift(); }
          this.buildHigherTimeframes();
          this.candleListeners.forEach((fn) => fn(candle, "1m", SYMBOL_R75));
        }
      }
    }

    // ── Proposal (trading + payout rate) ──
    if (msg.msg_type === "proposal") {
      const proposal = msg.proposal as Record<string, unknown>;
      const reqId = Number(msg.req_id);

      // Check if this is a payout rate request
      if (reqId >= 1000) {
        const payoutCb = this.payoutCallbacks.get(reqId);
        if (payoutCb) {
          this.payoutCallbacks.delete(reqId);
          const payout = Number(proposal?.payout);
          const askPrice = Number(proposal?.ask_price);
          const rate = askPrice > 0 ? (payout - askPrice) / askPrice : 0.85;
          logger.info({ reqId, payout, askPrice, rate: (rate * 100).toFixed(2) + "%" }, "Payout rate fetched");
          payoutCb(Math.max(0, Math.min(1, rate)));
        }
        return;
      }

      const id = String(proposal?.id);
      const askPrice = Number(proposal?.ask_price);
      const payoutAmt = Number(proposal?.payout ?? 0);
      const cb = this.proposalCallbacks.get("pending");
      if (cb) {
        this.proposalCallbacks.delete("pending");
        cb(id, askPrice, payoutAmt);
      }
    }

    if (msg.msg_type === "buy") {
      const buy = msg.buy as Record<string, unknown>;
      const contractId = Number(buy?.contract_id);
      const entrySpot = Number(buy?.start_spot || buy?.entry_spot || 0);
      const buyPrice = Number(buy?.buy_price || 0);
      const cb = this.buyCallbacks.get("pending");
      if (cb) { this.buyCallbacks.delete("pending"); cb({ success: true, contractId, entrySpot, buyPrice }); }
    }

    if (msg.error && this.buyCallbacks.has("pending")) {
      const err = msg.error as Record<string, unknown>;
      const cb = this.buyCallbacks.get("pending");
      if (cb) { this.buyCallbacks.delete("pending"); cb({ success: false, error: String(err?.message || "Deriv API error") }); }
    }

    if (msg.msg_type === "portfolio") {
      const portfolio = msg.portfolio as Record<string, unknown>;
      const contracts = ((portfolio?.contracts as Array<Record<string, unknown>>) || []).map((c) => ({
        contract_id: Number(c.contract_id),
        contract_type: String(c.contract_type || ""),
        entry_spot: Number(c.entry_spot || 0),
        buy_price: Number(c.buy_price || 0),
        symbol: String(c.symbol || ""),
      }));
      const callbacks = this.portfolioCallbacks.splice(0);
      callbacks.forEach((fn) => { try { fn(contracts); } catch {} });
    }
  }

  private updateCurrentCandle(price: number, ts: number) {
    const minuteTs = Math.floor(ts / 60000) * 60000;
    if (!this.currentCandle || this.currentCandle.time !== minuteTs) {
      if (this.currentCandle) {
        const completed: Candle = { ...this.currentCandle };
        const existing = this.candles1m.findIndex((c) => c.time === completed.time);
        if (existing >= 0) this.candles1m[existing] = completed;
        else { this.candles1m.push(completed); if (this.candles1m.length > 500) this.candles1m.shift(); }
        this.buildHigherTimeframes();
        this.candleListeners.forEach((fn) => fn(completed, "1m", SYMBOL_R75));
      }
      this.currentCandle = { time: minuteTs, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      this.currentCandle.close = price;
      if (price > this.currentCandle.high) this.currentCandle.high = price;
      if (price < this.currentCandle.low) this.currentCandle.low = price;
    }
  }

  private updateCurrentCandle_r10(price: number, ts: number) {
    const minuteTs = Math.floor(ts / 60000) * 60000;
    if (!this.currentCandle_r10 || this.currentCandle_r10.time !== minuteTs) {
      if (this.currentCandle_r10) {
        const completed: Candle = { ...this.currentCandle_r10 };
        const existing = this.candles1m_r10.findIndex((c) => c.time === completed.time);
        if (existing >= 0) this.candles1m_r10[existing] = completed;
        else { this.candles1m_r10.push(completed); if (this.candles1m_r10.length > 500) this.candles1m_r10.shift(); }
        this.buildHigherTimeframes_r10();
        this.candleListeners.forEach((fn) => fn(completed, "1m", SYMBOL_R10));
      }
      this.currentCandle_r10 = { time: minuteTs, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      this.currentCandle_r10.close = price;
      if (price > this.currentCandle_r10.high) this.currentCandle_r10.high = price;
      if (price < this.currentCandle_r10.low) this.currentCandle_r10.low = price;
    }
  }

  private buildHigherTimeframes() {
    this.candles5m = this.mergeHigherTf(this.candles5m, 5);
    this.candles15m = this.mergeHigherTf(this.candles15m, 15);
    this.candles1h = this.mergeHigherTf(this.candles1h, 60);
  }

  private buildHigherTimeframes_r10() {
    this.candles5m_r10 = this.mergeHigherTf_r10(this.candles5m_r10, 5);
    this.candles15m_r10 = this.mergeHigherTf_r10(this.candles15m_r10, 15);
    this.candles1h_r10 = this.mergeHigherTf_r10(this.candles1h_r10, 60);
  }

  private mergeHigherTf(existing: Candle[], minutesPerCandle: number): Candle[] {
    if (this.candles1m.length === 0) return existing;
    const built = this.groupCandles(this.candles1m, minutesPerCandle);
    if (built.length === 0) return existing;
    const historicalSeed = existing.filter((c) => c.time < built[0].time);
    return [...historicalSeed, ...built].slice(-500);
  }

  private mergeHigherTf_r10(existing: Candle[], minutesPerCandle: number): Candle[] {
    if (this.candles1m_r10.length === 0) return existing;
    const built = this.groupCandles(this.candles1m_r10, minutesPerCandle);
    if (built.length === 0) return existing;
    const historicalSeed = existing.filter((c) => c.time < built[0].time);
    return [...historicalSeed, ...built].slice(-500);
  }

  private groupCandles(candles: Candle[], n: number): Candle[] {
    const result: Candle[] = [];
    for (let i = 0; i < candles.length; i += n) {
      const slice = candles.slice(i, i + n);
      if (!slice.length) continue;
      result.push({
        time: slice[0].time,
        open: slice[0].open,
        high: Math.max(...slice.map((c) => c.high)),
        low: Math.min(...slice.map((c) => c.low)),
        close: slice[slice.length - 1].close,
        volume: slice.reduce((s, c) => s + c.volume, 0),
      });
    }
    return result;
  }

  private send(data: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getLatestTick(): Tick { return this.latestTick; }

  getLatestTickForPair(pair: string): Tick {
    return pair === SYMBOL_R10 ? this.latestTick_r10 : this.latestTick;
  }

  getCandles(tf: "1m" | "5m" | "15m" | "1h", count = 200): Candle[] {
    return this.getCandlesForPair(SYMBOL_R75, tf, count);
  }

  getCandlesForPair(pair: string, tf: "1m" | "5m" | "15m" | "1h", count = 200): Candle[] {
    if (pair === SYMBOL_R10) {
      const src = tf === "1m" ? this.candles1m_r10 : tf === "5m" ? this.candles5m_r10 : tf === "15m" ? this.candles15m_r10 : this.candles1h_r10;
      return src.slice(-count);
    }
    const src = tf === "1m" ? this.candles1m : tf === "5m" ? this.candles5m : tf === "15m" ? this.candles15m : this.candles1h;
    return src.slice(-count);
  }

  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  onCandle(fn: CandleListener): () => void {
    this.candleListeners.add(fn);
    return () => this.candleListeners.delete(fn);
  }

  onReconnect(fn: ReconnectListener): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  isConnected(): boolean { return this.connected; }

  async getOpenContracts(): Promise<DerivContract[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.portfolioCallbacks.indexOf(resolve as any);
        if (idx >= 0) this.portfolioCallbacks.splice(idx, 1);
        reject(new Error("Portfolio request timed out"));
      }, 8000);
      this.portfolioCallbacks.push((contracts) => { clearTimeout(timeout); resolve(contracts); });
      this.send({ portfolio: 1 });
    });
  }

  // ── Payout rate detection (Part 4) ───────────────────────────────────────────

  async fetchPayoutRate(pair: string, stake: number): Promise<number> {
    if (!this.connected) return 0.85;
    return new Promise((resolve) => {
      const reqId = ++this.payoutReqIdCounter;
      const timeout = setTimeout(() => {
        this.payoutCallbacks.delete(reqId);
        logger.warn({ pair }, "Payout rate request timed out, using 0.85");
        resolve(0.85);
      }, 8000);
      this.payoutCallbacks.set(reqId, (rate) => { clearTimeout(timeout); resolve(rate); });
      this.send({
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: "CALL",
        currency: "USD",
        duration: 5,
        duration_unit: "m",
        symbol: pair,
        req_id: reqId,
      });
    });
  }

  async getCachedPayoutRate(pair: string, stake: number): Promise<number> {
    const cached = payoutCache[pair];
    if (cached && Date.now() - cached.updatedAt < PAYOUT_CACHE_DURATION) {
      return cached.rate;
    }
    const rate = await this.fetchPayoutRate(pair, stake);
    payoutCache[pair] = { rate, updatedAt: Date.now() };
    logger.info({ pair, rate: (rate * 100).toFixed(2) + "%" }, "Payout rate cached");
    return rate;
  }

  // ── Order placement ───────────────────────────────────────────────────────────

  async placeOrder(
    direction: "BUY" | "SELL",
    stake: number,
    token: string,
    pair = SYMBOL_R75
  ): Promise<PlaceOrderResult> {
    if (!this.connected) return { success: false, error: "Deriv not connected" };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.buyCallbacks.delete("pending");
        this.proposalCallbacks.delete("pending");
        resolve({ success: false, error: "Order timed out" });
      }, 15000);

      this.proposalCallbacks.set("pending", (proposalId, askPrice) => {
        this.send({ buy: proposalId, price: askPrice, passthrough: { token } });
        this.buyCallbacks.set("pending", (result) => { clearTimeout(timeout); resolve(result); });
      });

      const contractType = direction === "BUY" ? "CALL" : "PUT";
      this.send({
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: contractType,
        currency: "USD",
        duration: 5,
        duration_unit: "t",
        symbol: pair,
        passthrough: { token },
      });
    });
  }
}

export const derivService = new DerivService();
