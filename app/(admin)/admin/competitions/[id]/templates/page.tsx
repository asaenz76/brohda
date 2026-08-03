import { notFound } from "next/navigation";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { TEMPLATE_REGISTRY } from "@/lib/pools/templates/registry";

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

export default async function CompetitionTemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        Informational only — cross-references the global template registry against this competition&apos;s coverage snapshot.
        Nothing here restricts which templates can be used yet.
      </p>
      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {TEMPLATE_REGISTRY.filter((t) => t.activeForCreation).map((template) => {
          const note = coverageNote(data.coverageSnapshot, template.id);
          return (
            <div key={template.id} className="px-3 py-2.5 text-sm">
              <p className="font-medium text-text-primary">{template.name}</p>
              {note ? <p className="text-xs text-warning-muted">{note}</p> : <p className="text-xs text-text-muted">No coverage concerns noted.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
