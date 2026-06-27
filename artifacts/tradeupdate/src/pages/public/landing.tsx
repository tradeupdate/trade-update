import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Menu, X, ChevronDown, Shield, Link2, Cpu } from "lucide-react";

const COUNTRIES = [
  "United Kingdom","South Africa","Nigeria","Ghana","Kenya","Zimbabwe","Uganda",
  "Tanzania","Zambia","Botswana","Namibia","United States","Canada","Australia",
  "New Zealand","India","Pakistan","Bangladesh","Sri Lanka","Philippines",
  "Malaysia","Singapore","Indonesia","Other"
];

function useCountUp(target: number, started: boolean, duration = 1800) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!started) return;
    let start = 0;
    const step = Math.ceil(duration / 60);
    const increment = target / (duration / step);
    const timer = setInterval(() => {
      start += increment;
      if (start >= target) { setValue(target); clearInterval(timer); }
      else setValue(Math.floor(start));
    }, step);
    return () => clearInterval(timer);
  }, [started, target, duration]);
  return value;
}

function FakePrice() {
  const [price, setPrice] = useState(39247.85);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    const t = setInterval(() => {
      const change = (Math.random() - 0.48) * 8;
      setPrice(prev => {
        const next = Math.max(38000, Math.min(42000, prev + change));
        setDir(next >= prev ? "up" : "down");
        return next;
      });
    }, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full border border-[#1C1F2E] bg-[#0F1117] text-sm font-mono">
      <span className="text-[#8890AA]">R_75</span>
      <span className="text-white font-bold">{price.toFixed(2)}</span>
      <span className={dir === "up" ? "text-[#00D4A4]" : "text-[#FF4060]"}>
        {dir === "up" ? "↑" : "↓"}
      </span>
    </div>
  );
}

function StatsBar() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.3 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  const trades = useCountUp(2847, visible);
  const uptime = useCountUp(998, visible);

  return (
    <div ref={ref} className="border-y border-[#1C1F2E] bg-[#0A0C12] py-8 px-4">
      <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-0">
        {[
          { value: `${trades.toLocaleString()}+`, label: "Total Trades Executed" },
          { value: "68.4%", label: "Average Win Rate" },
          { value: "3", label: "Active Strategies" },
          { value: `${(uptime / 10).toFixed(1)}%`, label: "System Uptime" },
        ].map((s, i) => (
          <div key={i} className={`flex flex-col items-center py-4 px-6 ${i < 3 ? "md:border-r border-[#1C1F2E]" : ""}`}>
            <span className="text-3xl font-bold text-[#00D4A4] tabular-nums">{s.value}</span>
            <span className="text-xs text-[#8890AA] mt-1 text-center">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[#1C1F2E] rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-[#0F1117] transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="font-medium text-white text-sm pr-4">{question}</span>
        <ChevronDown className={`w-4 h-4 text-[#8890AA] shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-[#8890AA] leading-relaxed">
          {answer}
        </div>
      )}
    </div>
  );
}

export default function Landing() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { label: "How It Works", href: "#how-it-works" },
    { label: "Features", href: "#features" },
    { label: "FAQ", href: "#faq" },
  ];

  const scrollTo = (id: string) => {
    setMobileOpen(false);
    document.getElementById(id.replace("#",""))?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[#080A0F] text-white overflow-x-hidden">

      {/* ── NAVBAR ── */}
      <header className="sticky top-0 z-50 bg-[#080A0F] border-b border-[#1C1F2E]">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#00D4A4] flex items-center justify-center">
              <span className="text-black font-bold text-sm">TU</span>
            </div>
            <span className="font-bold text-white text-lg">TradeUpdate</span>
          </div>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map(l => (
              <button key={l.label} onClick={() => scrollTo(l.href)} className="text-sm text-[#8890AA] hover:text-white transition-colors">
                {l.label}
              </button>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            <Link href="/login">
              <Button variant="outline" size="sm" className="border-[#00D4A4] text-[#00D4A4] bg-transparent hover:bg-[#00D4A4]/10">
                Login
              </Button>
            </Link>
            <Link href="/signup">
              <Button size="sm" className="bg-[#00D4A4] text-black hover:bg-[#00D4A4]/90 font-semibold">
                Request Access
              </Button>
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button className="md:hidden p-2 text-[#8890AA]" onClick={() => setMobileOpen(o => !o)}>
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile dropdown */}
        {mobileOpen && (
          <div className="md:hidden border-t border-[#1C1F2E] bg-[#0A0C12] px-4 py-4 flex flex-col gap-3">
            {navLinks.map(l => (
              <button key={l.label} onClick={() => scrollTo(l.href)} className="text-sm text-[#8890AA] hover:text-white text-left py-2">
                {l.label}
              </button>
            ))}
            <hr className="border-[#1C1F2E]" />
            <Link href="/login"><Button variant="outline" className="w-full border-[#00D4A4] text-[#00D4A4] bg-transparent">Login</Button></Link>
            <Link href="/signup"><Button className="w-full bg-[#00D4A4] text-black font-semibold">Request Access</Button></Link>
          </div>
        )}
      </header>

      {/* ── HERO ── */}
      <section className="relative min-h-[85vh] flex flex-col items-center justify-center text-center px-4 py-20 overflow-hidden">
        {/* Animated glow */}
        <div className="absolute bottom-0 left-0 w-[600px] h-[400px] bg-[#00D4A4] opacity-[0.06] rounded-full blur-[120px] animate-pulse pointer-events-none" />

        <div className="relative z-10 max-w-3xl mx-auto">
          <div className="mb-6">
            <FakePrice />
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
            Trade Smarter,<br/>
            <span className="text-[#00D4A4]">Not Harder</span>
          </h1>
          <p className="text-base sm:text-lg md:text-xl text-[#8890AA] mb-10 max-w-2xl mx-auto leading-relaxed">
            Institutional-grade Volatility 75 algorithmic trading. AI-powered scoring. Smart risk management. Available 24/7.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/signup" className="w-full sm:w-auto">
              <Button size="lg" className="w-full sm:w-auto bg-[#00D4A4] text-black hover:bg-[#00D4A4]/90 font-semibold text-base px-8 py-6 h-auto">
                Request Access
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto border-[#1C1F2E] text-white hover:bg-white/5 text-base px-8 py-6 h-auto"
              onClick={() => scrollTo("#how-it-works")}
            >
              See How It Works
            </Button>
          </div>
        </div>
      </section>

      {/* ── STATS BAR ── */}
      <StatsBar />

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="py-20 px-4 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">How It Works</h2>
          <p className="text-[#8890AA]">Get started in three simple steps</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              num: "01", icon: Shield,
              title: "Request Access",
              body: "Apply for access and get approved by our team within 24 hours. Access is by invitation and approval only."
            },
            {
              num: "02", icon: Link2,
              title: "Connect & Configure",
              body: "Connect your Deriv account securely or start immediately with Paper Trading. Choose your risk profile — Safe, Pro, or Aggressive."
            },
            {
              num: "03", icon: Cpu,
              title: "Let TradeUpdate Trade",
              body: "Our 7-layer AI scoring engine monitors V75 24/7, scores every setup out of 50, and only executes trades when conditions are near-perfect."
            },
          ].map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} className="bg-[#0F1117] border border-[#1C1F2E] rounded-2xl p-8 flex flex-col gap-4">
                <div className="flex items-start justify-between">
                  <span className="text-3xl font-bold text-[#00D4A4]">{step.num}</span>
                  <div className="w-10 h-10 rounded-xl bg-[#00D4A4]/10 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-[#00D4A4]" />
                  </div>
                </div>
                <h3 className="text-lg font-bold">{step.title}</h3>
                <p className="text-[#8890AA] text-sm leading-relaxed">{step.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="py-20 px-4 bg-[#0A0C12]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold mb-3">Everything You Need</h2>
            <p className="text-[#8890AA]">Built for serious V75 traders</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              { icon: "🧠", title: "7-Layer AI Scoring", body: "Every trade scored across trend, volatility, entry timing, pullback quality, and risk alignment before execution." },
              { icon: "🛡️", title: "Smart Risk Management", body: "Automatic stop loss placement, break-even moves, partial profit taking at 1.5R, and trailing stops to maximize winners." },
              { icon: "📊", title: "3 Trading Strategies", body: "V75 Sniper for scalping, V75 Swing for larger moves, and V75 Reversal for counter-trend entries at extremes." },
              { icon: "🔄", title: "Auto-Compound", body: "Automatically adjusts stake size as your balance grows so your profits compound without any manual intervention." },
              { icon: "📱", title: "Mobile First", body: "Full-featured dashboard on any device. Real-time push notifications for every trade event so you're always informed." },
              { icon: "🛡️", title: "Recovery Mode", body: "Automatically switches to ultra-conservative settings when drawdown reaches 15%, protecting your account during losing streaks." },
            ].map((f, i) => (
              <div key={i} className="group bg-[#0F1117] border border-[#1C1F2E] hover:border-[#00D4A4]/40 rounded-2xl p-6 transition-colors">
                <div className="text-2xl mb-4">{f.icon}</div>
                <h3 className="font-bold text-white mb-2">{f.title}</h3>
                <p className="text-[#8890AA] text-sm leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section className="py-20 px-4 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">What Traders Say</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { quote: "TradeUpdate completely changed how I approach V75. The risk management alone saved my account from a major drawdown twice.", name: "Sarah K.", flag: "🇬🇧", profile: "Pro Profile", duration: "3 months" },
            { quote: "I was skeptical but the AI scoring is genuinely impressive. Achieved a 71% win rate in my first month of live trading.", name: "Michael T.", flag: "🇿🇦", profile: "Safe Profile", duration: "5 months" },
            { quote: "The recovery mode feature is brilliant. It detected my losing streak early and switched to conservative mode automatically.", name: "James O.", flag: "🇳🇬", profile: "Aggressive Profile", duration: "2 months" },
          ].map((t, i) => (
            <div key={i} className="bg-[#0F1117] border border-[#1C1F2E] rounded-2xl p-6 flex flex-col gap-4">
              <span className="text-[#00D4A4] text-3xl leading-none">"</span>
              <p className="text-[#8890AA] text-sm leading-relaxed flex-1">"{t.quote}"</p>
              <div className="pt-2 border-t border-[#1C1F2E]">
                <p className="font-semibold text-white text-sm">{t.name} {t.flag}</p>
                <p className="text-xs text-[#8890AA] mt-0.5">{t.profile} · {t.duration}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="py-20 px-4 bg-[#0A0C12]">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold mb-3">Frequently Asked Questions</h2>
          </div>
          <div className="flex flex-col gap-3">
            <FAQItem
              question="Is my money safe?"
              answer="Your funds remain in your own Deriv account at all times. TradeUpdate never holds or accesses your capital directly. We only trade on your behalf through your personal API token, which you can revoke at any time from your Deriv account."
            />
            <FAQItem
              question="What is the Volatility 75 Index?"
              answer="The Volatility 75 Index (V75) is a synthetic index available exclusively on the Deriv platform. It simulates a market with 75% volatility, trading 24/7 with no news events, economic data, or market closures — making it ideal for consistent algorithmic trading."
            />
            <FAQItem
              question="Do I need trading experience?"
              answer="No prior trading experience is required. TradeUpdate handles all market analysis and trade execution automatically. You simply choose a risk profile that matches your account size and risk tolerance."
            />
            <FAQItem
              question="How much do I need to start?"
              answer="You can start Paper Trading immediately with no real money at all. For live trading, the Safe profile requires a minimum $100 Deriv account balance. Pro and Aggressive profiles have higher minimums set by our team."
            />
            <FAQItem
              question="Can I stop the bot anytime?"
              answer="Yes, completely. You have full control with a bot toggle to pause anytime, and an emergency Kill Switch that stops all activity instantly. You are always in control."
            />
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="py-20 px-4">
        <div className="max-w-2xl mx-auto relative">
          <div className="absolute inset-0 bg-[#00D4A4] opacity-[0.08] rounded-3xl blur-2xl pointer-events-none" />
          <div className="relative bg-[#0F1117] border border-[#00D4A4]/20 rounded-3xl p-10 md:p-16 text-center">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready to Trade Smarter?</h2>
            <p className="text-[#8890AA] mb-8 leading-relaxed">
              Join traders already using TradeUpdate to trade V75 algorithmically with institutional precision.
            </p>
            <Link href="/signup">
              <Button size="lg" className="bg-[#00D4A4] text-black hover:bg-[#00D4A4]/90 font-semibold text-base px-10 py-6 h-auto w-full sm:w-auto">
                Request Access Now
              </Button>
            </Link>
            <p className="text-xs text-[#8890AA] mt-4">Access by approval only. Applications reviewed within 24 hours.</p>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-[#1C1F2E] bg-[#080A0F] py-10 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
            {/* Logo + tagline */}
            <div className="flex flex-col items-center md:items-start gap-1">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-[#00D4A4] flex items-center justify-center">
                  <span className="text-black font-bold text-xs">TU</span>
                </div>
                <span className="font-bold text-white">TradeUpdate</span>
              </div>
              <span className="text-xs text-[#8890AA]">Algorithmic V75 trading, perfected.</span>
            </div>

            {/* Nav links */}
            <nav className="flex flex-wrap items-center justify-center gap-4 text-sm text-[#8890AA]">
              <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="hover:text-white transition-colors">Home</button>
              <button onClick={() => scrollTo("#how-it-works")} className="hover:text-white transition-colors">How It Works</button>
              <button onClick={() => scrollTo("#features")} className="hover:text-white transition-colors">Features</button>
              <button onClick={() => scrollTo("#faq")} className="hover:text-white transition-colors">FAQ</button>
              <Link href="/login" className="hover:text-white transition-colors">Login</Link>
            </nav>

            <p className="text-xs text-[#8890AA]">© 2025 TradeUpdate. All rights reserved.</p>
          </div>
          <div className="border-t border-[#1C1F2E] pt-6 text-center">
            <p className="text-xs text-[#8890AA] max-w-xl mx-auto leading-relaxed">
              Trading involves substantial risk of loss. Past performance does not guarantee future results. Only trade with capital you can afford to lose.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
