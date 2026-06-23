import { useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import { useGetAdminUsers, useExecuteCopyTrade } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Zap, AlertTriangle, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AdminCopy() {
  const { toast } = useToast();
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [riskMultiplier, setRiskMultiplier] = useState(1.0);
  const [forceOverride, setForceOverride] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  const { data: users, isLoading } = useGetAdminUsers(undefined, {
    query: { queryKey: ["adminUsers"] }
  });

  const execute = useExecuteCopyTrade();

  const handleExecute = () => {
    if (selectedUsers.length === 0) {
      toast({ title: "Select at least one user", variant: "destructive" });
      return;
    }
    
    execute.mutate({ 
      data: { 
        direction, 
        riskMultiplier,
        targetUserIds: selectedUsers,
        forceOverrideUserIds: forceOverride ? selectedUsers : []
      } 
    }, {
      onSuccess: () => {
        toast({ title: "Copy trade executed successfully" });
        setSelectedUsers([]);
      }
    });
  };

  const eligibleUsers = users?.users?.filter((u) => u.role !== 'admin') || [];

  const toggleAll = () => {
    if (selectedUsers.length === eligibleUsers.length) setSelectedUsers([]);
    else setSelectedUsers(eligibleUsers.map((u) => u.id));
  };

  const toggleUser = (id: string) => {
    setSelectedUsers(prev => 
      prev.includes(id) ? prev.filter(uid => uid !== id) : [...prev, id]
    );
  };

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-foreground">Copy Trading Engine</h1>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card className="bg-card border-border p-6">
              <h2 className="text-lg font-bold mb-4">Trade Configuration</h2>
              
              <div className="grid grid-cols-2 gap-4 mb-6">
                <Button 
                  variant="outline" 
                  className={`h-24 flex flex-col items-center justify-center gap-2 border-2 ${direction === 'BUY' ? 'border-primary text-primary bg-primary/10' : 'border-border text-text-secondary bg-background hover:bg-border'}`}
                  onClick={() => setDirection('BUY')}
                >
                  <ArrowRight className="w-6 h-6 -rotate-45" />
                  <span className="font-bold">BUY</span>
                </Button>
                <Button 
                  variant="outline" 
                  className={`h-24 flex flex-col items-center justify-center gap-2 border-2 ${direction === 'SELL' ? 'border-accent-red text-accent-red bg-accent-red/10' : 'border-border text-text-secondary bg-background hover:bg-border'}`}
                  onClick={() => setDirection('SELL')}
                >
                  <ArrowRight className="w-6 h-6 rotate-45" />
                  <span className="font-bold">SELL</span>
                </Button>
              </div>

              <div className="mb-6">
                <label className="text-sm font-medium text-text-secondary mb-3 block">Risk Multiplier</label>
                <div className="flex gap-2">
                  {[1.0, 1.25, 1.5, 2.0].map(m => (
                    <Button 
                      key={m}
                      variant="outline" 
                      className={`flex-1 ${riskMultiplier === m ? 'border-accent-gold text-accent-gold bg-accent-gold/10' : 'border-border text-text-secondary bg-background hover:bg-border'}`}
                      onClick={() => setRiskMultiplier(m)}
                    >
                      {m}x
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between p-4 bg-background border border-border rounded-lg">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-accent-red" />
                  <div>
                    <div className="font-medium">Force Override</div>
                    <div className="text-xs text-text-secondary">Ignore user's paused state and max drawdown limits</div>
                  </div>
                </div>
                <Checkbox 
                  checked={forceOverride} 
                  onCheckedChange={(c) => setForceOverride(!!c)} 
                  className="data-[state=checked]:bg-accent-red data-[state=checked]:border-accent-red border-border"
                />
              </div>
            </Card>

            <Card className="bg-card border-border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold">Select Targets</h2>
                <Button variant="ghost" size="sm" onClick={toggleAll} className="text-xs text-primary">
                  {selectedUsers.length === eligibleUsers.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>

              {isLoading ? (
                <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                  {eligibleUsers.map((user) => (
                    <div key={user.id} className="flex items-center justify-between p-3 border border-border rounded-lg bg-background">
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={selectedUsers.includes(user.id)} 
                          onCheckedChange={() => toggleUser(user.id)}
                          className="data-[state=checked]:bg-primary border-border"
                        />
                        <div>
                          <div className="font-medium text-sm">{user.username}</div>
                          <div className="text-xs text-text-secondary">{user.tradingProfile || 'Default'}</div>
                        </div>
                      </div>
                      <Badge variant="outline" className={user.botRunning ? 'border-primary text-primary' : 'border-border text-text-secondary'}>
                        {user.botRunning ? 'Running' : 'Paused'}
                      </Badge>
                    </div>
                  ))}
                  {eligibleUsers.length === 0 && (
                    <div className="text-center p-4 text-text-secondary text-sm">No eligible users found</div>
                  )}
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="bg-card border-border p-6">
              <h2 className="text-lg font-bold mb-4">Execution Summary</h2>
              
              <div className="space-y-4 mb-8">
                <div className="flex justify-between items-center pb-3 border-b border-border">
                  <span className="text-text-secondary">Direction</span>
                  <span className={`font-bold ${direction === 'BUY' ? 'text-primary' : 'text-accent-red'}`}>{direction}</span>
                </div>
                <div className="flex justify-between items-center pb-3 border-b border-border">
                  <span className="text-text-secondary">Target Users</span>
                  <span className="font-bold">{selectedUsers.length}</span>
                </div>
                <div className="flex justify-between items-center pb-3 border-b border-border">
                  <span className="text-text-secondary">Risk Multiplier</span>
                  <span className="font-bold text-accent-gold">{riskMultiplier}x</span>
                </div>
                <div className="flex justify-between items-center pb-3 border-b border-border">
                  <span className="text-text-secondary">Force Mode</span>
                  <span className={`font-bold ${forceOverride ? 'text-accent-red' : 'text-text-secondary'}`}>{forceOverride ? 'ON' : 'OFF'}</span>
                </div>
              </div>

              <Button 
                className="w-full h-14 text-lg font-bold bg-primary text-black hover:bg-primary/90 disabled:opacity-50"
                onClick={handleExecute}
                disabled={selectedUsers.length === 0 || execute.isPending}
              >
                {execute.isPending ? <Loader2 className="w-6 h-6 animate-spin" /> : (
                  <>
                    <Zap className="w-5 h-5 mr-2" />
                    EXECUTE TRADE
                  </>
                )}
              </Button>
            </Card>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
