import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { getMarketById, listFixtureTeamNames } from "@/lib/prediction-markets/repository";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { MarketPredictionCard } from "@/components/predictions/MarketPredictionCard";
import { Card, CardContent } from "@/components/ui/card";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

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
  // This page stands on its own, without a Game header, so it names the matchup itself (in the sport's own matchup order).
  const raw = await getMarketById(id);
  const teams = raw ? (await listFixtureTeamNames([raw.fixtureId])).get(raw.fixtureId) : undefined;
  const matchup = teams?.homeTeamName && teams?.awayTeamName ? formatMatchup(teams.sport ?? "", teams.homeTeamName, teams.awayTeamName) : null;

  return (
    <div className="space-y-3">
      <ColumnHeader title="Market" backHref="/feed" backLabel="Back to Home" />
      <Card>
        <CardContent className="pt-6">
          <MarketPredictionCard market={market} userId={user.id} matchup={matchup} />
        </CardContent>
      </Card>
    </div>
  );
}
