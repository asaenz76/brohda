import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { ArchiveActions } from "./archive-actions";

export default async function CompetitionLifecyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const adminClient = createAdminClient();
  const { data: auditRows } = await adminClient
    .from("audit_logs")
    .select("action, after, created_at")
    .eq("entity_type", "league_season_import")
    .eq("entity_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle p-3">
        <p className="text-sm font-medium text-text-primary">
          {data.isActive ? "This competition is active." : `Archived ${data.archivedAt ? new Date(data.archivedAt).toLocaleString() : ""}`}
        </p>
        <p className="mb-2 text-xs text-text-muted">
          Archiving removes it from pool creation and the Active views without deleting any imported fixtures or history.
        </p>
        <ArchiveActions leagueSeasonImportId={data.id} isActive={data.isActive} />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Audit trail</p>
        <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {(auditRows ?? []).map((row, i) => (
            <div key={i} className="px-3 py-2 text-xs">
              <span className="font-medium text-text-primary">{row.action}</span>{" "}
              <span className="text-text-muted">{new Date(row.created_at).toLocaleString()}</span>
            </div>
          ))}
          {(auditRows ?? []).length === 0 && <p className="p-3 text-sm text-text-muted">No history yet.</p>}
        </div>
      </div>
    </div>
  );
}
