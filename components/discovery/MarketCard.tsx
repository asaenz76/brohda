import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { DiscoveryStatusPill, FreshnessNote } from "./DiscoveryStatusPill";
import { formatClosesAt } from "@/lib/prediction-markets/discovery/format";
import type { DiscoveryMarketCard } from "@/lib/prediction-markets/discovery/types";

// The prediction-market discovery card (roadmap STEP 10). Deliberately
// minimal — question, YES/NO, minimal context, close time, freshness. No
// amount input, no trade action, no wallet/position information, and none
// of "Buy/Sell/Trade/Shares/Contracts/Order/Position" in its copy —
// discovery only.

export function MarketCard({ market }: { market: DiscoveryMarketCard }) {
  const closesLabel = formatClosesAt(market.closesAt);
  const hasPrice = market.yesPercent != null || market.noPercent != null;

  return (
    <Link href={`/markets/${market.id}`} className="block">
      <Card className="transition-colors hover:border-accent-primary/50">
        <CardContent className="space-y-3 pt-6">
          {market.categories.length > 0 && (
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {market.categories.map((c) => c.displayName).join(" · ")}
            </p>
          )}

          <p className="text-base font-semibold text-text-primary">{market.question}</p>

          <DiscoveryStatusPill status={market.status} />

          {hasPrice ? (
            <div className="flex items-center gap-6">
              <div>
                <p className="text-2xl font-bold text-text-primary sm:text-3xl">{market.yesPercent}%</p>
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{market.yesLabel}</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-text-primary sm:text-3xl">{market.noPercent}%</p>
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{market.noLabel}</p>
              </div>
            </div>
          ) : (
            // Freshness is definitionally UNAVAILABLE whenever there's no
            // usable price (see classifyFreshness) — FreshnessNote below is
            // skipped in this branch specifically so its own UNAVAILABLE
            // copy never renders a second time alongside this one.
            <FreshnessNote freshness="UNAVAILABLE" />
          )}

          <div className="flex items-center justify-between">
            {closesLabel ? <p className="text-xs text-text-secondary">Closes {closesLabel}</p> : <span />}
            {hasPrice && <FreshnessNote freshness={market.freshness} />}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
