import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  useGetCandles,
  useGetUserTrades,
  useGetUserStats,
  getGetBotStatusQueryKey,
  useGetUserDashboard,
  getGetUserDashboardQueryKey,
  useToggleBot,
  useLogout
} from "@workspace/api-client-react";
import { Logo } from "@/components/ui/logo";
import {
  Loader2, Power, Pause, LogOut, Home, BarChart2, List,
  Settings as SettingsIcon, TrendingUp, TrendingDown, Brain,
  X, ChevronRight, Eye, EyeOff, Link2, CheckCircle2
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line
} from "recharts";
import { useSSE } from "@/hooks/use-sse";

type Timeframe = "1m" | "5m" | "15m";
type TradeFilter = "all" | "win" | "loss" | "paper" | "copy";

function ScoreBar({ label, value, max = 12 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(100, (value / max) * 100);
  const color = pct >= 66 ? "#00D4A4" : pct >= 33 ? "#FFB347" : "#FF4060";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-secondary w-16 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-mono font-bold w-8 text-right" style={{ color }}>{value.toFixed(1)}</span>
    </div>
  );
}

function StatusBanner({ bot }: { bot: any }) {
  if (!bot) return null;

  let msg = "";
  let cls = "";

  if (bot.killSwitchActive) {
    msg = "KILL SWITCH ACTIVE — Bot halted";
    cls = "bg-accent-red/10 text-accent-red";
  } else if (bot.dailyLossHit) {
    msg = "DAILY LOSS LIMIT REACHED — Bot stopped";
    cls = "bg-accent-red/10 text-accent-red";
  } else if (bot.strategyCircuitBreakerActive) {
    msg = "STRATEGY PAUSED BY ADMIN";
    cls = "bg-accent-red/10 text-accent-red";
  } else if (bot.recoveryMode) {
    msg = "RECOVERY MODE — Stake reduced 50%";
    cls = "bg-yellow-500/10 text-yellow-400";
  } else if (bot.winStreakCaution) {
    msg = "WIN STREAK CAUTION — Stake reduced 20%";
    cls = "bg-orange-500/10 text-orange-400";
  } else if (bot.pauseReason && !bot.isRunning) {
    msg = bot.pauseReason.toUpperCase();
    cls = "bg-text-secondary/10 text-text-secondary";
  } else {
    return null;
  }

  return (
    <div className={`py-1 text-center text-xs font-medium uppercase tracking-wide ${cls}`}>
      {msg}
    </div>
  );
}

