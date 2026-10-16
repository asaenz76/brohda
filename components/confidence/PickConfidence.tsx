import { ConfidenceBacking } from "@/components/confidence/ConfidenceBacking";
import { confidenceLabel, formatConfidence } from "@/lib/confidence/format";
import type { StakeUiState } from "@/lib/confidence/stakes";

/**
 * The ONE place a Pick card (the Post detail and the Home feed alike) turns the database's answer about Confidence into UI: the optional "How confident are you?" control while the Pick is still open to it,
 * nothing at all otherwise. Eligibility, the ladder, the available balance and the lock reason all come from `StakeUiState` (the same database function for every surface), so the surfaces cannot drift.
 * The control is keyed by Pick AND side, so changing an unbacked Pick starts a fresh, never-stale selector bound to the new side.
 */
export function PickConfidence({ predictionId, selectedOutcome, selectionLabel, stake }: { predictionId: string; selectedOutcome: "YES" | "NO"; selectionLabel: string; stake: StakeUiState }) {
  if (stake.state !== "open") return null;
  return (
    <ConfidenceBacking key={`${predictionId}:${selectedOutcome}`} predictionId={predictionId} selectionLabel={selectionLabel} available={stake.available} allowedStakes={stake.allowedStakes} />
  );
}

/** The committed amount on the viewer's own locked Pick — the same line on every surface (Post detail's card and the feed card). */
export function CommittedConfidence({ amount, pending }: { amount: number; pending: boolean }) {
  return (
    <p className="text-sm font-medium text-text-primary" data-slot="pick-confidence" aria-label={`${confidenceLabel(amount)}${pending ? ", locked" : ""}`}>
      <span aria-hidden="true">
        {formatConfidence(amount)} Confidence{pending ? " · Locked" : ""}
      </span>
    </p>
  );
}
