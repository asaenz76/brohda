import { notFound } from "next/navigation";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { NEEDS_ATTENTION_LABEL, type NeedsAttentionReason } from "@/lib/competitions/status";
import { cn } from "@/lib/utils";

const ALL_REASONS: NeedsAttentionReason[] = [
  "IMPORT_FAILED",
  "SYNC_STALE",
  "SYNC_FAILED",
  "NEWER_SEASON_AVAILABLE",
  "NO_UPCOMING_FIXTURES",
  "SEASON_ENDED_NOT_ARCHIVED",
];

export default async function CompetitionHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const active = new Set(data.needsAttentionReasons);

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        {active.size === 0 ? "No issues detected for this competition." : `${active.size} issue(s) detected.`}
      </p>
      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {ALL_REASONS.map((reason) => {
          const flagged = active.has(reason);
          return (
            <div key={reason} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]",
                    flagged ? "bg-warning-muted/20 text-warning-muted" : "bg-credit/20 text-credit",
                  )}
                >
                  {flagged ? "!" : "✓"}
                </span>
                <span className={cn("text-sm", flagged ? "text-text-primary" : "text-text-muted")}>{NEEDS_ATTENTION_LABEL[reason]}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
