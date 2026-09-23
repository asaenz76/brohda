import type { Prediction } from "@/lib/predictions/types";

// Market detail's "you already predicted here" state (roadmap STEP 17).
// Never implies the user currently holds a financial position — this is a
// belief record, shown plainly. The page's own current YES/NO percentages
// render separately, just above this card, so "current" vs
// "prediction-time" stay visually distinct without this component
// repeating the current numbers itself (mirrors the FreshnessNote
// no-duplicated-copy precedent from Milestone 2).

export function YourPredictionCard({ prediction }: { prediction: Prediction }) {
  const predictedPercent = Math.round(
    (prediction.selectedOutcome === "YES" ? prediction.yesProbabilitySnapshot : prediction.noProbabilitySnapshot) * 100,
  );

  return (
    <div className="space-y-1 rounded-lg border-2 border-text-primary bg-secondary p-4">
      <p className="text-sm font-semibold text-text-primary">Your prediction: {prediction.selectedOutcome}</p>
      <p className="text-xs text-text-muted">You predicted at {predictedPercent}%.</p>
      <ResultLine prediction={prediction} />
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
  return <p className="text-xs font-medium text-text-muted">No result — this one didn&apos;t count</p>;
}
