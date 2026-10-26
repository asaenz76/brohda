import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { listDisplayableMarketsForFixture } from "@/lib/prediction-markets/repository";
import { getPostConversation } from "@/lib/post-comments/repository";
import { getCommunityRefsForPost } from "@/lib/communities/feed";
import { getUserPredictionRecords } from "@/lib/reputation/repository";
import type { UserIdentityReputation } from "@/components/identity/UserIdentity";
import { GameMarketSentimentSection } from "@/components/posts/GameMarketSentiment";
import { GameStorySection } from "@/components/game-stories/GameStorySection";
import { getApprovedStoryForFixture } from "@/lib/game-stories/repository";
import { GamePreviewSection } from "@/components/posts/GamePreviewSection";
import { MarketParticipants } from "@/components/predictions/MarketParticipants";
import { getGameMarketSentiment } from "@/lib/posts/game-sentiment";
import { getPickLockPolicy, getPredictionPolicy } from "@/lib/predictions/policy";
import { marketsOfAllowedTemplates } from "@/lib/prediction-markets/market-policy-parse";
import { arePredictionsClosed } from "@/lib/predictions/lock";
import { getGamePreviewForFixture } from "@/lib/game-previews/repository";
import { PostConversation } from "@/components/posts/PostConversation";
import { PostCommunityBadges } from "@/components/communities/PostCommunityBadges";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { MatchupHeading } from "@/components/posts/MatchupHeading";
import { orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import { LeagueCrest } from "@/components/LeagueCrest";
import { SponsoredLabel } from "@/components/sponsorship/SponsoredLabel";
import { SponsorPromotion } from "@/components/sponsorship/SponsorPromotion";
import { loadPublicSponsorshipForPost } from "@/lib/sponsorship/public";
import { resolveLeagueIdentity } from "@/lib/sports-data/league-crest";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Post detail — the canonical social destination for a Game, and its Game Preview. The split is deliberate: the FEED is where a prediction is made (every Market, Confidence, the committed state); the POST is the Game
 * Preview and the conversation. So this page carries information the feed does not: the Game (read live from `fixtures`, never duplicated sports truth), how the crowd picked on each Market (commit-before-crowd, one
 * labelled block per Market), the saved Game Preview (a hook and a short factual story, written ahead of time — nothing is researched or generated when a Member opens the Post), the one shared conversation, and the
 * Other Picks / Call BS context. It does not repeat the prediction interface: no Pick buttons, no Confidence control, no "more markets" links.
 * An unpublished or nonexistent Post renders the honest not-found state, matching the Market detail page's own convention.
 */
export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { id } = await params;

  const post = await getPublishedPostById(id);
  if (!post) notFound();

  const fixture = await getFixtureForPostPresentation(post.fixtureId);
  if (!fixture) notFound();
  const league = resolveLeagueIdentity({ competitionName: fixture.competitionName, competitionLogoUrl: fixture.competitionLogoUrl });

  const [allMarkets, policy, conversation, communities, sponsorship, preview, story, lockPolicy, predictionPolicy] = await Promise.all([
    listDisplayableMarketsForFixture(post.fixtureId),
    getPostPublicationPolicy(),
    getPostConversation(post.id, undefined, user.id),
    getCommunityRefsForPost(post.id),
    loadPublicSponsorshipForPost(post.id),
    getGamePreviewForFixture(post.fixtureId),
    getApprovedStoryForFixture(post.fixtureId),
    getPickLockPolicy(),
    getPredictionPolicy(),
  ]);
  // M2: only the templates Members are currently offered are shown on the Game; hidden Markets stay in history (profile, Call BS history), never as a secondary block here.
  const activeMarkets = marketsOfAllowedTemplates(allMarkets, predictionPolicy.allowedTemplates);
  const primaryMarket = selectPrimaryMarket(activeMarkets, policy.primaryMarketTemplatePriority);
  // One batched read for every Market of the Game (the viewer's predictions, the aggregates of those they have finished, their Confidence): the sentiment blocks, in the configured template order.
  const sentiment = await getGameMarketSentiment({
    userId: user.id,
    sport: fixture.sport,
    homeTeamName: fixture.homeTeamName,
    awayTeamName: fixture.awayTeamName,
    markets: activeMarkets,
    templatePriority: policy.primaryMarketTemplatePriority,
    // After the canonical deadline every Market's aggregate may be shown (it can no longer influence a prediction); before it, only Markets the viewer has finished.
    predictionsClosed: arePredictionsClosed(fixture, lockPolicy.lockMinutesBeforeKickoff, new Date()),
  });
  // Other Picks / Call BS ride on the primary Market and need to know whether the viewer has a Pick on it (unchanged from before).
  const viewerHasPick = primaryMarket ? sentiment.find((m) => m.marketId === primaryMarket.id)?.hasViewerPick === true : false;

  // Phase G — every commenter's canonical reputation, batched in one query
  // regardless of thread size (lib/reputation/repository.ts's
  // getUserPredictionRecords), never one getUserPredictionRecord() call
  // per comment (spec §31-32).
  const commenterIds = [...new Set(conversation.flatMap((c) => [c.author.id, ...c.replies.map((r) => r.author.id)]))];
  const reputationMap = await getUserPredictionRecords(commenterIds);
  const reputationByUserId: Record<string, UserIdentityReputation> = Object.fromEntries(reputationMap);

  return (
    <div className="space-y-3">
      <ColumnHeader title="Post" backHref="/feed" />

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              <span className="sr-only">Game published by Brohda. </span>
              <LeagueCrest league={league} />
            </p>
            <p className="flex flex-wrap items-center gap-1.5 text-xl font-semibold text-text-primary">
              <MatchupHeading
                sport={fixture.sport}
                homeTeamName={fixture.homeTeamName}
                awayTeamName={fixture.awayTeamName}
                homeTeamLogoUrl={fixture.homeTeamLogoUrl}
                awayTeamLogoUrl={fixture.awayTeamLogoUrl}
              />
            </p>
            <p className="text-sm text-text-secondary">
              <LocalDateTime iso={fixture.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            </p>
            {fixture.internalStatus === "COMPLETED" && fixture.homeScore != null && fixture.awayScore != null && (
              <p className="text-sm font-medium text-text-primary">
                {(() => {
                  const [first, second] = orderTeamsForDisplay(fixture.sport, { name: fixture.homeTeamName, score: fixture.homeScore }, { name: fixture.awayTeamName, score: fixture.awayScore });
                  return `Final: ${first.name} ${first.score} — ${second.name} ${second.score}`;
                })()}
              </p>
            )}
            {fixture.internalStatus === "CANCELLED" && <p className="text-sm font-medium text-text-primary">This game was cancelled.</p>}
            {sponsorship && <SponsoredLabel sponsorship={sponsorship} trackImpression />}
            <PostCommunityBadges communities={communities} />
          </div>

          {sentiment.length > 0 && (
            <div className="border-t border-border-subtle pt-4">
              <GameMarketSentimentSection markets={sentiment} />
            </div>
          )}

          {story ? (
            <div className="border-t border-border-subtle pt-4">
              <GameStorySection story={story} />
            </div>
          ) : (
            preview && (
              <div className="border-t border-border-subtle pt-4">
                <GamePreviewSection preview={preview} />
              </div>
            )
          )}

          {sponsorship?.promotion && (
            <div className="border-t border-border-subtle pt-4">
              <SponsorPromotion promotion={sponsorship.promotion} />
            </div>
          )}

          <div className="border-t border-border-subtle pt-4">
            <PostConversation
              postId={post.id}
              viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
              initialComments={conversation}
              reputationByUserId={reputationByUserId}
            />
          </div>

          {primaryMarket && (
            <div className="border-t border-border-subtle pt-4">
              <MarketParticipants marketId={primaryMarket.id} viewerId={user.id} viewerHasPick={viewerHasPick} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
