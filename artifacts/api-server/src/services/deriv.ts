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

type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h";
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

const TF_MAX: Record<Timeframe, number> = {
  "1m": 1000,
  "5m": 1000,
  "15m": 500,
  "1h": 200,
  "4h": 100,
};

function granularityToTf(g: number): Timeframe | null {
  const map: Record<number, Timeframe> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h" };
  return map[g] ?? null;
}

function upsertCandle(store: Candle[], candle: Candle, maxLen: number): void {
  const idx = store.findIndex((c) => c.time === candle.time);
  if (idx >= 0) {
    store[idx] = candle;
  } else {
    store.push(candle);
    if (store.length > maxLen) store.shift();
  }
}

// Payout rate cache per pair
const payoutCache: Record<string, { rate: number; updatedAt: number }> = {};
const PAYOUT_CACHE_DURATION = 30 * 60 * 1000;

class DerivService {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private hasConnectedOnce = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // ── R_75 candle stores ──────────────────────────────────────────────────────
  private candles1m: Candle[] = [];
  private candles5m: Candle[] = [];
  private candles15m: Candle[] = [];
  private candles1h: Candle[] = [];
  private candles4h: Candle[] = [];
  private currentCandle: InProgressCandle | null = null;
  private latestTick: Tick = { price: 39500, timestamp: Date.now() };

