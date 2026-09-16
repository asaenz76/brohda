import { Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDiscoveryFeed, listEnabledCategories } from "@/lib/prediction-markets/discovery/repository";
import { MarketCard } from "@/components/discovery/MarketCard";
import { CategoryTabs } from "@/components/discovery/CategoryTabs";
import { EmptyFeedState } from "@/components/EmptyFeedState";

// Prediction Market Discovery Experience (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
// Milestone 2). Read-only browse surface — no prediction submission, no
// order, no wallet, no position. Reads only Brohda's own normalized data
// (lib/prediction-markets/discovery/repository.ts) — never calls Polymarket
// directly, never triggers ingestion. The legacy pool feed at /feed is
// untouched and remains the default player-facing surface; this is an
// additional, clearly-separate route (roadmap STEP 17).

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireUser();
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
