import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, ArrowLeft } from "lucide-react";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export default function AdminLogin() {
  const [, setLocation] = useLocation();
  const { refetch } = useAuth();
  const { toast } = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const loginMutation = useLogin();

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const onSubmit = (values: z.infer<typeof loginSchema>) => {
    loginMutation.mutate({ data: values }, {
      onSuccess: async (data) => {
        await refetch();
        if (data.role === "admin") {
          setLocation("/admin");
        } else {
          toast({ variant: "destructive", title: "Access Denied", description: "Not an administrator" });
          setLocation("/dashboard");
        }
      },
      onError: (error) => {
        setAttempts(prev => prev + 1);
        toast({
          variant: "destructive",
          title: "Login failed",
          description: (error as any)?.error || "Invalid credentials",
        });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-500/5 via-background to-background z-0" />
      
      <div className="w-full max-w-[380px] bg-card border border-[#F59E0B]/30 p-8 rounded-xl shadow-2xl relative z-10">
        <button 
          onClick={() => setLocation("/login")}
          className="absolute top-6 left-6 text-text-secondary hover:text-foreground transition-colors"
        >
          <ArrowLeft size={20} />
        </button>

        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <Logo size="lg" className="border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B] shadow-[0_0_20px_rgba(245,158,11,0.4)]" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">TradeUpdate</h1>
          <div className="mt-2 bg-[#F59E0B]/20 text-[#F59E0B] px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider">
            Administrator Access
          </div>
        </div>

        <Form {...form}>
          <div onClick={() => {}} className="space-y-6">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Admin ID</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter admin ID" {...field} className="bg-background border-border text-foreground focus-visible:ring-[#F59E0B]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Master Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input 
                        type={showPassword ? "text" : "password"} 
                        placeholder="Enter password" 
                        {...field} 
                        className="bg-background border-border text-foreground pr-10 focus-visible:ring-[#F59E0B]" 
                      />
                      <button 
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button 
              className="w-full bg-[#F59E0B] text-black hover:bg-[#F59E0B]/90 mt-2 font-semibold"
              onClick={form.handleSubmit(onSubmit)}
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? <Loader2 className="animate-spin w-5 h-5" /> : "Authenticate"}
            </Button>
          </div>
        </Form>
        
        {attempts > 0 && (
          <div className="mt-6 text-center">
            <p className="text-xs text-accent-red">Failed attempts: {attempts}</p>
          </div>
        )}
      </div>
    </div>
  );
}
