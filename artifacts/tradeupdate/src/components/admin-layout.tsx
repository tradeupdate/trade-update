import { Link, useLocation } from "wouter";
import { Logo } from "@/components/ui/logo";
import { 
  Users, 
  LayoutDashboard, 
  Settings, 
  ScrollText, 
  Layers, 
  PlayCircle,
  LogOut,
  Menu,
  Copy
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

interface AdminLayoutProps {
  children: React.ReactNode;
}

export function AdminLayout({ children }: AdminLayoutProps) {
  const [location] = useLocation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const links = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/users", label: "Users", icon: Users },
    { href: "/admin/strategies", label: "Strategies", icon: Layers },
    { href: "/admin/copy", label: "Copy Trading", icon: Copy },
    { href: "/admin/backtest", label: "Backtest", icon: PlayCircle },
    { href: "/admin/settings", label: "Settings", icon: Settings },
    { href: "/admin/logs", label: "Logs", icon: ScrollText },
  ];

  const NavContent = () => (
    <div className="flex flex-col h-full bg-card border-r border-border">
      <div className="p-6">
        <Logo size="md" />
        <div className="mt-6 text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Admin Console
        </div>
      </div>
      
      <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          
          return (
            <Link key={link.href} href={link.href}>
              <div 
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                  isActive 
                    ? "bg-primary/10 text-primary font-medium" 
                    : "text-text-secondary hover:text-foreground hover:bg-white/5"
                }`}
                onClick={() => setOpen(false)}
              >
                <Icon className="w-5 h-5" />
                {link.label}
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
            {user?.username?.[0]?.toUpperCase() || 'A'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{user?.username}</p>
            <p className="text-xs text-text-secondary truncate">Administrator</p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex text-foreground">
      {/* Desktop Sidebar */}
      <aside className="hidden md:block w-64 fixed inset-y-0 left-0 z-20">
        <NavContent />
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-[60px] bg-card border-b border-border flex items-center justify-between px-4 z-20">
        <Logo size="sm" />
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="text-foreground">
              <Menu className="w-6 h-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-64 bg-card border-r-border">
            <NavContent />
          </SheetContent>
        </Sheet>
      </header>

      {/* Main Content */}
      <main className="flex-1 md:pl-64 pt-[60px] md:pt-0">
        <div className="p-4 md:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
