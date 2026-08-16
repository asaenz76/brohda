import { notFound } from "next/navigation";
import Link from "next/link";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { TEMPLATE_REGISTRY } from "@/lib/pools/templates/registry";
import { Button } from "@/components/ui/button";
import { SettingsForm } from "./settings/settings-form";

// Coverage-based enforcement isn't built yet (see the odds-integration
// coverage_snapshot design note) — this only surfaces what the snapshot
// suggests, informationally, so an admin isn't guessing at data support.
function coverageNote(coverage: unknown, templateId: string): string | null {
  if (!coverage || typeof coverage !== "object") return null;
  const c = coverage as Record<string, unknown>;
  const fixtures = c.fixtures as Record<string, unknown> | undefined;
  if (["RED_CARD", "PENALTY_AWARDED", "OWN_GOAL", "GOAL_AFTER_MINUTE", "FIRST_TEAM_TO_SCORE"].includes(templateId)) {
    if (fixtures && fixtures.events === false) return "Provider coverage does not confirm match-event data for this competition.";
  }
  if (templateId === "PLAYER_TO_SCORE" && fixtures && fixtures.statistics_players === false) {
    return "Provider coverage does not confirm player statistics for this competition.";
  }
  return null;
}

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
  const hasHistoricalImport = data.jobs.some((j) => j.includeHistorical && j.status === "SUCCEEDED");
  const activeTemplates = TEMPLATE_REGISTRY.filter((t) => t.activeForCreation);

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

      <Link href={`/admin/events?competition=${data.externalLeagueId}&range=7d`}>
        <Button size="sm" variant="outline">
          Browse upcoming events
        </Button>
      </Link>

      {/* Folded in from the old standalone Templates/Settings sub-tabs
          (Phase 7: Admin Cleanup — 6 workspace tabs down to 4). Both were
          the thinnest tabs in the workspace (informational-only, and a
          19-line stub wrapping a single form respectively) — collapsed by
          default so the dashboard stays scannable, but one click away
          instead of a full navigation. */}
      <details className="rounded-lg border border-border-subtle p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">Templates</summary>
        <p className="mt-2 text-xs text-text-muted">
          Informational only — cross-references the global template registry against this competition&apos;s
          coverage snapshot. Nothing here restricts which templates can be used yet.
        </p>
        <div className="mt-2 divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {activeTemplates.map((template) => {
            const note = coverageNote(data.coverageSnapshot, template.id);
            return (
              <div key={template.id} className="px-3 py-2.5 text-sm">
                <p className="font-medium text-text-primary">{template.name}</p>
                {note ? (
                  <p className="text-xs text-warning-muted">{note}</p>
                ) : (
                  <p className="text-xs text-text-muted">No coverage concerns noted.</p>
                )}
              </div>
            );
          })}
        </div>
      </details>

      <details className="rounded-lg border border-border-subtle p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">Settings</summary>
        <div className="mt-2">
          <SettingsForm
            leagueSeasonImportId={data.id}
            initialPoolCreationEnabled={data.poolCreationEnabled}
            hasHistoricalImport={hasHistoricalImport}
          />
        </div>
      </details>
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
