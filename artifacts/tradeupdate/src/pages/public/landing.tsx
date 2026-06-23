import { Link } from "wouter";
import { useGetPublicStats, getGetPublicStatsQueryKey } from "@workspace/api-client-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

export default function Landing() {
  const { data: stats } = useGetPublicStats({
    query: {
      queryKey: getGetPublicStatsQueryKey(),
      refetchInterval: 30000,
    }
  });

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <Logo size="md" />
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm font-medium text-text-secondary hover:text-primary transition-colors">
            Login
          </Link>
          <Link href="/signup">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">Request Access</Button>
          </Link>
        </div>
      </header>

      {stats && (
        <div className="bg-card border-b border-border py-2 px-6 flex items-center justify-center gap-8 text-sm tabular-nums">
          <div><span className="text-text-secondary">Uptime:</span> <span className="text-primary">{stats.uptime}%</span></div>
          <div><span className="text-text-secondary">Trades:</span> <span className="text-primary">{stats.totalTrades.toLocaleString()}</span></div>
          <div><span className="text-text-secondary">Win Rate:</span> <span className="text-primary">{stats.avgWinRate.toFixed(1)}%</span></div>
          <div><span className="text-text-secondary">Strategies:</span> <span className="text-primary">{stats.strategiesCount}</span></div>
        </div>
      )}

      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-background z-0" />
        
        <div className="relative z-10 max-w-3xl mx-auto">
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            Trade Smarter, <br/><span className="text-primary">Not Harder</span>
          </h1>
          <p className="text-lg md:text-xl text-text-secondary mb-10 max-w-2xl mx-auto">
            Institutional-grade algorithmic trading platform for the Volatility 75 Index. Precise, automated, and built for serious traders.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/signup">
              <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 text-lg px-8 py-6 h-auto">
                Start Trading
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="border-primary/50 text-primary hover:bg-primary/10 text-lg px-8 py-6 h-auto">
                View Platform
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
