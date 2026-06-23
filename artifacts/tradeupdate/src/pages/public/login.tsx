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
import { Eye, EyeOff, Loader2 } from "lucide-react";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const { refetch } = useAuth();
  const { toast } = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [logoClicks, setLogoClicks] = useState(0);

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
          setLocation("/dashboard");
        }
      },
      onError: (error) => {
        if ((error as any)?.status === "pending") {
          setLocation("/pending");
        } else {
          toast({
            variant: "destructive",
            title: "Login failed",
            description: (error as any)?.error || "Invalid credentials",
          });
        }
      }
    });
  };

  const handleLogoClick = () => {
    setLogoClicks(prev => {
      const newClicks = prev + 1;
      if (newClicks >= 3) {
        setLocation("/admin-login");
        return 0;
      }
      setTimeout(() => setLogoClicks(0), 2000);
      return newClicks;
    });
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-[380px] bg-card border border-border p-8 rounded-xl shadow-2xl relative">
        <div className="flex flex-col items-center mb-8">
          <div onClick={handleLogoClick} className="cursor-pointer mb-6">
            <Logo size="lg" className="animate-pulse shadow-[0_0_20px_rgba(0,212,164,0.4)]" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">TradeUpdate</h1>
          <p className="text-text-secondary text-sm">Professional V75 Trading</p>
        </div>

        <Form {...form}>
          <div onClick={() => {}} className="space-y-6">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Username</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter username" {...field} className="bg-background border-border text-foreground" />
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
                  <FormLabel className="text-text-secondary">Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input 
                        type={showPassword ? "text" : "password"} 
                        placeholder="Enter password" 
                        {...field} 
                        className="bg-background border-border text-foreground pr-10" 
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
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 mt-2"
              onClick={form.handleSubmit(onSubmit)}
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? <Loader2 className="animate-spin w-5 h-5" /> : "Sign In"}
            </Button>
          </div>
        </Form>
        
        <div className="mt-8 text-center">
          <p className="text-xs text-text-secondary/50">v1.0</p>
        </div>
      </div>
    </div>
  );
}
