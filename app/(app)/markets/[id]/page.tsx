import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { getMarketById, listFixtureTeamNames } from "@/lib/prediction-markets/repository";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { MarketPredictionCard } from "@/components/predictions/MarketPredictionCard";
import { Card, CardContent } from "@/components/ui/card";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { getPostByFixtureId } from "@/lib/posts/repository";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { resolveLeagueIdentity } from "@/lib/sports-data/league-crest";
import { LeagueCrest } from "@/components/LeagueCrest";

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

  // Back = where you came from (real history). With no in-app previous page (a shared link, a reload) it falls back to this Market's own Game Post, and only to the feed when the Game has no published Post.
  const post = raw ? await getPostByFixtureId(raw.fixtureId) : null;
  const backHref = post?.publishedAt ? `/post/${post.id}` : "/feed";

  // The league identity belongs to the Game, so every Market of one Game shows the same crest.
  const fixture = raw ? await getFixtureForPostPresentation(raw.fixtureId) : null;
  const league = fixture ? resolveLeagueIdentity({ competitionName: fixture.competitionName, competitionLogoUrl: fixture.competitionLogoUrl }) : null;

  return (
    <div className="space-y-3">
      <ColumnHeader title="Market" backHref={backHref} />
      <Card>
        <CardContent className="space-y-3 pt-6">
          {league && (league.name || league.crestUrl) && (
            <p className="text-xs text-text-muted">
              <span className="sr-only">Game published by Brohda. </span>
              <LeagueCrest league={league} />
            </p>
          )}
          <MarketPredictionCard market={market} userId={user.id} matchup={matchup} />
        </CardContent>
      </Card>
    </div>
  );
}
