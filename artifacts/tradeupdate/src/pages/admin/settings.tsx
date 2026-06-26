import { useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Server, Mail, ShieldAlert, Activity, Plus, Check, Loader2 } from "lucide-react";
import { useSetMasterStop, useGetSystemSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useQuery } from "@tanstack/react-query";

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings } = useGetSystemSettings({
    query: { queryKey: ["systemSettings"] }
  });

  const masterStop = useSetMasterStop();
  const isMasterStopActive = settings?.masterStop ?? false;

  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["systemHealth"],
    queryFn: async () => {
      const res = await fetch("/api/admin/system-health", { credentials: "include" });
      return res.json();
    },
    refetchInterval: 15000,
  });

  const { data: configData, refetch: refetchConfig } = useQuery({
    queryKey: ["globalConfig"],
    queryFn: async () => {
      const res = await fetch("/api/admin/config", { credentials: "include" });
      return res.json();
    },
  });

  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

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

  const handleSaveConfig = async (key: string, value: string) => {
    if (!key || !value) return;
    setSavingConfig(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        toast({ title: "Config updated" });
        setNewKey("");
        setNewValue("");
        refetchConfig();
      }
    } finally {
      setSavingConfig(false);
    }
  };

  const formatUptime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-foreground">System Settings</h1>

        {/* Master Stop */}
        <Card className={`border-2 p-8 transition-colors ${isMasterStopActive ? 'bg-accent-red/5 border-accent-red/50' : 'bg-card border-border'}`}>
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${isMasterStopActive ? 'bg-accent-red/20 text-accent-red' : 'bg-background border border-border text-text-secondary'}`}>
                <ShieldAlert className="w-8 h-8" />
              </div>
              <div>
                <h2 className={`text-xl font-bold mb-1 ${isMasterStopActive ? 'text-accent-red' : 'text-foreground'}`}>MASTER STOP</h2>
                <p className="text-sm text-text-secondary max-w-md">
                  Emergency kill switch. Activates platform-wide pause, preventing any new positions from opening.
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

        {/* System Health */}
        <Card className="bg-card border-border p-6">
          <div className="flex items-center gap-3 mb-6">
            <Activity className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold">System Health</h2>
            {healthLoading && <Loader2 className="w-4 h-4 animate-spin text-text-secondary" />}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {[
              { label: "Uptime", value: health ? formatUptime(health.uptime) : "—" },
              { label: "Active Bots", value: health?.activeBotsCount ?? "—" },
              { label: "Memory", value: health ? `${health.memUsageMb} MB` : "—" },
              { label: "Environment", value: health?.nodeEnv ?? "—" },
            ].map(({ label, value }) => (
              <div key={label} className="bg-background border border-border rounded-lg p-3">
                <p className="text-xs text-text-secondary mb-1">{label}</p>
                <p className="font-mono font-bold text-sm">{String(value)}</p>
              </div>
            ))}
          </div>
          {health?.errors && health.errors.length > 0 && (
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wide mb-2">Recent Errors</p>
              <div className="space-y-2">
                {health.errors.map((err: any, i: number) => (
                  <div key={i} className="bg-accent-red/5 border border-accent-red/20 rounded-lg p-3">
                    <p className="text-xs text-accent-red font-mono">{err.message}</p>
                    <p className="text-[10px] text-text-secondary mt-1">
                      {new Date((err.createdAt || 0) * 1000).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {health?.errors?.length === 0 && (
            <div className="flex items-center gap-2 text-primary text-sm">
              <Check className="w-4 h-4" />
              No recent errors
            </div>
          )}
        </Card>

        {/* Global Config */}
        <Card className="bg-card border-border p-6">
          <div className="flex items-center gap-3 mb-6">
            <Server className="w-5 h-5 text-text-secondary" />
            <h2 className="text-lg font-bold">Global Config</h2>
          </div>
          <div className="space-y-2 mb-4">
            {(configData?.config || []).map((item: any) => (
              <div key={item.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                <span className="font-mono text-sm text-text-secondary w-40 shrink-0">{item.key}</span>
                <span className="font-mono text-sm flex-1">{item.value}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-text-secondary"
                  onClick={() => { setNewKey(item.key); setNewValue(item.value); }}
                >
                  Edit
                </Button>
              </div>
            ))}
            {(!configData?.config || configData.config.length === 0) && (
              <p className="text-sm text-text-secondary py-2">No config entries yet.</p>
            )}
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs text-text-secondary block mb-1">Key</label>
              <Input
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                placeholder="config.key"
                className="bg-background border-border font-mono text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-secondary block mb-1">Value</label>
              <Input
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder="value"
                className="bg-background border-border font-mono text-sm"
              />
            </div>
            <Button
              onClick={() => handleSaveConfig(newKey, newValue)}
              disabled={savingConfig || !newKey || !newValue}
              className="bg-primary text-black hover:bg-primary/90"
            >
              {savingConfig ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
        </Card>

        {/* System Status & SMTP */}
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
              <p>Email delivery is configured via environment variables on the backend deployment.</p>
              <div className="bg-background border border-border rounded-lg p-3 font-mono text-xs">
                SMTP_HOST=smtp.sendgrid.net<br />
                SMTP_PORT=587<br />
                SMTP_USER=apikey
              </div>
            </div>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
