import { Sparkles } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getDiscoveryFeed, listEnabledCategories } from "@/lib/prediction-markets/discovery/repository";
import { MarketCard } from "@/components/discovery/MarketCard";
import { CategoryTabs } from "@/components/discovery/CategoryTabs";
import { EmptyFeedState } from "@/components/EmptyFeedState";

// Sports prediction question discovery surface
// (docs/architecture/sports-prediction-network.md). Read-only browse
// surface — no order, no wallet, no position, no financial exposure of any
// kind. Reads only Brohda's own normalized `markets` data
// (lib/prediction-markets/discovery/repository.ts) — never calls a
// third-party provider directly, never triggers ingestion from here. The
// legacy pool feed at /feed is untouched and remains the default
// player-facing surface; this is an additional, clearly-separate route.

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireSocialPredictionAccess();
  const { category: categorySlug } = await searchParams;

  const [categories, markets] = await Promise.all([listEnabledCategories(), getDiscoveryFeed(categorySlug)]);

  return (
    <div className="space-y-[18px] sm:space-y-[22px]">
      <h1 className="sr-only">Markets</h1>

      <CategoryTabs categories={categories} activeSlug={categorySlug ?? null} />

      {markets.length === 0 ? (
        <EmptyFeedState
          icon={Sparkles}
          title={categorySlug ? "Nothing here yet" : "No predictions right now"}
          description={
            categorySlug
              ? "There's nothing in this category at the moment — check back soon or browse All."
              : "Check back soon for new questions to think about."
          }
        />
      ) : (
        <div className="space-y-3">
          {markets.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </div>
  );
}