  // ── R_10 candle stores ──────────────────────────────────────────────────────
  private candles1m_r10: Candle[] = [];
  private candles5m_r10: Candle[] = [];
  private candles15m_r10: Candle[] = [];
  private candles1h_r10: Candle[] = [];
  private candles4h_r10: Candle[] = [];
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
    // ── R_75 — seed + subscribe all timeframes ──────────────────────────────
    // req_ids: 1m=1, 5m=5, 15m=15, 1h=60, 4h=240
    this.send({ ticks: SYMBOL_R75, subscribe: 1 });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 60,    count: 1000, end: "latest", subscribe: 1, req_id: 1   });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 300,   count: 1000, end: "latest", subscribe: 1, req_id: 5   });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 900,   count: 500,  end: "latest", subscribe: 1, req_id: 15  });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 3600,  count: 200,  end: "latest", subscribe: 1, req_id: 60  });
    this.send({ ticks_history: SYMBOL_R75, style: "candles", granularity: 14400, count: 100,  end: "latest", subscribe: 1, req_id: 240 });

    // ── R_10 — seed + subscribe all timeframes ──────────────────────────────
    // req_ids: 1m=101, 5m=105, 15m=115, 1h=160, 4h=340
    this.send({ ticks: SYMBOL_R10, subscribe: 1 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 60,    count: 1000, end: "latest", subscribe: 1, req_id: 101 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 300,   count: 1000, end: "latest", subscribe: 1, req_id: 105 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 900,   count: 500,  end: "latest", subscribe: 1, req_id: 115 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 3600,  count: 200,  end: "latest", subscribe: 1, req_id: 160 });
    this.send({ ticks_history: SYMBOL_R10, style: "candles", granularity: 14400, count: 100,  end: "latest", subscribe: 1, req_id: 340 });

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

  // ── Returns the mutable candle array for a given symbol + timeframe ─────────
  private getStore(symbol: string, tf: Timeframe): Candle[] {
    if (symbol === SYMBOL_R10) {
      switch (tf) {
        case "1m":  return this.candles1m_r10;
        case "5m":  return this.candles5m_r10;
        case "15m": return this.candles15m_r10;
        case "1h":  return this.candles1h_r10;
        case "4h":  return this.candles4h_r10;
      }
    }
    switch (tf) {
      case "1m":  return this.candles1m;
      case "5m":  return this.candles5m;
      case "15m": return this.candles15m;
      case "1h":  return this.candles1h;
      case "4h":  return this.candles4h;
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    // ── Tick (raw price from both symbols) ──────────────────────────────────
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

    // ── Historical candle seed (bulk response) ──────────────────────────────
    if (msg.msg_type === "candles") {
      const reqId = Number(msg.req_id);
      const history = msg.candles as Array<Record<string, unknown>>;
      if (!history || !Array.isArray(history)) return;

      const mapped: Candle[] = history.map((c) => ({
        time: Number(c.epoch) * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: 0,
      }));

      // Route by req_id to the correct symbol + tf store
      let symbol = SYMBOL_R75;
      let tf: Timeframe = "1m";

      if      (reqId === 1   || reqId === 101) { tf = "1m";  symbol = reqId >= 100 ? SYMBOL_R10 : SYMBOL_R75; }
      else if (reqId === 5   || reqId === 105) { tf = "5m";  symbol = reqId >= 100 ? SYMBOL_R10 : SYMBOL_R75; }
      else if (reqId === 15  || reqId === 115) { tf = "15m"; symbol = reqId >= 100 ? SYMBOL_R10 : SYMBOL_R75; }
      else if (reqId === 60  || reqId === 160) { tf = "1h";  symbol = reqId >= 100 ? SYMBOL_R10 : SYMBOL_R75; }
      else if (reqId === 240 || reqId === 340) { tf = "4h";  symbol = reqId >= 100 ? SYMBOL_R10 : SYMBOL_R75; }
      else return; // unknown req_id (e.g. payout proposals arrive as "proposal" not "candles")

      const store = this.getStore(symbol, tf);
      store.length = 0;
      store.push(...mapped);
      logger.info(`Deriv: seeded ${mapped.length} ${symbol === SYMBOL_R10 ? "V10 " : ""}${tf} candles`);
    }

    // ── Live ohlc update (single candle, updating or new) ───────────────────
    if (msg.msg_type === "ohlc") {
      const ohlc = msg.ohlc as Record<string, unknown>;
      if (!ohlc) return;

      const granularity = Number(ohlc.granularity);
      const tf = granularityToTf(granularity);
      if (!tf) return;

      const symbol = String(ohlc.symbol || "R_75");
      const candle: Candle = {
        time: Number(ohlc.open_time) * 1000,
        open: Number(ohlc.open),
        high: Number(ohlc.high),
        low: Number(ohlc.low),
        close: Number(ohlc.close),
        volume: 0,
      };

      const store = this.getStore(symbol, tf);
      upsertCandle(store, candle, TF_MAX[tf]);

      // Only emit candle listeners for 1m (bot loop listens on this)
      if (tf === "1m") {
        this.candleListeners.forEach((fn) => fn(candle, "1m", symbol));
      }
    }

    // ── Proposal (trading + payout rate) ────────────────────────────────────
    if (msg.msg_type === "proposal") {
      const proposal = msg.proposal as Record<string, unknown>;
      const reqId = Number(msg.req_id);

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

  // ── Tick-driven 1m candle builder (real-time price, completes when minute rolls) ──
  private updateCurrentCandle(price: number, ts: number) {
    const minuteTs = Math.floor(ts / 60000) * 60000;
    if (!this.currentCandle || this.currentCandle.time !== minuteTs) {
      if (this.currentCandle) {
        const completed: Candle = { ...this.currentCandle };
        upsertCandle(this.candles1m, completed, TF_MAX["1m"]);
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
        upsertCandle(this.candles1m_r10, completed, TF_MAX["1m"]);
        this.candleListeners.forEach((fn) => fn(completed, "1m", SYMBOL_R10));
      }
      this.currentCandle_r10 = { time: minuteTs, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      this.currentCandle_r10.close = price;
      if (price > this.currentCandle_r10.high) this.currentCandle_r10.high = price;
      if (price < this.currentCandle_r10.low) this.currentCandle_r10.low = price;
    }
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

  getCandles(tf: Timeframe, count = 200): Candle[] {
    return this.getCandlesForPair(SYMBOL_R75, tf, count);
  }

  getCandlesForPair(pair: string, tf: Timeframe, count = 200): Candle[] {
    const store = this.getStore(pair === SYMBOL_R10 ? SYMBOL_R10 : SYMBOL_R75, tf);
    return store.slice(-count);
  }

  getCandleStoreSize(pair: string, tf: Timeframe): number {
    return this.getStore(pair === SYMBOL_R10 ? SYMBOL_R10 : SYMBOL_R75, tf).length;
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

  // ── Payout rate detection ─────────────────────────────────────────────────

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

  // ── Order placement ───────────────────────────────────────────────────────

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

// ── One-shot Deriv balance fetcher ────────────────────────────────────────────
// Opens a temporary WebSocket, authorises with the user's token, requests the
// current account balance, then closes cleanly. Used when a token is saved or
// mode switches to live so the bot balance syncs to the real Deriv balance.
export async function fetchDerivBalance(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let done = false;

    const finish = (err?: Error, balance?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(balance!);
    };

    const timer = setTimeout(() => finish(new Error("Deriv balance fetch timed out")), 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.error) {
        finish(new Error(msg.error.message ?? "Deriv auth error"));
        return;
      }

      if (msg.msg_type === "authorize") {
        ws.send(JSON.stringify({ balance: 1, account: "current" }));
        return;
      }

      if (msg.msg_type === "balance") {
        const bal = parseFloat(msg.balance?.balance ?? "0");
        finish(undefined, Math.round(bal * 100) / 100);
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => { if (!done) finish(new Error("Connection closed unexpectedly")); });
  });
}

// ── V10 Precision live contract placer ────────────────────────────────────────
// Opens a fresh, dedicated WebSocket per trade (isolated from the shared market
// data socket). Authorizes with the user's token, proposes a timed binary, buys
// it, and subscribes to proposal_open_contract for settlement. Calls onSettlement
// asynchronously when the contract expires.

export interface PrecisionSettlementResult {
  won: boolean;
  pnl: number;       // positive = profit, negative = loss
  exitSpot: number;
  contractId: number;
}

export async function placePrecisionLiveContract(
  direction: "BUY" | "SELL",
  stake: number,
  token: string,
  symbol: string,
  durationMinutes: number,
  onSettlement: (result: PrecisionSettlementResult) => void
): Promise<PlaceOrderResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    let contractId: number | null = null;

    // Central cleanup — safe to call multiple times; only acts once
    const finish = (error?: string, settlement?: PrecisionSettlementResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      if (settlementTimeout) { clearTimeout(settlementTimeout); settlementTimeout = null; }
      try { ws.close(); } catch {}
      if (error) {
        resolve({ success: false, error });
      }
      // settlement path: resolve already called earlier (after buy); just invoke callback
      if (settlement) onSettlement(settlement);
    };

    const fail = (error: string) => finish(error);

    // Hard timeout — if no contract_id after 20s, abort
    const connectTimeout = setTimeout(() => fail("Connection or proposal timed out"), 20000);
    // Settlement timeout — if Deriv never settles, close after duration + 10min buffer
    let settlementTimeout: ReturnType<typeof setTimeout> | null = null;

    let step: "auth" | "proposal" | "buy" | "monitor" = "auth";
    let proposalId: string | null = null;
    let buyPrice: number | null = null;
    let entrySpot: number | null = null;

    ws.on("open", () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.error) {
        logger.error({ code: msg.error.code, msg: msg.error.message }, "V10P Deriv contract error");
        fail(`Deriv error: ${msg.error.message}`);
        return;
      }

      if (msg.msg_type === "authorize" && step === "auth") {
        step = "proposal";
        const contractType = direction === "BUY" ? "CALL" : "PUT";
        ws.send(JSON.stringify({
          proposal: 1,
          amount: stake,
          basis: "stake",
          contract_type: contractType,
          currency: "USD",
          duration: durationMinutes,
          duration_unit: "m",
          symbol,
        }));
        return;
      }

      if (msg.msg_type === "proposal" && step === "proposal") {
        step = "buy";
        proposalId = msg.proposal?.id;
        buyPrice = msg.proposal?.ask_price;
        if (!proposalId || !buyPrice) { fail("Invalid proposal response"); return; }
        ws.send(JSON.stringify({ buy: proposalId, price: buyPrice }));
        return;
      }

      if (msg.msg_type === "buy" && step === "buy") {
        clearTimeout(connectTimeout);
        contractId = msg.buy?.contract_id;
        entrySpot = msg.buy?.entry_spot ?? msg.buy?.start_spot ?? null;
        const actualBuyPrice = msg.buy?.buy_price ?? stake;
        if (!contractId) { fail("No contract_id in buy response"); return; }

        step = "monitor";
        // Subscribe to contract updates for settlement
        ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1,
        }));

        // Settlement safety timeout — contract duration + 10-minute buffer
        settlementTimeout = setTimeout(() => {
          logger.warn({ contractId }, "V10P settlement timeout — forced loss");
          finish(undefined, { won: false, pnl: -actualBuyPrice, exitSpot: entrySpot ?? 0, contractId: contractId! });
        }, (durationMinutes + 10) * 60 * 1000);

        // Resolve immediately with contract_id so the caller can store it
        resolve({ success: true, contractId, entrySpot: entrySpot ?? undefined, buyPrice: actualBuyPrice });
        return;
      }

      if (msg.msg_type === "proposal_open_contract" && step === "monitor") {
        const poc = msg.proposal_open_contract;
        if (!poc || !poc.is_sold) return; // Not yet settled

        const profit = parseFloat(poc.profit ?? "0");
        const won = profit > 0;
        const exitSpotVal = parseFloat(poc.exit_tick ?? poc.sell_spot ?? poc.entry_spot ?? "0");
        const pnl = Math.round(profit * 100) / 100;

        logger.info({ contractId, won, pnl, exitSpot: exitSpotVal }, "V10P contract settled");
        finish(undefined, { won, pnl, exitSpot: exitSpotVal, contractId: poc.contract_id });
        return;
      }
    });

    ws.on("error", (err) => {
      logger.error({ err: err.message }, "V10P contract WS error");
      fail(`WebSocket error: ${err.message}`);
    });

    ws.on("close", () => {
      // Only fail if we haven't finished successfully (i.e. pre-buy close)
      if (!settled) fail("WebSocket closed before settlement");
    });
  });
}