export default function Dashboard() {
  const { data: user } = useGetMe();
  const [activeTab, setActiveTab] = useState("home");
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>("all");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  // Trade detail modal
  const [selectedTrade, setSelectedTrade] = useState<any | null>(null);

  // Deriv token form
  const [derivTokenInput, setDerivTokenInput] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);

  const handleSaveDerivToken = async () => {
    if (!derivTokenInput.trim()) return;
    setTokenSaving(true);
    try {
      const res = await fetch("/api/user/deriv/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: derivTokenInput.trim() }),
      });
      if (res.ok) {
        setTokenSaved(true);
        setDerivTokenInput("");
        queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
        setTimeout(() => setTokenSaved(false), 3000);
      }
    } finally {
      setTokenSaving(false);
    }
  };

  // SSE hook — single source of truth for real-time data
  const sse = useSSE(true);

  // Refresh React Query cache on trade events
  useEffect(() => {
    if (!sse.lastTrade) return;
    const action = sse.lastTrade.action;
    if (action === "opened" || action === "closed") {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["userTrades"] });
      queryClient.invalidateQueries({ queryKey: ["userStats"] });
    }
  }, [sse.lastTrade, queryClient]);

  const { data: dashboardData } = useGetUserDashboard({
    query: {
      queryKey: getGetUserDashboardQueryKey(),
      refetchInterval: 15000,
    }
  });

  const { data: candles, isLoading: candlesLoading } = useGetCandles(
    { timeframe, count: 200 },
    {
      query: {
        queryKey: ["candles", timeframe],
        refetchInterval: activeTab === "chart" ? 30000 : false,
        enabled: activeTab === "chart"
      }
    }
  );

  const { data: tradesData, isLoading: tradesLoading } = useGetUserTrades(
    { filter: tradeFilter, limit: 50 },
    {
      query: {
        queryKey: ["userTrades", tradeFilter],
        enabled: activeTab === "trades"
      }
    }
  );

  // Always-on equity data — fetch all trades for the home tab chart
  const { data: equityTradesData } = useGetUserTrades(
    { filter: "all", limit: 200 },
    {
      query: {
        queryKey: ["userTradesEquity"],
        refetchInterval: 30000,
      }
    }
  );

  const { data: stats } = useGetUserStats({
    query: {
      queryKey: ["userStats"],
      enabled: activeTab === "trades",
      refetchInterval: activeTab === "trades" ? 30000 : false,
    }
  });

  const toggleBot = useToggleBot();
  const logout = useLogout();

  // Use SSE data preferentially, fall back to polling
  const botData = sse.bot ?? dashboardData?.botStatus;
  const isRunning = botData?.isRunning ?? false;
  const price = sse.tick?.price ?? 0;
  const priceDir = sse.tick?.direction ?? "";

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setLocation("/login");
        setTimeout(() => window.location.reload(), 100);
      }
    });
  };

  // Connection dot color
  const connDotClass = !sse.connected
    ? "bg-accent-red"
    : sse.isStale
    ? "bg-yellow-400"
    : sse.scores?.loading
    ? "bg-yellow-400 animate-pulse"
    : "bg-primary animate-pulse";

  // Compute daily equity curve from trade history
  const homeEquityData = useMemo(() => {
    const trades = equityTradesData?.trades ?? [];
    if (trades.length === 0) return [];

    // Sort oldest first
    const sorted = [...trades].sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));

    // Group PnL by calendar day
    const byDay: Record<string, number> = {};
    for (const t of sorted) {
      const date = new Date((t.openedAt ?? 0) * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      byDay[date] = (byDay[date] ?? 0) + (t.pnl ?? 0);
    }

    // Reconstruct running balance
    const currentBalance = dashboardData?.user?.accountBalance ?? 0;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const startBalance = Math.max(100, currentBalance - totalPnl);

    let running = startBalance;
    return Object.entries(byDay).map(([date, dayPnl]) => {
      running += dayPnl;
      return { date, balance: Math.round(running * 100) / 100 };
    });
  }, [equityTradesData, dashboardData?.user?.accountBalance]);

  // Session performance breakdown from all fetched trades
  const sessionStats = useMemo(() => {
    const trades = equityTradesData?.trades ?? [];
    const map: Record<string, { trades: number; wins: number; totalPnl: number }> = {};
    for (const t of trades) {
      const name = t.sessionName ?? "Other";
      if (!map[name]) map[name] = { trades: 0, wins: 0, totalPnl: 0 };
      map[name].trades++;
      if ((t.pnl ?? 0) > 0) map[name].wins++;
      map[name].totalPnl += t.pnl ?? 0;
    }
    const SESSION_ORDER = ["London Open", "London/NY Overlap", "NY Afternoon", "Asia", "Other"];
    return Object.entries(map)
      .sort((a, b) => {
        const ai = SESSION_ORDER.indexOf(a[0]);
        const bi = SESSION_ORDER.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
      .map(([name, s]) => ({
        name,
        trades: s.trades,
        winRate: s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0,
        avgPnl: s.trades > 0 ? Math.round((s.totalPnl / s.trades) * 100) / 100 : 0,
        totalPnl: Math.round(s.totalPnl * 100) / 100,
      }));
  }, [equityTradesData]);

  // Whether the account is profitable overall
  const isProfit = homeEquityData.length > 1
    ? homeEquityData[homeEquityData.length - 1].balance >= homeEquityData[0].balance
    : true;
  const equityColor = isProfit ? "#00D4A4" : "#FF4060";

  // Chart data
  const chartData = candles?.candles?.map((c) => ({
    time: new Date(c.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    close: c.close,
    open: c.open,
    high: c.high,
    low: c.low,
  })) ?? [];

  // Equity curve from stats
  const equityData = (stats as any)?.equityCurve?.map((e: any) => ({
    time: e.date ?? new Date(e.time * 1000).toLocaleDateString([], { month: "short", day: "numeric" }),
    balance: e.balance ?? e.value ?? 0,
  })) ?? [];

  // Session countdown display
  const [sessionCountdown, setSessionCountdown] = useState("");
  useEffect(() => {
    const t = setInterval(() => {
      const next = sse.session?.next;
      if (!next) { setSessionCountdown(""); return; }
      const totalSecs = next.minutesUntil * 60;
      if (totalSecs <= 0) { setSessionCountdown(""); return; }
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      if (h > 0) setSessionCountdown(`${h}h ${m}m`);
      else setSessionCountdown(`${m}m ${s}s`);
    }, 1000);
    return () => clearInterval(t);
  }, [sse.session]);

  // Cooldown countdown
  const [cooldownDisplay, setCooldownDisplay] = useState<string | null>(null);
  useEffect(() => {
    const rem = botData?.cooldownSecondsRemaining;
    if (!rem) { setCooldownDisplay(null); return; }
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    setCooldownDisplay(`${m}m ${s}s`);
    const t = setInterval(() => {
      setCooldownDisplay(prev => {
        if (!prev) return null;
        const [mStr, sStr] = prev.split("m ");
        const mVal = parseInt(mStr);
        const sVal = parseInt(sStr);
        let total = mVal * 60 + sVal - 1;
        if (total <= 0) return "Available now";
        return `${Math.floor(total / 60)}m ${total % 60}s`;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [botData?.cooldownSecondsRemaining]);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16">

      {/* ─── TRADE DETAIL MODAL ─── */}
      {selectedTrade && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setSelectedTrade(null)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg bg-card border-t border-border rounded-t-2xl p-5 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {selectedTrade.direction === "BUY" ? (
                  <TrendingUp className="w-5 h-5 text-primary" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-accent-red" />
                )}
                <span className="font-bold text-lg">{selectedTrade.direction}</span>
                <Badge className={`border-0 text-xs ${(selectedTrade.pnl ?? 0) > 0 ? "bg-primary/20 text-primary" : "bg-accent-red/20 text-accent-red"}`}>
                  {(selectedTrade.pnl ?? 0) > 0 ? "WIN" : "LOSS"}
                </Badge>
              </div>
              <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setSelectedTrade(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* P&L + Entry/Exit */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Card className="bg-background border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">P&L</div>
                <div className={`font-bold tabular-nums ${(selectedTrade.pnl ?? 0) > 0 ? "text-primary" : "text-accent-red"}`}>
                  {(selectedTrade.pnl ?? 0) > 0 ? "+" : ""}{(selectedTrade.pnl ?? 0).toFixed(2)}
                </div>
              </Card>
              <Card className="bg-background border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Entry</div>
                <div className="font-mono text-sm font-semibold">{selectedTrade.entryPrice?.toFixed(2) ?? "—"}</div>
              </Card>
              <Card className="bg-background border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Exit</div>
                <div className="font-mono text-sm font-semibold">{selectedTrade.exitPrice?.toFixed(2) ?? "—"}</div>
              </Card>
            </div>

            {/* AI Score Breakdown */}
            {selectedTrade.scoreTotal != null && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Brain className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">AI Score Breakdown</span>
                  <span className="ml-auto font-bold tabular-nums text-primary">{selectedTrade.scoreTotal?.toFixed(1)}/50</span>
                </div>
                <div className="h-1.5 bg-border rounded-full overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (selectedTrade.scoreTotal / 50) * 100)}%` }} />
                </div>
                <div className="space-y-2">
                  {[
                    { label: "Trend", value: selectedTrade.scoreTrend, max: 12 },
                    { label: "Volatility", value: selectedTrade.scoreVolatility, max: 10 },
                    { label: "Timing", value: selectedTrade.scoreTiming, max: 10 },
                    { label: "Pullback", value: selectedTrade.scorePullback, max: 10 },
                    { label: "Risk", value: selectedTrade.scoreRisk, max: 10 },
                  ].map(({ label, value, max }) => value != null && (
                    <ScoreBar key={label} label={label} value={value} max={max} />
                  ))}
                </div>
              </div>
            )}

            {/* Indicators */}
            <div className="mb-4">
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Indicators at Entry</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {selectedTrade.rsiAtEntry != null && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">RSI(14)</span>
                    <span className={`font-mono font-medium ${selectedTrade.rsiAtEntry < 30 ? "text-primary" : selectedTrade.rsiAtEntry > 70 ? "text-accent-red" : "text-foreground"}`}>
                      {selectedTrade.rsiAtEntry?.toFixed(1)}
                    </span>
                  </div>
                )}
                {selectedTrade.stochAtEntry != null && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Stoch %K</span>
                    <span className={`font-mono font-medium ${selectedTrade.stochAtEntry < 20 ? "text-primary" : selectedTrade.stochAtEntry > 80 ? "text-accent-red" : "text-foreground"}`}>
                      {selectedTrade.stochAtEntry?.toFixed(1)}
                    </span>
                  </div>
                )}
                {selectedTrade.macdAtEntry != null && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">MACD Hist</span>
                    <span className={`font-mono font-medium ${(selectedTrade.macdAtEntry ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {selectedTrade.macdAtEntry?.toFixed(3)}
                    </span>
                  </div>
                )}
                {selectedTrade.bbPosition && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">BB Position</span>
                    <span className={`font-medium ${selectedTrade.bbPosition === "LOWER" ? "text-primary" : selectedTrade.bbPosition === "UPPER" ? "text-accent-red" : "text-foreground"}`}>
                      {selectedTrade.bbPosition}
                    </span>
                  </div>
                )}
                {selectedTrade.smcStructure && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">SMC</span>
                    <span className="font-medium text-foreground">{selectedTrade.smcStructure}</span>
                  </div>
                )}
                {selectedTrade.sessionName && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Session</span>
                    <span className="font-medium">{selectedTrade.sessionName}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Trade flags */}
            <div className="flex flex-wrap gap-2 mb-4">
              {selectedTrade.breakEvenMoved === 1 && <Badge className="border-0 bg-primary/10 text-primary text-[10px]">Break Even ✓</Badge>}
              {selectedTrade.partialClosed === 1 && <Badge className="border-0 bg-yellow-500/10 text-yellow-400 text-[10px]">Partial Closed</Badge>}
              {selectedTrade.pullbackZoneActive === 1 && <Badge className="border-0 bg-blue-500/10 text-blue-400 text-[10px]">Pullback Zone</Badge>}
              {selectedTrade.isPaper === 1 && <Badge className="border-0 bg-text-secondary/20 text-text-secondary text-[10px]">Paper Trade</Badge>}
              {selectedTrade.isCopyTrade === 1 && <Badge className="border-0 bg-yellow-500/20 text-yellow-400 text-[10px]">Copy Trade</Badge>}
            </div>

            {/* SL / TP */}
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="bg-background border border-border rounded-lg p-2 text-center">
                <div className="text-text-secondary mb-0.5">Stop Loss</div>
                <div className="font-mono text-accent-red font-semibold">{selectedTrade.stopLoss?.toFixed(2) ?? "—"}</div>
              </div>
              <div className="bg-background border border-border rounded-lg p-2 text-center">
                <div className="text-text-secondary mb-0.5">TP1</div>
                <div className="font-mono text-primary font-semibold">{selectedTrade.takeProfit1?.toFixed(2) ?? "—"}</div>
              </div>
              <div className="bg-background border border-border rounded-lg p-2 text-center">
                <div className="text-text-secondary mb-0.5">TP2</div>
                <div className="font-mono text-primary font-semibold">{selectedTrade.takeProfit2?.toFixed(2) ?? "—"}</div>
              </div>
            </div>

            {/* Duration + Stake */}
            <div className="mt-3 flex justify-between text-xs text-text-secondary">
              <span>Stake: <span className="text-foreground font-medium">${selectedTrade.stake?.toFixed(2) ?? "—"}</span></span>
              <span>Duration: <span className="text-foreground font-medium">{selectedTrade.durationMinutes ?? "—"}m</span></span>
              <span>{new Date((selectedTrade.openedAt || 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="h-[60px] flex items-center justify-between px-4 border-b border-border bg-card fixed top-0 w-full z-10">
        <Logo size="sm" />
        <div className="flex flex-col items-center">
          <span className="text-xs text-text-secondary">V75 INDEX</span>
          <span className={`text-lg font-bold tabular-nums transition-colors duration-150 ${
            priceDir === "up" ? "text-primary" : priceDir === "down" ? "text-accent-red" : "text-foreground"
          }`}>
            {price > 0 ? price.toFixed(2) : "———"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connDotClass}`} title={sse.connected ? "Connected" : "Disconnected"} />
          <div className="w-8 h-8 rounded-full bg-border flex items-center justify-center text-xs font-bold text-foreground select-none">
            {user?.username?.[0]?.toUpperCase() || "U"}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 text-text-secondary hover:text-accent-red hover:bg-accent-red/10 transition-colors"
            onClick={handleLogout}
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Status banner */}
      <div className="mt-[60px]">
        <StatusBanner bot={botData} />
      </div>

      <main className="flex-1 p-4">

        {/* ─── HOME TAB ─── */}
        {activeTab === "home" && (
          <div className="space-y-4">
            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Balance</div>
                <div className="text-xl font-bold tabular-nums">
                  ${(dashboardData?.user?.accountBalance ?? 0).toFixed(2)}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Today P&L</div>
                <div className={`text-xl font-bold tabular-nums ${(botData?.dailyPnl ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                  {(botData?.dailyPnl ?? 0) >= 0 ? "+" : ""}
                  {(botData?.dailyPnl ?? 0).toFixed(2)}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Streak</div>
                <div className="text-xl font-bold tabular-nums">
                  {(botData?.consecutiveWins ?? 0) > 0 ? (
                    <span className="text-primary">+{botData!.consecutiveWins}W</span>
                  ) : (botData?.consecutiveLosses ?? 0) > 0 ? (
                    <span className="text-accent-red">-{botData!.consecutiveLosses}L</span>
                  ) : "—"}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Trades Today</div>
                <div className="text-xl font-bold tabular-nums">
                  {botData?.todayTrades ?? 0}
                </div>
              </Card>
            </div>

            {/* 30-Day Equity Curve */}
            {homeEquityData.length > 1 && (
              <Card className="bg-card border-border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">Account Equity</div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">{homeEquityData.length}d</span>
                    <span className={`text-xs font-bold tabular-nums ${isProfit ? "text-primary" : "text-accent-red"}`}>
                      {isProfit ? "+" : ""}${(homeEquityData[homeEquityData.length - 1].balance - homeEquityData[0].balance).toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="h-[120px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={homeEquityData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={equityColor} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={equityColor} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        stroke="#8890AA"
                        fontSize={9}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        tick={{ fill: "#8890AA" }}
                      />
                      <YAxis
                        domain={["auto", "auto"]}
                        hide
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#0F1117", borderColor: "#1C1F2E", color: "#F0F2FF", fontSize: 11 }}
                        labelStyle={{ color: "#8890AA" }}
                        formatter={(v: number) => [`$${v.toFixed(2)}`, "Balance"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="balance"
                        stroke={equityColor}
                        strokeWidth={2}
                        fill="url(#equityGrad)"
                        dot={false}
                        activeDot={{ r: 3, fill: equityColor }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex justify-between text-[10px] text-text-secondary mt-1">
                  <span>${homeEquityData[0]?.balance.toFixed(0)} start</span>
                  <span>${homeEquityData[homeEquityData.length - 1]?.balance.toFixed(0)} now</span>
                </div>
              </Card>
            )}

            {/* Bot control */}
            <Card className="bg-card border-border p-6 flex flex-col items-center">
              <Button
                onClick={() => {
                  toggleBot.mutate({ data: { running: !isRunning } }, {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
                      queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
                    }
                  });
                }}
                disabled={toggleBot.isPending}
                className={`w-32 h-32 rounded-full mb-4 transition-all duration-300 ${
                  isRunning
                    ? "bg-primary/20 hover:bg-primary/30 border-2 border-primary text-primary"
                    : "bg-card border-2 border-border hover:bg-border text-text-secondary"
                }`}
              >
                {toggleBot.isPending ? (
                  <Loader2 className="w-8 h-8 animate-spin" />
                ) : isRunning ? (
                  <Power className="w-10 h-10" />
                ) : (
                  <Pause className="w-10 h-10" />
                )}
              </Button>
              <div className="text-lg font-bold">{isRunning ? "BOT ACTIVE" : "BOT PAUSED"}</div>
              {botData?.pauseReason && !isRunning && (
                <div className="text-xs text-text-secondary mt-1 text-center max-w-[200px]">
                  {cooldownDisplay && botData.pauseReason.includes("Cooldown")
                    ? `Cooldown — ${cooldownDisplay}`
                    : botData.pauseReason}
                </div>
              )}
              <div className="text-sm text-text-secondary mt-1 capitalize">
                {dashboardData?.user?.tradingProfile ?? "No Profile"} · {dashboardData?.user?.tradingMode ?? "paper"}
              </div>
            </Card>

            {/* Open trade card — live from SSE bot.openTrade */}
            {botData?.openTrade && (
              <Card className="bg-card border-border p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-text-secondary">Open Trade</span>
                  <div className="flex items-center gap-2">
                    <Badge className={`border-0 ${botData.openTrade.direction === "BUY" ? "bg-primary/20 text-primary" : "bg-accent-red/20 text-accent-red"}`}>
                      {botData.openTrade.direction}
                    </Badge>
                    <Badge className="border-0 bg-text-secondary/20 text-text-secondary text-[10px]">LIVE</Badge>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm mb-3">
                  <div>
                    <div className="text-xs text-text-secondary">Entry</div>
                    <div className="font-mono font-semibold">{botData.openTrade.entryPrice?.toFixed(2) ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-text-secondary">Current</div>
                    <div className={`font-mono font-semibold ${priceDir === "up" ? "text-primary" : priceDir === "down" ? "text-accent-red" : "text-foreground"}`}>
                      {price > 0 ? price.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-text-secondary">P&L</div>
                    <div className={`font-mono font-bold ${(botData.openTrade.pnl ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {(botData.openTrade.pnl ?? 0) >= 0 ? "+" : ""}{(botData.openTrade.pnl ?? 0).toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Stop Loss</span>
                    <span className="font-mono text-accent-red">{botData.openTrade.stopLoss?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">TP2</span>
                    <span className="font-mono text-primary">{botData.openTrade.takeProfit2?.toFixed(2) ?? "—"}</span>
                  </div>
                  {botData.openTrade.breakEvenMoved && (
                    <div className="col-span-2">
                      <Badge className="border-0 bg-primary/10 text-primary text-[10px]">Break even moved</Badge>
                    </div>
                  )}
                  {botData.openTrade.partialClosed && (
                    <div className="col-span-2">
                      <Badge className="border-0 bg-yellow-500/10 text-yellow-400 text-[10px]">TP1 partial closed</Badge>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* Session info */}
            {sse.session && (
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-2 uppercase tracking-wide">Trading Sessions</div>
                <div className="space-y-2">
                  {sse.session.all.map((s) => (
                    <div key={s.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${s.isActive ? "bg-primary animate-pulse" : "bg-border"}`} />
                        <span className={`text-xs ${s.isActive ? "text-foreground font-medium" : "text-text-secondary"}`}>
                          {s.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          s.quality === "PREMIUM" ? "bg-primary/20 text-primary" :
                          s.quality === "HIGH" ? "bg-yellow-500/20 text-yellow-400" :
                          "bg-border text-text-secondary"
                        }`}>
                          {s.quality}
                        </span>
                        {s.isActive && <span className="text-[10px] text-primary font-medium">ACTIVE</span>}
                      </div>
                    </div>
                  ))}
                  {sse.session.next && !sse.session.current && (
                    <div className="text-xs text-text-secondary mt-2">
                      {sse.session.next.name} opens in {sessionCountdown || `${sse.session.next.minutesUntil}m`}
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ─── CHART TAB ─── */}
        {activeTab === "chart" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-foreground">V75 Price Chart</h2>
              <div className="flex gap-1">
                {(["1m", "5m", "15m"] as Timeframe[]).map((tf) => (
                  <Button
                    key={tf}
                    size="sm"
                    variant="ghost"
                    className={`h-7 px-3 text-xs font-mono ${timeframe === tf ? "bg-primary/20 text-primary" : "text-text-secondary hover:text-foreground"}`}
                    onClick={() => setTimeframe(tf)}
                  >
                    {tf}
                  </Button>
                ))}
              </div>
            </div>

            <Card className="bg-card border-border p-4">
              {candlesLoading ? (
                <div className="h-[280px] flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : chartData.length > 0 ? (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#00D4A4" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#00D4A4" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1C1F2E" vertical={false} />
                      <XAxis
                        dataKey="time"
                        stroke="#8890AA"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        tick={{ fill: "#8890AA" }}
                      />
                      <YAxis
                        stroke="#8890AA"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        domain={["auto", "auto"]}
                        tick={{ fill: "#8890AA" }}
                        tickFormatter={(v: number) => v.toFixed(0)}
                        width={55}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#0F1117", borderColor: "#1C1F2E", color: "#F0F2FF", fontSize: 12 }}
                        labelStyle={{ color: "#8890AA" }}
                        formatter={(v: number) => [v.toFixed(2), "Price"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke="#00D4A4"
                        strokeWidth={2}
                        fill="url(#priceGradient)"
                        dot={false}
                        activeDot={{ r: 4, fill: "#00D4A4" }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[280px] flex flex-col items-center justify-center text-text-secondary text-sm gap-2">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <span>Connecting to live Deriv data...</span>
                </div>
              )}
            </Card>

            {/* Live price + AI score row */}
            <div className="grid grid-cols-3 gap-3">
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Live Price</div>
                <div className={`font-bold font-mono text-sm ${priceDir === "up" ? "text-primary" : priceDir === "down" ? "text-accent-red" : "text-foreground"}`}>
                  {price > 0 ? price.toFixed(2) : "—"}
                </div>
              </Card>
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Drawdown</div>
                <div className="font-bold text-accent-red text-sm">
                  {(botData?.currentDrawdown ?? 0) > 0 ? `-${((botData?.currentDrawdown ?? 0) * 100).toFixed(1)}%` : "0%"}
                </div>
              </Card>
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">AI Score</div>
                <div className={`font-bold text-sm ${
                  (sse.scores?.total ?? 0) >= 38 ? "text-primary" :
                  (sse.scores?.total ?? 0) >= 25 ? "text-yellow-400" : "text-text-secondary"
                }`}>
                  {sse.scores?.loading ? "…" : sse.scores?.total != null ? `${sse.scores.total.toFixed(1)}/50` : "—"}
                </div>
              </Card>
            </div>

            {/* AI Score breakdown panel */}
            {sse.scores && !sse.scores.loading && (
              <Card className="bg-card border-border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium">AI Signal Analysis</span>
                  </div>
                  {sse.scores.direction && sse.scores.direction !== "NONE" && (
                    <Badge className={`border-0 font-bold ${sse.scores.direction === "BUY" ? "bg-primary/20 text-primary" : "bg-accent-red/20 text-accent-red"}`}>
                      {sse.scores.direction}
                    </Badge>
                  )}
                  {sse.scores.direction === "NONE" && (
                    <Badge className="border-0 bg-text-secondary/20 text-text-secondary">NO SIGNAL</Badge>
                  )}
                </div>

                {/* Score bars */}
                <div className="space-y-2 mb-4">
                  <ScoreBar label="Trend" value={sse.scores.trend ?? 0} max={12} />
                  <ScoreBar label="Volatility" value={sse.scores.volatility ?? 0} max={10} />
                  <ScoreBar label="Timing" value={sse.scores.timing ?? 0} max={10} />
                  <ScoreBar label="Pullback" value={sse.scores.pullback ?? 0} max={10} />
                  <ScoreBar label="Risk" value={sse.scores.risk ?? 0} max={10} />
                </div>

                {/* Total score bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-text-secondary">Total Score</span>
                    <span className={`font-bold font-mono ${(sse.scores.total ?? 0) >= 38 ? "text-primary" : "text-text-secondary"}`}>
                      {(sse.scores.total ?? 0).toFixed(1)} / 50
                    </span>
                  </div>
                  <div className="h-2 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, ((sse.scores.total ?? 0) / 50) * 100)}%`,
                        backgroundColor: (sse.scores.total ?? 0) >= 38 ? "#00D4A4" : (sse.scores.total ?? 0) >= 25 ? "#FFB347" : "#FF4060"
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-text-secondary mt-1">
                    <span>0</span>
                    <span className="text-primary">38 threshold</span>
                    <span>50</span>
                  </div>
                </div>

                {/* Indicator grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">RSI(14)</span>
                    <span className={`font-mono font-medium ${
                      (sse.scores.rsi ?? 50) < 30 ? "text-primary" :
                      (sse.scores.rsi ?? 50) > 70 ? "text-accent-red" : "text-foreground"
                    }`}>{sse.scores.rsi?.toFixed(1) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">ADX</span>
                    <span className={`font-mono font-medium ${(sse.scores.adx ?? 0) >= 25 ? "text-primary" : "text-text-secondary"}`}>
                      {sse.scores.adx?.toFixed(1) ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Stoch %K</span>
                    <span className={`font-mono font-medium ${
                      (sse.scores.stochK ?? 50) < 20 ? "text-primary" :
                      (sse.scores.stochK ?? 50) > 80 ? "text-accent-red" : "text-foreground"
                    }`}>{sse.scores.stochK?.toFixed(1) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">MACD Hist</span>
                    <span className={`font-mono font-medium ${(sse.scores.macdHistogram ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {sse.scores.macdHistogram?.toFixed(4) ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA9</span>
                    <span className="font-mono">{sse.scores.ema9?.toFixed(1) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA21</span>
                    <span className="font-mono">{sse.scores.ema21?.toFixed(1) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Trend</span>
                    <span className={`font-medium ${
                      sse.scores.trendDirection === "BULL" ? "text-primary" :
                      sse.scores.trendDirection === "BEAR" ? "text-accent-red" : "text-text-secondary"
                    }`}>{sse.scores.trendDirection ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Band</span>
                    <span className={`font-medium ${
                      sse.scores.bandTouched === "LOWER" ? "text-primary" :
                      sse.scores.bandTouched === "UPPER" ? "text-accent-red" : "text-text-secondary"
                    }`}>{sse.scores.bandTouched ?? "NONE"}</span>
                  </div>
                </div>

                {/* Context flags */}
                <div className="flex gap-2 mt-3 flex-wrap">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${sse.scores.pullbackZone ? "bg-primary/20 text-primary" : "bg-border text-text-secondary"}`}>
                    Pullback Zone
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${sse.scores.consolidation ? "bg-yellow-500/20 text-yellow-400" : "bg-border text-text-secondary"}`}>
                    Consolidation
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${sse.scores.spikeDetected ? "bg-accent-red/20 text-accent-red" : "bg-border text-text-secondary"}`}>
                    Spike
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full bg-border text-text-secondary`}>
                    {sse.scores.rangeContext ?? "middle"}
                  </span>
                </div>

                {sse.scores.rejectionReason && (
                  <div className="mt-2 text-xs text-text-secondary">
                    ↳ {sse.scores.rejectionReason}
                  </div>
                )}
              </Card>
            )}

            {sse.scores?.loading && (
              <Card className="bg-card border-border p-4 flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
                <div>
                  <div className="text-sm font-medium">Gathering market data</div>
                  <div className="text-xs text-text-secondary">
                    {sse.scores.candlesLoaded ?? 0} / 50 candles needed
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ─── TRADES TAB ─── */}
        {activeTab === "trades" && (
          <div className="space-y-4">
            {/* Stats summary */}
            {stats && (
              <div className="grid grid-cols-3 gap-3">
                <Card className="bg-card border-border p-3 text-center">
                  <div className="text-xs text-text-secondary mb-1">Win Rate</div>
                  <div className="font-bold text-primary">
                    {(stats as any).totalTrades >= 10
                      ? `${(stats as any).winRate?.toFixed(1)}%`
                      : "—"}
                  </div>
                </Card>
                <Card className="bg-card border-border p-3 text-center">
                  <div className="text-xs text-text-secondary mb-1">Total P&L</div>
                  <div className={`font-bold ${(stats as any).totalPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                    {(stats as any).totalPnl >= 0 ? "+" : ""}{(stats as any).totalPnl?.toFixed(2)}
                  </div>
                </Card>
                <Card className="bg-card border-border p-3 text-center">
                  <div className="text-xs text-text-secondary mb-1">Trades</div>
                  <div className="font-bold">{(stats as any).totalTrades}</div>
                </Card>
              </div>
            )}

            {/* Extended stats */}
            {stats && (stats as any).totalTrades > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <Card className="bg-card border-border p-3">
                  <div className="text-xs text-text-secondary mb-1">Profit Factor</div>
                  <div className="font-bold">{(stats as any).profitFactor?.toFixed(2) ?? "—"}</div>
                </Card>
                <Card className="bg-card border-border p-3">
                  <div className="text-xs text-text-secondary mb-1">Avg Duration</div>
                  <div className="font-bold">{(stats as any).avgDuration?.toFixed(0) ?? "—"}m</div>
                </Card>
                <Card className="bg-card border-border p-3">
                  <div className="text-xs text-text-secondary mb-1">Best Win</div>
                  <div className="font-bold text-primary">+{(stats as any).largestWin?.toFixed(2) ?? "—"}</div>
                </Card>
                <Card className="bg-card border-border p-3">
                  <div className="text-xs text-text-secondary mb-1">Worst Loss</div>
                  <div className="font-bold text-accent-red">{(stats as any).largestLoss?.toFixed(2) ?? "—"}</div>
                </Card>
              </div>
            )}

            {/* Equity curve */}
            {equityData.length > 1 && (
              <Card className="bg-card border-border p-4">
                <div className="text-sm font-medium text-text-secondary mb-3">Equity Curve</div>
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={equityData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <YAxis domain={["auto", "auto"]} hide />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#0F1117", borderColor: "#1C1F2E", color: "#F0F2FF", fontSize: 11 }}
                        formatter={(v: number) => [`$${v.toFixed(2)}`, "Balance"]}
                      />
                      <Line type="monotone" dataKey="balance" stroke="#FFB347" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            {/* Session Performance Breakdown */}
            {sessionStats.length > 0 && (
              <Card className="bg-card border-border p-4">
                <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">Session Performance</div>
                <div className="space-y-2.5">
                  {sessionStats.map((s) => {
                    const wr = s.winRate;
                    const barColor = wr >= 60 ? "#00D4A4" : wr >= 45 ? "#FFB347" : "#FF4060";
                    return (
                      <div key={s.name}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-foreground font-medium truncate max-w-[140px]">{s.name}</span>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-text-secondary tabular-nums">{s.trades}T</span>
                            <span className="font-bold tabular-nums" style={{ color: barColor }}>{wr}%</span>
                            <span className={`font-bold tabular-nums ${s.totalPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                              {s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(0)}
                            </span>
                          </div>
                        </div>
                        <div className="h-1 bg-border rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${wr}%`, backgroundColor: barColor }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* Filter tabs */}
            <div className="flex gap-1 overflow-x-auto pb-1">
              {(["all", "win", "loss", "paper", "copy"] as TradeFilter[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant="ghost"
                  className={`h-7 px-3 text-xs capitalize whitespace-nowrap ${tradeFilter === f ? "bg-primary/20 text-primary" : "text-text-secondary hover:text-foreground"}`}
                  onClick={() => setTradeFilter(f)}
                >
                  {f}
                </Button>
              ))}
            </div>

            {/* Trade list */}
            {tradesLoading ? (
              <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
            ) : (
              <div className="space-y-2">
                {tradesData?.trades?.map((trade) => {
                  const pnl = trade.pnl ?? 0;
                  const isWin = pnl > 0;
                  const isOpen = trade.status === "open";
                  return (
                    <Card
                      key={trade.id}
                      className="bg-card border-border p-3 cursor-pointer hover:border-primary/40 transition-colors active:scale-[0.99]"
                      onClick={() => setSelectedTrade(trade)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {trade.direction === "BUY" ? (
                            <TrendingUp className="w-4 h-4 text-primary" />
                          ) : (
                            <TrendingDown className="w-4 h-4 text-accent-red" />
                          )}
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-medium">{trade.direction}</span>
                              {isOpen && <Badge className="h-4 text-[10px] bg-primary/20 text-primary border-0 px-1">LIVE</Badge>}
                              {trade.isCopyTrade === 1 && <Badge className="h-4 text-[10px] bg-yellow-500/20 text-yellow-400 border-0 px-1">COPY</Badge>}
                              {trade.isPaper === 1 && <Badge className="h-4 text-[10px] bg-text-secondary/20 text-text-secondary border-0 px-1">PAPER</Badge>}
                            </div>
                            <div className="text-xs text-text-secondary font-mono">
                              {trade.entryPrice?.toFixed(2) ?? "—"} → {trade.exitPrice?.toFixed(2) ?? "open"}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-bold tabular-nums ${isWin ? "text-primary" : isOpen ? "text-text-secondary" : "text-accent-red"}`}>
                            {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                          </div>
                          {trade.scoreTotal != null && (
                            <div className="text-xs text-text-secondary">Score: {trade.scoreTotal.toFixed(0)}</div>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-text-secondary">
                        <span>
                          {new Date((trade.openedAt || 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {trade.sessionName ? ` · ${trade.sessionName}` : ""}
                        </span>
                        {trade.durationMinutes != null && <span>{trade.durationMinutes}m</span>}
                      </div>
                    </Card>
                  );
                })}
                {(!tradesData?.trades || tradesData.trades.length === 0) && (
                  <div className="text-center p-8 text-text-secondary border border-dashed border-border rounded-xl">
                    No trades yet. Start the bot to begin trading.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── SETTINGS TAB ─── */}
        {activeTab === "settings" && (
          <div className="space-y-4">
            <Card className="p-4 bg-card border border-border rounded-xl">
              <h3 className="font-bold mb-4">Account</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Username</span>
                  <span className="font-medium">{user?.username}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Profile</span>
                  <span className="font-medium capitalize">{dashboardData?.user?.tradingProfile ?? "Not set"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Mode</span>
                  <span className="font-medium capitalize">{dashboardData?.user?.tradingMode ?? "paper"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Deriv Token</span>
                  <span className={dashboardData?.user?.hasDerivToken ? "text-primary" : "text-accent-red"}>
                    {dashboardData?.user?.hasDerivToken ? "✓ Connected" : "Not connected"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Copy Trading</span>
                  <span className={dashboardData?.user?.copyTradingEnabled ? "text-primary" : "text-text-secondary"}>
                    {dashboardData?.user?.copyTradingEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="p-4 bg-card border border-border rounded-xl">
              <h3 className="font-bold mb-3">Connection</h3>
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${connDotClass}`} />
                <div className="text-sm">
                  {sse.connected ? (
                    <span className="text-primary">
                      Live — V75 @ {price > 0 ? price.toFixed(2) : "loading..."}
                    </span>
                  ) : (
                    <span className="text-accent-red">Disconnected — reconnecting...</span>
                  )}
                </div>
              </div>
            </Card>

            <Button
              variant="outline"
              className="w-full text-accent-red border-accent-red/20 hover:bg-accent-red/10 hover:text-accent-red"
              onClick={handleLogout}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        )}
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 w-full h-[64px] bg-card border-t border-border flex items-center justify-around px-2 z-10">
        {[
          { id: "home", label: "Home", icon: Home },
          { id: "chart", label: "Chart", icon: BarChart2 },
          { id: "trades", label: "Trades", icon: List },
          { id: "settings", label: "Settings", icon: SettingsIcon }
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex flex-col items-center p-2 w-16 transition-colors ${activeTab === id ? "text-primary" : "text-text-secondary"}`}
          >
            <Icon className="w-5 h-5 mb-1" />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
