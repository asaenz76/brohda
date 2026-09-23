import { getUserPredictionRecord, getUserCallBsRecord } from "@/lib/reputation/repository";

// Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md, Reputation +
// Leaderboards), §26-28. A compact, understandable sports record — never
// the legacy pool "Predictions" tab's own WON/LOST stats (predictions-tab.tsx,
// a separate, pre-existing, untouched domain), and never
// market-predictions-tab.tsx's own pre-existing "X correct · Y incorrect"
// line (also untouched — that display predates R11 and reads from an
// older, unrelated counter; this component is R11's own canonical
// reputation surface, sourced from lib/reputation/repository.ts). Shown on
// both the viewer's own profile and any other user's public profile —
// prediction reputation is public to the same extent a Pick or a
// RESOLVED free Challenge is already public (§42).
export async function ReputationSummary({ userId }: { userId: string }) {
  const [record, callBs] = await Promise.all([getUserPredictionRecord(userId), getUserCallBsRecord(userId)]);

  const hasAnyGradedHistory = record.decided > 0 || record.void > 0;
  const hasCallBsHistory = callBs.wins + callBs.losses + callBs.void > 0;

  if (!hasAnyGradedHistory) {
    return <p className="text-sm text-text-muted">No graded predictions yet.</p>;
  }

  return (
    <div className="flex flex-wrap gap-6">
      <div>
        <p className="text-xl font-bold text-text-primary">{record.decided + record.void}</p>
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Predictions</p>
      </div>

      <div>
        <p className="text-xl font-bold text-text-primary">
          {record.correct}–{record.incorrect}
        </p>
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Record</p>
        {record.void > 0 && <p className="text-xs text-text-muted">{record.void} void</p>}
      </div>

      <div>
        <p className="text-xl font-bold text-text-primary">{record.accuracy !== null ? `${(record.accuracy * 100).toFixed(1)}%` : "—"}</p>
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Accuracy</p>
        {/* §28: a real record can exist without leaderboard eligibility — these are two different questions, shown distinctly rather than conflated. */}
        {record.decided > 0 && !record.eligibleForLeaderboard && <p className="text-xs text-text-muted">Not ranked yet</p>}
      </div>

      {hasCallBsHistory && (
        <div>
          <p className="text-xl font-bold text-text-primary">
            {callBs.wins}–{callBs.losses}
          </p>
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Call BS</p>
          {callBs.void > 0 && <p className="text-xs text-text-muted">{callBs.void} void</p>}
        </div>
      )}
    </div>
  );
}
