import { requireSuperAdmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

// Audit entries embed wallet-adjustment/settlement before/after payloads
// (dollar amounts) — stays super_admin-only even though the admin layout
// above it now admits the lower-privileged 'admin' role too. This used to
// rely solely on the layout's gate; now that the layout is broader, this
// page needs its own explicit check.
export default async function AdminAuditLogPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { data: entries } = await supabase
    .from("audit_logs")
    .select("id, actor_id, action, entity_type, entity_id, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Audit Log</h1>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Entity</th>
            <th className="px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {(entries ?? []).map((entry) => (
            <tr key={entry.id}>
              <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                {new Date(entry.created_at).toLocaleString()}
              </td>
              <td className="px-3 py-2 text-text-primary">{entry.action}</td>
              <td className="px-3 py-2 text-text-secondary">
                {entry.entity_type}
                {entry.entity_id ? ` (${entry.entity_id.slice(0, 8)})` : ""}
              </td>
              <td className="px-3 py-2 text-text-secondary">{entry.reason ?? "—"}</td>
            </tr>
          ))}
          {(!entries || entries.length === 0) && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-text-muted">
                No audit entries yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
