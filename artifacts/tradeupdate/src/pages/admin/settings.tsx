import { AdminLayout } from "@/components/admin-layout";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Server, Mail, ShieldAlert } from "lucide-react";
import { useSetMasterStop, useGetSystemSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: settings } = useGetSystemSettings({
    query: { queryKey: ["systemSettings"] }
  });

  const masterStop = useSetMasterStop();

  const handleMasterStop = (active: boolean) => {
    if (active && !confirm("DANGER: This will instantly halt ALL trading activity platform-wide. Proceed?")) return;
    
    masterStop.mutate({ data: { active } }, {
      onSuccess: () => {
        toast({ 
          title: active ? "Master Stop ACTIVATED" : "Master Stop DEACTIVATED",
          variant: active ? "destructive" : "default"
        });
        queryClient.invalidateQueries({ queryKey: ["systemSettings"] });
      }
    });
  };

  const isMasterStopActive = settings?.masterStop ?? false;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-foreground">System Settings</h1>
        
        <Card className={`border-2 p-8 transition-colors ${isMasterStopActive ? 'bg-accent-red/5 border-accent-red/50' : 'bg-card border-border'}`}>
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${isMasterStopActive ? 'bg-accent-red/20 text-accent-red' : 'bg-background border border-border text-text-secondary'}`}>
                <ShieldAlert className="w-8 h-8" />
              </div>
              <div>
                <h2 className={`text-xl font-bold mb-1 ${isMasterStopActive ? 'text-accent-red' : 'text-foreground'}`}>MASTER STOP</h2>
                <p className="text-sm text-text-secondary max-w-md">
                  Emergency kill switch. Activates platform-wide pause, preventing any new positions from opening. Existing positions will be managed according to individual bot settings.
                </p>
              </div>
            </div>
            
            <div className="flex flex-col items-center gap-2">
              <Switch 
                checked={isMasterStopActive} 
                onCheckedChange={handleMasterStop}
                className="scale-150 data-[state=checked]:bg-accent-red"
              />
              <span className={`text-xs font-bold tracking-wide mt-2 ${isMasterStopActive ? 'text-accent-red' : 'text-text-secondary'}`}>
                {isMasterStopActive ? 'SYSTEM HALTED' : 'SYSTEM NORMAL'}
              </span>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="bg-card border-border p-6">
            <div className="flex items-center gap-3 mb-6">
              <Server className="w-5 h-5 text-text-secondary" />
              <h2 className="text-lg font-bold">System Status</h2>
            </div>
            
            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b border-border">
                <span className="text-text-secondary text-sm">Database Size</span>
                <span className="font-mono text-sm">{settings?.dbSize || '—'}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border">
                <span className="text-text-secondary text-sm">Total Trades</span>
                <span className="font-mono text-sm">{settings?.totalTrades ?? '—'}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border">
                <span className="text-text-secondary text-sm">SMTP Ready</span>
                <span className={`font-mono text-sm ${settings?.smtpConfigured ? 'text-primary' : 'text-accent-red'}`}>
                  {settings?.smtpConfigured ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </Card>

          <Card className="bg-card border-border p-6">
            <div className="flex items-center gap-3 mb-6">
              <Mail className="w-5 h-5 text-text-secondary" />
              <h2 className="text-lg font-bold">SMTP Configuration</h2>
            </div>
            
            <div className="space-y-4 text-sm text-text-secondary">
              <p>Email delivery is currently configured via environment variables. To update these settings, modify the backend deployment environment.</p>
              <div className="bg-background border border-border rounded-lg p-3 font-mono text-xs">
                SMTP_HOST=smtp.sendgrid.net<br/>
                SMTP_PORT=587<br/>
                SMTP_USER=apikey
              </div>
            </div>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
