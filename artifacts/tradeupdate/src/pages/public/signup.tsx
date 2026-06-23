import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSignup } from "@workspace/api-client-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

const signupSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters").max(20),
  email: z.string().email("Invalid email address"),
  country: z.string().min(1, "Country is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
  disclaimer: z.boolean().refine(val => val === true, "You must accept the risk disclaimer"),
}).refine(data => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export default function Signup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const signupMutation = useSignup();
  
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      username: "",
      email: "",
      country: "",
      password: "",
      confirmPassword: "",
      disclaimer: false,
    },
  });

  const password = form.watch("password");
  
  const getPasswordStrength = () => {
    if (!password) return 0;
    let strength = 0;
    if (password.length >= 8) strength += 1;
    if (/[A-Z]/.test(password)) strength += 1;
    if (/[0-9]/.test(password)) strength += 1;
    if (/[^A-Za-z0-9]/.test(password)) strength += 1;
    return strength;
  };
  
  const strength = getPasswordStrength();
  const strengthText = strength === 0 ? "" : strength <= 2 ? "Weak" : strength === 3 ? "Fair" : "Strong";
  const strengthColor = strength <= 2 ? "bg-accent-red" : strength === 3 ? "bg-accent-amber" : "bg-accent-teal";

  const onSubmit = (values: z.infer<typeof signupSchema>) => {
    signupMutation.mutate({ data: {
      username: values.username,
      email: values.email,
      country: values.country,
      password: values.password
    } }, {
      onSuccess: () => {
        setLocation("/pending");
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Signup failed",
          description: (error as any)?.error || "Please try again later",
        });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-[480px] bg-card border border-border p-8 rounded-xl shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <Logo size="lg" className="mb-4" />
          <h1 className="text-2xl font-bold text-foreground">Request Access</h1>
          <p className="text-text-secondary text-sm text-center mt-2">TradeUpdate is an exclusive algorithmic trading platform.</p>
        </div>

        <Form {...form}>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Username</FormLabel>
                  <FormControl>
                    <Input placeholder="Choose a username" {...field} className="bg-background border-border" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Email</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="Enter your email" {...field} className="bg-background border-border" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Country</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="bg-background border-border">
                        <SelectValue placeholder="Select a country" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="UK">United Kingdom</SelectItem>
                      <SelectItem value="AU">Australia</SelectItem>
                      <SelectItem value="ZA">Australia</SelectItem>
                      <SelectItem value="CA">Canada</SelectItem>
                      <SelectItem value="SG">Singapore</SelectItem>
                      <SelectItem value="ZA">South Africa</SelectItem>
                      <SelectItem value="OTHER">Other</SelectItem>
                    </SelectContent>
                  </Select>
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
                    <Input type="password" placeholder="Create a strong password" {...field} className="bg-background border-border" />
                  </FormControl>
                  {password && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden flex">
                        <div className={`h-full ${strength >= 1 ? strengthColor : 'bg-transparent'} transition-all`} style={{ width: '25%' }} />
                        <div className={`h-full border-l border-background ${strength >= 2 ? strengthColor : 'bg-transparent'} transition-all`} style={{ width: '25%' }} />
                        <div className={`h-full border-l border-background ${strength >= 3 ? strengthColor : 'bg-transparent'} transition-all`} style={{ width: '25%' }} />
                        <div className={`h-full border-l border-background ${strength >= 4 ? strengthColor : 'bg-transparent'} transition-all`} style={{ width: '25%' }} />
                      </div>
                      <span className={`text-xs ${strengthColor.replace('bg-', 'text-')}`}>{strengthText}</span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-text-secondary">Confirm Password</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Confirm your password" {...field} className="bg-background border-border" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="disclaimer"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-4 border border-border rounded-md bg-background/50 mt-6">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      className="mt-1"
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel className="text-sm font-medium">Risk Disclaimer</FormLabel>
                    <p className="text-xs text-text-secondary">
                      I understand that algorithmic trading of V75 involves significant risk of loss and is not suitable for all investors. TradeUpdate does not guarantee profits.
                    </p>
                  </div>
                </FormItem>
              )}
            />

            <Button 
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 mt-6"
              onClick={form.handleSubmit(onSubmit)}
              disabled={signupMutation.isPending}
            >
              {signupMutation.isPending ? <Loader2 className="animate-spin w-5 h-5" /> : "Submit Application"}
            </Button>
          </div>
        </Form>
        
        <div className="mt-6 text-center">
          <Link href="/login" className="text-sm text-text-secondary hover:text-primary transition-colors">
            Already have an account? Log in
          </Link>
        </div>
      </div>
    </div>
  );
}
