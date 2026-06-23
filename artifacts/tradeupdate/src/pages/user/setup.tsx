import { useState } from "react";
import { useLocation } from "wouter";
import { Logo } from "@/components/ui/logo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSaveDerivToken, useUpdateTradingProfile } from "@workspace/api-client-react";
import { Loader2, Shield, Zap, Flame } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ProfileOption = 'safe' | 'pro' | 'aggressive';

export default function Setup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [profile, setProfile] = useState<ProfileOption>('safe');

  const saveToken = useSaveDerivToken();
  const updateProfile = useUpdateTradingProfile();

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      if (token) {
        saveToken.mutate({ data: { token } }, {
          onSuccess: () => setStep(3),
          onError: () => toast({ title: "Failed to save token", variant: "destructive" })
        });
      } else {
        setStep(3);
      }
    } else {
      updateProfile.mutate({ data: { profile } }, {
        onSuccess: () => setLocation("/dashboard"),
        onError: () => toast({ title: "Failed to save profile", variant: "destructive" })
      });
    }
  };

  const handleSkip = () => {
    if (step === 2) setStep(3);
  };

  const profiles: { id: ProfileOption; label: string; icon: typeof Shield; desc: string }[] = [
    { id: 'safe', label: 'Safe', icon: Shield, desc: "Low risk, smaller position sizing, tight stop loss." },
    { id: 'pro', label: 'Pro', icon: Zap, desc: "Balanced risk/reward, standard position sizing." },
    { id: 'aggressive', label: 'Aggressive', icon: Flame, desc: "High risk, maximum leverage, wider stops." }
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4">
      <Logo size="lg" className="mb-8" />
      
      <div className="w-full max-w-md mb-8">
        <div className="flex justify-between mb-2 text-xs text-text-secondary">
          <span>Welcome</span>
          <span>Connection</span>
          <span>Profile</span>
        </div>
        <div className="flex h-1 bg-border rounded-full overflow-hidden">
          <div className="bg-primary transition-all duration-300" style={{ width: `${(step / 3) * 100}%` }} />
        </div>
      </div>

      <Card className="w-full max-w-md p-6 bg-card border-border">
        {step === 1 && (
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Welcome to TradeUpdate</h1>
            <p className="text-text-secondary mb-8 leading-relaxed">
              You're about to set up your automated trading environment. 
              We'll connect your Deriv account and configure your trading profile to match your risk tolerance.
            </p>
            <Button className="w-full bg-primary text-black hover:bg-primary/90" onClick={handleNext}>
              Get Started
            </Button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-xl font-bold mb-2">Connect Deriv Account</h2>
            <p className="text-sm text-text-secondary mb-6">Enter your API token to allow the bot to execute trades.</p>
            
            <div className="space-y-4 mb-8">
              <div>
                <label className="text-sm font-medium mb-1.5 block text-text-secondary">Environment</label>
                <div className="grid grid-cols-2 gap-2">
                  <Button 
                    variant="outline" 
                    className={mode === "demo" ? "border-primary text-primary bg-primary/10" : "border-border text-text-secondary"}
                    onClick={() => setMode("demo")}
                  >
                    Demo (Paper)
                  </Button>
                  <Button 
                    variant="outline" 
                    className={mode === "live" ? "border-accent-red text-accent-red bg-accent-red/10" : "border-border text-text-secondary"}
                    onClick={() => setMode("live")}
                  >
                    Live (Real)
                  </Button>
                </div>
              </div>
              
              <div>
                <label className="text-sm font-medium mb-1.5 block text-text-secondary">API Token</label>
                <Input 
                  type="password" 
                  value={token} 
                  onChange={(e) => setToken(e.target.value)} 
                  placeholder="Enter token..." 
                  className="bg-background border-border focus-visible:ring-primary"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 border-border text-foreground hover:bg-border" onClick={handleSkip}>
                Skip for now
              </Button>
              <Button className="flex-1 bg-primary text-black hover:bg-primary/90" onClick={handleNext} disabled={saveToken.isPending}>
                {saveToken.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save & Continue"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-xl font-bold mb-2">Choose Profile</h2>
            <p className="text-sm text-text-secondary mb-6">Select a trading strategy profile.</p>

            <div className="space-y-3 mb-8">
              {profiles.map((p) => {
                const Icon = p.icon;
                const isActive = profile === p.id;
                return (
                  <div 
                    key={p.id}
                    onClick={() => setProfile(p.id)}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      isActive ? 'border-primary bg-primary/10' : 'border-border bg-background hover:border-text-secondary'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-1">
                      <Icon className={`w-5 h-5 ${isActive ? 'text-primary' : 'text-text-secondary'}`} />
                      <span className={`font-bold ${isActive ? 'text-primary' : 'text-foreground'}`}>{p.label}</span>
                    </div>
                    <p className="text-xs text-text-secondary ml-8">{p.desc}</p>
                  </div>
                );
              })}
            </div>

            <Button className="w-full bg-primary text-black hover:bg-primary/90" onClick={handleNext} disabled={updateProfile.isPending}>
              {updateProfile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Complete Setup"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
