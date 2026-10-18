import { PredictionComposer } from "@/components/predictions/PredictionComposer";
import { PublicPickChoices } from "@/components/posts/PublicPickChoices";
import { CommittedConfidence } from "@/components/confidence/CommittedConfidence";
import type { FeedMarketSummary } from "@/lib/communities/feed";

/**
 * Brohda's crowd sentiment, Pick-first: percentages for both visible sides and the predicted count appear only AFTER the viewer has made a Pick on THIS Market (and stay once it changes, locks or is graded). Logged-out
 * visitors can't pick, so they never see them. This is social sentiment, never a betting probability. Before a Pick, a single nudge says where it comes from.
 */
function SentimentLine({ market, isPublic }: { market: FeedMarketSummary; isPublic: boolean }) {
  if (!isPublic && market.sentimentRevealed) {
    return (
      <p className="text-xs text-text-muted" data-slot="market-sentiment">
        {market.choices.map((c) => `${c.label} ${c.outcome === "YES" ? market.yesPercent : market.noPercent}%`).join(" · ")} · {market.totalPickCount} predicted
      </p>
    );
  }
  // Nothing to nudge toward when picking isn't possible right now (locked / closed game).
  if (market.pickDisabledReason) return null;
  return <p className="text-xs text-text-muted">Make your pick to see how everyone else picked.</p>;
}

/**
 * ONE Market's whole interaction on a feed card — the Pick, its lock state, the optional Confidence control, the committed amount and the Market's own sentiment. The primary Market and every secondary Market render
 * through this same component, so a Market behaves identically wherever it appears; the only difference is whether it carries a heading (a Market shown among others is introduced by it) and the shared "Make your
 * prediction" title (shown once for the group, not before every Market).
 */
export function FeedMarketPick({ market, isPublic, postId, heading = null, showTitle = true }: { market: FeedMarketSummary; isPublic: boolean; postId: string; heading?: string | null; showTitle?: boolean }) {
  const headingId = heading ? `market-heading-${market.id}` : undefined;
  const selectionLabel = market.choices.find((c) => c.outcome === market.viewerSelection)?.label ?? "";
  return (
    <section aria-labelledby={headingId} data-slot="feed-market" data-market-id={market.id} className="space-y-2">
      {heading && (
        <h4 id={headingId} className="text-sm font-semibold text-text-primary" data-slot="market-heading">
          {heading}
        </h4>
      )}
      {isPublic ? (
        market.pickDisabledReason ? (
          <p className="text-sm font-medium text-text-muted">{market.pickDisabledReason}</p>
        ) : (
          <PublicPickChoices choices={market.choices} postId={postId} />
        )
      ) : market.isEditable ? (
        // The prediction composer: side (local) + Confidence (the commitment). An open Pick from before Confidence was part of every prediction comes in with its side pre-selected, to be completed.
        <PredictionComposer
          marketId={market.id}
          choices={market.choices}
          offer={market.confidenceOffer}
          disabledReason={market.pickDisabledReason}
          lockAt={market.pickLockAt}
          initialSelection={market.viewerSelection}
          legacyOpenPick={market.viewerPredictionId !== null}
          hideTitle={!showTitle}
          groupLabel={heading ?? undefined}
        />
      ) : market.confidence.state === "staked" ? (
        // A prediction: the side and the Confidence behind it, final.
        <div className="space-y-1">
          <p className="text-sm font-semibold text-text-primary">You picked {selectionLabel}</p>
          <CommittedConfidence amount={market.confidence.amount} pending={market.confidence.stakeState === "RESERVED"} />
        </div>
      ) : (
        // A pick from before Confidence was part of every prediction that is already locked: kept as the record it is.
        <p className="text-sm font-medium text-text-muted">
          You picked {selectionLabel} — {market.pickDisabledReason}
        </p>
      )}

      <SentimentLine market={market} isPublic={isPublic} />
    </section>
  );
}
