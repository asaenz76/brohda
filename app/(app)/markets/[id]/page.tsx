import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { formatClosesAt } from "@/lib/prediction-markets/discovery/format";
import { DiscoveryStatusPill, FreshnessNote } from "@/components/discovery/DiscoveryStatusPill";
import { Card, CardContent } from "@/components/ui/card";

// Market detail (roadmap STEP 15) — read-only. No prediction submission
// exists on this page. A market that's INACTIVE/ARCHIVED, or genuinely
// doesn't exist, renders the same honest not-found state (roadmap STEP 18:
// "reachable... matching a nonexistent id").

export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;

  const market = await getMarketDetail(id);
  if (!market) notFound();

  const hasPrice = market.yesPercent != null || market.noPercent != null;
  const closesLabel = formatClosesAt(market.closesAt);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Market detail</h1>

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
        </CardContent>
      </Card>
    </div>
  );
}
