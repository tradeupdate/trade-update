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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MoreVertical, Check, X, Shield, PlayCircle, StopCircle, Trash2, PauseCircle, KeyRound, Plus, Copy, CheckCircle2, RefreshCw } from "lucide-react";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

const COUNTRIES = [
  "United Kingdom","South Africa","Nigeria","Ghana","Kenya","Zimbabwe","Uganda",
  "Tanzania","Zambia","Botswana","Namibia","United States","Canada","Australia",
  "New Zealand","India","Pakistan","Bangladesh","Sri Lanka","Philippines",
  "Malaysia","Singapore","Indonesia","Other"
];

function generatePassword() {
  return "Trade" + String(Math.floor(1000 + Math.random() * 9000)) + "!";
}

interface CreatedUser { username: string; email: string; tempPassword: string; profile: string; }

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

  // Create user modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [modalStep, setModalStep] = useState<"form" | "success">("form");
  const [creating, setCreating] = useState(false);
  const [createdUser, setCreatedUser] = useState<CreatedUser | null>(null);
  const [credsCopied, setCredsCopied] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    username: "", email: "", country: "", password: "", profile: "safe", isActive: true,
  });

  const setField = (k: keyof typeof form, v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }));

  const openCreateModal = () => {
    setForm({ username: "", email: "", country: "", password: "", profile: "safe", isActive: true });
    setFormErrors({});
    setModalStep("form");
    setCreatedUser(null);
    setCredsCopied(false);
    setCreateModalOpen(true);
  };

  const handleAutoGenerate = () => {
    setField("password", generatePassword());
    setFormErrors(e => ({ ...e, password: "" }));
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!form.username.trim()) errors.username = "Username is required";
    if (!form.email.trim()) errors.email = "Email is required";
    if (!form.country) errors.country = "Country is required";
    if (!form.password.trim()) errors.password = "Password is required";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreateUser = async () => {
    if (!validate()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username: form.username.trim(),
          email: form.email.trim(),
          country: form.country,
          password: form.password,
          tradingProfile: form.profile,
          isActive: form.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error || "Failed to create user", variant: "destructive" });
        return;
      }
      setCreatedUser({
        username: form.username.trim(),
        email: form.email.trim(),
        tempPassword: form.password,
        profile: form.profile,
      });
      setModalStep("success");
      queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const handleCopyCredentials = () => {
    if (!createdUser) return;
    const text = `Username: ${createdUser.username}\nPassword: ${createdUser.tempPassword}\nProfile: ${createdUser.profile}`;
    navigator.clipboard.writeText(text).then(() => {
      setCredsCopied(true);
      setTimeout(() => setCredsCopied(false), 2500);
    });
  };

  const handleApprove = (id: string) => {
    approveSignup.mutate({ signupId: id }, {
      onSuccess: () => {
        toast({ title: "User approved and notified" });
        queryClient.invalidateQueries({ queryKey: ["pendingSignups"] });
        queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      }
    });
  };

  const handleReject = (id: string) => {
    if (!confirm("Reject this application?")) return;
    rejectSignup.mutate({ signupId: id }, {
      onSuccess: () => {
        toast({ title: "Application rejected" });
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

  const profileOptions = [
    { value: "safe", label: "Safe", desc: "Conservative — lower risk, steady gains" },
    { value: "pro", label: "Pro", desc: "Balanced — moderate risk and reward" },
    { value: "aggressive", label: "Aggressive", desc: "High risk — maximum potential returns" },
  ];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">User Management</h1>
          <Button className="bg-primary text-black hover:bg-primary/90" onClick={openCreateModal}>
            <Plus className="w-4 h-4 mr-2" />
            Create User
          </Button>
        </div>

        {/* Create User Modal */}
        <Dialog open={createModalOpen} onOpenChange={open => { if (!open) setCreateModalOpen(false); }}>
          <DialogContent className="bg-card border-border max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-foreground">
                {modalStep === "success" ? "User Created" : "Create New User"}
              </DialogTitle>
            </DialogHeader>

            {modalStep === "form" ? (
              <div className="flex flex-col gap-5 mt-2">
                {/* Username */}
                <div>
                  <Label className="text-foreground mb-1.5 block">Username <span className="text-accent-red">*</span></Label>
                  <Input
                    value={form.username}
                    onChange={e => { setField("username", e.target.value); setFormErrors(er => ({ ...er, username: "" })); }}
                    placeholder="johndoe"
                    className="bg-background border-border"
                  />
                  {formErrors.username && <p className="text-xs text-accent-red mt-1">{formErrors.username}</p>}
                </div>

                {/* Email */}
                <div>
                  <Label className="text-foreground mb-1.5 block">Email <span className="text-accent-red">*</span></Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={e => { setField("email", e.target.value); setFormErrors(er => ({ ...er, email: "" })); }}
                    placeholder="user@example.com"
                    className="bg-background border-border"
                  />
                  {formErrors.email && <p className="text-xs text-accent-red mt-1">{formErrors.email}</p>}
                </div>

                {/* Country */}
                <div>
                  <Label className="text-foreground mb-1.5 block">Country <span className="text-accent-red">*</span></Label>
                  <select
                    value={form.country}
                    onChange={e => { setField("country", e.target.value); setFormErrors(er => ({ ...er, country: "" })); }}
                    className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Select country...</option>
                    {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {formErrors.country && <p className="text-xs text-accent-red mt-1">{formErrors.country}</p>}
                </div>

                {/* Password */}
                <div>
                  <Label className="text-foreground mb-1.5 block">Password <span className="text-accent-red">*</span></Label>
                  <div className="flex gap-2">
                    <Input
                      value={form.password}
                      onChange={e => { setField("password", e.target.value); setFormErrors(er => ({ ...er, password: "" })); }}
                      placeholder="Enter or auto-generate"
                      className="bg-background border-border flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" className="border-border text-text-secondary hover:text-foreground whitespace-nowrap" onClick={handleAutoGenerate}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Auto-generate
                    </Button>
                  </div>
                  {formErrors.password && <p className="text-xs text-accent-red mt-1">{formErrors.password}</p>}
                </div>

                {/* Trading Profile */}
                <div>
                  <Label className="text-foreground mb-2 block">Trading Profile</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {profileOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setField("profile", opt.value)}
                        className={`p-3 rounded-lg border text-left transition-colors ${form.profile === opt.value ? "border-primary bg-primary/10" : "border-border bg-background hover:border-border/80"}`}
                      >
                        <div className={`text-sm font-semibold ${form.profile === opt.value ? "text-primary" : "text-foreground"}`}>{opt.label}</div>
                        <div className="text-xs text-text-secondary mt-0.5 leading-tight">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Active toggle */}
                <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border bg-background">
                  <div>
                    <div className="text-sm font-medium text-foreground">Account Active</div>
                    <div className="text-xs text-text-secondary">User can log in immediately</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setField("isActive", !form.isActive)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.isActive ? "bg-primary" : "bg-border"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${form.isActive ? "translate-x-4" : "translate-x-1"}`} />
                  </button>
                </div>

                {/* Buttons */}
                <div className="flex gap-3 pt-1">
                  <Button variant="outline" className="flex-1 border-border" onClick={() => setCreateModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button className="flex-1 bg-primary text-black hover:bg-primary/90" onClick={handleCreateUser} disabled={creating}>
                    {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Create User
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-5 mt-2">
                <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-primary" />
                </div>
                <div className="text-center">
                  <h3 className="font-bold text-lg text-foreground">User Created Successfully</h3>
                  <p className="text-sm text-text-secondary mt-1">Share these credentials with the user.</p>
                </div>

                {createdUser && (
                  <div className="w-full rounded-xl border border-border bg-background p-4 font-mono text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Username:</span>
                      <span className="text-foreground font-semibold">{createdUser.username}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Password:</span>
                      <span className="text-foreground font-semibold">{createdUser.tempPassword}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Profile:</span>
                      <span className="text-primary capitalize font-semibold">{createdUser.profile}</span>
                    </div>
                  </div>
                )}

                <div className="flex gap-3 w-full">
                  <Button variant="outline" className="flex-1 border-border" onClick={handleCopyCredentials}>
                    {credsCopied ? <CheckCircle2 className="w-4 h-4 mr-2 text-primary" /> : <Copy className="w-4 h-4 mr-2" />}
                    {credsCopied ? "Copied!" : "Copy Credentials"}
                  </Button>
                  <Button className="flex-1 bg-primary text-black hover:bg-primary/90" onClick={() => setCreateModalOpen(false)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

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
