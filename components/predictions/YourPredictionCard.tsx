import type { Prediction } from "@/lib/predictions/types";
import type { Choice } from "@/lib/prediction-markets/selection-labels";
import { formatConfidence, formatSignedConfidence } from "@/lib/confidence/format";
import { CommittedConfidence } from "@/components/confidence/CommittedConfidence";

/** The Confidence committed behind this Pick, if any (shown only on the viewer's own Pick). */
export interface PickStake {
  amount: number;
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
}

// Market detail's "you already predicted here" state (roadmap STEP 17).
// Never implies the user currently holds a financial position — this is a
// belief record, shown plainly. The page's own current YES/NO percentages
// render separately, just above this card, so "current" vs
// "prediction-time" stay visually distinct without this component
// repeating the current numbers itself (mirrors the FreshnessNote
// no-duplicated-copy precedent from Milestone 2).

export function YourPredictionCard({ prediction, choices, stake = null }: { prediction: Prediction; choices: [Choice, Choice]; stake?: PickStake | null }) {
  const pickedLabel = choices.find((c) => c.outcome === prediction.selectedOutcome)?.label;

  return (
    <div className="space-y-1 rounded-lg border-2 border-text-primary bg-secondary p-4">
      <p className="text-sm font-semibold text-text-primary">You picked: {pickedLabel}</p>
      {stake && <CommittedConfidence amount={stake.amount} pending={prediction.lifecycleState === "PENDING"} />}
      <ResultLine prediction={prediction} />
      {stake && prediction.lifecycleState === "GRADED" && stake.result && (
        <p className="text-xs font-medium text-text-primary" data-slot="pick-confidence-result">
          {stake.result === "CORRECT"
            ? formatSignedConfidence(stake.amount)
            : stake.result === "INCORRECT"
              ? formatSignedConfidence(-stake.amount)
              : `${formatConfidence(stake.amount)} returned`}
        </p>
      )}
    </div>
  );
}

function ResultLine({ prediction }: { prediction: Prediction }) {
  if (prediction.lifecycleState === "PENDING") {
    // Milestone R5: this card is only ever shown for a locked-or-graded
    // Pick now (MarketPredictionCard routes a still-editable Pick to the
    // interactive PredictionActions instead) — a PENDING Pick reaching
    // here is therefore always locked, never merely "not yet resolved."
    if (prediction.lockedAt !== null) {
      return <p className="text-xs font-medium text-text-muted">Picks are locked for this game. Waiting for result.</p>;
    }
    return <p className="text-xs font-medium text-text-muted">Waiting for result</p>;
  }
  if (prediction.result === "CORRECT") {
    return <p className="text-xs font-medium text-text-primary">Result: Correct</p>;
  }
  if (prediction.result === "INCORRECT") {
    return <p className="text-xs font-medium text-text-primary">Result: Incorrect</p>;
  }
  // VOID: a cancelled game, a push, or a tied Moneyline. Said plainly, in the same register as Correct / Incorrect, and neither choice is marked right.
  return <p className="text-xs font-medium text-text-muted">Result: Void — this one didn&apos;t count</p>;
}
