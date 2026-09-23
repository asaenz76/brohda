import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R12 (§40, §84): a read-only, durable audit trail for every
// Brohda 2.0 settings change — actor, timestamp, domain (the RPC-specific
// `action` string, e.g. "settings.monetary_updated"), and the full
// before/after snapshot of the changed domain's own fields (never the
// whole 37-column row, since each RPC's own audit INSERT already scopes
// `before`/`after` to just the columns it touched). super_admin-only,
// same gate as the settings page itself and as the pre-existing generic
// /admin/audit-log page. Reads directly via the admin client rather than
// the request-scoped client so this page works the same regardless of
// audit_logs' own RLS (select is already granted to `authenticated`, but
// the admin client keeps this consistent with the rest of R12's own
// read path in lib/admin-settings/repository.ts).
export default async function BrohdaSettingsHistoryPage() {
  await requireSuperAdmin();
  const admin = createAdminClient();

  const { data: entries } = await admin
    .from("audit_logs")
    .select("id, actor_id, action, before, after, created_at")
    .eq("entity_type", "platform_settings")
    .order("created_at", { ascending: false })
    .limit(200);

  const actorIds = Array.from(new Set((entries ?? []).map((e) => e.actor_id).filter((id): id is string => !!id)));
  const { data: profiles } = actorIds.length
    ? await admin.from("user_profiles").select("id, display_name").in("id", actorIds)
    : { data: [] as { id: string; display_name: string }[] };
  const displayNameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-text-primary">Brohda Settings — Change History</h1>
        <Link href="/admin/settings/brohda" className="shrink-0 text-sm font-medium text-accent-primary hover:underline">
          Back to settings
        </Link>
      </div>
      <p className="text-sm text-text-muted">
        Every change to Brohda 2.0 configuration, newest first. This record is append-only — it cannot be edited or deleted, including by administrators.
      </p>
      <div className="space-y-3">
        {(entries ?? []).map((entry) => (
          <div key={entry.id} className="rounded-xl border-2 border-text-primary bg-card p-4 text-sm shadow-[3px_3px_0_0_var(--text-primary)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-text-primary">{entry.action}</span>
              <span className="text-text-muted">
                {entry.actor_id ? (displayNameById.get(entry.actor_id) ?? entry.actor_id.slice(0, 8)) : "system"} · {new Date(entry.created_at).toLocaleString()}
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium tracking-wide text-text-muted uppercase">Before</p>
                <pre className="overflow-x-auto rounded-lg bg-surface-secondary p-2 text-xs text-text-secondary">{JSON.stringify(entry.before, null, 2)}</pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium tracking-wide text-text-muted uppercase">After</p>
                <pre className="overflow-x-auto rounded-lg bg-surface-secondary p-2 text-xs text-text-secondary">{JSON.stringify(entry.after, null, 2)}</pre>
              </div>
            </div>
          </div>
        ))}
        {(!entries || entries.length === 0) && <p className="py-8 text-center text-text-muted">No configuration changes yet.</p>}
      </div>
    </div>
  );
}
