import { PredictionComposer } from "@/components/predictions/PredictionComposer";
import { TwoStepPickComposer } from "@/components/predictions/TwoStepPickComposer";
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
  // M7: someone who HAS picked must not be told to "make your pick" — say when the crowd appears instead (commit-before-crowd: once the Pick is final, locked or backed with Confidence).
  if (!isPublic && market.viewerSelection != null && !market.pickDisabledReason) {
    return (
      <p className="text-xs text-text-muted" data-slot="crowd-after-lock">
        Your pick is in. You&apos;ll see how everyone else picked once it locks or you add Confidence.
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
      ) : market.isEditable && market.twoStep ? (
        // Brohda 2.1: a team Pick on its own, then optional Confidence (which locks the team and fixes the amount). The database decides every deadline and lock.
        <TwoStepPickComposer
          marketId={market.id}
          choices={market.choices}
          offer={market.confidenceOffer}
          disabledReason={market.pickDisabledReason}
          lockAt={market.pickLockAt}
          initialSelection={market.viewerSelection}
          pickState={market.pickState ?? null}
          canChangeTeam={market.canChangeTeam ?? true}
          canAttachConfidence={market.canAttachConfidence ?? false}
          hideTitle={!showTitle}
          groupLabel={heading ?? undefined}
        />
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
          {market.lockSources?.includes("CALL_BS") && (
            <p className="text-xs text-text-muted" data-slot="locked-by-call-bs">
              Locked in a Call BS too.
            </p>
          )}
        </div>
      ) : (
        // A pick from before Confidence was part of every prediction that is already locked: kept as the record it is.
        <p className="text-sm font-medium text-text-muted" data-slot={market.pickState === "LOCKED_CALL_BS" ? "locked-by-call-bs" : undefined}>
          You picked {selectionLabel} — {market.pickState === "LOCKED_CALL_BS" ? "locked by an accepted Call BS." : market.pickDisabledReason}
        </p>
      )}

      <SentimentLine market={market} isPublic={isPublic} />
    </section>
  );
}
