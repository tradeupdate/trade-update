import { useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import { useGetStrategies, usePauseStrategy, useReactivateStrategy } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, PlayCircle, PauseCircle, Settings2, Activity, ChevronRight, ChevronLeft, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

type StrategyType = "Scalping" | "Swing" | "Reversal" | "Trend-Following";
type Session = "asian" | "london" | "overlap" | "ny";

interface StrategyForm {
  name: string;
  description: string;
  type: StrategyType;
  entryTimeframe: string;
  signalTimeframe: string;
  trendTimeframe: string;
  sessions: Session[];
  scoreThreshold: number;
  maxTradesDay: number;
  maxTradesHour: number;
  autoPauseOnLosses: number;
  maxRiskPercent: number;
  stopMultiplier: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
  counterTrendEnabled: boolean;
  consolidationDetection: boolean;
  firstCandleRule: boolean;
  spikeFilterEnabled: boolean;
  momentumExtensionEnabled: boolean;
}

const DEFAULT_FORM: StrategyForm = {
  name: "", description: "", type: "Scalping",
  entryTimeframe: "1m", signalTimeframe: "5m", trendTimeframe: "15m",
  sessions: [],
  scoreThreshold: 35, maxTradesDay: 6, maxTradesHour: 3, autoPauseOnLosses: 5,
  maxRiskPercent: 1.0, stopMultiplier: 1.5, tp1Multiplier: 1.5, tp2Multiplier: 3.0,
  counterTrendEnabled: false, consolidationDetection: true, firstCandleRule: true,
  spikeFilterEnabled: true, momentumExtensionEnabled: true,
};

const SESSIONS = [
  { key: "asian" as Session, label: "Asian / Tokyo", time: "00:00–03:00 UTC", badge: "MODERATE" },
  { key: "london" as Session, label: "London Open", time: "07:00–10:00 UTC", badge: "HIGH" },
  { key: "overlap" as Session, label: "London / NY Overlap", time: "12:00–15:00 UTC", badge: "PREMIUM" },
  { key: "ny" as Session, label: "NY Afternoon", time: "13:00–16:00 UTC", badge: "HIGH" },
];

function SliderField({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  const fmt = format ?? (v => String(v));
  return (
    <div>
      <div className="flex justify-between mb-1">
        <Label className="text-foreground text-sm">{label}</Label>
        <span className="text-primary text-sm font-mono font-bold">{fmt(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="flex justify-between text-xs text-text-secondary mt-0.5">
        <span>{fmt(min)}</span><span>{fmt(max)}</span>
      </div>
    </div>
  );
}

function Toggle({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-border last:border-0 gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">{desc}</div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors mt-0.5 ${value ? "bg-primary" : "bg-border"}`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

function StrategyModal({
  open, onClose, editingStrategy, onSaved
}: {
  open: boolean;
  onClose: () => void;
  editingStrategy: any | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<StrategyForm>(DEFAULT_FORM);

  const set = <K extends keyof StrategyForm>(k: K, v: StrategyForm[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const toggleSession = (s: Session) =>
    setForm(f => ({
      ...f,
      sessions: f.sessions.includes(s) ? f.sessions.filter(x => x !== s) : [...f.sessions, s],
    }));

  const handleOpen = () => {
    if (editingStrategy) {
      setForm({
        name: editingStrategy.name ?? "",
        description: editingStrategy.description ?? "",
        type: (editingStrategy.type as StrategyType) ?? "Scalping",
        entryTimeframe: editingStrategy.entryTimeframe ?? "1m",
        signalTimeframe: editingStrategy.signalTimeframe ?? "5m",
        trendTimeframe: editingStrategy.trendTimeframe ?? "15m",
        sessions: JSON.parse(editingStrategy.sessionsEnabled ?? "[]"),
        scoreThreshold: editingStrategy.scoreThreshold ?? 35,
        maxTradesDay: editingStrategy.maxTradesDay ?? 6,
        maxTradesHour: editingStrategy.maxTradesHour ?? 3,
        autoPauseOnLosses: editingStrategy.autoPauseOnLosses ?? 5,
        maxRiskPercent: editingStrategy.maxRiskPercent ?? 1.0,
        stopMultiplier: editingStrategy.stopMultiplier ?? 1.5,
        tp1Multiplier: editingStrategy.tp1Multiplier ?? 1.5,
        tp2Multiplier: editingStrategy.tp2Multiplier ?? 3.0,
        counterTrendEnabled: !!editingStrategy.counterTrendEnabled,
        consolidationDetection: !!editingStrategy.consolidationDetection,
        firstCandleRule: !!editingStrategy.firstCandleRule,
        spikeFilterEnabled: !!editingStrategy.spikeFilterEnabled,
        momentumExtensionEnabled: !!editingStrategy.momentumExtensionEnabled,
      });
    } else {
      setForm(DEFAULT_FORM);
    }
    setStep(1);
  };

  const buildPayload = () => ({
    name: form.name,
    description: form.description,
    type: form.type,
    entryTimeframe: form.entryTimeframe,
    signalTimeframe: form.signalTimeframe,
    trendTimeframe: form.trendTimeframe,
    sessionsEnabled: JSON.stringify(form.sessions),
    scoreThreshold: form.scoreThreshold,
    maxTradesDay: form.maxTradesDay,
    maxTradesHour: form.maxTradesHour,
    autoPauseOnLosses: form.autoPauseOnLosses,
    maxRiskPercent: form.maxRiskPercent,
    stopMultiplier: form.stopMultiplier,
    tp1Multiplier: form.tp1Multiplier,
    tp2Multiplier: form.tp2Multiplier,
    counterTrendEnabled: form.counterTrendEnabled ? 1 : 0,
    consolidationDetection: form.consolidationDetection ? 1 : 0,
    firstCandleRule: form.firstCandleRule ? 1 : 0,
    spikeFilterEnabled: form.spikeFilterEnabled ? 1 : 0,
    momentumExtensionEnabled: form.momentumExtensionEnabled ? 1 : 0,
    status: "active",
  });

  const handleSave = async () => {
    if (!form.name.trim()) { toast({ title: "Strategy name is required", variant: "destructive" }); setStep(1); return; }
    setSaving(true);
    try {
      const url = editingStrategy ? `/api/admin/strategies/${editingStrategy.id}` : "/api/admin/strategies";
      const method = editingStrategy ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Error"); }
      toast({ title: editingStrategy ? "Strategy updated" : "Strategy created successfully" });
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: err.message || "Failed to save strategy", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const canNext = () => {
    if (step === 1 && !form.name.trim()) return false;
    return true;
  };

  const sessionLabel = (s: Session) => SESSIONS.find(x => x.key === s)?.label ?? s;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); else handleOpen(); }}>
      <DialogContent className="bg-card border-border max-w-lg w-full max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            {editingStrategy ? `Edit Strategy: ${editingStrategy.name}` : "Create Strategy"}
          </DialogTitle>
        </DialogHeader>

        {/* Progress */}
        <div className="mt-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-secondary">Step {step} of 7</span>
            <span className="text-xs text-primary font-medium">{Math.round((step / 7) * 100)}%</span>
          </div>
          <div className="w-full h-1 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(step / 7) * 100}%` }} />
          </div>
        </div>

        <div className="flex flex-col gap-5 mt-4 min-h-[320px]">
          {/* STEP 1 — Basic Info */}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Basic Info</h3>
              <div>
                <Label className="text-foreground mb-1.5 block">Strategy Name <span className="text-accent-red">*</span></Label>
                <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="V75 Sniper" className="bg-background border-border" />
              </div>
              <div>
                <Label className="text-foreground mb-1.5 block">Description</Label>
                <textarea
                  value={form.description}
                  onChange={e => set("description", e.target.value)}
                  rows={2}
                  placeholder="Describe this strategy..."
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
              <div>
                <Label className="text-foreground mb-2 block">Type</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(["Scalping", "Swing", "Reversal", "Trend-Following"] as StrategyType[]).map(t => (
                    <button
                      key={t} type="button" onClick={() => set("type", t)}
                      className={`py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors ${form.type === t ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-text-secondary hover:text-foreground"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP 2 — Timeframes */}
          {step === 2 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Timeframes</h3>
              {[
                { label: "Entry Timeframe", key: "entryTimeframe" as const, opts: ["1m", "5m", "15m"] },
                { label: "Signal Timeframe", key: "signalTimeframe" as const, opts: ["1m", "5m", "15m"] },
                { label: "Trend Timeframe", key: "trendTimeframe" as const, opts: ["5m", "15m", "1h"] },
              ].map(f => (
                <div key={f.key}>
                  <Label className="text-foreground mb-2 block">{f.label}</Label>
                  <div className="flex gap-2">
                    {f.opts.map(opt => (
                      <button
                        key={opt} type="button" onClick={() => set(f.key, opt)}
                        className={`flex-1 py-2 rounded-lg border text-sm font-mono transition-colors ${form[f.key] === opt ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-text-secondary hover:text-foreground"}`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* STEP 3 — Sessions */}
          {step === 3 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Trading Sessions</h3>
              <p className="text-xs text-text-secondary">Select which sessions this strategy trades during.</p>
              {SESSIONS.map(s => {
                const active = form.sessions.includes(s.key);
                const badgeColor = s.badge === "PREMIUM" ? "text-primary bg-primary/10" : "text-text-secondary bg-border/50";
                return (
                  <button
                    key={s.key} type="button" onClick={() => toggleSession(s.key)}
                    className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-colors text-left ${active ? "border-primary bg-primary/5" : "border-border bg-background hover:border-border/80"}`}
                  >
                    <div>
                      <div className={`text-sm font-medium ${active ? "text-foreground" : "text-text-secondary"}`}>{s.label}</div>
                      <div className="text-xs text-text-secondary mt-0.5">{s.time}</div>
                    </div>
                    <Badge className={`text-xs border-0 ${badgeColor}`}>{s.badge}</Badge>
                  </button>
                );
              })}
            </div>
          )}

          {/* STEP 4 — Scoring & Limits */}
          {step === 4 && (
            <div className="flex flex-col gap-5">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Scoring & Limits</h3>
              <SliderField label="Score Threshold" value={form.scoreThreshold} min={0} max={50} step={1} onChange={v => set("scoreThreshold", v)} format={v => `${v}/50`} />
              <div>
                <Label className="text-foreground mb-1.5 block">Max Trades Per Day</Label>
                <Input type="number" min={1} max={50} value={form.maxTradesDay} onChange={e => set("maxTradesDay", parseInt(e.target.value) || 6)} className="bg-background border-border" />
              </div>
              <div>
                <Label className="text-foreground mb-1.5 block">Max Trades Per Hour</Label>
                <Input type="number" min={1} max={20} value={form.maxTradesHour} onChange={e => set("maxTradesHour", parseInt(e.target.value) || 3)} className="bg-background border-border" />
              </div>
              <div>
                <Label className="text-foreground mb-1.5 block">Auto-pause After X Consecutive Losses</Label>
                <Input type="number" min={1} max={20} value={form.autoPauseOnLosses} onChange={e => set("autoPauseOnLosses", parseInt(e.target.value) || 5)} className="bg-background border-border" />
              </div>
            </div>
          )}

          {/* STEP 5 — Risk */}
          {step === 5 && (
            <div className="flex flex-col gap-5">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Risk Settings</h3>
              <SliderField label="Max Risk Per Trade" value={form.maxRiskPercent} min={0.5} max={2.0} step={0.1} onChange={v => set("maxRiskPercent", v)} format={v => `${v.toFixed(1)}%`} />
              <SliderField label="Stop Multiplier" value={form.stopMultiplier} min={1.0} max={2.0} step={0.1} onChange={v => set("stopMultiplier", v)} format={v => `${v.toFixed(1)}×`} />
              <SliderField label="TP1 Multiplier" value={form.tp1Multiplier} min={1.0} max={2.5} step={0.1} onChange={v => set("tp1Multiplier", v)} format={v => `${v.toFixed(1)}×`} />
              <SliderField label="TP2 Multiplier" value={form.tp2Multiplier} min={2.0} max={4.0} step={0.1} onChange={v => set("tp2Multiplier", v)} format={v => `${v.toFixed(1)}×`} />
            </div>
          )}

          {/* STEP 6 — Advanced */}
          {step === 6 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-2">Advanced Features</h3>
              <Toggle label="Counter-trend entries" desc='Allow trades against the main trend at RSI extremes (requires RSI>78 or <22)' value={form.counterTrendEnabled} onChange={v => set("counterTrendEnabled", v)} />
              <Toggle label="Consolidation detection" desc="Detect range-bound markets and wait for breakout instead of trend entry" value={form.consolidationDetection} onChange={v => set("consolidationDetection", v)} />
              <Toggle label="First candle rule" desc="Wait for first full 15m candle after session opens before evaluating" value={form.firstCandleRule} onChange={v => set("firstCandleRule", v)} />
              <Toggle label="Spike filter" desc="Pause trading when abnormal candle detected (range > 3× ATR)" value={form.spikeFilterEnabled} onChange={v => set("spikeFilterEnabled", v)} />
              <Toggle label="Momentum extension" desc="Allow winning trades to run past TP2 when momentum conditions are met" value={form.momentumExtensionEnabled} onChange={v => set("momentumExtensionEnabled", v)} />
            </div>
          )}

          {/* STEP 7 — Review */}
          {step === 7 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Review</h3>
              <div className="bg-background border border-border rounded-xl p-4 text-sm space-y-2 text-text-secondary leading-relaxed">
                <p className="font-semibold text-foreground mb-3">"{form.name}" will:</p>
                <p>• Trade on {form.entryTimeframe} entry, {form.signalTimeframe} signal, {form.trendTimeframe} trend</p>
                {form.sessions.length > 0
                  ? <p>• Only trade during: {form.sessions.map(sessionLabel).join(", ")}</p>
                  : <p>• Trade during all sessions (none selected)</p>
                }
                <p>• Require score of {form.scoreThreshold}/50 minimum</p>
                <p>• Max {form.maxTradesDay} trades/day, {form.maxTradesHour} trades/hour</p>
                <p>• Risk {form.maxRiskPercent.toFixed(1)}% per trade</p>
                <p>• Stop {form.stopMultiplier.toFixed(1)}×, TP1 {form.tp1Multiplier.toFixed(1)}×, TP2 {form.tp2Multiplier.toFixed(1)}×</p>
                <p>• Auto-pause after {form.autoPauseOnLosses} consecutive losses</p>
                <p>• Spike filter: {form.spikeFilterEnabled ? "ON" : "OFF"}</p>
                <p>• Counter-trend: {form.counterTrendEnabled ? "ON" : "OFF"}</p>
                <p>• Consolidation detection: {form.consolidationDetection ? "ON" : "OFF"}</p>
                <p>• First candle rule: {form.firstCandleRule ? "ON" : "OFF"}</p>
                <p>• Momentum extension: {form.momentumExtensionEnabled ? "ON" : "OFF"}</p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex gap-3 pt-2 border-t border-border mt-2">
          {step > 1 ? (
            <Button variant="outline" className="border-border" onClick={() => setStep(s => s - 1)}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
          ) : (
            <Button variant="outline" className="border-border" onClick={onClose}>
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
          )}
          <div className="flex-1" />
          {step < 7 ? (
            <Button className="bg-primary text-black hover:bg-primary/90" onClick={() => { if (canNext()) setStep(s => s + 1); else toast({ title: "Strategy name is required", variant: "destructive" }); }}>
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button className="bg-primary text-black hover:bg-primary/90" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editingStrategy ? "Save Changes" : "Create Strategy"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminStrategies() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: strategies, isLoading } = useGetStrategies({
    query: { queryKey: ["strategies"] }
  });

  const pauseStrategy = usePauseStrategy();
  const reactivateStrategy = useReactivateStrategy();

  const [strategyModalOpen, setStrategyModalOpen] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<any | null>(null);

  const openCreate = () => { setEditingStrategy(null); setStrategyModalOpen(true); };
  const openEdit = (s: any) => { setEditingStrategy(s); setStrategyModalOpen(true); };

  const handleToggleState = (id: string, isActive: boolean) => {
    if (isActive) {
      pauseStrategy.mutate({ strategyId: id }, {
        onSuccess: () => {
          toast({ title: "Strategy paused — all users affected" });
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

  const formatWinRate = (s: any) => {
    if (s.totalTrades > 0 && s.winRate != null) {
      return { label: `${(s.winRate * 100).toFixed(1)}%`, sub: `${s.totalTrades} trades` };
    }
    return { label: "—", sub: "No trades yet" };
  };

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Strategies</h1>
          <Button className="bg-primary text-black hover:bg-primary/90" onClick={openCreate}>
            <Plus className="w-4 h-4 mr-2" />
            Create Strategy
          </Button>
        </div>

        <StrategyModal
          open={strategyModalOpen}
          onClose={() => setStrategyModalOpen(false)}
          editingStrategy={editingStrategy}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["strategies"] })}
        />

        {isLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {strategies?.strategies?.map((strategy) => {
              const isActive = strategy.status === 'active';
              const wr = formatWinRate(strategy);
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
                        <div className="text-2xl font-bold text-foreground tabular-nums">{wr.label}</div>
                        <div className="text-xs text-text-secondary">{wr.sub}</div>
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
                      <Button
                        variant="outline"
                        className="flex-1 border-border bg-background hover:bg-border hover:text-foreground"
                        onClick={() => openEdit(strategy)}
                      >
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
                No strategies found. Create your first strategy.
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
