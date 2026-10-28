import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { listDisplayableMarketsForFixture } from "@/lib/prediction-markets/repository";
import { getPostConversation } from "@/lib/post-comments/repository";
import { getCommunityRefsForPost, getFeedItemForPost, type FeedItem } from "@/lib/communities/feed";
import { parsePickIntent } from "@/lib/auth/pick-intent";
import { FeedMarketPick } from "@/components/posts/FeedMarketPick";
import { PickIntentConfirm } from "@/components/posts/PickIntentConfirm";
import { loadResultNextSteps } from "@/lib/predictions/result-next-steps";
import { ResultNextSteps } from "@/components/predictions/ResultNextSteps";
import { getUserPredictionRecords } from "@/lib/reputation/repository";
import type { UserIdentityReputation } from "@/components/identity/UserIdentity";
import { GameMarketSentimentSection } from "@/components/posts/GameMarketSentiment";
import { GamePreviewSection } from "@/components/posts/GamePreviewSection";
import { MarketParticipants } from "@/components/predictions/MarketParticipants";
import { getGameMarketSentiment } from "@/lib/posts/game-sentiment";
import { getPickLockPolicy, getPredictionPolicy } from "@/lib/predictions/policy";
import { marketsOfAllowedTemplates } from "@/lib/prediction-markets/market-policy-parse";
import { arePredictionsClosed, isPastEffectiveLock } from "@/lib/predictions/lock";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { loadPostSocial, toConversationSocial, type PostSocial } from "@/lib/challenges/post-social";
import { loadGameCallBsStatus, type GameCallBsStatus } from "@/lib/challenges/game-status";
import { visibleCommenterIds } from "@/lib/post-comments/commenters";
import { CallBsStatusCard } from "@/components/posts/CallBsStatusCard";
import { getGamePreviewForFixture } from "@/lib/game-previews/repository";
import { PostConversation } from "@/components/posts/PostConversation";
import { PostCommunityBadges } from "@/components/communities/PostCommunityBadges";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { MatchupHeading } from "@/components/posts/MatchupHeading";
import { GameContextLine } from "@/components/posts/GameContextLine";
import { getGameContexts } from "@/lib/game-context/repository";
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
 * Other Picks / Call BS context. M7: it ALSO carries the Game's Pick control (the very same component the feed card uses), so someone who arrives at a Game — a shared link, a notification, or back from sign-up with
 * "?pick=" — can make their Pick right here instead of hunting for the Game in the feed. No "more markets" links.
 * An unpublished or nonexistent Post renders the honest not-found state, matching the Market detail page's own convention.
 */
