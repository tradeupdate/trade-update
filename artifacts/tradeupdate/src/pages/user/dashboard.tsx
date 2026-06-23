import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { 
  useGetMe, 
  useGetBotStatus, 
  useGetLatestTick, 
  getGetBotStatusQueryKey,
  useGetUserDashboard,
  getGetUserDashboardQueryKey,
  useToggleBot,
  useLogout
} from "@workspace/api-client-react";
import { Logo } from "@/components/ui/logo";
import { Loader2, Power, Pause, LogOut, Home, BarChart2, List, Settings as SettingsIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

export default function Dashboard() {
  const { data: user } = useGetMe();
  const [price, setPrice] = useState(0);
  const [activeTab, setActiveTab] = useState("home");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: botStatus } = useGetBotStatus({
    query: {
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: 3000
    }
  });

  const { data: dashboardData } = useGetUserDashboard({
    query: {
      queryKey: getGetUserDashboardQueryKey(),
      refetchInterval: 5000
    }
  });

  const { data: tick } = useGetLatestTick({
    query: {
      queryKey: ['latestTick'],
      refetchInterval: 1000
    }
  });

  const toggleBot = useToggleBot();
  const logout = useLogout();

  useEffect(() => {
    if (tick) {
      setPrice(tick.price);
    }
  }, [tick]);

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setLocation("/login");
      }
    });
  };

  const isRunning = botStatus?.isRunning ?? false;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground pb-16">
      <header className="h-[60px] flex items-center justify-between px-4 border-b border-border bg-card fixed top-0 w-full z-10">
        <Logo size="sm" />
        <div className="flex flex-col items-center">
          <span className="text-xs text-text-secondary">V75 INDEX</span>
          <span className={`text-lg font-bold tabular-nums transition-colors duration-150 ${tick?.direction === 'up' ? 'text-primary' : tick?.direction === 'down' ? 'text-accent-red' : 'text-foreground'}`}>
            {price > 0 ? price.toFixed(2) : '---'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-text-secondary" />
          )}
          <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full bg-border text-xs font-bold" onClick={handleLogout}>
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </Button>
        </div>
      </header>
      
      {(botStatus?.pauseReason || botStatus?.killSwitchActive || botStatus?.recoveryModeActive) && (
        <div className={`mt-[60px] py-1 text-center text-xs font-medium uppercase tracking-wide ${
          botStatus.killSwitchActive ? 'bg-accent-red/10 text-accent-red' :
          botStatus.recoveryModeActive ? 'bg-accent-amber/10 text-accent-amber' :
          'bg-text-secondary/10 text-text-secondary'
        }`}>
          {botStatus.killSwitchActive ? 'KILL SWITCH ACTIVE' : botStatus.recoveryModeActive ? 'RECOVERY MODE' : botStatus.pauseReason}
        </div>
      )}

      <main className={`flex-1 p-4 ${!(botStatus?.pauseReason || botStatus?.killSwitchActive) ? 'mt-[60px]' : ''}`}>
        {activeTab === "home" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Balance</div>
                <div className="text-xl font-bold tabular-nums">${(dashboardData?.user?.accountBalance ?? 0).toFixed(2)}</div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Today P&L</div>
                <div className={`text-xl font-bold tabular-nums ${(dashboardData?.botStatus?.dailyPnl ?? 0) >= 0 ? 'text-primary' : 'text-accent-red'}`}>
                  {(dashboardData?.botStatus?.dailyPnl ?? 0) >= 0 ? '+' : ''}{(dashboardData?.botStatus?.dailyPnl ?? 0).toFixed(2)}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Streak</div>
                <div className="text-xl font-bold tabular-nums">
                  {(dashboardData?.botStatus?.consecutiveWins ?? 0) > 0
                    ? <span className="text-primary">+{dashboardData?.botStatus?.consecutiveWins}W</span>
                    : (dashboardData?.botStatus?.consecutiveLosses ?? 0) > 0
                    ? <span className="text-accent-red">-{dashboardData?.botStatus?.consecutiveLosses}L</span>
                    : '—'}
                </div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Trades Today</div>
                <div className="text-xl font-bold tabular-nums">{dashboardData?.botStatus?.todayTrades ?? 0}</div>
              </Card>
            </div>

            <Card className="bg-card border-border p-6 flex flex-col items-center">
              <Button 
                onClick={() => {
                  toggleBot.mutate({ data: { running: !isRunning } }, {
                    onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() })
                  });
                }}
                disabled={toggleBot.isPending}
                className={`w-32 h-32 rounded-full mb-4 transition-all duration-300 ${
                  isRunning 
                    ? 'bg-primary/20 hover:bg-primary/30 border-2 border-primary text-primary' 
                    : 'bg-card border-2 border-border hover:bg-border text-text-secondary'
                }`}
              >
                {toggleBot.isPending ? <Loader2 className="w-8 h-8 animate-spin" /> : 
                 isRunning ? <Power className="w-10 h-10" /> : <Pause className="w-10 h-10" />}
              </Button>
              <div className="text-lg font-bold">{isRunning ? 'BOT ACTIVE' : 'BOT PAUSED'}</div>
              <div className="text-sm text-text-secondary mt-1">{dashboardData?.user?.tradingProfile || 'No Profile'}</div>
            </Card>
          </div>
        )}

        {activeTab === "chart" && (
          <div className="text-center p-8 border border-border rounded-xl bg-card">
            Chart Coming Soon
          </div>
        )}

        {activeTab === "trades" && (
          <div className="text-center p-8 border border-border rounded-xl bg-card">
            Trades Coming Soon
          </div>
        )}

        {activeTab === "settings" && (
          <div className="space-y-4">
             <div className="p-4 bg-card border border-border rounded-xl">
               <h3 className="font-bold mb-4">Settings</h3>
               <Button variant="outline" className="w-full text-accent-red border-accent-red/20 hover:bg-accent-red/10 hover:text-accent-red" onClick={handleLogout}>
                 <LogOut className="w-4 h-4 mr-2" />
                 Sign Out
               </Button>
             </div>
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 w-full h-[64px] bg-card border-t border-border flex items-center justify-around px-2 z-10 pb-safe">
        <button 
          onClick={() => setActiveTab("home")}
          className={`flex flex-col items-center p-2 w-16 transition-colors ${activeTab === "home" ? "text-primary" : "text-text-secondary"}`}
        >
          <Home className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium">Home</span>
        </button>
        <button 
          onClick={() => setActiveTab("chart")}
          className={`flex flex-col items-center p-2 w-16 transition-colors ${activeTab === "chart" ? "text-primary" : "text-text-secondary"}`}
        >
          <BarChart2 className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium">Chart</span>
        </button>
        <button 
          onClick={() => setActiveTab("trades")}
          className={`flex flex-col items-center p-2 w-16 transition-colors ${activeTab === "trades" ? "text-primary" : "text-text-secondary"}`}
        >
          <List className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium">Trades</span>
        </button>
        <button 
          onClick={() => setActiveTab("settings")}
          className={`flex flex-col items-center p-2 w-16 transition-colors ${activeTab === "settings" ? "text-primary" : "text-text-secondary"}`}
        >
          <SettingsIcon className="w-5 h-5 mb-1" />
          <span className="text-[10px] font-medium">Settings</span>
        </button>
      </nav>
    </div>
  );
}
