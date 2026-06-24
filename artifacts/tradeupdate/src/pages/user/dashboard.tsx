import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { 
  useGetMe, 
  useGetBotStatus, 
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
import { Loader2, Power, Pause, LogOut, Home, BarChart2, List, Settings as SettingsIcon, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line
} from "recharts";

type Timeframe = "1m" | "5m" | "15m";
type TradeFilter = "all" | "win" | "loss" | "paper" | "copy";

export default function Dashboard() {
  const { data: user } = useGetMe();
  const [price, setPrice] = useState(0);
  const [priceDir, setPriceDir] = useState<"up" | "down" | "">("");
  const [activeTab, setActiveTab] = useState("home");
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>("all");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const sseRef = useRef<EventSource | null>(null);

  const { data: botStatus } = useGetBotStatus({
    query: {
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: 5000
    }
  });

  const { data: dashboardData } = useGetUserDashboard({
    query: {
      queryKey: getGetUserDashboardQueryKey(),
      refetchInterval: 8000
    }
  });

  const { data: candles, isLoading: candlesLoading } = useGetCandles(
    { timeframe, count: 200 },
    {
      query: {
        queryKey: ["candles", timeframe],
        refetchInterval: activeTab === "chart" ? 5000 : false,
        enabled: activeTab === "chart"
      }
    }
  );

  const { data: tradesData, isLoading: tradesLoading } = useGetUserTrades(
    { filter: tradeFilter, limit: 30 },
    {
      query: {
        queryKey: ["userTrades", tradeFilter],
        enabled: activeTab === "trades"
      }
    }
  );

  const { data: stats } = useGetUserStats({
    query: {
      queryKey: ["userStats"],
      enabled: activeTab === "trades"
    }
  });

  const toggleBot = useToggleBot();
  const logout = useLogout();

  // SSE streaming for live tick updates
  useEffect(() => {
    const es = new EventSource("/api/user/stream", { withCredentials: true });
    sseRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "tick") {
          setPrice(data.price);
          setPriceDir(data.direction || "");
          setTimeout(() => setPriceDir(""), 300);
        } else if (data.type === "trade_opened" || data.type === "trade_closed" || data.type === "bot_status") {
          queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUserDashboardQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["userTrades"] });
        }
      } catch {
        // ignore parse errors (keepalive pings)
      }
    };

    es.onerror = () => {
      // SSE reconnects automatically on error
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [queryClient]);

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => setLocation("/login")
    });
  };

  const isRunning = botStatus?.isRunning ?? false;

  const chartData = candles?.candles?.map((c) => ({
    time: new Date(c.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    close: c.close,
    open: c.open,
    high: c.high,
    low: c.low,
  })) ?? [];

  const equityData = stats?.equityCurve?.map((e) => ({
    time: new Date(e.time * 1000).toLocaleDateString([], { month: "short", day: "numeric" }),
    balance: e.balance
  })) ?? [];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16">
      {/* Header */}
      <header className="h-[60px] flex items-center justify-between px-4 border-b border-border bg-card fixed top-0 w-full z-10">
        <Logo size="sm" />
        <div className="flex flex-col items-center">
          <span className="text-xs text-text-secondary">V75 INDEX</span>
          <span className={`text-lg font-bold tabular-nums transition-colors duration-150 ${
            priceDir === "up" ? "text-primary" : priceDir === "down" ? "text-accent-red" : "text-foreground"
          }`}>
            {price > 0 ? price.toFixed(2) : "---"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-primary animate-pulse" : "bg-text-secondary"}`} />
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 rounded-full bg-border text-xs font-bold"
            onClick={handleLogout}
          >
            {user?.username?.[0]?.toUpperCase() || "U"}
          </Button>
        </div>
      </header>

      {/* Status banner */}
      {(botStatus?.killSwitchActive || botStatus?.recoveryModeActive || botStatus?.pauseReason) && (
        <div className={`mt-[60px] py-1 text-center text-xs font-medium uppercase tracking-wide ${
          botStatus.killSwitchActive ? "bg-accent-red/10 text-accent-red" :
          botStatus.recoveryModeActive ? "bg-yellow-500/10 text-yellow-400" :
          "bg-text-secondary/10 text-text-secondary"
        }`}>
          {botStatus.killSwitchActive ? "KILL SWITCH ACTIVE" :
           botStatus.recoveryModeActive ? "RECOVERY MODE" :
           botStatus.pauseReason}
        </div>
      )}

      <main className={`flex-1 p-4 ${!(botStatus?.killSwitchActive || botStatus?.recoveryModeActive || botStatus?.pauseReason) ? "mt-[60px]" : ""}`}>

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
                <div className={`text-xl font-bold tabular-nums ${(dashboardData?.botStatus?.dailyPnl ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                  {(dashboardData?.botStatus?.dailyPnl ?? 0) >= 0 ? "+" : ""}
                  {(dashboardData?.botStatus?.dailyPnl ?? 0).toFixed(2)}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Win Streak</div>
                <div className="text-xl font-bold tabular-nums">
                  {(dashboardData?.botStatus?.consecutiveWins ?? 0) > 0 ? (
                    <span className="text-primary">+{dashboardData!.botStatus.consecutiveWins}W</span>
                  ) : (dashboardData?.botStatus?.consecutiveLosses ?? 0) > 0 ? (
                    <span className="text-accent-red">-{dashboardData!.botStatus.consecutiveLosses}L</span>
                  ) : "—"}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Trades Today</div>
                <div className="text-xl font-bold tabular-nums">
                  {dashboardData?.botStatus?.todayTrades ?? 0}
                </div>
              </Card>
            </div>

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
              <div className="text-sm text-text-secondary mt-1">
                {dashboardData?.user?.tradingProfile
                  ? dashboardData.user.tradingProfile.charAt(0).toUpperCase() + dashboardData.user.tradingProfile.slice(1)
                  : "No Profile"}
              </div>
            </Card>

            {/* Open trade card */}
            {botStatus?.openTrade && (
              <Card className="bg-card border-border p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-text-secondary">Open Trade</span>
                  <Badge className={`border-0 ${botStatus.openTrade.direction === "BUY" ? "bg-primary/20 text-primary" : "bg-accent-red/20 text-accent-red"}`}>
                    {botStatus.openTrade.direction}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-text-secondary">Entry</div>
                    <div className="font-mono font-semibold">{botStatus.openTrade.entryPrice?.toFixed(2) ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-text-secondary">Current</div>
                    <div className="font-mono font-semibold">{price > 0 ? price.toFixed(2) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-text-secondary">P&L</div>
                    <div className={`font-mono font-bold ${(botStatus.openTrade.pnl ?? 0) >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {(botStatus.openTrade.pnl ?? 0) >= 0 ? "+" : ""}{(botStatus.openTrade.pnl ?? 0).toFixed(2)}
                    </div>
                  </div>
                </div>
                {botStatus.lastSignalScore != null && (
                  <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                    <span className="text-xs text-text-secondary">AI Score</span>
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-24 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${Math.min(100, (botStatus.lastSignalScore / 100) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono font-bold text-primary">
                        {botStatus.lastSignalScore?.toFixed(0)}
                      </span>
                    </div>
                  </div>
                )}
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
                <div className="h-[280px] flex items-center justify-center text-text-secondary text-sm">
                  No chart data available. Live data loads from Deriv.
                </div>
              )}
            </Card>

            {/* Current stats bar */}
            <div className="grid grid-cols-3 gap-3">
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Live Price</div>
                <div className={`font-bold font-mono ${priceDir === "up" ? "text-primary" : priceDir === "down" ? "text-accent-red" : "text-foreground"}`}>
                  {price > 0 ? price.toFixed(2) : "—"}
                </div>
              </Card>
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">Drawdown</div>
                <div className="font-bold text-accent-red">
                  {botStatus?.currentDrawdown != null ? `-${(botStatus.currentDrawdown * 100).toFixed(1)}%` : "—"}
                </div>
              </Card>
              <Card className="bg-card border-border p-3 text-center">
                <div className="text-xs text-text-secondary mb-1">AI Score</div>
                <div className="font-bold text-primary">
                  {botStatus?.currentScore != null ? botStatus.currentScore.toFixed(0) : "—"}
                </div>
              </Card>
            </div>

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
                  <div className="font-bold text-primary">{(stats.winRate * 100).toFixed(1)}%</div>
                </Card>
                <Card className="bg-card border-border p-3 text-center">
                  <div className="text-xs text-text-secondary mb-1">Total P&L</div>
                  <div className={`font-bold ${stats.totalPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                    {stats.totalPnl >= 0 ? "+" : ""}{stats.totalPnl.toFixed(2)}
                  </div>
                </Card>
                <Card className="bg-card border-border p-3 text-center">
                  <div className="text-xs text-text-secondary mb-1">Trades</div>
                  <div className="font-bold">{stats.totalTrades}</div>
                </Card>
              </div>
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
                    <Card key={trade.id} className="bg-card border-border p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {trade.direction === "BUY" ? (
                            <TrendingUp className="w-4 h-4 text-primary" />
                          ) : (
                            <TrendingDown className="w-4 h-4 text-accent-red" />
                          )}
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium">{trade.direction}</span>
                              {isOpen && (
                                <Badge className="h-4 text-[10px] bg-primary/20 text-primary border-0 px-1">LIVE</Badge>
                              )}
                              {trade.isCopyTrade && (
                                <Badge className="h-4 text-[10px] bg-yellow-500/20 text-yellow-400 border-0 px-1">COPY</Badge>
                              )}
                              {trade.isPaper && (
                                <Badge className="h-4 text-[10px] bg-text-secondary/20 text-text-secondary border-0 px-1">PAPER</Badge>
                              )}
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
                          <div className="text-xs text-text-secondary">
                            {trade.scoreTotal != null ? `Score: ${trade.scoreTotal.toFixed(0)}` : ""}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-text-secondary">
                        {new Date(trade.openedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {trade.sessionName ? ` · ${trade.sessionName}` : ""}
                      </div>
                    </Card>
                  );
                })}
                {(!tradesData?.trades || tradesData.trades.length === 0) && (
                  <div className="text-center p-8 text-text-secondary border border-dashed border-border rounded-xl">
                    No trades found.
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
                  <span className="font-medium capitalize">
                    {dashboardData?.user?.tradingProfile ?? "Not set"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Deriv Token</span>
                  <span className={dashboardData?.user?.hasDerivToken ? "text-primary" : "text-accent-red"}>
                    {dashboardData?.user?.hasDerivToken ? "Connected" : "Not connected"}
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
