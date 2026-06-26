import { useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import { useGetAuthLogs } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

function AuditLog() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["auditLog", page],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit-log?page=${page}&limit=20`, { credentials: "include" });
      return res.json();
    },
    refetchInterval: 30000,
  });

  const totalPages = data ? Math.ceil((data.total || 0) / 20) : 1;

  const actionColor = (action: string) => {
    if (action.includes("kill") || action.includes("suspended") || action.includes("revoke")) return "border-accent-red text-accent-red";
    if (action.includes("active") || action.includes("set_token")) return "border-primary text-primary";
    return "border-text-secondary text-text-secondary";
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="bg-card border-border overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-background border-b border-border text-text-secondary text-xs uppercase">
                <tr>
                  <th className="px-6 py-4 font-medium">Time</th>
                  <th className="px-6 py-4 font-medium">Admin</th>
                  <th className="px-6 py-4 font-medium">Action</th>
                  <th className="px-6 py-4 font-medium">Target</th>
                  <th className="px-6 py-4 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data?.logs?.map((log: any) => (
                  <tr key={log.id} className="hover:bg-white/5">
                    <td className="px-6 py-4 whitespace-nowrap text-text-secondary font-mono text-xs">
                      {new Date((log.createdAt || 0) * 1000).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap font-medium text-foreground font-mono text-xs">
                      {log.adminUserId?.slice(0, 8) ?? "—"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge variant="outline" className={actionColor(log.action || "")}>
                        {log.action}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-text-secondary">
                      {log.targetUserId?.slice(0, 8) ?? "—"}
                    </td>
                    <td className="px-6 py-4 text-text-secondary text-xs truncate max-w-[200px]">
                      {log.details ?? "—"}
                    </td>
                  </tr>
                ))}
                {(!data?.logs || data.logs.length === 0) && (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-text-secondary">No audit logs yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>Page {page} of {totalPages} · {data?.total || 0} records</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminLogs() {
  const { data: logs, isLoading } = useGetAuthLogs(undefined, {
    query: { queryKey: ["authLogs"] }
  });

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Logs</h1>

        <Tabs defaultValue="auth">
          <TabsList className="bg-card border border-border">
            <TabsTrigger value="auth">Auth Logs</TabsTrigger>
            <TabsTrigger value="audit">Audit Trail</TabsTrigger>
          </TabsList>

          <TabsContent value="auth" className="mt-4">
            <Card className="bg-card border-border overflow-hidden">
              {isLoading ? (
                <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-background border-b border-border text-text-secondary text-xs uppercase">
                      <tr>
                        <th className="px-6 py-4 font-medium">Timestamp</th>
                        <th className="px-6 py-4 font-medium">User</th>
                        <th className="px-6 py-4 font-medium">Event</th>
                        <th className="px-6 py-4 font-medium">IP Address</th>
                        <th className="px-6 py-4 font-medium">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {logs?.logs?.map((log) => (
                        <tr key={log.id} className="hover:bg-white/5">
                          <td className="px-6 py-4 whitespace-nowrap text-text-secondary font-mono text-xs">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap font-medium text-foreground">
                            {log.username}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <Badge variant="outline" className={
                              log.event === 'LOGIN_SUCCESS' ? 'border-primary text-primary' :
                              log.event === 'LOGIN_FAILED' ? 'border-accent-red text-accent-red' :
                              'border-text-secondary text-text-secondary'
                            }>
                              {log.event}
                            </Badge>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-text-secondary">
                            {log.ip ?? "—"}
                          </td>
                          <td className="px-6 py-4 text-text-secondary text-xs truncate max-w-[200px]">
                            {log.details ?? "—"}
                          </td>
                        </tr>
                      ))}
                      {(!logs?.logs || logs.logs.length === 0) && (
                        <tr>
                          <td colSpan={5} className="px-6 py-12 text-center text-text-secondary">No logs found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            <AuditLog />
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
