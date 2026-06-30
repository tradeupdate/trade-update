import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, RefreshCw, ShieldCheck } from "lucide-react";

interface Check {
  id: string;
  label: string;
  auto: boolean;
  pass: boolean | null;
  detail: string;
}

interface PreLiveData {
  userId: string;
  username: string;
  tradingMode: string;
  checks: Check[];
  autoPass: boolean;
}

async function fetchUsers() {
  const r = await fetch("/api/admin/users?limit=200", { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load users");
  return r.json();
}

async function fetchPreLive(userId: string): Promise<PreLiveData> {
  const r = await fetch(`/api/admin/prelive-check/${userId}`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to run checks");
  return r.json();
}

export default function PreLiveCheck() {
  const [selectedUserId, setSelectedUserId] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [manualChecks, setManualChecks] = useState<Record<string, boolean>>({});

  const { data: usersData } = useQuery({ queryKey: ["admin-users-prelive"], queryFn: fetchUsers });
  const users = usersData?.users || [];

  const { data, isLoading, error } = useQuery<PreLiveData>({
    queryKey: ["prelive-check", selectedUserId, runKey],
    queryFn: () => fetchPreLive(selectedUserId),
    enabled: !!selectedUserId,
    staleTime: 0,
  });

  const toggleManual = (id: string) => {
    setManualChecks(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const allPass = data
    ? data.checks.every(c => {
        if (c.auto) return c.pass === true;
        return manualChecks[c.id] === true;
      })
    : false;

  const readyToGo = allPass && data?.autoPass;

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pre-Live Checklist</h1>
          <p className="text-text-secondary text-sm mt-1">
            Run all checks before switching a user from paper to live trading.
          </p>
        </div>

        {/* User selector */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={selectedUserId}
              onChange={e => { setSelectedUserId(e.target.value); setManualChecks({}); }}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
            >
              <option value="">— Select a user —</option>
              {users.filter((u: any) => u.role !== "admin").map((u: any) => (
                <option key={u.id} value={u.id}>{u.username} ({u.tradingMode || "paper"})</option>
              ))}
            </select>
            <Button
              onClick={() => setRunKey(k => k + 1)}
              disabled={!selectedUserId || isLoading}
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              Run Checks
            </Button>
          </div>

          {data && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary">User:</span>
              <span className="font-medium text-foreground">{data.username}</span>
              <Badge variant={data.tradingMode === "live" ? "destructive" : "secondary"} className="text-xs">
                {data.tradingMode || "paper"}
              </Badge>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-accent-red/10 border border-accent-red/30 rounded-xl p-4 text-accent-red text-sm">
            Failed to run checks. Please try again.
          </div>
        )}

        {/* Checklist */}
        {data && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="font-semibold text-foreground">Readiness Checks</h2>
              <p className="text-xs text-text-secondary mt-0.5">All items must pass before switching to live</p>
            </div>
            <div className="divide-y divide-border">
              {data.checks.map(check => {
                const isManualPass = manualChecks[check.id] === true;
                const effective = check.auto ? check.pass : isManualPass ? true : null;

                return (
                  <div key={check.id} className="flex items-center justify-between px-4 py-3.5 gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {effective === true ? (
                        <CheckCircle2 className="w-5 h-5 text-accent-green flex-shrink-0" />
                      ) : effective === false ? (
                        <XCircle className="w-5 h-5 text-accent-red flex-shrink-0" />
                      ) : (
                        <Clock className="w-5 h-5 text-text-secondary flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{check.label}</p>
                        <p className="text-xs text-text-secondary">{check.detail}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {check.auto ? (
                        <Badge
                          className={`text-xs ${
                            check.pass === true
                              ? "bg-accent-green/10 text-accent-green border-accent-green/30"
                              : check.pass === false
                              ? "bg-accent-red/10 text-accent-red border-accent-red/30"
                              : "bg-border text-text-secondary"
                          }`}
                          variant="outline"
                        >
                          {check.pass === true ? "PASS" : check.pass === false ? "FAIL" : "—"}
                        </Badge>
                      ) : (
                        <button
                          onClick={() => toggleManual(check.id)}
                          className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                            isManualPass
                              ? "bg-accent-green/10 text-accent-green border-accent-green/30"
                              : "bg-border/50 text-text-secondary border-border hover:border-primary hover:text-primary"
                          }`}
                        >
                          {isManualPass ? "✓ Confirmed" : "Confirm"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Summary */}
        {data && (
          <div className={`rounded-xl border p-6 ${readyToGo ? "bg-accent-green/5 border-accent-green/30" : "bg-border/30 border-border"}`}>
            {readyToGo ? (
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-8 h-8 text-accent-green" />
                <div>
                  <p className="font-bold text-accent-green text-lg">READY FOR LIVE TRADING</p>
                  <p className="text-sm text-text-secondary">All checks passed. You can safely switch {data.username} to live mode.</p>
                </div>
              </div>
            ) : (
              <div className="text-center text-text-secondary">
                <p className="font-medium text-foreground">Not ready yet</p>
                <p className="text-sm mt-1">
                  {data.checks.filter(c => c.auto && c.pass === false).length} auto-check(s) failing
                  {" · "}
                  {data.checks.filter(c => !c.auto && !manualChecks[c.id]).length} manual confirmation(s) pending
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
