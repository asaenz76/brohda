import { Compass } from "lucide-react";
import Link from "next/link";
import { listUserPredictions } from "@/lib/predictions/repository";
import { listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";
import { getChoicePresentation, getMarketSubject, type SelectionLabelSource } from "@/lib/prediction-markets/selection-labels";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Phase F (Brohda 2.0 redesign) — Profile's "Predictions" surface,
 * renamed/reframed from market-predictions-tab.tsx's "Market Predictions"
 * (spec §11, §43: user-facing Profile language is "Predictions", never
 * "Market Predictions" — the internal domain object stays Market). Still
 * entirely the Brohda 2.0 `predictions` table, still deliberately
 * separate from the legacy Pool `entries` domain (now removed from
 * Profile altogether, spec §10) — reuses the exact same data layer
 * (listUserPredictions, no change there) and the same "no odds/stake/P&L,
 * factual correct/incorrect counts only" standing rule.
 *
 * New in Phase F: links to the canonical `/post/[id]` instead of
 * `/markets/[id]` wherever a Market's Game has a resolvable published Post
 * (spec §28 — "avoid making /markets/[id] the primary social
 * destination"), batched via lib/predictions/post-links.ts; falls back to
 * `/markets/[id]` only for the (expected to be rare) case where no Post
 * resolves. Also new: `gradedOnly`, for showing another user's Predictions
 * without leaking a still-open Pick — the exact same privacy posture the
 * legacy Pool tab already established for a visited profile (only settled
 * results, never an in-flight one), applied here for consistency rather
 * than invented fresh.
 */
export async function PredictionsHistory({ userId, gradedOnly = false }: { userId: string; gradedOnly?: boolean }) {
  const allPredictions = await listUserPredictions(userId);
  const predictions = gradedOnly ? allPredictions.filter((p) => p.lifecycleState === "GRADED") : allPredictions;

  if (predictions.length === 0) {
    return <EmptyFeedState icon={Compass} title="No predictions yet." description="Real Picks on real games will show up here." />;
  }

  const marketIds = [...new Set(predictions.map((p) => p.marketId))];
  const [sourcesByMarketId, postIdsByMarketId] = await Promise.all([
    listChoiceSourcesByMarketIds(marketIds),
    listPostIdsForMarkets(marketIds),
  ]);

  return (
    <div className="space-y-3">
      {predictions.map((prediction) => (
        <PredictionHistoryRow
          key={prediction.id}
          prediction={prediction}
          choiceSource={sourcesByMarketId.get(prediction.marketId) ?? null}
          postId={postIdsByMarketId.get(prediction.marketId) ?? null}
        />
      ))}
    </div>
  );
}

function PredictionHistoryRow({
  prediction,
  choiceSource,
  postId,
}: {
  prediction: Awaited<ReturnType<typeof listUserPredictions>>[number];
  /** What the shared presentation needs to name this Pick (template, line, side, teams), or null if the Market's own row is no longer resolvable — it then falls back to the labels it can still find, never to a guess. */
  choiceSource: SelectionLabelSource | null;
  postId: string | null;
}) {
  const predictedAt = new Date(prediction.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const presentation = getChoicePresentation(choiceSource ?? {});
  const pickedLabel = presentation.choices.find((c) => c.outcome === prediction.selectedOutcome)!.label;
  // A template-aware Market is named by its matchup and label ("Washington Commanders @ Indianapolis Colts · Moneyline"); the old
  // question snapshot is only the fallback for a Market the presentation can't describe.
  const title = getMarketSubject(choiceSource ?? {}, prediction.marketQuestionSnapshot);

  return (
    <Card>
      <CardContent className="space-y-1 pt-4">
        <Link href={postId ? `/post/${postId}` : `/markets/${prediction.marketId}`} className="text-sm font-semibold text-text-primary hover:underline">
          {title}
        </Link>
        <p className="text-xs text-text-muted">
          You picked {pickedLabel} · {predictedAt}
        </p>
        <ResultBadge prediction={prediction} />
      </CardContent>
    </Card>
  );
}

/** Restrained, factual result language (spec §13) — never gamified, never color-only. */
function ResultBadge({ prediction }: { prediction: Awaited<ReturnType<typeof listUserPredictions>>[number] }) {
  if (prediction.lifecycleState === "PENDING") {
    return <p className="text-xs font-medium text-text-muted">Pending</p>;
  }
  if (prediction.result === "CORRECT") return <p className="text-xs font-medium text-text-primary">Correct</p>;
  if (prediction.result === "INCORRECT") return <p className="text-xs font-medium text-text-primary">Incorrect</p>;
  if (prediction.result === "VOID") return <p className="text-xs font-medium text-text-muted">Void</p>;
  return <p className="text-xs font-medium text-text-muted">Pending</p>;
}
