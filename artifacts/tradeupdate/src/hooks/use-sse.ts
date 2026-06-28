import { useState, useEffect, useRef, useCallback } from "react";

export interface TickPayload {
  price: number;
  direction: "up" | "down";
  time: number;
}

export interface ScoresPayload {
  loading?: boolean;
  message?: string;
  candlesLoaded?: number;
  candlesNeeded?: number;
  total?: number;
  c1?: number;
  c2?: number;
  c3?: number;
  signal?: string;
  direction?: string;
  ema20_1h?: number;
  ema50_1h?: number;
  ema9_15m?: number;
  ema21_15m?: number;
  adx15m?: number;
  rsi5m?: number;
  ema21_5m?: number;
  rejectionReason?: string | null;
  /** @deprecated legacy fields kept for backward compat */
  trend?: number;
  volatility?: number;
  timing?: number;
  pullback?: number;
  risk?: number;
  ema9?: number;
  ema21?: number;
  adx?: number;
  rsi?: number;
  bbUpper?: number;
  bbLower?: number;
  stochK?: number;
  macdHistogram?: number;
  rangeContext?: string;
  consolidation?: boolean;
  spikeDetected?: boolean;
  trendDirection?: string;
  bandTouched?: string;
  pullbackZone?: boolean;
}

export interface BotPayload {
  status: "active" | "paused" | "stopped";
  isRunning: boolean;
  pauseReason: string | null;
  killSwitchActive: boolean;
  openTrade: any | null;
  consecutiveLosses: number;
  consecutiveWins: number;
  todayTrades: number;
  thisHourTrades: number;
  recoveryMode: boolean;
  winStreakCaution: boolean;
  spikeDetected: boolean;
  consolidation: boolean;
  dailyLossHit?: boolean;
  currentDrawdown?: number;
  dailyPnl?: number;
  currentScore?: number | null;
  scoreBreakdown?: any;
  rangeContext?: string | null;
  cooldownSecondsRemaining?: number | null;
  strategyCircuitBreakerActive?: boolean;
}

export interface SessionInfo {
  name: string;
  quality: string;
  isActive: boolean;
  startUtcHour: number;
  endUtcHour: number;
}

export interface SessionPayload {
  current: { name: string; quality: string } | null;
  next: { name: string; minutesUntil: number } | null;
  all: SessionInfo[];
}

export interface StatsPayload {
  balance: number;
  equity: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  peakBalance: number;
  currentDrawdown: number;
}

export interface AlertPayload {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ActivityPayload {
  message: string;
  level: "info" | "win" | "loss" | "warning" | "error";
  createdAt: number;
}

export interface TradePayload {
  action: "opened" | "closed" | "partial_close" | "break_even";
  trade?: any;
  result?: string;
  pnl?: number;
  tradeId?: string;
  exitPrice?: number;
}

interface SSEState {
  tick: TickPayload | null;
  scores: ScoresPayload | null;
  bot: BotPayload | null;
  session: SessionPayload | null;
  stats: StatsPayload | null;
  lastTrade: TradePayload | null;
  alerts: AlertPayload[];
  activity: ActivityPayload[];
  connected: boolean;
  lastTickTime: number;
}

export function useSSE(enabled = true) {
  const [state, setState] = useState<SSEState>({
    tick: null, scores: null, bot: null, session: null,
    stats: null, lastTrade: null, alerts: [], activity: [], connected: false, lastTickTime: 0,
  });

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  const onTradeRef = useRef<((trade: TradePayload) => void) | null>(null);
  const onAlertRef = useRef<((alert: AlertPayload) => void) | null>(null);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource("/api/user/stream", { withCredentials: true });
    esRef.current = es;

    es.onopen = () => {
      setState(s => ({ ...s, connected: true }));
      reconnectDelay.current = 1000;
    };

    es.onmessage = (e) => {
      if (!e.data || e.data.trim() === "") return;
      let msg: { type: string; payload: any };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      const { type, payload } = msg;

      switch (type) {
        case "tick":
          setState(s => ({
            ...s, connected: true, lastTickTime: Date.now(),
            tick: payload as TickPayload,
          }));
          break;

        case "scores":
          setState(s => ({ ...s, scores: payload as ScoresPayload }));
          break;

        case "bot":
          setState(s => ({ ...s, bot: payload as BotPayload }));
          break;

        case "session":
          setState(s => ({ ...s, session: payload as SessionPayload }));
          break;

        case "stats":
          setState(s => ({ ...s, stats: payload as StatsPayload }));
          break;

        case "trade":
          setState(s => ({ ...s, lastTrade: payload as TradePayload }));
          onTradeRef.current?.(payload as TradePayload);
          break;

        case "alert":
          setState(s => ({
            ...s,
            alerts: [...s.alerts.slice(-9), payload as AlertPayload],
          }));
          onAlertRef.current?.(payload as AlertPayload);
          break;

        case "activity":
          setState(s => ({
            ...s,
            activity: [payload as ActivityPayload, ...s.activity.slice(0, 99)],
          }));
          break;

        case "maintenance":
          setState(s => ({
            ...s,
            alerts: [...s.alerts.slice(-9), { level: "warning", message: "System maintenance" }],
          }));
          break;

        case "connected":
          setState(s => ({ ...s, connected: true }));
          break;
      }
    };

    es.onerror = () => {
      setState(s => ({ ...s, connected: false }));
      es.close();
      esRef.current = null;
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 15000);
        connect();
      }, reconnectDelay.current);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect, enabled]);

  // Connection quality: stale if no tick for 5 seconds
  const [isStale, setIsStale] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setIsStale(state.lastTickTime > 0 && Date.now() - state.lastTickTime > 5000);
    }, 1000);
    return () => clearInterval(t);
  }, [state.lastTickTime]);

  const onTrade = useCallback((fn: (t: TradePayload) => void) => {
    onTradeRef.current = fn;
  }, []);

  const onAlert = useCallback((fn: (a: AlertPayload) => void) => {
    onAlertRef.current = fn;
  }, []);

  return { ...state, isStale, onTrade, onAlert };
}
