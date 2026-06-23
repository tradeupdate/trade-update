import { useAuth } from "@/hooks/use-auth";
import { Link, Redirect } from "wouter";
import { Logo } from "@/components/ui/logo";
import { Hourglass, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLogout } from "@workspace/api-client-react";

export default function Pending() {
  const { user, isAuthenticated, refetch } = useAuth();
  const logoutMutation = useLogout();

  if (isAuthenticated && user?.status !== "pending") {
    return <Redirect to="/dashboard" />;
  }

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/login";
      }
    });
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-[480px] bg-card border border-border p-8 rounded-xl shadow-2xl text-center">
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
            <div className="w-20 h-20 bg-background border-2 border-primary rounded-full flex items-center justify-center relative z-10">
              <Hourglass className="w-10 h-10 text-primary animate-pulse" />
            </div>
          </div>
        </div>
        
        <h1 className="text-2xl font-bold text-foreground mb-4">Application Under Review</h1>
        <p className="text-text-secondary mb-8">
          Thank you for applying to TradeUpdate. Your account is currently pending administrative approval.
        </p>
        
        <div className="bg-background border border-border rounded-lg p-6 text-left mb-8">
          <h3 className="font-semibold text-foreground mb-4">What happens next?</h3>
          <ul className="space-y-4">
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <span className="text-sm text-text-secondary">Our team will review your application details to ensure you meet the platform requirements.</span>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <span className="text-sm text-text-secondary">This process typically takes 1-2 business days.</span>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <span className="text-sm text-text-secondary">You will be notified via email once your account is activated.</span>
            </li>
          </ul>
        </div>
        
        <div className="flex flex-col gap-4">
          <Button 
            variant="outline" 
            onClick={() => refetch()}
            className="w-full border-primary/50 text-primary hover:bg-primary/10"
          >
            Check Status Again
          </Button>
          <Button 
            variant="ghost" 
            onClick={handleLogout}
            className="w-full text-text-secondary hover:text-foreground"
          >
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
