import { AdminLayout } from "@/components/admin-layout";
import { useGetStrategies } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Play, BarChart2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export default function AdminBacktest() {
  const { toast } = useToast();
  const [strategyId, setStrategyId] = useState("");
  
  const { data: strategies } = useGetStrategies({ query: { queryKey: ["strategies"] } });

  const handleRun = () => {
    if (!strategyId) {
      toast({ title: "Please select a strategy", variant: "destructive" });
      return;
    }
    toast({ title: "Backtest started (simulation)" });
  };

  const mockData = [
    { name: 'Day 1', equity: 10000 },
    { name: 'Day 2', equity: 10150 },
    { name: 'Day 3', equity: 10080 },
    { name: 'Day 4', equity: 10300 },
    { name: 'Day 5', equity: 10250 },
    { name: 'Day 6', equity: 10500 },
    { name: 'Day 7', equity: 10800 },
  ];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-foreground">Backtest Engine</h1>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="bg-card border-border p-6 lg:col-span-1">
            <h2 className="text-lg font-bold mb-4">Configuration</h2>
            
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-text-secondary mb-1.5 block">Strategy</label>
                <select 
                  className="w-full h-10 px-3 rounded-md border border-border bg-background text-foreground"
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
                <label className="text-sm font-medium text-text-secondary mb-1.5 block">Time Range</label>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" className="h-10 px-3 rounded-md border border-border bg-background text-foreground text-sm" />
                  <input type="date" className="h-10 px-3 rounded-md border border-border bg-background text-foreground text-sm" />
                </div>
              </div>
            </div>

            <Button 
              className="w-full mt-6 bg-primary text-black hover:bg-primary/90"
              onClick={handleRun}
            >
              <Play className="w-4 h-4 mr-2" />
              Run Backtest
            </Button>
          </Card>

          <div className="lg:col-span-2 space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Total Trades</div>
                <div className="text-xl font-bold">142</div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Win Rate</div>
                <div className="text-xl font-bold text-primary">68.5%</div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Total P&L</div>
                <div className="text-xl font-bold text-primary">+$800.00</div>
              </Card>
              <Card className="bg-card border-border p-4">
                <div className="text-xs text-text-secondary mb-1">Max Drawdown</div>
                <div className="text-xl font-bold text-accent-red">-4.2%</div>
              </Card>
            </div>

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base font-medium flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-text-secondary" />
                  Equity Curve
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={mockData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1C1F2E" vertical={false} />
                    <XAxis dataKey="name" stroke="#8890AA" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#8890AA" fontSize={12} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0F1117', borderColor: '#1C1F2E', color: '#F0F2FF' }}
                    />
                    <Line type="monotone" dataKey="equity" stroke="#00D4A4" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
