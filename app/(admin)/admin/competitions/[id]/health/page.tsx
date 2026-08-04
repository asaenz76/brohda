import { notFound } from "next/navigation";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { NEEDS_ATTENTION_ACTION_LABEL, NEEDS_ATTENTION_LABEL, type NeedsAttentionReason } from "@/lib/competitions/status";
import { cn } from "@/lib/utils";

const ALL_REASONS: NeedsAttentionReason[] = [
  "IMPORT_FAILED",
  "SYNC_STALE",
  "SYNC_FAILED",
  "NEWER_SEASON_AVAILABLE",
  "FIXTURE_COUNT_MISMATCH",
  "UPCOMING_FIXTURES_NOT_IMPORTED",
  "SEASON_METADATA_CONFLICT",
  "NO_UPCOMING_FIXTURES",
  "SEASON_ENDED_NOT_ARCHIVED",
];

export default async function CompetitionHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const detailsByCode = new Map(data.needsAttentionDetails.map((d) => [d.code, d]));

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        {detailsByCode.size === 0 ? "No issues detected for this competition." : `${detailsByCode.size} issue(s) detected.`}
      </p>
      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {ALL_REASONS.map((reason) => {
          const detail = detailsByCode.get(reason);
          const flagged = detail != null;
          return (
            <div key={reason} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
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
                {detail?.action && (
                  <span className="shrink-0 text-xs font-medium text-accent-primary">{NEEDS_ATTENTION_ACTION_LABEL[detail.action]}</span>
                )}
              </div>
              {detail && <p className="pl-6 text-xs text-text-secondary">{detail.message}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
