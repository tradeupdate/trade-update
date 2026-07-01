import { AdminLayout } from "@/components/admin-layout";
import {
  useGetStrategies,
  useRunBacktest,
  useGetBacktestResults,
  getGetBacktestResultsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo, useCallback, useRef } from "react";
import {
  Play, BarChart2, Loader2, TrendingUp, TrendingDown,
  Clock, Target, RefreshCw, Database, AlertTriangle, Hash,
  Activity, Layers, GitBranch, Zap, X, List, Cpu,
} from "lucide-react";

interface StreamProgress {
  type: "progress";
  candleIndex: number;
  totalCandles: number;
  tradesExecuted: number;
  wins: number;
  currentBalance: number;
  phase: "fetching" | "running";
  funnel: Record<string, number>;
}
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function DataSourceBadge({ source }: { source?: string | null }) {
  if (!source) return null;
  const isFresh = source === "deriv_fresh";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${
      isFresh ? "bg-primary/10 text-primary border border-primary/20" : "bg-muted text-text-secondary border border-border"
    }`}>
      <Database className="w-2.5 h-2.5" />
      {isFresh ? "Fresh Fetch" : "Cached"}
    </span>
  );
}

function CorrelationBar({ label, value }: { label: string; value: number }) {
  const pct = Math.abs(value) * 100;
  const isPositive = value >= 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-secondary w-16 shrink-0 capitalize">{label}</span>
      <div className="flex-1 flex items-center gap-1 h-4">
        <div className="flex-1 bg-muted rounded-full overflow-hidden h-2 relative">
          <div
            className={`h-full rounded-full transition-all ${isPositive ? "bg-primary" : "bg-accent-red"}`}
            style={{ width: `${Math.max(3, pct)}%` }}
          />
        </div>
        <span className={`text-[10px] font-mono w-10 text-right ${isPositive ? "text-primary" : "text-accent-red"}`}>
          {value >= 0 ? "+" : ""}{value.toFixed(3)}
        </span>
      </div>
    </div>
  );
}

export default function AdminBacktest() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [strategyId, setStrategyId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sessionFilterEnabled, setSessionFilterEnabled] = useState(true);
  const [sessionStartHour, setSessionStartHour] = useState(6);
  const [sessionEndHour, setSessionEndHour] = useState(20);
  const [activeResult, setActiveResult] = useState<any>(null);
  const [selectedTrade, setSelectedTrade] = useState<any | null>(null);

  const { data: strategies } = useGetStrategies({ query: { queryKey: ["strategies"] } });
  const { data: history, isLoading: historyLoading } = useGetBacktestResults({
    query: {
      queryKey: getGetBacktestResultsQueryKey(),
      refetchInterval: 5000,
    }
  });

  const runMutation = useRunBacktest();

  const handleRun = (refreshData = false) => {
    if (!strategyId) {
      toast({ title: "Please select a strategy", variant: "destructive" });
      return;
    }
    const from = dateFrom ? Math.floor(new Date(dateFrom).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400 * 7;
    const to = dateTo ? Math.floor(new Date(dateTo).getTime() / 1000) : Math.floor(Date.now() / 1000);

    runMutation.mutate(
      { data: { strategyId, dateFrom: from, dateTo: to, refreshData, sessionFilterEnabled, sessionStartHour, sessionEndHour } },
      {
        onSuccess: (result) => {
          setActiveResult(result);
          queryClient.invalidateQueries({ queryKey: getGetBacktestResultsQueryKey() });
          const ranging = (result as any).regimeStats?.rangingTrades ?? 0;
          const trending = (result as any).regimeStats?.trendingTrades ?? 0;
          toast({
            title: refreshData ? "Data refreshed & backtest complete" : "Backtest complete",
            description: `${result.totalTrades} trades · Win Rate: ${result.winRate?.toFixed(1)}% · P&L: $${result.totalPnl?.toFixed(2)} · ${ranging}R/${trending}T`,
          });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Backtest failed — check dates and try again";
          toast({ title: "Backtest failed", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const display = activeResult ?? (history?.results?.[0] ?? null);
  const equityCurve = useMemo(() => {
    try {
      const raw = display?.equityCurve;
      if (!raw) return [];
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed.map((p: any) => ({ name: `T${p.index + 1}`, equity: p.value }));
    } catch { return []; }
  }, [display?.equityCurve]);

  const strategyName = strategies?.strategies?.find(s => s.id === (display?.strategyId ?? strategyId))?.name ?? "—";

  const mismatchedIds = useMemo(() => {
    const results = history?.results ?? [];
    const rangeGroups: Record<string, { hash: string; ids: string[] }> = {};
    for (const r of results) {
      if (!r.dateFrom || !r.dateTo || !r.candleHash) continue;
      const key = `${r.dateFrom}_${r.dateTo}`;
      if (!rangeGroups[key]) {
        rangeGroups[key] = { hash: r.candleHash, ids: [r.id] };
      } else if (rangeGroups[key].hash !== r.candleHash) {
        rangeGroups[key].ids.push(r.id);
      }
    }
    const mismatched = new Set<string>();
    for (const g of Object.values(rangeGroups)) {
      if (g.ids.length > 1) g.ids.forEach(id => mismatched.add(id));
    }
    return mismatched;
  }, [history?.results]);

  const featureImportance = (display as any)?.featureImportance ?? null;
  const regimeStats = (display as any)?.regimeStats ?? null;
  const scoreHistogram = (display as any)?.scoreHistogram ?? null;
  const partialExitStats = (display as any)?.partialExitStats ?? null;

  const totalRegimeCandles = (regimeStats?.trendingCandles ?? 0) + (regimeStats?.rangingCandles ?? 0);
  const trendingPct = totalRegimeCandles > 0 ? Math.round((regimeStats.trendingCandles / totalRegimeCandles) * 100) : 0;
  const rangingPct = 100 - trendingPct;

  const histogramData = useMemo(() => {
    if (!scoreHistogram) return [];
    return scoreHistogram.map((b: any) => ({
      bucket: b.bucket,
      scored: b.count,
      trades: b.trades,
      wins: b.wins,
    }));
  }, [scoreHistogram]);

  return (
    <>
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Backtest Engine</h1>
            <p className="text-xs text-text-secondary mt-0.5">Deterministic · Candle-accurate · Reproducible · Partial Exits</p>
          </div>
          {historyLoading && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Config panel */}
          <Card className="bg-card border-border p-6 lg:col-span-1">
            <h2 className="text-base font-bold mb-4">Configuration</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block uppercase tracking-wide">Strategy</label>
                <select
                  className="w-full h-10 px-3 rounded-md border border-border bg-background text-foreground text-sm"
                  value={strategyId}
                  onChange={(e) => setStrategyId(e.target.value)}
                >
                  <option value="">Select strategy...</option>
                  {strategies?.strategies?.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block uppercase tracking-wide">Date From</label>
                <input
                  type="date"
                  className="w-full h-10 px-3 rounded-md border border-border bg-background text-foreground text-sm"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block uppercase tracking-wide">Date To</label>
                <input
                  type="date"
                  className="w-full h-10 px-3 rounded-md border border-border bg-background text-foreground text-sm"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>

              {/* Session filter */}
              <div className="border border-border rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">Session Filter</label>
                  <button
                    onClick={() => setSessionFilterEnabled(!sessionFilterEnabled)}
                    className={`w-9 h-5 rounded-full transition-colors relative ${sessionFilterEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${sessionFilterEnabled ? "left-4" : "left-0.5"}`} />
                  </button>
                </div>
                {sessionFilterEnabled && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-text-secondary block mb-1">Start (UTC)</label>
                      <input
                        type="number" min="0" max="23"
                        className="w-full h-7 px-2 rounded border border-border bg-background text-foreground text-xs"
                        value={sessionStartHour}
                        onChange={(e) => setSessionStartHour(parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-text-secondary block mb-1">End (UTC)</label>
                      <input
                        type="number" min="0" max="23"
                        className="w-full h-7 px-2 rounded border border-border bg-background text-foreground text-xs"
                        value={sessionEndHour}
                        onChange={(e) => setSessionEndHour(parseInt(e.target.value) || 20)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <Button
              className="w-full mt-6 bg-primary text-black hover:bg-primary/90 font-semibold"
              onClick={() => handleRun(false)}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Running...</>
              ) : (
                <><Play className="w-4 h-4 mr-2" />Run Backtest</>
              )}
            </Button>

            <Button
              variant="outline"
              className="w-full mt-2 border-border text-text-secondary hover:text-foreground text-xs"
              onClick={() => handleRun(true)}
              disabled={runMutation.isPending || !strategyId}
              title="Delete cached candle data and re-fetch from Deriv before running"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-2" />
              Refresh Historical Data
            </Button>

            {/* Results history list */}
            {(history?.results?.length ?? 0) > 0 && (
              <div className="mt-6">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">History</p>
                <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-0.5">
                  {history!.results!.map((r) => {
                    const hasMismatch = mismatchedIds.has(r.id);
                    return (
                      <button
                        key={r.id}
                        onClick={() => setActiveResult(r)}
                        className={`w-full text-left px-3 py-2 rounded-md text-xs border transition-colors ${
                          activeResult?.id === r.id
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-background hover:border-primary/40 text-text-secondary"
                        }`}
                      >
                        <div className="font-medium text-foreground truncate">
                          {strategies?.strategies?.find(s => s.id === r.strategyId)?.name ?? r.strategyId?.slice(0, 8)}
                        </div>
                        {r.dateFrom && r.dateTo && (
                          <div className="text-[10px] text-text-secondary mt-0.5">
                            {formatDate(r.dateFrom)} – {formatDate(r.dateTo)}
                          </div>
                        )}
                        <div className="flex justify-between items-center mt-1 gap-1">
                          <span className={r.totalPnl >= 0 ? "text-primary" : "text-accent-red"}>
                            {r.totalPnl >= 0 ? "+" : ""}${r.totalPnl?.toFixed(0)}
                          </span>
                          <span>{r.winRate?.toFixed(1)}% WR</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          <DataSourceBadge source={r.dataSource} />
                          {r.candlesUsed && (
                            <span className="text-[10px] text-text-secondary">{r.candlesUsed} candles</span>
                          )}
                        </div>
                        {hasMismatch && (
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-yellow-400">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            Data mismatch vs other runs
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          {/* Results panel */}
          <div className="lg:col-span-3 space-y-6">
            {display ? (
              <>
                {/* Run metadata bar */}
                <div className="flex flex-wrap items-center gap-2 px-1">
                  {display.runId && (
                    <span className="flex items-center gap-1 text-[10px] text-text-secondary font-mono">
                      <Hash className="w-3 h-3" />
                      {display.runId}
                    </span>
                  )}
                  <DataSourceBadge source={display.dataSource} />
                  {display.candlesUsed && (
                    <Badge variant="outline" className="border-border text-text-secondary text-[10px]">
                      {display.candlesUsed} candles
                    </Badge>
                  )}
                  {display.candleHash && (
                    <span className="text-[10px] text-text-secondary font-mono">
                      hash: {display.candleHash}
                    </span>
                  )}
                  {mismatchedIds.has(display.id) && (
                    <Badge variant="outline" className="border-yellow-500/40 text-yellow-400 text-[10px] gap-1">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Data mismatch between runs
                    </Badge>
                  )}
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <BarChart2 className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs text-text-secondary">Total Trades</span>
                    </div>
                    <div className="text-2xl font-bold tabular-nums">{display.totalTrades}</div>
                    <div className="text-xs text-text-secondary mt-0.5">{display.wins}W / {display.losses}L</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Target className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs text-text-secondary">Win Rate</span>
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${display.winRate >= 55 ? "text-primary" : display.winRate >= 40 ? "text-yellow-400" : "text-accent-red"}`}>
                      {display.winRate?.toFixed(1)}%
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">PF: {display.profitFactor?.toFixed(2) ?? "—"}</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs text-text-secondary">Total P&L</span>
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${display.totalPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {display.totalPnl >= 0 ? "+" : ""}${display.totalPnl?.toFixed(2)}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      Best: +${display.bestTrade?.toFixed(2) ?? "—"}
                    </div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingDown className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs text-text-secondary">Max Drawdown</span>
                    </div>
                    <div className="text-2xl font-bold tabular-nums text-accent-red">
                      -{((display.maxDrawdown ?? 0) * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      Sharpe: {display.sharpeRatio?.toFixed(2) ?? "—"}
                    </div>
                  </Card>
                </div>

                {/* Equity curve */}
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-medium flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <BarChart2 className="w-4 h-4 text-text-secondary" />
                        Equity Curve — {strategyName}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {display.dateFrom && display.dateTo && (
                          <Badge variant="outline" className="border-border text-text-secondary text-xs">
                            {formatDate(display.dateFrom)} – {formatDate(display.dateTo)}
                          </Badge>
                        )}
                        <Badge variant="outline" className="border-primary/40 text-primary text-xs">
                          {display.totalTrades} trades
                        </Badge>
                        {display.avgDurationMinutes && (
                          <Badge variant="outline" className="border-border text-text-secondary text-xs">
                            <Clock className="w-3 h-3 mr-1" />
                            {display.avgDurationMinutes?.toFixed(0)}m avg
                          </Badge>
                        )}
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="h-[240px]">
                    {equityCurve.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={equityCurve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="eqGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#00D4A4" stopOpacity={0.15} />
                              <stop offset="95%" stopColor="#00D4A4" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1C1F2E" vertical={false} />
                          <XAxis dataKey="name" stroke="#8890AA" fontSize={10} tickLine={false} axisLine={false}
                            interval={Math.max(1, Math.floor(equityCurve.length / 10))} tick={{ fill: "#8890AA" }} />
                          <YAxis stroke="#8890AA" fontSize={10} tickLine={false} axisLine={false}
                            domain={["auto", "auto"]} tick={{ fill: "#8890AA" }}
                            tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={65} />
                          <Tooltip
                            contentStyle={{ backgroundColor: "#0F1117", borderColor: "#1C1F2E", color: "#F0F2FF", fontSize: 12 }}
                            labelStyle={{ color: "#8890AA" }}
                            formatter={(v: number) => [`$${v.toFixed(2)}`, "Balance"]}
                          />
                          <ReferenceLine y={equityCurve[0]?.equity ?? 0} stroke="#8890AA" strokeDasharray="4 4" />
                          <Line type="monotone" dataKey="equity" stroke="#00D4A4" strokeWidth={2}
                            dot={false} activeDot={{ r: 4, fill: "#00D4A4" }} />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center text-text-secondary text-sm">
                        No trades generated — try a wider date range or lower score threshold
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Signal Intelligence row */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                  {/* Feature Importance */}
                  {featureImportance && (
                    <Card className="bg-card border-border p-4 md:col-span-1">
                      <div className="flex items-center gap-2 mb-3">
                        <Activity className="w-3.5 h-3.5 text-primary" />
                        <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Feature Importance</span>
                      </div>
                      <p className="text-[10px] text-text-secondary mb-3">Pearson r: sub-score vs win/loss outcome</p>
                      <div className="space-y-2">
                        {Object.entries(featureImportance as Record<string, number>)
                          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                          .map(([key, val]) => (
                            <CorrelationBar
                              key={key}
                              label={({ c1Trend: "1h Trend", c2Confirm: "15m Conf", c3Entry: "5m Entry" } as Record<string,string>)[key] ?? key}
                              value={val}
                            />
                          ))}
                      </div>
                      {display.totalTrades < 10 && (
                        <p className="text-[10px] text-yellow-400 mt-2">⚠ Run longer backtest for statistical significance</p>
                      )}
                    </Card>
                  )}

                  {/* Regime Stats + Partial Exits */}
                  <div className="space-y-4 md:col-span-1">
                    {regimeStats && (
                      <Card className="bg-card border-border p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <GitBranch className="w-3.5 h-3.5 text-primary" />
                          <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Market Regime</span>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <div className="flex justify-between text-[10px] mb-0.5">
                              <span className="text-primary">Trending</span>
                              <span className="text-text-secondary">{trendingPct}% · {regimeStats.trendingTrades} trades</span>
                            </div>
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${trendingPct}%` }} />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] mb-0.5">
                              <span className="text-yellow-400">Ranging</span>
                              <span className="text-text-secondary">{rangingPct}% · {regimeStats.rangingTrades} trades</span>
                            </div>
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-yellow-400 rounded-full" style={{ width: `${rangingPct}%` }} />
                            </div>
                          </div>
                        </div>
                      </Card>
                    )}

                    {partialExitStats && (
                      <Card className="bg-card border-border p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Layers className="w-3.5 h-3.5 text-primary" />
                          <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Partial Exits</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div>
                            <div className="text-lg font-bold text-primary tabular-nums">{partialExitStats.tp1Hits}</div>
                            <div className="text-[10px] text-text-secondary">TP1 hit</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold text-primary tabular-nums">{partialExitStats.tp2Hits}</div>
                            <div className="text-[10px] text-text-secondary">TP2 hit</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold text-yellow-400 tabular-nums">{partialExitStats.beHits}</div>
                            <div className="text-[10px] text-text-secondary">Breakeven</div>
                          </div>
                        </div>
                        <p className="text-[10px] text-text-secondary mt-2">After TP1: SL moves to entry price (risk-free)</p>
                      </Card>
                    )}
                  </div>

                  {/* Score Distribution */}
                  {histogramData.length > 0 && (
                    <Card className="bg-card border-border p-4 md:col-span-1">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-3.5 h-3.5 text-primary" />
                        <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Score Distribution</span>
                      </div>
                      <p className="text-[10px] text-text-secondary mb-2">All scored candles by total score bucket</p>
                      <div className="h-[120px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={histogramData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                            <XAxis dataKey="bucket" fontSize={9} tick={{ fill: "#8890AA" }} tickLine={false} axisLine={false} />
                            <YAxis fontSize={9} tick={{ fill: "#8890AA" }} tickLine={false} axisLine={false} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#0F1117", borderColor: "#1C1F2E", color: "#F0F2FF", fontSize: 11 }}
                              formatter={(v: any, name: string) => [v, name === "scored" ? "Candles" : name === "trades" ? "Entries" : "Wins"]}
                            />
                            <Bar dataKey="scored" name="scored" radius={[2, 2, 0, 0]}>
                              {histogramData.map((entry: any, idx: number) => (
                                <Cell
                                  key={idx}
                                  fill={entry.bucket === "20-22" || entry.bucket === "22-25" || entry.bucket === "25+" ? "#00D4A4" : "#1C1F2E"}
                                />
                              ))}
                            </Bar>
                            <Bar dataKey="trades" name="trades" fill="#3B82F6" radius={[2, 2, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex gap-3 mt-1">
                        <span className="flex items-center gap-1 text-[10px] text-text-secondary"><span className="w-2 h-2 rounded-sm bg-[#1C1F2E] border border-border inline-block" />Scored</span>
                        <span className="flex items-center gap-1 text-[10px] text-text-secondary"><span className="w-2 h-2 rounded-sm bg-primary inline-block" />Threshold zone</span>
                        <span className="flex items-center gap-1 text-[10px] text-text-secondary"><span className="w-2 h-2 rounded-sm bg-blue-500 inline-block" />Entries</span>
                      </div>
                    </Card>
                  )}
                </div>

                {/* Bottom stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Profit Factor</div>
                    <div className="text-lg font-bold tabular-nums text-primary">{display.profitFactor?.toFixed(2) ?? "—"}</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Best Trade</div>
                    <div className="text-lg font-bold tabular-nums text-primary">+${display.bestTrade?.toFixed(2) ?? "—"}</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Worst Trade</div>
                    <div className="text-lg font-bold tabular-nums text-accent-red">${display.worstTrade?.toFixed(2) ?? "—"}</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Avg Duration</div>
                    <div className="text-lg font-bold tabular-nums">{display.avgDurationMinutes?.toFixed(0) ?? "—"}m</div>
                  </Card>
                </div>

                {/* Trade Log — available for freshly-run backtests */}
                {activeResult?.trades && activeResult.trades.length > 0 && (
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <List className="w-3.5 h-3.5 text-primary" />
                      <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Trade Log</span>
                      <span className="ml-auto text-[10px] text-text-secondary">{activeResult.trades.length} trades · click row for detail</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-text-secondary border-b border-border">
                            <th className="text-left pb-1.5 font-medium">#</th>
                            <th className="text-left pb-1.5 font-medium">Dir</th>
                            <th className="text-left pb-1.5 font-medium">Entry</th>
                            <th className="text-left pb-1.5 font-medium">Exit</th>
                            <th className="text-left pb-1.5 font-medium">Reason</th>
                            <th className="text-right pb-1.5 font-medium">Score</th>
                            <th className="text-right pb-1.5 font-medium">P&L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeResult.trades.map((trade: any) => (
                            <tr
                              key={trade.tradeNum}
                              className="border-b border-border/50 cursor-pointer hover:bg-muted/30 transition-colors"
                              onClick={() => setSelectedTrade(trade)}
                            >
                              <td className="py-1.5 text-text-secondary">{trade.tradeNum}</td>
                              <td className="py-1.5">
                                <span className={`font-bold ${trade.direction === "BUY" ? "text-primary" : "text-accent-red"}`}>
                                  {trade.direction}
                                </span>
                              </td>
                              <td className="py-1.5 font-mono text-text-secondary">{trade.entryPrice.toFixed(2)}</td>
                              <td className="py-1.5 font-mono text-text-secondary">{trade.exitPrice.toFixed(2)}</td>
                              <td className="py-1.5">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                  trade.closeReason === "tp2" ? "bg-primary/20 text-primary" :
                                  trade.closeReason === "sl" ? "bg-accent-red/20 text-accent-red" :
                                  "bg-muted text-text-secondary"
                                }`}>
                                  {trade.closeReason === "sl" ? "SL" : trade.closeReason === "tp2" ? "TP2" : trade.closeReason === "breakeven" ? "BE" : trade.closeReason === "time_stop" ? "Time" : "EOD"}
                                </span>
                              </td>
                              <td className="py-1.5 text-right font-mono">{trade.score}</td>
                              <td className={`py-1.5 text-right font-mono font-bold ${trade.pnl > 0 ? "text-primary" : "text-accent-red"}`}>
                                {trade.pnl > 0 ? "+" : ""}{trade.pnl.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-[400px] text-text-secondary gap-3">
                <BarChart2 className="w-12 h-12 text-border" />
                <p className="text-sm">Select a strategy and run a backtest to see results</p>
                <p className="text-xs">Results are fully deterministic — same inputs always produce identical output</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>

    {/* Trade detail modal */}
    {selectedTrade && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSelectedTrade(null)}>
        <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className={`font-bold text-lg ${selectedTrade.direction === "BUY" ? "text-primary" : "text-accent-red"}`}>
                {selectedTrade.direction}
              </span>
              <span className="text-sm text-text-secondary">Trade #{selectedTrade.tradeNum}</span>
            </div>
            <button onClick={() => setSelectedTrade(null)} className="text-text-secondary hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">Entry Price</div>
              <div className="font-mono font-bold">{selectedTrade.entryPrice.toFixed(2)}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">Exit Price</div>
              <div className="font-mono font-bold">{selectedTrade.exitPrice.toFixed(2)}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">Stop Loss</div>
              <div className="font-mono font-bold text-accent-red">{selectedTrade.slPrice.toFixed(2)}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">TP1 / TP2</div>
              <div className="font-mono text-xs">{selectedTrade.tp1Price.toFixed(2)} / {selectedTrade.tp2Price.toFixed(2)}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">Close Reason</div>
              <div className={`font-bold ${
                selectedTrade.closeReason === "tp2" ? "text-primary" :
                selectedTrade.closeReason === "sl" ? "text-accent-red" : "text-foreground"
              }`}>
                {selectedTrade.closeReason === "sl" ? "Stop Loss" :
                 selectedTrade.closeReason === "tp2" ? "Take Profit 2" :
                 selectedTrade.closeReason === "breakeven" ? "Breakeven" :
                 selectedTrade.closeReason === "time_stop" ? "Time Stop (30m)" : "End of Data"}
              </div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-text-secondary text-xs mb-1">Duration</div>
              <div className="font-bold">{selectedTrade.durationMinutes}m</div>
            </div>
            <div className="bg-muted rounded-lg p-3 col-span-2">
              <div className="text-text-secondary text-xs mb-2">Score Breakdown</div>
              <div className="flex gap-4">
                <div className="text-center flex-1">
                  <div className="text-xl font-bold font-mono text-primary">{selectedTrade.c1}</div>
                  <div className="text-[10px] text-text-secondary">1h Trend</div>
                </div>
                <div className="text-center flex-1">
                  <div className="text-xl font-bold font-mono text-primary">{selectedTrade.c2}</div>
                  <div className="text-[10px] text-text-secondary">15m Conf</div>
                </div>
                <div className="text-center flex-1">
                  <div className="text-xl font-bold font-mono text-primary">{selectedTrade.c3}</div>
                  <div className="text-[10px] text-text-secondary">5m Entry</div>
                </div>
                <div className="text-center flex-1 border-l border-border pl-4">
                  <div className="text-xl font-bold font-mono">{selectedTrade.score}</div>
                  <div className="text-[10px] text-text-secondary">Total / 30</div>
                </div>
              </div>
            </div>
            <div className={`bg-muted rounded-lg p-3 col-span-2 ${selectedTrade.pnl > 0 ? "border border-primary/30" : "border border-accent-red/30"}`}>
              <div className="text-text-secondary text-xs mb-1">P&amp;L</div>
              <div className={`text-2xl font-bold font-mono ${selectedTrade.pnl > 0 ? "text-primary" : "text-accent-red"}`}>
                {selectedTrade.pnl > 0 ? "+" : ""}{selectedTrade.pnl.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
