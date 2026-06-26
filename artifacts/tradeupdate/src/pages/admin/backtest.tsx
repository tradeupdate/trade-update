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
import { useState } from "react";
import { Play, BarChart2, Loader2, TrendingUp, TrendingDown, Clock, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from "recharts";

export default function AdminBacktest() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [strategyId, setStrategyId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [activeResult, setActiveResult] = useState<any>(null);

  const { data: strategies } = useGetStrategies({ query: { queryKey: ["strategies"] } });
  const { data: history, isLoading: historyLoading } = useGetBacktestResults({
    query: {
      queryKey: getGetBacktestResultsQueryKey(),
      refetchInterval: 5000,
    }
  });

  const runMutation = useRunBacktest();

  const handleRun = () => {
    if (!strategyId) {
      toast({ title: "Please select a strategy", variant: "destructive" });
      return;
    }
    const from = dateFrom ? Math.floor(new Date(dateFrom).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400 * 30;
    const to = dateTo ? Math.floor(new Date(dateTo).getTime() / 1000) : Math.floor(Date.now() / 1000);

    runMutation.mutate(
      { data: { strategyId, dateFrom: from, dateTo: to } },
      {
        onSuccess: (result) => {
          setActiveResult(result);
          queryClient.invalidateQueries({ queryKey: getGetBacktestResultsQueryKey() });
          toast({
            title: "Backtest complete",
            description: `${result.totalTrades} trades | Win Rate: ${result.winRate.toFixed(1)}% | P&L: $${result.totalPnl.toFixed(2)}`,
          });
        },
        onError: () => {
          toast({ title: "Backtest failed", variant: "destructive" });
        },
      }
    );
  };

  const display = activeResult ?? (history?.results?.[0] ?? null);
  const equityCurve = (() => {
    try {
      const raw = display?.equityCurve;
      if (!raw) return [];
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed.map((p: any) => ({ name: `T${p.index + 1}`, equity: p.value }));
    } catch { return []; }
  })();

  const strategyName = strategies?.strategies?.find(s => s.id === (display?.strategyId ?? strategyId))?.name ?? "—";

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Backtest Engine</h1>
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
            </div>
            <Button
              className="w-full mt-6 bg-primary text-black hover:bg-primary/90 font-semibold"
              onClick={handleRun}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Running...</>
              ) : (
                <><Play className="w-4 h-4 mr-2" />Run Backtest</>
              )}
            </Button>

            {/* Results history list */}
            {(history?.results?.length ?? 0) > 0 && (
              <div className="mt-6">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">History</p>
                <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                  {history!.results!.map((r) => (
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
                        {strategies?.strategies?.find(s => s.id === r.strategyId)?.name ?? r.strategyId.slice(0, 8)}
                      </div>
                      <div className="flex justify-between mt-0.5">
                        <span className={r.totalPnl >= 0 ? "text-primary" : "text-accent-red"}>
                          {r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(0)}
                        </span>
                        <span>{r.winRate.toFixed(1)}% WR</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Results panel */}
          <div className="lg:col-span-3 space-y-6">
            {display ? (
              <>
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
                    <div className={`text-2xl font-bold tabular-nums ${display.winRate >= 55 ? "text-primary" : "text-accent-red"}`}>
                      {display.winRate.toFixed(1)}%
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">PF: {display.profitFactor?.toFixed(2) ?? "—"}</div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-xs text-text-secondary">Total P&L</span>
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${display.totalPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                      {display.totalPnl >= 0 ? "+" : ""}${display.totalPnl.toFixed(2)}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      Best: ${display.bestTrade?.toFixed(2) ?? "—"}
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
                    <CardTitle className="text-base font-medium flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BarChart2 className="w-4 h-4 text-text-secondary" />
                        Equity Curve — {strategyName}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="border-primary/40 text-primary text-xs">
                          {display.totalTrades} trades
                        </Badge>
                        {display.avgDurationMinutes && (
                          <Badge variant="outline" className="border-border text-text-secondary text-xs">
                            <Clock className="w-3 h-3 mr-1" />
                            {display.avgDurationMinutes.toFixed(0)}m avg
                          </Badge>
                        )}
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="h-[300px]">
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
                        No equity curve data
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Extra stats */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
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
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Sharpe Ratio</div>
                    <div className={`text-lg font-bold tabular-nums ${(display.sharpeRatio ?? 0) >= 1 ? "text-primary" : "text-accent-red"}`}>
                      {display.sharpeRatio?.toFixed(2) ?? "—"}
                    </div>
                  </Card>
                  <Card className="bg-card border-border p-4">
                    <div className="text-xs text-text-secondary mb-1">Strategy</div>
                    <div className="text-sm font-bold truncate">{strategyName}</div>
                  </Card>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-[400px] text-text-secondary gap-3">
                <BarChart2 className="w-12 h-12 text-border" />
                <p className="text-sm">Select a strategy and run a backtest to see results</p>
                <p className="text-xs">Previous results will appear in the history panel</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
