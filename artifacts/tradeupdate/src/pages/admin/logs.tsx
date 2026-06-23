import { AdminLayout } from "@/components/admin-layout";
import { useGetAuthLogs } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

export default function AdminLogs() {
  const { data: logs, isLoading } = useGetAuthLogs(undefined, {
    query: { queryKey: ["authLogs"] }
  });

  return (
    <AdminLayout>
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Security Logs</h1>
        
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
                        {log.ip ?? '—'}
                      </td>
                      <td className="px-6 py-4 text-text-secondary text-xs truncate max-w-[200px]">
                        {log.details ?? '—'}
                      </td>
                    </tr>
                  ))}
                  {(!logs?.logs || logs.logs.length === 0) && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-text-secondary">
                        No logs found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AdminLayout>
  );
}
