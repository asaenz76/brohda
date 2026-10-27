import { Compass } from "lucide-react";
import Link from "next/link";
import { listUserPredictionsPage } from "@/lib/predictions/repository";
import type { Prediction } from "@/lib/predictions/types";
import { listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";
import { getChoicePresentation, getMarketSubject, type SelectionLabelSource } from "@/lib/prediction-markets/selection-labels";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Card, CardContent } from "@/components/ui/card";
import { getConfidenceConfig } from "@/lib/confidence/config";
import { getStakesForPredictions, type PublicStake } from "@/lib/confidence/stakes";
import { confidenceLabel, formatConfidence, formatSignedConfidence } from "@/lib/confidence/format";

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
/** M5: a page of history, never the whole of it (20 a page, "Older"/"Newer" links). The record above is derived from the full history in the database; this list is only the browsable part. */
export const PREDICTIONS_PAGE_SIZE = 20;

export async function PredictionsHistory({ userId, gradedOnly = false, page = 1, basePath }: { userId: string; gradedOnly?: boolean; page?: number; basePath?: string }) {
  const pageNumber = Number.isInteger(page) && page >= 1 ? page : 1;
  const { rows: predictions, hasMore } = await listUserPredictionsPage(userId, { limit: PREDICTIONS_PAGE_SIZE, offset: (pageNumber - 1) * PREDICTIONS_PAGE_SIZE, gradedOnly });

  if (predictions.length === 0) {
    return <EmptyFeedState icon={Compass} title={pageNumber > 1 ? "No more predictions." : "No predictions yet."} description={pageNumber > 1 ? "That was the oldest one." : "Real Picks on real games will show up here."} />;
  }

  const marketIds = [...new Set(predictions.map((p) => p.marketId))];
  // Conviction beside a Pick that is ALREADY visible here (your own Picks, or someone's graded Picks on their public profile — `predictions` above is already filtered to exactly that). Hidden while Confidence is off.
  const confidenceOn = (await getConfidenceConfig()) !== null;
  const [sourcesByMarketId, postIdsByMarketId, stakesByPredictionId] = await Promise.all([
    listChoiceSourcesByMarketIds(marketIds),
    listPostIdsForMarkets(marketIds),
    confidenceOn ? getStakesForPredictions(predictions.map((p) => p.id)) : Promise.resolve(new Map<string, PublicStake>()),
  ]);

  return (
    <div className="space-y-3">
      {predictions.map((prediction) => (
        <PredictionHistoryRow
          key={prediction.id}
          prediction={prediction}
          choiceSource={sourcesByMarketId.get(prediction.marketId) ?? null}
          postId={postIdsByMarketId.get(prediction.marketId) ?? null}
          stake={stakesByPredictionId.get(prediction.id) ?? null}
        />
      ))}
      {basePath && (pageNumber > 1 || hasMore) && (
        <nav aria-label="Predictions pages" className="flex items-center justify-between text-sm" data-slot="predictions-pager">
          {pageNumber > 1 ? <Link href={pageNumber === 2 ? basePath : `${basePath}?page=${pageNumber - 1}`} className="font-medium text-accent-primary hover:underline">Newer</Link> : <span />}
          <span className="text-xs text-text-muted">Page {pageNumber}</span>
          {hasMore ? <Link href={`${basePath}?page=${pageNumber + 1}`} className="font-medium text-accent-primary hover:underline">Older</Link> : <span />}
        </nav>
      )}
    </div>
  );
}

function PredictionHistoryRow({
  prediction,
  choiceSource,
  postId,
  stake,
}: {
  prediction: Prediction;
  /** Confidence committed behind this Pick, if any. */
  stake: PublicStake | null;
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
        {stake && (
          <p className="text-xs font-medium text-text-primary" data-slot="pick-conviction" aria-label={confidenceLabel(stake.amount)}>
            <span aria-hidden="true">
              {formatConfidence(stake.amount)}
              {prediction.lifecycleState === "GRADED" && stake.result
                ? ` · ${stake.result === "CORRECT" ? formatSignedConfidence(stake.amount) : stake.result === "INCORRECT" ? formatSignedConfidence(-stake.amount) : "returned"}`
                : ""}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Restrained, factual result language (spec §13) — never gamified, never color-only. */
function ResultBadge({ prediction }: { prediction: Prediction }) {
  if (prediction.lifecycleState === "PENDING") {
    return <p className="text-xs font-medium text-text-muted">Pending</p>;
  }
  if (prediction.result === "CORRECT") return <p className="text-xs font-medium text-text-primary">Correct</p>;
  if (prediction.result === "INCORRECT") return <p className="text-xs font-medium text-text-primary">Incorrect</p>;
  if (prediction.result === "VOID") return <p className="text-xs font-medium text-text-muted">Void</p>;
  return <p className="text-xs font-medium text-text-muted">Pending</p>;
}
