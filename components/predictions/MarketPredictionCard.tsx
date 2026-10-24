import { getMarketById } from "@/lib/prediction-markets/repository";
import { formatClosesAt } from "@/lib/prediction-markets/discovery/format";
import type { DiscoveryMarketDetail } from "@/lib/prediction-markets/discovery/types";
import { DiscoveryStatusPill } from "@/components/discovery/DiscoveryStatusPill";
import { getLatestUserPredictionForMarket } from "@/lib/predictions/repository";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { copyForIneligible } from "@/lib/predictions/copy";
import { PredictionComposer } from "@/components/predictions/PredictionComposer";
import { TwoStepPickComposer } from "@/components/predictions/TwoStepPickComposer";
import { derivePickState } from "@/lib/predictions/pick-state";
import { YourPredictionCard } from "@/components/predictions/YourPredictionCard";
import { MarketParticipants } from "@/components/predictions/MarketParticipants";
import { getStakeUiState } from "@/lib/confidence/stakes";
import { getConfidenceOffer } from "@/lib/confidence/offer";
import { getMarketPickLock } from "@/lib/predictions/lock-state";

/**
 * Milestone R3 (Post Foundation): extracted from
 * app/(app)/markets/[id]/page.tsx's own body so a Post detail page can
 * present a Market's full Pick interaction without duplicating logic.
 *
 * Milestone R5 (Pick Editing + Locking) extended the branch below: an
 * existing Pick that is still editable (not locked, not graded) now
 * renders the SAME interactive PredictionActions control — pre-filled
 * with its current selection — instead of the old always-readonly
 * YourPredictionCard. Game-level eligibility (the T-10 cutoff, Game
 * status, lock state) is decided authoritatively server-side inside
 * set_pick() itself on every submit — this component only pre-computes
 * Market-level eligibility (price/freshness/status) for the disabled-state
 * copy, exactly as it already did pre-R5.
 *
 * Deliberately does NOT own its own Card wrapper — a caller with a single
 * Market as its whole page (markets/[id]) wraps this in one; the Post
 * detail page instead composes this content into one Card alongside the
 * Game header and comments, rather than stacking several separately-
 * bordered Cards (product feedback: the Post detail page should read as
 * one coherent Post, not four boxes).
 */
