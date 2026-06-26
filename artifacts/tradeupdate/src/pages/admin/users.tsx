import { useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import { 
  useGetAdminUsers, 
  useGetPendingSignups,
  useAdminDeleteUser,
  useApproveSignup,
  useRejectSignup
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, MoreVertical, Check, X, Shield, PlayCircle, StopCircle, Trash2, PauseCircle, Key, KeyRound } from "lucide-react";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminUsers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("active");

  const { data: users, isLoading: usersLoading } = useGetAdminUsers(undefined, {
    query: { queryKey: ["adminUsers"] }
  });

  const { data: pending, isLoading: pendingLoading } = useGetPendingSignups({
    query: { queryKey: ["pendingSignups"] }
  });

  const deleteUser = useAdminDeleteUser();
  const approveSignup = useApproveSignup();
  const rejectSignup = useRejectSignup();

  const handleApprove = (id: string) => {
    approveSignup.mutate({ signupId: id }, {
      onSuccess: () => {
        toast({ title: "User approved" });
        queryClient.invalidateQueries({ queryKey: ["pendingSignups"] });
        queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      }
    });
  };

  const handleReject = (id: string) => {
    rejectSignup.mutate({ signupId: id }, {
      onSuccess: () => {
        toast({ title: "Signup rejected" });
        queryClient.invalidateQueries({ queryKey: ["pendingSignups"] });
      }
    });
  };

  const handleDelete = (id: string) => {
    if (confirm("Are you sure you want to delete this user?")) {
      deleteUser.mutate({ userId: id }, {
        onSuccess: () => {
          toast({ title: "User deleted" });
          queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
        }
      });
    }
  };

  const handleToggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === "suspended" ? "active" : "suspended";
    if (newStatus === "suspended" && !confirm(`Suspend this user? Their bot will be stopped.`)) return;
    try {
      const res = await fetch(`/api/admin/users/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        toast({ title: `User ${newStatus === "suspended" ? "suspended" : "reactivated"}` });
        queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      }
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  const handleRevokeToken = async (id: string) => {
    if (!confirm("Revoke this user's Deriv token? They will need to re-enter it.")) return;
    try {
      const res = await fetch(`/api/admin/users/${id}/token`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        toast({ title: "Token revoked" });
        queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      }
    } catch {
      toast({ title: "Failed to revoke token", variant: "destructive" });
    }
  };

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">User Management</h1>
          <Button className="bg-primary text-black hover:bg-primary/90">
            Create User
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="bg-card border border-border p-1 w-full sm:w-auto inline-flex h-11 mb-6">
            <TabsTrigger value="active" className="flex-1 sm:flex-none data-[state=active]:bg-background">
              Active Users
            </TabsTrigger>
            <TabsTrigger value="pending" className="flex-1 sm:flex-none data-[state=active]:bg-background">
              Pending Signups
              {(pending?.signups?.length ?? 0) > 0 && (
                <Badge variant="secondary" className="ml-2 bg-primary/20 text-primary border-0">
                  {pending!.signups.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-0">
            {usersLoading ? (
              <div className="flex justify-center p-8"><Loader2 className="animate-spin w-8 h-8 text-primary" /></div>
            ) : (
              <div className="grid gap-4">
                {users?.users?.map((user) => (
                  <Card key={user.id} className="p-4 bg-card border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                        {user.username?.[0]?.toUpperCase() || 'U'}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-foreground">{user.username}</h3>
                          {user.role === 'admin' && <Shield className="w-3 h-3 text-accent-gold" />}
                        </div>
                        <p className="text-sm text-text-secondary">{user.email}</p>
                      </div>
                    </div>
                    
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 text-sm">
                      <Badge variant="outline" className="border-border">
                        {user.tradingProfile || 'No Profile'}
                      </Badge>
                      
                      <div className="flex items-center gap-1">
                        {user.botRunning ? (
                          <Badge variant="secondary" className="bg-primary/10 text-primary border-0">
                            <PlayCircle className="w-3 h-3 mr-1" /> Running
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-text-secondary/10 text-text-secondary border-0">
                            <StopCircle className="w-3 h-3 mr-1" /> Stopped
                          </Badge>
                        )}
                      </div>

                      {user.recoveryModeActive && (
                        <Badge variant="secondary" className="bg-accent-red/10 text-accent-red border-0">
                          Recovery
                        </Badge>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto sm:ml-0">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-card border-border">
                          <DropdownMenuItem
                            className="cursor-pointer focus:bg-background"
                            onClick={() => handleToggleStatus(user.id, (user as any).status || "active")}
                          >
                            {(user as any).status === "suspended" ? (
                              <><PlayCircle className="w-4 h-4 mr-2 text-primary" /> Reactivate</>
                            ) : (
                              <><PauseCircle className="w-4 h-4 mr-2 text-yellow-400" /> Suspend</>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer focus:bg-background"
                            onClick={() => handleRevokeToken(user.id)}
                          >
                            <KeyRound className="w-4 h-4 mr-2 text-text-secondary" /> Revoke Token
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-accent-red focus:bg-accent-red/10 focus:text-accent-red cursor-pointer"
                            onClick={() => handleDelete(user.id)}
                          >
                            <Trash2 className="w-4 h-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </Card>
                ))}
                
                {(!users?.users || users.users.length === 0) && (
                  <div className="text-center p-8 text-text-secondary border border-dashed border-border rounded-xl">
                    No active users found.
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="pending" className="mt-0">
            {pendingLoading ? (
              <div className="flex justify-center p-8"><Loader2 className="animate-spin w-8 h-8 text-primary" /></div>
            ) : (
              <div className="grid gap-4">
                {pending?.signups?.map((req) => (
                  <Card key={req.id} className="p-4 bg-card border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-foreground">{req.username}</h3>
                      <p className="text-sm text-text-secondary">{req.email}</p>
                      <div className="text-xs text-text-secondary mt-1">
                        Country: {req.country} • Applied: {new Date(req.requestedAt).toLocaleDateString()}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="text-accent-red border-accent-red/20 hover:bg-accent-red/10 hover:text-accent-red"
                        onClick={() => handleReject(req.id)}
                        disabled={rejectSignup.isPending}
                      >
                        <X className="w-4 h-4 mr-1" /> Reject
                      </Button>
                      <Button 
                        size="sm" 
                        className="bg-primary text-black hover:bg-primary/90"
                        onClick={() => handleApprove(req.id)}
                        disabled={approveSignup.isPending}
                      >
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </Button>
                    </div>
                  </Card>
                ))}

                {(!pending?.signups || pending.signups.length === 0) && (
                  <div className="text-center p-8 text-text-secondary border border-dashed border-border rounded-xl">
                    No pending signups.
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
