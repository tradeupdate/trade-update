import { AdminLayout } from "@/components/admin-layout";
import { useGetStrategies, usePauseStrategy, useReactivateStrategy } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, PlayCircle, PauseCircle, Settings2, Activity } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminStrategies() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: strategies, isLoading } = useGetStrategies({
    query: { queryKey: ["strategies"] }
  });

  const pauseStrategy = usePauseStrategy();
  const reactivateStrategy = useReactivateStrategy();

  const handleToggleState = (id: string, isActive: boolean) => {
    if (isActive) {
      pauseStrategy.mutate({ strategyId: id }, {
        onSuccess: () => {
          toast({ title: "Strategy paused" });
          queryClient.invalidateQueries({ queryKey: ["strategies"] });
        }
      });
    } else {
      reactivateStrategy.mutate({ strategyId: id }, {
        onSuccess: () => {
          toast({ title: "Strategy reactivated" });
          queryClient.invalidateQueries({ queryKey: ["strategies"] });
        }
      });
    }
  };

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Strategies</h1>
          <Button className="bg-primary text-black hover:bg-primary/90">
            <Plus className="w-4 h-4 mr-2" />
            Create Strategy
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {strategies?.strategies?.map((strategy) => {
              const isActive = strategy.status === 'active';
              return (
                <Card key={strategy.id} className={`bg-card border ${isActive ? 'border-border' : 'border-border/50 opacity-75'}`}>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="font-bold text-lg">{strategy.name}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="border-border text-text-secondary font-normal">
                            {strategy.type || 'Standard'}
                          </Badge>
                          {isActive ? (
                            <Badge className="bg-primary/20 text-primary border-0 hover:bg-primary/20">Active</Badge>
                          ) : (
                            <Badge className="bg-text-secondary/20 text-text-secondary border-0 hover:bg-text-secondary/20">Paused</Badge>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-bold text-foreground tabular-nums">
                          {strategy.winRate != null ? `${(strategy.winRate * 100).toFixed(1)}%` : '0%'}
                        </div>
                        <div className="text-xs text-text-secondary">Win Rate</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className="bg-background rounded-lg p-3 border border-border">
                        <div className="text-xs text-text-secondary mb-1 flex items-center">
                          <Activity className="w-3 h-3 mr-1" /> Score
                        </div>
                        <div className="font-semibold">{strategy.scoreThreshold ?? 0}+</div>
                      </div>
                      <div className="bg-background rounded-lg p-3 border border-border">
                        <div className="text-xs text-text-secondary mb-1">Users</div>
                        <div className="font-semibold">{strategy.usersAssigned ?? 0}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant="outline" className="flex-1 border-border bg-background hover:bg-border hover:text-foreground">
                        <Settings2 className="w-4 h-4 mr-2 text-text-secondary" />
                        Configure
                      </Button>
                      <Button 
                        variant="outline" 
                        className={`w-12 border-border bg-background hover:bg-border ${isActive ? 'text-accent-red hover:text-accent-red' : 'text-primary hover:text-primary'}`}
                        onClick={() => handleToggleState(strategy.id, isActive)}
                        disabled={pauseStrategy.isPending || reactivateStrategy.isPending}
                      >
                        {isActive ? <PauseCircle className="w-5 h-5" /> : <PlayCircle className="w-5 h-5" />}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {(!strategies?.strategies || strategies.strategies.length === 0) && (
              <div className="col-span-full text-center p-12 text-text-secondary border border-dashed border-border rounded-xl">
                No strategies found.
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
