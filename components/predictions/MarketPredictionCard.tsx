import { getMarketById } from "@/lib/prediction-markets/repository";
import { formatClosesAt } from "@/lib/prediction-markets/discovery/format";
import type { DiscoveryMarketDetail } from "@/lib/prediction-markets/discovery/types";
import { DiscoveryStatusPill, FreshnessNote } from "@/components/discovery/DiscoveryStatusPill";
import { Card, CardContent } from "@/components/ui/card";
import { getLatestUserPredictionForMarket } from "@/lib/predictions/repository";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { copyForIneligible } from "@/lib/predictions/copy";
import { PredictionActions } from "@/components/predictions/PredictionActions";
import { YourPredictionCard } from "@/components/predictions/YourPredictionCard";
import { MarketParticipants } from "@/components/predictions/MarketParticipants";

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
 */
export async function MarketPredictionCard({ market, userId }: { market: DiscoveryMarketDetail; userId: string }) {
  const hasPrice = market.yesPercent != null || market.noPercent != null;
  const closesLabel = formatClosesAt(market.closesAt);

  const existingPrediction = await getLatestUserPredictionForMarket(userId, market.id);
  const isEditable = existingPrediction === null || (existingPrediction.lockedAt === null && existingPrediction.lifecycleState === "PENDING");

  let predictionDisabledReason: string | null = null;
  if (isEditable) {
    // Re-reads the raw (unrounded) market record — the same source of
    // truth the submit action itself checks — so this pre-submission
    // disabled state never disagrees with what the action would actually
    // decide from the view model's already-rounded percentages.
    const [rawMarket, predictionPolicy] = await Promise.all([getMarketById(market.id), getPredictionPolicy()]);
    const eligibility = checkMarketEligibility(
      {
        consumerStatus: market.status,
        freshness: market.freshness,
        yesPrice: rawMarket?.yesPrice ?? null,
        noPrice: rawMarket?.noPrice ?? null,
        closesAt: market.closesAt,
        now: new Date(),
      },
      predictionPolicy,
    );
    predictionDisabledReason = eligibility.eligible ? null : copyForIneligible(eligibility.reason);
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {market.categories.length > 0 && (
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            {market.categories.map((c) => c.displayName).join(" · ")}
          </p>
        )}

        <p className="text-xl font-semibold text-text-primary">{market.question}</p>

        <DiscoveryStatusPill status={market.status} />

        {market.status === "RESOLVED" && market.resolvedOutcome && (
          <p className="text-sm font-medium text-text-primary">Result: {market.resolvedOutcome}</p>
        )}

        {hasPrice ? (
          <div className="flex items-center gap-8">
            <div>
              <p className="text-3xl font-bold text-text-primary">{market.yesPercent}%</p>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Yes</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-text-primary">{market.noPercent}%</p>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">No</p>
            </div>
          </div>
        ) : (
          // Freshness is definitionally UNAVAILABLE whenever there's no
          // usable price — the FreshnessNote below is skipped in this
          // branch so its own UNAVAILABLE copy never renders twice.
          <FreshnessNote freshness="UNAVAILABLE" />
        )}

        {hasPrice && <FreshnessNote freshness={market.freshness} />}

        {market.description && <p className="text-sm text-text-secondary">{market.description}</p>}

        {closesLabel && <p className="text-sm text-text-secondary">Closes {closesLabel}</p>}

        {isEditable ? (
          <PredictionActions marketId={market.id} disabledReason={predictionDisabledReason} currentSelection={existingPrediction?.selectedOutcome ?? null} />
        ) : (
          <YourPredictionCard prediction={existingPrediction!} />
        )}

        {existingPrediction && <MarketParticipants marketId={market.id} viewerId={userId} />}
      </CardContent>
    </Card>
  );
}