// ── Shared chunked candle fetcher for backtests ───────────────────────────────
// Opens a temporary WS per chunk, walks backwards from dateTo to dateFrom.

export async function fetchCandlesChunked(
  symbol: string,
  granularity: number,
  dateFrom: number,
  dateTo: number
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>> {
  const CHUNK_SIZE = 5000;
  const MAX_CHUNKS = 10;
  const all: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
  let currentEnd = dateTo;
  let chunks = 0;

  while (currentEnd > dateFrom && chunks < MAX_CHUNKS) {
    chunks++;
    const chunk = await fetchOneChunk(symbol, granularity, CHUNK_SIZE, currentEnd);
    if (!chunk.length) break;
    all.push(...chunk);
    const earliest = Math.min(...chunk.map((c) => c.time));
    currentEnd = earliest - granularity;
    if (earliest <= dateFrom) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const filtered = all.filter((c) => c.time >= dateFrom && c.time <= dateTo);
  const sorted = filtered.sort((a, b) => a.time - b.time);
  const deduped = sorted.filter((c, i) => i === 0 || c.time !== sorted[i - 1]!.time);

  logger.info(
    { symbol, granularity, chunks, total: all.length, filtered: deduped.length },
    "fetchCandlesChunked complete"
  );
  return deduped;
}

function fetchOneChunk(
  symbol: string,
  granularity: number,
  count: number,
  endTime: number
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve([]); }, 20000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ ticks_history: symbol, style: "candles", granularity, count, end: endTime }));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.candles.map((c: Record<string, unknown>) => ({
            time: Number(c.epoch),
            open: parseFloat(String(c.open)),
            high: parseFloat(String(c.high)),
            low: parseFloat(String(c.low)),
            close: parseFloat(String(c.close)),
          })));
        } else if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          resolve([]);
        }
      } catch { /* skip */ }
    });

    ws.on("error", () => { clearTimeout(timeout); try { ws.terminate(); } catch {} resolve([]); });
  });
}
