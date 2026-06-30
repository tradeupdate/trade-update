import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AuthProvider } from "@/hooks/use-auth";
import { GuestGuard, AuthGuard, AdminGuard } from "@/components/guards";

// Public Pages
import Landing from "@/pages/public/landing";
import Login from "@/pages/public/login";
import AdminLogin from "@/pages/public/admin-login";
import Signup from "@/pages/public/signup";
import Pending from "@/pages/public/pending";

// User Pages
import Setup from "@/pages/user/setup";
import Dashboard from "@/pages/user/dashboard";

// Admin Pages
import AdminDashboard from "@/pages/admin/dashboard";
import AdminUsers from "@/pages/admin/users";
import AdminStrategies from "@/pages/admin/strategies";
import AdminCopy from "@/pages/admin/copy";
import AdminBacktest from "@/pages/admin/backtest";
import AdminSettings from "@/pages/admin/settings";
import AdminLogs from "@/pages/admin/logs";
import AdminPreLiveCheck from "@/pages/admin/prelive-check";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <GuestGuard><Landing /></GuestGuard>
      </Route>
      <Route path="/login">
        <GuestGuard><Login /></GuestGuard>
      </Route>
      <Route path="/admin-login">
        <GuestGuard><AdminLogin /></GuestGuard>
      </Route>
      <Route path="/signup">
        <GuestGuard><Signup /></GuestGuard>
      </Route>
      <Route path="/pending">
        <Pending />
      </Route>
      
      <Route path="/setup">
        <AuthGuard><Setup /></AuthGuard>
      </Route>
      <Route path="/dashboard">
        <AuthGuard><Dashboard /></AuthGuard>
      </Route>

      <Route path="/admin">
        <AdminGuard><AdminDashboard /></AdminGuard>
      </Route>
      <Route path="/admin/users">
        <AdminGuard><AdminUsers /></AdminGuard>
      </Route>
      <Route path="/admin/strategies">
        <AdminGuard><AdminStrategies /></AdminGuard>
      </Route>
      <Route path="/admin/copy">
        <AdminGuard><AdminCopy /></AdminGuard>
      </Route>
      <Route path="/admin/backtest">
        <AdminGuard><AdminBacktest /></AdminGuard>
      </Route>
      <Route path="/admin/settings">
        <AdminGuard><AdminSettings /></AdminGuard>
      </Route>
      <Route path="/admin/logs">
        <AdminGuard><AdminLogs /></AdminGuard>
      </Route>
      <Route path="/admin/prelive-check">
        <AdminGuard><AdminPreLiveCheck /></AdminGuard>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
