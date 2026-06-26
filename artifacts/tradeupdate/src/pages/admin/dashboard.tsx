import { useState } from "react";
import { useGetAdminOverview, getGetAdminOverviewQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Users, PlayCircle, Zap, ShieldAlert, Activity, Skull } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid
} from "recharts";

export default function AdminDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [killingAll, setKillingAll] = useState(false);

  const { data, isLoading } = useGetAdminOverview({
    query: {
      queryKey: getGetAdminOverviewQueryKey(),
      refetchInterval: 10000
    }
  });

  const { data: instancesData } = useQuery({
    queryKey: ["botInstances"],
    queryFn: async () => {
      const res = await fetch("/api/admin/bot-instances", { credentials: "include" });
      return res.json();
    },
    refetchInterval: 10000,
  });

  const handleKillAll = async () => {
    if (!confirm("DANGER: Kill all running bots? This will stop all active trades immediately.")) return;
    setKillingAll(true);
    try {
      const res = await fetch("/api/admin/kill-all", { method: "POST", credentials: "include" });
      if (res.ok) {
        toast({ title: "All bots killed", variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: ["botInstances"] });
        queryClient.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() });
      }
    } finally {
      setKillingAll(false);
    }
  };

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="animate-spin w-8 h-8 text-primary" />
        </div>
      </AdminLayout>
    );
  }

  // Fallback data if needed
  const overview = data ?? {
    totalUsers: 0,
    activeBots: 0,
    onlineNow: 0,
    inRecovery: 0,
    pendingSignups: 0,
    usersByProfile: [] as { profile: string; count: number }[],
    strategyPerformance: [] as { strategyId: string; name: string; winRate: number; totalTrades: number; usersAssigned: number; circuitBreakerActive?: boolean }[],
    recentAlerts: [] as { type: string; message: string; timestamp: number }[],
  };

  const COLORS = ['#00D4A4', '#FFB347', '#FF4060', '#8890AA'];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Overview</h1>
          <Button
            variant="outline"
            className="border-accent-red/40 text-accent-red hover:bg-accent-red/10 gap-2"
            onClick={handleKillAll}
            disabled={killingAll}
          >
            {killingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Skull className="w-4 h-4" />}
            Kill All Bots
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-text-secondary">Total Users</p>
                <Users className="h-4 w-4 text-text-secondary" />
              </div>
              <div className="text-2xl font-bold tabular-nums">{overview.totalUsers}</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-text-secondary">Active Bots</p>
                <PlayCircle className="h-4 w-4 text-primary" />
              </div>
              <div className="text-2xl font-bold tabular-nums text-primary">{overview.activeBots}</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-text-secondary">Online Now</p>
                <Activity className="h-4 w-4 text-accent-gold" />
              </div>
              <div className="text-2xl font-bold tabular-nums text-accent-gold">{overview.onlineNow}</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-text-secondary">In Recovery</p>
                <ShieldAlert className="h-4 w-4 text-accent-red" />
              </div>
              <div className="text-2xl font-bold tabular-nums text-accent-red">{overview.inRecovery}</div>
            </CardContent>
          </Card>
          <Link href="/admin/users">
            <Card className="bg-card border-border hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-6">
                <div className="flex items-center justify-between space-y-0 pb-2">
                  <p className="text-sm font-medium text-text-secondary">Pending Signups</p>
                  <Zap className="h-4 w-4 text-primary animate-pulse" />
                </div>
                <div className="text-2xl font-bold tabular-nums">{overview.pendingSignups}</div>
              </CardContent>
            </Card>
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-medium">Users by Profile</CardTitle>
            </CardHeader>
            <CardContent className="h-[300px]">
              {(overview.usersByProfile?.length ?? 0) > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={overview.usersByProfile}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="count"
                      nameKey="profile"
                    >
                      {(overview.usersByProfile ?? []).map((_entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0F1117', borderColor: '#1C1F2E', color: '#F0F2FF' }}
                      itemStyle={{ color: '#F0F2FF' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-text-secondary text-sm">No profile data</div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-medium">Strategy Performance</CardTitle>
            </CardHeader>
            <CardContent className="h-[300px]">
              {(overview.strategyPerformance?.length ?? 0) > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={overview.strategyPerformance}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1C1F2E" vertical={false} />
                    <XAxis dataKey="name" stroke="#8890AA" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#8890AA" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0F1117', borderColor: '#1C1F2E', color: '#F0F2FF' }}
                      cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    />
                    <Bar dataKey="winRate" fill="#00D4A4" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-text-secondary text-sm">No strategy data</div>
              )}
            </CardContent>
          </Card>
        </div>
        {/* Bot Instances */}
        {instancesData?.instances && instancesData.instances.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Bot Instances
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-background border-b border-border text-text-secondary text-xs uppercase">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">User</th>
                      <th className="px-4 py-3 text-left font-medium">Mode</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Trades</th>
                      <th className="px-4 py-3 text-right font-medium">Daily P&L</th>
                      <th className="px-4 py-3 text-left font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {instancesData.instances.map((inst: any) => (
                      <tr key={inst.userId} className="hover:bg-white/5">
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{inst.username}</div>
                          <div className="text-xs text-text-secondary">{inst.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={inst.tradingMode === "live" ? "border-primary text-primary" : "border-text-secondary text-text-secondary"}>
                            {inst.tradingMode}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={
                            inst.status === "running" ? "border-primary text-primary" :
                            inst.status === "killed" ? "border-accent-red text-accent-red" :
                            "border-text-secondary text-text-secondary"
                          }>
                            {inst.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm">{inst.tradesToday}</td>
                        <td className={`px-4 py-3 text-right font-mono text-sm font-bold ${inst.dailyPnl >= 0 ? "text-primary" : "text-accent-red"}`}>
                          {inst.dailyPnl >= 0 ? "+" : ""}${inst.dailyPnl.toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {inst.openTrade && <Badge className="text-[10px] bg-primary/20 text-primary border-0">OPEN</Badge>}
                            {inst.recoveryMode && <Badge className="text-[10px] bg-yellow-500/20 text-yellow-400 border-0">REC</Badge>}
                            {inst.dailyLossHit && <Badge className="text-[10px] bg-accent-red/20 text-accent-red border-0">LOSS</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