export async function MarketPredictionCard({
  market,
  userId,
  includeParticipants = true,
  matchup = null,
}: {
  market: DiscoveryMarketDetail;
  userId: string;
  /** "Away @ Home" — shown above the Market label when this card is a page on its own (the Market page); the Post detail page already carries the Game header. */
  matchup?: string | null;
  /** Post detail renders the participants (Call BS / money) itself, after the conversation. */
  includeParticipants?: boolean;
}) {
  // Phase C (Brohda 2.0 redesign): market.yesPercent/noPercent are real
  // Brohda Pick-share sentiment now, not provider odds — see
  // getMarketDetail()'s own comment (lib/prediction-markets/discovery/repository.ts).
  // "hasPicks", not "hasPrice": null here means zero Picks exist yet.
  const hasPicks = market.yesPercent != null || market.noPercent != null;
  const closesLabel = formatClosesAt(market.closesAt);

  const existingPrediction = await getLatestUserPredictionForMarket(userId, market.id);
  const legacyEditable = existingPrediction === null || (existingPrediction.lockedAt === null && existingPrediction.lifecycleState === "PENDING");

  // Confidence behind the viewer's OWN Pick (optional): the card shows the committed amount, or — while the Pick is still open to it — the "How confident are you?" control. Nothing at all while Confidence is off.
  const [stakeState, confidenceOffer] = await Promise.all([existingPrediction ? getStakeUiState(userId, existingPrediction.id) : Promise.resolve({ state: "none" } as const), getConfidenceOffer(userId)]);
  // Brohda 2.1 (M1): with optional Picks and the two-step UI flag on, the Pick is derived once (lib/predictions/pick-state.ts) and the card stays interactive while the team can still change OR Confidence can still be added.
  const twoStep = confidenceOffer?.twoStep === true;
  const earlyLock = twoStep ? await getMarketPickLock(market.id) : null;
  const pickState = twoStep
    ? derivePickState({
        prediction: existingPrediction ? { lifecycleState: existingPrediction.lifecycleState, result: existingPrediction.result, lockedAt: existingPrediction.lockedAt, lockReason: existingPrediction.lockReason } : null,
        staked: stakeState.state === "staked",
        acceptedCallBs: existingPrediction?.lockReason === "CHALLENGE_ACCEPTED",
        windowOpen: !earlyLock!.closed,
      })
    : null;
  const isEditable = twoStep ? existingPrediction === null || pickState!.canChangeTeam || pickState!.canAttachConfidence : legacyEditable;

  let predictionDisabledReason: string | null = null;
  let pickLockAt: string | null = null;
  if (isEditable) {
    // The pre-kickoff lock, shown the moment it passes (the Market stays ACTIVE until the provider reports the Game live, which is after kickoff).
    const lock = await getMarketPickLock(market.id);
    pickLockAt = lock.lockAt;
    // Re-reads the raw (unrounded) market record — the same source of
    // truth the submit action itself checks — so this pre-submission
    // disabled state never disagrees with what the action would actually
    // decide from the view model's already-rounded percentages.
    const [rawMarket, predictionPolicy] = await Promise.all([getMarketById(market.id), getPredictionPolicy()]);
    const eligibility = checkMarketEligibility(
      {
        consumerStatus: market.status,
        // M2: a direct visit to a Market of a template Members are no longer offered (an old SPREAD/TOTAL link) renders read-only: the record stays, new interaction does not.
        marketTemplate: rawMarket?.marketTemplate ?? "",
        freshness: market.freshness,
        yesPrice: rawMarket?.yesPrice ?? null,
        noPrice: rawMarket?.noPrice ?? null,
        closesAt: market.closesAt,
        now: new Date(),
      },
      predictionPolicy,
    );
    predictionDisabledReason = eligibility.eligible ? null : copyForIneligible(eligibility.reason);
    if (predictionDisabledReason === null && lock.closed) predictionDisabledReason = "Picks are locked for this game.";
  }

  return (
    <div className="space-y-4">
      {market.categories.length > 0 && (
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {market.categories.map((c) => c.displayName).join(" · ")}
        </p>
      )}

      {matchup && <p className="text-xl font-semibold text-text-primary">{matchup}</p>}
      {/* The Market is named by its compact label ("Moneyline", "Spread", "Total 47.5"); only a Market without a template-aware label keeps its original question as context. */}
      <p className={matchup ? "text-sm font-medium text-text-secondary" : "text-lg font-semibold text-text-primary"}>{market.marketLabel ?? market.question}</p>

      <DiscoveryStatusPill status={market.status} />

      {market.status === "RESOLVED" && market.resolvedOutcome && (
        <p className="text-sm font-medium text-text-primary">{market.resolvedOutcome === "YES" ? market.yesLabel : market.noLabel}</p>
      )}

      {existingPrediction === null || (twoStep ? pickState!.state === "UNSTAKED_EDITABLE" : isEditable) ? (
        <p className="text-xs text-text-muted">Make your pick to see how everyone else picked.</p>
      ) : hasPicks ? (
        <div className="space-y-1">
          <div className="flex items-start gap-8">
            {/* Sentiment sits against the visible sides, in the same order as the choices: the canonical YES/NO percentages, relabelled — nothing re-aggregated. */}
            {market.choices.map((choice) => (
              <div key={choice.outcome} className="min-w-0">
                <p className="text-3xl font-bold text-text-primary">{choice.outcome === "YES" ? market.yesPercent : market.noPercent}%</p>
                <p className="break-words text-xs font-medium uppercase tracking-wide text-text-muted">{choice.label}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-muted">{market.totalPickCount} predicted</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">No one has predicted yet.</p>
      )}

      {market.description && <p className="text-sm text-text-secondary">{market.description}</p>}

      {closesLabel && <p className="text-sm text-text-secondary">Closes {closesLabel}</p>}

      {isEditable && twoStep ? (
        <TwoStepPickComposer
          marketId={market.id}
          choices={market.choices}
          offer={confidenceOffer}
          disabledReason={predictionDisabledReason}
          lockAt={pickLockAt}
          initialSelection={existingPrediction?.selectedOutcome ?? null}
          pickState={pickState!.state}
          canChangeTeam={pickState!.canChangeTeam}
          canAttachConfidence={pickState!.canAttachConfidence}
        />
      ) : isEditable ? (
        <PredictionComposer
          marketId={market.id}
          choices={market.choices}
          offer={confidenceOffer}
          disabledReason={predictionDisabledReason}
          lockAt={pickLockAt}
          initialSelection={existingPrediction?.selectedOutcome ?? null}
          legacyOpenPick={existingPrediction !== null}
        />
      ) : (
        <YourPredictionCard
          prediction={existingPrediction!}
          choices={market.choices}
          stake={stakeState.state === "staked" ? { amount: stakeState.amount, result: stakeState.result } : null}
        />
      )}

      {includeParticipants && (
        <MarketParticipants marketId={market.id} viewerId={userId} viewerHasPick={Boolean(existingPrediction)} />
      )}
    </div>
  );
}
