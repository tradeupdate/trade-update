import { useGetAdminOverview, getGetAdminOverviewQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Users, PlayCircle, Zap, ShieldAlert, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid
} from "recharts";

export default function AdminDashboard() {
  const { data, isLoading } = useGetAdminOverview({
    query: {
      queryKey: getGetAdminOverviewQueryKey(),
      refetchInterval: 10000
    }
  });

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
      </div>
    </AdminLayout>
  );
}
