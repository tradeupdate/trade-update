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
  X, ChevronRight, Eye, EyeOff, Link2, CheckCircle2,
  Activity, Save, RefreshCw, Shield, Target, Bell, Zap, Award
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

function ScoreBar({ label, value, min = 0, max = 10 }: { label: string; value: number; min?: number; max?: number }) {
  const range = max - min;
  const pct = range > 0 ? Math.min(100, Math.max(0, ((value - min) / range) * 100)) : 0;
  const color = value < 0 ? "#FF4060" : pct >= 66 ? "#00D4A4" : pct >= 33 ? "#FFB347" : "#FF4060";
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

function RiskGaugeCard({ dailyPnl, maxDailyLossPct, balance, profitLockHit, dailyProfitTarget }: {
  dailyPnl: number; maxDailyLossPct: number; balance: number; profitLockHit?: boolean; dailyProfitTarget?: number | null;
}) {
  const dailyStartBalance = Math.max(balance - dailyPnl, 1);
  const dailyLossPct = dailyPnl < 0 ? (Math.abs(dailyPnl) / dailyStartBalance) * 100 : 0;
  const limitPct = maxDailyLossPct > 0 ? Math.min(100, (dailyLossPct / maxDailyLossPct) * 100) : 0;
  const gaugeColor = limitPct >= 80 ? "#FF4060" : limitPct >= 50 ? "#FFB347" : "#00D4A4";
  const riskLevel = limitPct >= 80 ? "HIGH" : limitPct >= 50 ? "MODERATE" : "LOW";
  const riskBadge = limitPct >= 80 ? "bg-accent-red/20 text-accent-red" : limitPct >= 50 ? "bg-yellow-500/20 text-yellow-400" : "bg-primary/20 text-primary";

  const r = 48; const cx = 60; const cy = 58;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const ax = (a: number) => cx + r * Math.cos(toRad(a));
  const ay = (a: number) => cy + r * Math.sin(toRad(a));
  const endAngle = -180 + (180 * Math.min(limitPct, 100)) / 100;
  const largeArc = limitPct > 50 ? 1 : 0;
  const bgPath = `M ${ax(-180)} ${ay(-180)} A ${r} ${r} 0 0 1 ${ax(0)} ${ay(0)}`;
  const fillPath = limitPct > 0 ? `M ${ax(-180)} ${ay(-180)} A ${r} ${r} 0 ${largeArc} 1 ${ax(endAngle)} ${ay(endAngle)}` : "";

  return (
    <Card className="bg-card border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" /> Risk Gauge
        </div>
        <Badge className={`border-0 text-[10px] ${riskBadge}`}>{riskLevel} RISK</Badge>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <svg viewBox="0 0 120 66" className="w-[110px] h-[60px]">
            <path d={bgPath} fill="none" stroke="#1C1F2E" strokeWidth="11" strokeLinecap="round" />
            {limitPct > 0 && <path d={fillPath} fill="none" stroke={gaugeColor} strokeWidth="11" strokeLinecap="round" />}
            <text x="60" y="54" textAnchor="middle" fill={gaugeColor} fontSize="13" fontWeight="bold" fontFamily="monospace">{limitPct.toFixed(0)}%</text>
            <text x="60" y="64" textAnchor="middle" fill="#8890AA" fontSize="7" fontFamily="sans-serif">of limit used</text>
          </svg>
        </div>
        <div className="flex-1 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-text-secondary">Today P&L</span>
            <span className={`font-mono font-bold tabular-nums ${dailyPnl < 0 ? "text-accent-red" : dailyPnl > 0 ? "text-primary" : "text-text-secondary"}`}>
              {dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Loss limit ({maxDailyLossPct}%)</span>
            <span className="font-mono text-text-secondary tabular-nums">${((dailyStartBalance * maxDailyLossPct) / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Drawdown</span>
            <span className={`font-mono font-bold tabular-nums ${dailyLossPct > 3 ? "text-accent-red" : "text-text-secondary"}`}>{dailyLossPct.toFixed(1)}%</span>
          </div>
          {dailyProfitTarget && dailyProfitTarget > 0 && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Profit target</span>
              <span className={`font-mono tabular-nums ${profitLockHit ? "text-primary font-bold" : "text-text-secondary"}`}>
                ${dailyProfitTarget.toFixed(2)}{profitLockHit ? " ✓" : ""}
              </span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function ProfitLockBar({ dailyPnl, target, profitLockHit }: { dailyPnl: number; target: number; profitLockHit?: boolean }) {
  const pct = target > 0 ? Math.min(100, Math.max(0, (dailyPnl / target) * 100)) : 0;
  const isHit = profitLockHit || pct >= 100;
  const barColor = isHit ? "#00D4A4" : pct >= 75 ? "#FFB347" : "#00D4A4";
  return (
    <Card className={`bg-card p-4 border transition-colors ${isHit ? "border-primary/50" : "border-border"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary uppercase tracking-wide">
          <Target className="w-3.5 h-3.5" /> Profit Lock
        </div>
        <div className="flex items-center gap-2">
          {isHit && <Badge className="border-0 bg-primary/20 text-primary text-[10px]">🎯 TARGET HIT</Badge>}
          <span className={`text-xs font-bold tabular-nums font-mono ${dailyPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
            {dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)} <span className="text-text-secondary font-normal">/ ${target.toFixed(2)}</span>
          </span>
        </div>
      </div>
      <div className="h-2.5 bg-border rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: barColor }} />
      </div>
      <div className="flex justify-between text-[10px] text-text-secondary mt-1">
        <span>$0</span>
        <span>{pct.toFixed(0)}% of target</span>
        <span>${target.toFixed(2)}</span>
      </div>
    </Card>
  );
}

function BacktestSummaryCard({ summary }: { summary: any }) {
  if (!summary) return null;
  const runDate = summary.createdAt
    ? new Date(summary.createdAt * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
    : "—";
  const pf = summary.profitFactor ?? 0;
  const pfColor = pf >= 1.5 ? "text-primary" : pf >= 1 ? "text-yellow-400" : "text-accent-red";
  return (
    <Card className="bg-card border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
          <Award className="w-3.5 h-3.5" /> Strategy Backtest
        </div>
        <span className="text-[10px] text-text-secondary">{runDate}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div>
          <div className="text-xl font-bold text-primary tabular-nums">{summary.winRate?.toFixed(1)}%</div>
          <div className="text-[10px] text-text-secondary">Win Rate</div>
        </div>
        <div>
          <div className={`text-xl font-bold tabular-nums ${pfColor}`}>{pf.toFixed(2)}</div>
          <div className="text-[10px] text-text-secondary">Prof. Factor</div>
        </div>
        <div>
          <div className="text-xl font-bold text-accent-red tabular-nums">{summary.maxDrawdown?.toFixed(1)}%</div>
          <div className="text-[10px] text-text-secondary">Max DD</div>
        </div>
      </div>
      <div className="pt-2 border-t border-border/50 flex justify-between text-[10px] text-text-secondary">
        <span>{summary.totalTrades} trades simulated</span>
        {summary.sharpeRatio != null && <span>Sharpe {summary.sharpeRatio?.toFixed(2)}</span>}
        {summary.avgDurationMinutes != null && <span>Avg {summary.avgDurationMinutes?.toFixed(0)}m/trade</span>}
      </div>
      <p className="text-[10px] text-text-secondary/50 text-center mt-1.5">Reference only — past performance ≠ future results</p>
    </Card>
  );
}

interface DeepStats {
  maxWinStreak: number; maxLossStreak: number;
  avgWinDuration: number; avgLossDuration: number;
  expectancy: number; avgWinLossRatio: number;
  avgWin: number; avgLoss: number;
  bestSession: { name: string; winRate: number } | null;
  worstSession: { name: string; winRate: number } | null;
  totalTrades: number;
}

function DeepStatsPanel({ stats }: { stats: DeepStats | null }) {
  if (!stats || stats.totalTrades < 3) return null;
  const expColor = stats.expectancy >= 0 ? "text-primary" : "text-accent-red";
  return (
    <Card className="bg-card border-border p-4">
      <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5" /> Deep Stats
      </div>
      <div className="grid grid-cols-2 gap-2.5 text-xs">
        <div className="bg-background rounded-lg p-2.5">
          <div className="text-text-secondary mb-1">Avg Win / Loss</div>
          <div className="font-bold text-sm">
            <span className="text-primary">+${stats.avgWin.toFixed(2)}</span>
            <span className="text-text-secondary"> / </span>
            <span className="text-accent-red">${Math.abs(stats.avgLoss).toFixed(2)}</span>
          </div>
          <div className="text-text-secondary mt-0.5">{stats.avgWinLossRatio.toFixed(2)}:1 ratio</div>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <div className="text-text-secondary mb-1">Expectancy / Trade</div>
          <div className={`font-bold text-sm ${expColor}`}>{stats.expectancy >= 0 ? "+" : ""}${stats.expectancy.toFixed(2)}</div>
          <div className="text-text-secondary mt-0.5">per closed trade</div>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <div className="text-text-secondary mb-1">Best Streak Ever</div>
          <div className="font-bold text-primary text-sm">+{stats.maxWinStreak}W</div>
          <div className="text-accent-red mt-0.5">-{stats.maxLossStreak}L worst</div>
        </div>
        <div className="bg-background rounded-lg p-2.5">
          <div className="text-text-secondary mb-1">Avg Hold Time</div>
          <div className="font-bold text-primary text-sm">{stats.avgWinDuration.toFixed(0)}m <span className="text-[10px] font-normal text-text-secondary">winners</span></div>
          <div className="text-accent-red mt-0.5">{stats.avgLossDuration.toFixed(0)}m <span className="text-[10px] font-normal text-text-secondary">losers</span></div>
        </div>
        {stats.bestSession && (
          <div className="bg-background rounded-lg p-2.5">
            <div className="text-text-secondary mb-1">Best Session</div>
            <div className="font-bold text-primary text-sm truncate">{stats.bestSession.name}</div>
            <div className="text-text-secondary mt-0.5">{stats.bestSession.winRate.toFixed(0)}% win rate</div>
          </div>
        )}
        {stats.worstSession && (
          <div className="bg-background rounded-lg p-2.5">
            <div className="text-text-secondary mb-1">Worst Session</div>
            <div className="font-bold text-accent-red text-sm truncate">{stats.worstSession.name}</div>
            <div className="text-text-secondary mt-0.5">{stats.worstSession.winRate.toFixed(0)}% win rate</div>
          </div>
        )}
      </div>
    </Card>
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
  const [showTokenChars, setShowTokenChars] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);

  // Balance sync
  const [balanceSyncing, setBalanceSyncing] = useState(false);
  const [lastSyncedBalance, setLastSyncedBalance] = useState<number | null>(null);

  // Bot settings form
  const [stakeInput, setStakeInput] = useState("");
  const [maxLossInput, setMaxLossInput] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [demoToggling, setDemoToggling] = useState(false);

  // Pair selection
  const [pairSwitching, setPairSwitching] = useState(false);
  const [pairSwitchMsg, setPairSwitchMsg] = useState<string | null>(null);

  // Profit lock target
  const [profitTargetInput, setProfitTargetInput] = useState("");

  // Browser push notifications
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");

  // Backtest summary
  const [backtestSummary, setBacktestSummary] = useState<any>(null);

  // Activity log history (fetched on first open)
  const [activityHistory, setActivityHistory] = useState<Array<{message: string; level: string; createdAt: number}>>([]);
  const [activityLoaded, setActivityLoaded] = useState(false);

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
        const data = await res.json();
        setTokenSaved(true);
        setDerivTokenInput("");
        setShowTokenInput(false);
        if (data.derivBalance != null) setLastSyncedBalance(data.derivBalance);
        queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
        setTimeout(() => setTokenSaved(false), 3000);
      }
    } finally {
      setTokenSaving(false);
    }
  };

  const handleSyncBalance = async () => {
    setBalanceSyncing(true);
    try {
      const res = await fetch("/api/user/deriv/sync-balance", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        setLastSyncedBalance(data.derivBalance);
        queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
      }
    } finally {
      setBalanceSyncing(false);
    }
  };

  const handleSaveSettings = async () => {
    const body: Record<string, number | null> = {};
    if (stakeInput) body.stakeSize = parseFloat(stakeInput);
    if (maxLossInput) body.maxDailyLoss = parseFloat(maxLossInput);
    if (profitTargetInput) body.dailyProfitTarget = parseFloat(profitTargetInput);
    else if (profitTargetInput === "") body.dailyProfitTarget = null;
    if (Object.keys(body).length === 0) return;
    setSettingsSaving(true);
    try {
      const res = await fetch("/api/user/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSettingsSaved(true);
        queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
        setTimeout(() => setSettingsSaved(false), 2500);
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSwitchPair = async (pair: "R_75" | "R_10") => {
    if (pair === activePair || pairSwitching) return;
    setPairSwitching(true);
    setPairSwitchMsg(null);
    try {
      const res = await fetch("/api/user/settings/pair", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pair }),
      });
      const data = await res.json();
      if (res.ok) {
        setPairSwitchMsg(`Switched to ${pair}`);
        queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
        setTimeout(() => setPairSwitchMsg(null), 3000);
      } else {
        setPairSwitchMsg(data.error || "Switch failed");
        setTimeout(() => setPairSwitchMsg(null), 4000);
      }
    } finally {
      setPairSwitching(false);
    }
  };

  const handleToggleDemoMode = async () => {
    setDemoToggling(true);
    try {
      await fetch("/api/user/demo-mode", { method: "PATCH", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
    } finally {
      setDemoToggling(false);
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

  const activePair = (dashboardData?.user as any)?.activePair ?? "R_75";

  // Populate bot settings form from fetched user data (runs after dashboardData is defined)
  useEffect(() => {
    if (!dashboardData?.user) return;
    const u = dashboardData.user as any;
    if (u.stakeSize != null && stakeInput === "") setStakeInput(String(u.stakeSize));
    if (u.maxDailyLoss != null && maxLossInput === "") setMaxLossInput(String(u.maxDailyLoss));
    if (u.dailyProfitTarget != null && profitTargetInput === "") setProfitTargetInput(String(u.dailyProfitTarget));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardData?.user]);

  // Init notification permission state
  useEffect(() => {
    if ("Notification" in window) setNotifPermission(Notification.permission);
  }, []);

  // Fetch backtest summary for user's strategy
  useEffect(() => {
    fetch("/api/user/backtest-summary", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.summary) setBacktestSummary(d.summary); })
      .catch(() => {});
  }, [dashboardData?.user?.strategyId]);

  // Push notifications on bot events
  const prevDailyLossHit = useRef(false);
  const prevProfitLockHit = useRef(false);
  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const bot = sse.bot as any;
    const hitLoss = !!bot?.dailyLossHit;
    const hitProfit = !!bot?.profitLockHit;
    if (hitLoss && !prevDailyLossHit.current) {
      new Notification("⚠️ Daily Loss Limit Hit", { body: "Bot has been automatically stopped to protect your capital.", icon: "/favicon.ico" });
    }
    if (hitProfit && !prevProfitLockHit.current) {
      new Notification("🎯 Profit Target Reached!", { body: `Daily target hit — gains locked in at +$${bot?.dailyPnl?.toFixed(2) ?? "0.00"}`, icon: "/favicon.ico" });
    }
    prevDailyLossHit.current = hitLoss;
    prevProfitLockHit.current = hitProfit;
  }, [(sse.bot as any)?.dailyLossHit, (sse.bot as any)?.profitLockHit]);

  useEffect(() => {
    if (!sse.lastTrade || !("Notification" in window) || Notification.permission !== "granted") return;
    if (sse.lastTrade.action === "closed") {
      const pnl: number = (sse.lastTrade as any).pnl ?? 0;
      const isWin = pnl > 0;
      new Notification(isWin ? `✅ Trade Won +$${pnl.toFixed(2)}` : `❌ Trade Lost $${Math.abs(pnl).toFixed(2)}`, {
        body: `${(sse.lastTrade as any).direction ?? ""} ${(sse.lastTrade as any).symbol ?? ""} — tap to view`.trim(),
        icon: "/favicon.ico",
      });
    }
  }, [sse.lastTrade]);

  // Fetch activity log history when activity tab opens
  useEffect(() => {
    if (activeTab !== "activity" || activityLoaded) return;
    fetch("/api/user/activity-log?limit=100", { credentials: "include" })
      .then(r => r.json())
      .then(d => { setActivityHistory(d.logs || []); setActivityLoaded(true); })
      .catch(() => {});
  }, [activeTab, activityLoaded]);

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

  // Deep stats — computed client-side from already-fetched trade history
  const deepStats = useMemo((): DeepStats | null => {
    const allTrades = equityTradesData?.trades ?? [];
    const closed = [...allTrades].filter(t => t.status === "closed").sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
    if (closed.length < 3) return null;
    const wins = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    const winRate = closed.length > 0 ? wins.length / closed.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;
    let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
    for (const t of closed) {
      if ((t.pnl ?? 0) > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
      else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
    }
    const avgWinDuration = wins.length > 0 ? wins.reduce((s, t) => s + ((t as any).durationMinutes ?? 0), 0) / wins.length : 0;
    const avgLossDuration = losses.length > 0 ? losses.reduce((s, t) => s + ((t as any).durationMinutes ?? 0), 0) / losses.length : 0;
    const expectancy = (winRate * avgWin) + ((1 - winRate) * avgLoss);
    const avgWinLossRatio = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;
    const sessionMap: Record<string, { wins: number; trades: number }> = {};
    for (const t of closed) {
      const sn = t.sessionName ?? "Unknown";
      if (!sessionMap[sn]) sessionMap[sn] = { wins: 0, trades: 0 };
      sessionMap[sn].trades++;
      if ((t.pnl ?? 0) > 0) sessionMap[sn].wins++;
    }
    const sessions = Object.entries(sessionMap)
      .filter(([, s]) => s.trades >= 3)
      .map(([name, s]) => ({ name, winRate: (s.wins / s.trades) * 100 }))
      .sort((a, b) => b.winRate - a.winRate);
    return {
      maxWinStreak, maxLossStreak,
      avgWinDuration: Math.round(avgWinDuration * 10) / 10,
      avgLossDuration: Math.round(avgLossDuration * 10) / 10,
      expectancy: Math.round(expectancy * 100) / 100,
      avgWinLossRatio: Math.round(avgWinLossRatio * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      bestSession: sessions[0] ?? null,
      worstSession: sessions[sessions.length - 1] ?? null,
      totalTrades: closed.length,
    };
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
                  <span className="ml-auto font-bold tabular-nums text-primary">{selectedTrade.scoreTotal?.toFixed(1)}/25</span>
                </div>
                <div className="h-1.5 bg-border rounded-full overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (selectedTrade.scoreTotal / 25) * 100)}%` }} />
                </div>
                <div className="space-y-2">
                  {[
                    { label: "1h Trend", value: selectedTrade.scoreTrend, min: 0, max: 10 },
                    { label: "15m Conf", value: selectedTrade.scoreVolatility, min: -2, max: 5 },
                    { label: "5m Entry", value: selectedTrade.scoreTiming, min: 0, max: 10 },
                  ].map(({ label, value, min, max }) => value != null && (
                    <ScoreBar key={label} label={label} value={value} min={min} max={max} />
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
          <span className="text-xs text-text-secondary">{activePair === "R_10" ? "V10 INDEX" : "V75 INDEX"}</span>
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
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-text-secondary">Balance</div>
                  {dashboardData?.user?.tradingMode !== "paper" && dashboardData?.user?.hasDerivToken && (
                    <button
                      onClick={handleSyncBalance}
                      disabled={balanceSyncing}
                      className="text-text-secondary hover:text-primary transition-colors disabled:opacity-50"
                      title="Sync balance from Deriv"
                    >
                      <RefreshCw className={`w-3 h-3 ${balanceSyncing ? "animate-spin" : ""}`} />
                    </button>
                  )}
                </div>
                <div className="text-xl font-bold tabular-nums">
                  ${(lastSyncedBalance ?? dashboardData?.user?.accountBalance ?? 0).toFixed(2)}
                </div>
                {lastSyncedBalance != null && (
                  <div className="text-[10px] text-primary mt-0.5">● synced from Deriv</div>
                )}
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

            {/* ── Risk Gauge Card ── */}
            <RiskGaugeCard
              dailyPnl={botData?.dailyPnl ?? 0}
              maxDailyLossPct={(dashboardData?.user as any)?.maxDailyLoss ?? 5}
              balance={dashboardData?.user?.accountBalance ?? 100}
              profitLockHit={!!(botData as any)?.profitLockHit}
              dailyProfitTarget={(dashboardData?.user as any)?.dailyProfitTarget}
            />

            {/* ── Profit Lock Bar — only shown when a target is set ── */}
            {(() => {
              const target = (dashboardData?.user as any)?.dailyProfitTarget;
              return target && target > 0 ? (
                <ProfitLockBar
                  dailyPnl={botData?.dailyPnl ?? 0}
                  target={target}
                  profitLockHit={!!(botData as any)?.profitLockHit}
                />
              ) : null;
            })()}

            {/* ── Backtest Summary Card ── */}
            <BacktestSummaryCard summary={backtestSummary} />

            {/* ── Deep Stats Panel ── */}
            <DeepStatsPanel stats={deepStats} />

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
                  (sse.scores?.total ?? 0) >= 16 ? "text-primary" :
                  (sse.scores?.total ?? 0) >= 10 ? "text-yellow-400" : "text-text-secondary"
                }`}>
                  {sse.scores?.loading ? "…" : sse.scores?.total != null ? `${sse.scores.total.toFixed(1)}/25` : "—"}
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

                {/* Score bars — c1 (1h Trend) · c2 (15m Confirm) · c3 (5m Entry) */}
                <div className="space-y-2 mb-4">
                  <ScoreBar label="1h Trend" value={sse.scores.c1 ?? 0} max={10} />
                  <ScoreBar label="15m Conf" value={sse.scores.c2 ?? 0} min={-2} max={5} />
                  <ScoreBar label="5m Entry" value={sse.scores.c3 ?? 0} max={10} />
                </div>

                {/* Total score bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-text-secondary">Total Score</span>
                    <span className={`font-bold font-mono ${(sse.scores.total ?? 0) >= 16 ? "text-primary" : "text-text-secondary"}`}>
                      {(sse.scores.total ?? 0).toFixed(1)} / 25
                    </span>
                  </div>
                  <div className="h-2 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, ((sse.scores.total ?? 0) / 25) * 100)}%`,
                        backgroundColor: (sse.scores.total ?? 0) >= 16 ? "#00D4A4" : (sse.scores.total ?? 0) >= 10 ? "#FFB347" : "#FF4060"
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-text-secondary mt-1">
                    <span>0</span>
                    <span className="text-primary">16 threshold</span>
                    <span>25</span>
                  </div>
                </div>

                {/* Indicator grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA20 (1h)</span>
                    <span className="font-mono">{sse.scores.ema20_1h?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA50 (1h)</span>
                    <span className="font-mono">{sse.scores.ema50_1h?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA9 (15m)</span>
                    <span className="font-mono">{sse.scores.ema9_15m?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA21 (15m)</span>
                    <span className="font-mono">{sse.scores.ema21_15m?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">ADX (15m)</span>
                    <span className={`font-mono font-medium ${(sse.scores.adx15m ?? 0) >= 20 ? "text-primary" : "text-text-secondary"}`}>
                      {sse.scores.adx15m?.toFixed(1) ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">RSI (5m)</span>
                    <span className={`font-mono font-medium ${
                      (sse.scores.rsi5m ?? 50) < 40 ? "text-primary" :
                      (sse.scores.rsi5m ?? 50) > 60 ? "text-accent-red" : "text-foreground"
                    }`}>{sse.scores.rsi5m?.toFixed(1) ?? "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EMA21 (5m)</span>
                    <span className="font-mono">{sse.scores.ema21_5m?.toFixed(2) ?? "—"}</span>
                  </div>
                </div>

                {/* Live "Why No Signal" diagnostic */}
                {sse.scores.direction === "NONE" && (() => {
                  const total = sse.scores.total ?? 0;
                  const c1 = sse.scores.c1 ?? 0;
                  const c2 = sse.scores.c2 ?? 0;
                  const adx = sse.scores.adx15m ?? 0;
                  const rsi = sse.scores.rsi5m ?? 50;

                  const checks: { label: string; pass: boolean; detail: string }[] = [
                    {
                      label: "1h Trend Aligned",
                      pass: c1 >= 4,
                      detail: c1 >= 4 ? `Score ${c1.toFixed(1)}/10 ✓` : `Score ${c1.toFixed(1)}/10 — need ≥4 for direction`,
                    },
                    {
                      label: "15m Momentum",
                      pass: c2 >= 1,
                      detail: c2 >= 1 ? `Score ${c2.toFixed(1)} ✓` : `Score ${c2.toFixed(1)} — EMAs not aligned`,
                    },
                    {
                      label: "ADX Filter",
                      pass: adx < 25,
                      detail: adx < 25 ? `ADX ${adx.toFixed(1)} (range-bound) ✓` : `ADX ${adx.toFixed(1)} — strong trend, paused`,
                    },
                    {
                      label: "RSI Window",
                      pass: rsi < 65 && rsi > 35,
                      detail: rsi < 65 && rsi > 35 ? `RSI ${rsi.toFixed(1)} ✓` : rsi >= 65 ? `RSI ${rsi.toFixed(1)} — overbought` : `RSI ${rsi.toFixed(1)} — oversold`,
                    },
                    {
                      label: "Score Threshold",
                      pass: total >= 16,
                      detail: total >= 16 ? `${total.toFixed(1)}/25 ✓` : `${total.toFixed(1)}/25 — need 16+`,
                    },
                  ];

                  const failing = checks.filter(c => !c.pass);
                  const firstFail = failing[0];

                  return (
                    <div className="mt-3 pt-3 border-t border-border">
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">Why No Signal</span>
                      </div>
                      <div className="space-y-1.5">
                        {checks.map(({ label, pass, detail }) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${pass ? "bg-primary/20 text-primary" : "bg-accent-red/20 text-accent-red"}`}>
                              {pass ? "✓" : "✗"}
                            </span>
                            <span className={`text-[11px] ${pass ? "text-text-secondary" : "text-foreground font-medium"}`}>{label}</span>
                            <span className="text-[10px] text-text-secondary ml-auto">{detail}</span>
                          </div>
                        ))}
                      </div>
                      {firstFail && (
                        <div className="mt-2 px-2 py-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
                          <p className="text-[11px] text-yellow-400">
                            Primary blocker: <span className="font-semibold">{firstFail.label}</span> — {firstFail.detail}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {sse.scores.rejectionReason && sse.scores.direction !== "NONE" && (
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
                    {sse.scores.candlesLoaded ?? 0} / 55 1h candles needed
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
                              {(trade as any).isCopyTrade === 1 && <Badge className="h-4 text-[10px] bg-yellow-500/20 text-yellow-400 border-0 px-1">COPY</Badge>}
                              {(trade as any).isPaper === 1 && <Badge className="h-4 text-[10px] bg-text-secondary/20 text-text-secondary border-0 px-1">PAPER</Badge>}
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
                        {(trade as any).durationMinutes != null && <span>{(trade as any).durationMinutes}m</span>}
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

        {/* ─── ACTIVITY TAB ─── */}
        {activeTab === "activity" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Activity Log</h2>
              <span className="text-xs text-text-secondary">{(sse.activity.length + activityHistory.length) > 0 ? `${Math.min(sse.activity.length + activityHistory.length, 100)} events` : ""}</span>
            </div>
            <div className="space-y-0">
              {(() => {
                const seen = new Set<string>();
                const merged = [...sse.activity, ...activityHistory].filter(log => {
                  const key = `${log.createdAt}|${log.message}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                }).slice(0, 100);
                if (merged.length === 0) {
                  return (
                    <div className="text-center text-text-secondary p-10 border border-dashed border-border rounded-xl">
                      <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p>No activity yet.</p>
                      <p className="text-xs mt-1">Start the bot to see events here.</p>
                    </div>
                  );
                }
                return merged.map((log, i) => {
                  const dotColor =
                    log.level === "win" ? "bg-primary" :
                    log.level === "loss" ? "bg-accent-red" :
                    log.level === "warning" ? "bg-yellow-400" :
                    log.level === "error" ? "bg-accent-red" :
                    "bg-text-secondary";
                  const textColor =
                    log.level === "win" ? "text-primary" :
                    log.level === "loss" ? "text-accent-red" :
                    log.level === "warning" ? "text-yellow-400" :
                    log.level === "error" ? "text-accent-red" :
                    "text-foreground";
                  return (
                    <div key={i} className="flex gap-3 py-2.5 border-b border-border/40 last:border-0 items-start">
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${textColor}`}>{log.message}</p>
                      </div>
                      <span className="text-[10px] text-text-secondary font-mono shrink-0 mt-0.5">
                        {new Date(log.createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
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

            {/* ── Deriv Token ── */}
            <Card className="p-4 bg-card border border-border rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold">Deriv API Token</h3>
                {dashboardData?.user?.hasDerivToken && !showTokenInput && (
                  <Badge className="border-0 bg-primary/20 text-primary text-xs">
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Connected
                  </Badge>
                )}
              </div>

              {!showTokenInput ? (
                <div className="space-y-2">
                  <p className="text-xs text-text-secondary">
                    {dashboardData?.user?.hasDerivToken
                      ? "Your Deriv API token is saved. You can replace it below."
                      : "Connect your Deriv account to enable live trading."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-border text-foreground hover:bg-border gap-2"
                    onClick={() => setShowTokenInput(true)}
                  >
                    <Link2 className="w-4 h-4" />
                    {dashboardData?.user?.hasDerivToken ? "Replace Token" : "Connect Deriv Account"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-text-secondary">
                    Enter your Deriv API token. Get it from{" "}
                    <a
                      href="https://app.deriv.com/account/api-token"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline"
                    >
                      app.deriv.com/account/api-token
                    </a>
                  </p>
                  <div className="relative">
                    <Input
                      type={showTokenChars ? "text" : "password"}
                      value={derivTokenInput}
                      onChange={(e) => setDerivTokenInput(e.target.value)}
                      placeholder="Enter Deriv API token..."
                      className="bg-background border-border focus-visible:ring-primary pr-10 font-mono text-sm"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground"
                      onClick={() => setShowTokenChars((v) => !v)}
                    >
                      {showTokenChars ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-border text-text-secondary"
                      onClick={() => { setShowTokenInput(false); setDerivTokenInput(""); setShowTokenChars(false); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1 bg-primary text-black hover:bg-primary/90"
                      onClick={handleSaveDerivToken}
                      disabled={!derivTokenInput.trim() || tokenSaving}
                    >
                      {tokenSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : tokenSaved ? (
                        <><CheckCircle2 className="w-4 h-4 mr-1" /> Saved</>
                      ) : (
                        "Save Token"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            {/* Sync Deriv Balance — only shown for live users with a token */}
            {dashboardData?.user?.hasDerivToken && dashboardData?.user?.tradingMode !== "paper" && (
              <Card className="p-4 bg-card border border-border rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold">Deriv Balance</h3>
                  {lastSyncedBalance != null && (
                    <Badge className="border-0 bg-primary/20 text-primary text-xs">
                      ${lastSyncedBalance.toFixed(2)}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-text-secondary mb-3">
                  Pull your current balance directly from Deriv to keep the bot in sync.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-border text-foreground hover:bg-border gap-2"
                  onClick={handleSyncBalance}
                  disabled={balanceSyncing}
                >
                  {balanceSyncing ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Syncing...</>
                  ) : (
                    <><RefreshCw className="w-4 h-4" /> Sync Balance from Deriv</>
                  )}
                </Button>
              </Card>
            )}

            <Card className="p-4 bg-card border border-border rounded-xl">
              <h3 className="font-bold mb-3">Connection</h3>
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${connDotClass}`} />
                <div className="text-sm">
                  {sse.connected ? (
                    <span className="text-primary">
                      Live — {activePair === "R_10" ? "V10" : "V75"} @ {price > 0 ? price.toFixed(2) : "loading..."}
                    </span>
                  ) : (
                    <span className="text-accent-red">Disconnected — reconnecting...</span>
                  )}
                </div>
              </div>
            </Card>

            {/* Trading Pair Selection */}
            <Card className="p-4 bg-card border border-border rounded-xl">
              <h3 className="font-bold mb-1">Trading Pair</h3>
              <p className="text-[11px] text-text-secondary mb-3">Select which index your bot trades. Cannot switch while a trade is open.</p>
              <div className="grid grid-cols-2 gap-3">
                {/* V75 card */}
                <button
                  onClick={() => handleSwitchPair("R_75")}
                  disabled={pairSwitching || activePair === "R_75"}
                  className={`relative rounded-xl border-2 p-3 text-left transition-all ${
                    activePair === "R_75"
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:border-primary/50"
                  } disabled:opacity-70`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-text-secondary uppercase tracking-wide">V75</span>
                    {activePair === "R_75" && <CheckCircle2 className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="font-bold text-sm">Volatility 75</div>
                  <div className="text-[10px] text-text-secondary mt-0.5">Session-based · High vol</div>
                </button>

                {/* V10 card */}
                <button
                  onClick={() => handleSwitchPair("R_10")}
                  disabled={pairSwitching || activePair === "R_10"}
                  className={`relative rounded-xl border-2 p-3 text-left transition-all ${
                    activePair === "R_10"
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:border-primary/50"
                  } disabled:opacity-70`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-text-secondary uppercase tracking-wide">V10</span>
                    {activePair === "R_10" && <CheckCircle2 className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="font-bold text-sm">Volatility 10</div>
                  <div className="text-[10px] text-text-secondary mt-0.5">24/7 · Mean reversion</div>
                </button>
              </div>
              {pairSwitching && (
                <div className="flex items-center gap-2 mt-2 text-xs text-text-secondary">
                  <Loader2 className="w-3 h-3 animate-spin" /> Switching pair...
                </div>
              )}
              {pairSwitchMsg && !pairSwitching && (
                <div className={`mt-2 text-xs px-2 py-1 rounded-md ${pairSwitchMsg.startsWith("Switched") ? "bg-primary/10 text-primary" : "bg-accent-red/10 text-accent-red"}`}>
                  {pairSwitchMsg}
                </div>
              )}
            </Card>

            {/* Bot Settings */}
            <Card className="p-4 bg-card border border-border rounded-xl">
              <h3 className="font-bold mb-4">Bot Settings</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-text-secondary block mb-1.5">Fixed Stake Size ($)</label>
                  <Input
                    type="number"
                    value={stakeInput}
                    onChange={(e) => setStakeInput(e.target.value)}
                    placeholder="Auto (profile-based)"
                    className="bg-background border-border focus-visible:ring-primary"
                    min="0.5" max="1000" step="0.5"
                  />
                  <p className="text-[11px] text-text-secondary mt-1">Leave blank to use profile % sizing</p>
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1.5">Max Daily Loss (%)</label>
                  <Input
                    type="number"
                    value={maxLossInput}
                    onChange={(e) => setMaxLossInput(e.target.value)}
                    placeholder="Auto (5% / 8% / 12%)"
                    className="bg-background border-border focus-visible:ring-primary"
                    min="1" max="100" step="0.5"
                  />
                  <p className="text-[11px] text-text-secondary mt-1">Overrides profile default</p>
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1.5 flex items-center gap-1">
                    <Target className="w-3 h-3" /> Daily Profit Target ($)
                  </label>
                  <Input
                    type="number"
                    value={profitTargetInput}
                    onChange={(e) => setProfitTargetInput(e.target.value)}
                    placeholder="e.g. 50 (leave blank to disable)"
                    className="bg-background border-border focus-visible:ring-primary"
                    min="0.01" step="0.5"
                  />
                  <p className="text-[11px] text-text-secondary mt-1">Bot auto-pauses when daily P&amp;L reaches this — leave blank to disable</p>
                </div>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm font-medium">Demo Mode</p>
                    <p className="text-[11px] text-text-secondary">Trades are flagged as simulated</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`min-w-[80px] border-border ${(dashboardData?.user as any)?.demoMode ? "text-primary border-primary/40 bg-primary/5" : "text-text-secondary"}`}
                    onClick={handleToggleDemoMode}
                    disabled={demoToggling}
                  >
                    {demoToggling ? <Loader2 className="w-4 h-4 animate-spin" /> : (dashboardData?.user as any)?.demoMode ? "ON" : "OFF"}
                  </Button>
                </div>
                <Button
                  className="w-full bg-primary text-black hover:bg-primary/90"
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                >
                  {settingsSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : settingsSaved ? (
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  {settingsSaved ? "Saved!" : "Save Settings"}
                </Button>
              </div>
            </Card>

            {/* Push Notifications Card */}
            {"Notification" in window && (
              <Card className="bg-card border-border p-4 space-y-3">
                <div className="text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
                  <Bell className="w-3.5 h-3.5" /> Push Notifications
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Trade &amp; Bot Alerts</p>
                    <p className="text-[11px] text-text-secondary">Get notified when trades close or bot stops</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={notifPermission === "denied"}
                    className={`min-w-[80px] border-border ${
                      notifPermission === "granted"
                        ? "text-primary border-primary/40 bg-primary/5"
                        : notifPermission === "denied"
                        ? "text-accent-red border-accent-red/30 opacity-60"
                        : "text-text-secondary"
                    }`}
                    onClick={async () => {
                      if (notifPermission === "granted") {
                        setNotifPermission("default");
                        return;
                      }
                      if ("Notification" in window) {
                        const perm = await Notification.requestPermission();
                        setNotifPermission(perm);
                      }
                    }}
                  >
                    {notifPermission === "granted" ? "ON" : notifPermission === "denied" ? "BLOCKED" : "Enable"}
                  </Button>
                </div>
                {notifPermission === "denied" && (
                  <p className="text-[10px] text-accent-red">Blocked in browser — reset in site settings to enable</p>
                )}
                {notifPermission === "granted" && (
                  <p className="text-[10px] text-primary">Active — you'll receive alerts for trade closes, loss limit, and profit target hits</p>
                )}
              </Card>
            )}

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
          { id: "activity", label: "Activity", icon: Activity },
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
