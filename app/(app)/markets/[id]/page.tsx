import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { MarketPredictionCard } from "@/components/predictions/MarketPredictionCard";
import { Card, CardContent } from "@/components/ui/card";

// Market detail (roadmap STEP 15; prediction submission added Milestone 3,
// roadmap STEP 17). A market that's INACTIVE/ARCHIVED, or genuinely doesn't
// exist, renders the same honest not-found state (roadmap STEP 18:
// "reachable... matching a nonexistent id").
//
// Rendering itself was extracted to MarketPredictionCard (Milestone R3,
// Post Foundation) so a Post detail page can reuse the exact same Pick
// interaction without duplicating it — this page's own behavior is
// unchanged. MarketPredictionCard itself no longer owns a Card wrapper
// (product feedback on the Post detail page's own multi-card layout), so
// this, its only other caller, provides one directly.

export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { id } = await params;

  const market = await getMarketDetail(id);
  if (!market) notFound();

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Market detail</h1>
      <Card>
        <CardContent className="pt-6">
          <MarketPredictionCard market={market} userId={user.id} />
        </CardContent>
      </Card>
    </div>
  );
}