export default async function PostDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ pick?: string | string[] }> }) {
  const user = await requireSocialPredictionAccess();
  const { id } = await params;
  const pickIntent = parsePickIntent((await searchParams).pick);

  const post = await getPublishedPostById(id);
  if (!post) notFound();

  const fixture = await getFixtureForPostPresentation(post.fixtureId);
  if (!fixture) notFound();
  const league = resolveLeagueIdentity({ competitionName: fixture.competitionName, competitionLogoUrl: fixture.competitionLogoUrl });

  const [allMarkets, policy, conversation, communities, sponsorship, preview, lockPolicy, predictionPolicy, gameContexts, feedItem] = await Promise.all([
    listDisplayableMarketsForFixture(post.fixtureId),
    getPostPublicationPolicy(),
    getPostConversation(post.id, undefined, user.id),
    getCommunityRefsForPost(post.id),
    loadPublicSponsorshipForPost(post.id),
    getGamePreviewForFixture(post.fixtureId),
    getPickLockPolicy(),
    getPredictionPolicy(),
    // Same function, same answer as the feed card. Never throws: any failure is "no context".
    getGameContexts([post.fixtureId]),
    // M7: the Game as a feed card sees it, for the Pick control below. Fails soft: without it the Post renders exactly as before.
    getFeedItemForPost(post.id, user.id).catch((error): FeedItem | null => {
      console.error("[post-pick] could not load the Pick control; showing the Post without it:", error instanceof Error ? error.message : error);
      return null;
    }),
  ]);
  const gameContext = gameContexts.get(post.fixtureId) ?? null;
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

  // M4: the Game's social loop. Everything below is read-only presentation of stored picks and Call BS (never a new rule), and it fails soft: if either read fails the Post still renders, without the side badges /
  // the "Your Call BS" block, and the failure is logged.
  const pastCutoff = isPastEffectiveLock(fixture.scheduledStartUtc, lockPolicy.lockMinutesBeforeKickoff, new Date());
  // M7: a Game with a result for this viewer also connects it to their Record, the week and the next Pick (nothing beyond one head count is read unless their Pick on the primary Market is graded).
  const [social, callBsStatus, resultNextSteps] = await Promise.all([
    primaryMarket && viewerHasPick
      ? loadPostSocial({
          marketId: primaryMarket.id,
          viewerId: user.id,
          scheduledStartUtc: fixture.scheduledStartUtc,
          lockMinutesBeforeKickoff: lockPolicy.lockMinutesBeforeKickoff,
          // The same shared presentation the sentiment block and every other surface use.
          labelFor: (outcome) => getSelectionLabel({ ...primaryMarket, homeTeamName: fixture.homeTeamName, awayTeamName: fixture.awayTeamName, sport: fixture.sport }, outcome),
        }).catch((error): PostSocial | null => {
          console.error("[post-social] failed; showing the Post without side badges:", error instanceof Error ? error.message : error);
          return null;
        })
      : Promise.resolve<PostSocial | null>(null),
    loadGameCallBsStatus({ viewerId: user.id, marketIds: allMarkets.map((m) => m.id), pastCutoff }).catch((error): GameCallBsStatus => {
      console.error("[game-call-bs-status] failed; showing the Post without it:", error instanceof Error ? error.message : error);
      return { items: [], more: 0 };
    }),
    primaryMarket ? loadResultNextSteps(user.id, primaryMarket.id) : Promise.resolve(null),
  ]);

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
            {gameContext && <GameContextLine text={gameContext.text} />}
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

          {feedItem?.primaryMarket && (() => {
            const market = feedItem.primaryMarket;
            const chosen = pickIntent ? market.choices.find((c) => c.outcome === pickIntent) : undefined;
            // The hint only ever asks a question, and only when a Pick is still possible: no Pick yet, and the Market open.
            const askToConfirm = Boolean(chosen) && market.viewerSelection == null && market.isEditable && market.pickDisabledReason === null;
            return (
              <div className="space-y-3 border-t border-border-subtle pt-4" data-slot="post-pick">
                {askToConfirm && chosen && <PickIntentConfirm marketId={market.id} outcome={chosen.outcome as "YES" | "NO"} label={chosen.label} postId={post.id} />}
                {/* Keyed by whether the confirmation is showing: when the Member confirms, the hint leaves the address and this control is built again from the server's state (the Pick now exists), instead of keeping the empty state it was first built with. */}
                <FeedMarketPick key={askToConfirm ? "confirming" : "plain"} market={market} isPublic={false} postId={post.id} />
              </div>
            );
          })()}

          {resultNextSteps && (
            <div className="border-t border-border-subtle pt-4">
              <ResultNextSteps data={resultNextSteps} />
            </div>
          )}

          {callBsStatus.items.length > 0 && (
            <div className="border-t border-border-subtle pt-4">
              <CallBsStatusCard status={callBsStatus} />
            </div>
          )}

          {sentiment.length > 0 && (
            <div className="border-t border-border-subtle pt-4">
              <GameMarketSentimentSection markets={sentiment} />
            </div>
          )}

          {preview && (
            <div className="border-t border-border-subtle pt-4">
              <GamePreviewSection preview={preview} />
            </div>
          )}

          {sponsorship?.promotion && (
            <div className="border-t border-border-subtle pt-4">
              <SponsorPromotion promotion={sponsorship.promotion} />
            </div>
          )}

          <div id="conversation" className="scroll-mt-16 border-t border-border-subtle pt-4">
            <PostConversation
              postId={post.id}
              viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
              initialComments={conversation}
              reputationByUserId={reputationByUserId}
              social={social ? toConversationSocial(social) : null}
              gameOver={fixture.internalStatus === "COMPLETED" || fixture.internalStatus === "CANCELLED"}
            />
          </div>

          {primaryMarket && (
            <div className="border-t border-border-subtle pt-4">
              <MarketParticipants
                marketId={primaryMarket.id}
                viewerId={user.id}
                viewerHasPick={viewerHasPick}
                social={social}
                conversationUserIds={social ? visibleCommenterIds(conversation) : undefined}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
