import { Compass } from "lucide-react";
import { listUserPredictions } from "@/lib/predictions/repository";
import { getPredictionStats } from "@/lib/predictions/streak";
import { listPriceOutcomeLabelsByMarketIds, type MarketRecord } from "@/lib/prediction-markets/repository";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";

// Milestone 3's Prediction history surface (roadmap STEP 16). Deliberately
// a SEPARATE tab/component from the legacy predictions-tab.tsx (which
// shows legacy pool entries, also user-facing-labeled "Predictions" in
// ProfileTabs) — the two domains must stay explicit and unmixed (roadmap
// STEP 25: "do not cross-write... keep code/domain boundaries explicit").
// Self-history only in this milestone; showing another user's Market
// Predictions is deferred (roadmap STEP 15) — see
// docs/architecture/prediction-layer.md.
//
// Milestone 3 final standing-rule remediation, Finding 2: only the
// factual correct/incorrect counts are shown here — no streak number.
// Streak semantics were deferred to roadmap Milestone 8; see
// lib/predictions/streak.ts's own comment for why.

export async function MarketPredictionsTab({ userId }: { userId: string }) {
  const [predictions, stats] = await Promise.all([listUserPredictions(userId), getPredictionStats(userId)]);
  const labelsByMarketId = await listPriceOutcomeLabelsByMarketIds([...new Set(predictions.map((p) => p.marketId))]);

  if (predictions.length === 0) {
    return (
      <EmptyFeedState
        icon={Compass}
        title="No market predictions yet"
        description="Browse real markets and make your first prediction."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        {stats.correctCount} correct · {stats.incorrectCount} incorrect
      </p>

      <div className="space-y-3">
        {predictions.map((prediction) => (
          <PredictionHistoryRow key={prediction.id} prediction={prediction} priceOutcomeLabels={labelsByMarketId.get(prediction.marketId) ?? null} />
        ))}
      </div>
    </div>
  );
}

function PredictionHistoryRow({
  prediction,
  priceOutcomeLabels,
}: {
  prediction: Awaited<ReturnType<typeof listUserPredictions>>[number];
  /** Stage 4A remediation (§16 — "You predicted YES" raw-enum leakage): the referenced Market's semantic labels, or null if the Market's own row is no longer resolvable (falls back to a plain "Yes"/"No" via getSelectionLabel). */
  priceOutcomeLabels: MarketRecord["priceOutcomeLabels"] | undefined;
}) {
  const predictedPercent = Math.round(
    (prediction.selectedOutcome === "YES" ? prediction.yesProbabilitySnapshot : prediction.noProbabilitySnapshot) * 100,
  );
  const predictedAt = new Date(prediction.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const pickedLabel = getSelectionLabel({ priceOutcomeLabels: priceOutcomeLabels ?? null }, prediction.selectedOutcome);

  return (
    <Card>
      <CardContent className="space-y-1 pt-4">
        <Link href={`/markets/${prediction.marketId}`} className="text-sm font-semibold text-text-primary hover:underline">
          {prediction.marketQuestionSnapshot}
        </Link>
        <p className="text-xs text-text-muted">
          You picked {pickedLabel} ({predictedPercent}%) · {predictedAt}
        </p>
        <ResultBadge prediction={prediction} />
      </CardContent>
    </Card>
  );
}

function ResultBadge({ prediction }: { prediction: Awaited<ReturnType<typeof listUserPredictions>>[number] }) {
  if (prediction.lifecycleState === "PENDING") {
    return <p className="text-xs font-medium text-text-muted">Waiting for result</p>;
  }
  if (prediction.result === "CORRECT") return <p className="text-xs font-medium text-text-primary">Correct</p>;
  if (prediction.result === "INCORRECT") return <p className="text-xs font-medium text-text-primary">Incorrect</p>;
  return <p className="text-xs font-medium text-text-muted">No result</p>;
}
