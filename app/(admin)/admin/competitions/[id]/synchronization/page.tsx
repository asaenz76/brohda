import { notFound } from "next/navigation";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { SyncActions } from "./sync-actions";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default async function CompetitionSynchronizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const latestFailedJob = data.jobs.find((j) => j.status === "FAILED");

  return (
    <div className="space-y-4">
      <SyncActions leagueSeasonImportId={data.id} failedJobId={latestFailedJob?.id ?? null} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-muted">
          <p className="text-sm font-medium text-text-primary">Discovery sync</p>
          <p>Last discovered: {formatDate(data.lastFixtureDiscoveryAt)}</p>
          <p>Last synced: {formatDate(data.lastSyncedAt)}</p>
          {data.lastSyncError && <p className="text-destructive">Last error: {data.lastSyncError}</p>}
        </div>
        <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-muted">
          <p className="text-sm font-medium text-text-primary">Coverage snapshot</p>
          <p>Checked: {formatDate(data.coverageCheckedAt)}</p>
          {data.coverageSnapshot ? (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(data.coverageSnapshot, null, 2)}</pre>
          ) : (
            <p>Not yet captured.</p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Import job history</p>
        <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {data.jobs.map((job) => (
            <div key={job.id} className="px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">
                  {job.status} {job.includeHistorical ? "(includes historical)" : ""}
                </span>
                <span className="text-xs text-text-muted">{formatDate(job.createdAt)}</span>
              </div>
              <p className="text-xs text-text-muted">
                {job.processedFixtures} / {job.totalFixtures} fixtures · {job.chunkCounts.succeeded} chunk(s) succeeded,{" "}
                {job.chunkCounts.failed} failed, {job.chunkCounts.pending + job.chunkCounts.running} pending
              </p>
              {job.lastError && <p className="text-xs text-destructive">{job.lastError}</p>}
            </div>
          ))}
          {data.jobs.length === 0 && <p className="p-3 text-sm text-text-muted">No import jobs yet.</p>}
        </div>
      </div>
    </div>
  );
}
