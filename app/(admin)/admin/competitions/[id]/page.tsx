import { notFound } from "next/navigation";
import Link from "next/link";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { Button } from "@/components/ui/button";

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  const days = Math.round(Math.abs(diffMs) / 86_400_000);
  const label = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

export default async function CompetitionDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const currentJob = data.jobs.find((j) => j.status === "PENDING" || j.status === "RUNNING");

  return (
    <div className="space-y-4">
      {currentJob && (
        <div className="rounded-lg border border-border-subtle p-3">
          <p className="text-sm font-medium text-text-primary">Import in progress</p>
          <p className="text-xs text-text-muted">
            {currentJob.processedFixtures} / {currentJob.totalFixtures} fixtures imported
            {currentJob.failedFixtures > 0 ? ` · ${currentJob.failedFixtures} failed` : ""}
          </p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary">
            <div
              className="h-full rounded-full bg-accent-primary"
              style={{ width: `${currentJob.totalFixtures > 0 ? Math.round((currentJob.processedFixtures / currentJob.totalFixtures) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Fixtures imported" value={String(data.fixtureCountImported)} />
        <Stat label="Upcoming fixtures" value={String(data.upcomingFixtureCount)} />
        <Stat label="Next fixture" value={formatRelative(data.nextFixtureAt)} />
        <Stat label="Last synced" value={formatRelative(data.lastSyncedAt)} />
      </div>

      {data.needsAttentionReasons.length > 0 && (
        <div className="rounded-lg border border-warning-muted/40 bg-warning-muted/10 p-3">
          <p className="text-sm font-medium text-warning-muted">This competition needs attention</p>
          <p className="text-xs text-text-muted">See the Health tab for details.</p>
        </div>
      )}

      <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-muted">
        <p>Provider fixture count: {data.providerFixtureCount ?? "—"}</p>
        <p>Season: {data.seasonStartDate ?? "—"} → {data.seasonEndDate ?? "—"}</p>
        <p>Provider currently flags this as the current season: {data.providerCurrent ? "Yes" : "No"}</p>
        <p>Pool creation enabled: {data.poolCreationEnabled ? "Yes" : "No"}</p>
      </div>

      <Link href="/admin/fixtures">
        <Button size="sm" variant="outline">
          View fixtures
        </Button>
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
    </div>
  );
}
