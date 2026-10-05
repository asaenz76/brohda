import { notFound } from "next/navigation";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { listActiveMarketsForFixture } from "@/lib/prediction-markets/repository";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { getPostConversation } from "@/lib/post-comments/repository";
import { getCommunityRefsForPost } from "@/lib/communities/feed";
import { getUserPredictionRecords } from "@/lib/reputation/repository";
import type { UserIdentityReputation } from "@/components/identity/UserIdentity";
import { MarketPredictionCard } from "@/components/predictions/MarketPredictionCard";
import { MarketParticipants } from "@/components/predictions/MarketParticipants";
import { getLatestUserPredictionForMarket } from "@/lib/predictions/repository";
import { PostConversation } from "@/components/posts/PostConversation";
import { PostCommunityBadges } from "@/components/communities/PostCommunityBadges";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { TeamCrest } from "@/components/TeamCrest";
import Link from "next/link";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Post detail (Milestone R3, docs/BROHDA_2_0_MILESTONE_MAP.md, Post
 * Foundation) — the canonical social destination for a Game. Presents the
 * Game itself (never duplicated sports truth — read live from `fixtures`
 * on every request), the Game's current primary Market with full Pick
 * interaction (reusing MarketPredictionCard unchanged from the Market
 * detail page — Picks remain Market-scoped, not Post-scoped), and links to
 * any other currently-active Markets for the same Game. An unpublished or
 * nonexistent Post renders the same honest not-found state, matching the
 * Market detail page's own convention.
 *
 * Comments (Milestone R6, Post Conversation) render below the Markets —
 * the one canonical, shared conversation for this Post, independent of
 * Market state and Pick locking. Community badges were added in Stage 4A
 * (R13.10 remediation of the Stage 4 audit's §11 finding) — no Challenge
 * controls, no monetary controls, still deferred to later milestones
 * (R7/R9).
 *
 * Product feedback: a single Post used to render as four separately-
 * bordered Cards (Game header, primary Market, other Markets, comments) —
 * visually reading as unrelated boxes rather than one Post. All of that
 * content is now one Card, with a plain `border-t` between sections
 * (the same divider convention CardFooter already uses) instead of a
 * second outer border per section.
 */
export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { id } = await params;

  const post = await getPublishedPostById(id);
  if (!post) notFound();

  const fixture = await getFixtureForPostPresentation(post.fixtureId);
  if (!fixture) notFound();

  const [activeMarkets, policy, conversation, communities] = await Promise.all([
    listActiveMarketsForFixture(post.fixtureId),
    getPostPublicationPolicy(),
    getPostConversation(post.id),
    getCommunityRefsForPost(post.id),
  ]);
  const primaryMarket = selectPrimaryMarket(activeMarkets, policy.primaryMarketTemplatePriority);
  const primaryMarketDetail = primaryMarket ? await getMarketDetail(primaryMarket.id) : null;
  const otherMarkets = activeMarkets.filter((m) => m.id !== primaryMarket?.id);
  // Call BS and the optional money action sit under the conversation (the Post reads Game -> Pick -> conversation -> challenges),
  // so the participants block is rendered here rather than inside MarketPredictionCard; it needs to know whether the viewer has a Pick.
  const viewerPrediction = primaryMarketDetail ? await getLatestUserPredictionForMarket(user.id, primaryMarketDetail.id) : null;

  // Phase G — every commenter's canonical reputation, batched in one query
  // regardless of thread size (lib/reputation/repository.ts's
  // getUserPredictionRecords), never one getUserPredictionRecord() call
  // per comment (spec §31-32).
  const commenterIds = [...new Set(conversation.flatMap((c) => [c.author.id, ...c.replies.map((r) => r.author.id)]))];
  const reputationMap = await getUserPredictionRecords(commenterIds);
  const reputationByUserId: Record<string, UserIdentityReputation> = Object.fromEntries(reputationMap);

  return (
    <div className="space-y-3">
      <ColumnHeader title="Post" backHref="/feed" backLabel="Back to Home" />

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              <span className="sr-only">Game published by </span>
              <span className="font-medium text-text-secondary">Brohda</span>
              {fixture.competitionName && ` · ${fixture.competitionName}`}
            </p>
            <p className="flex flex-wrap items-center gap-1.5 text-xl font-semibold text-text-primary">
              <TeamCrest logoUrl={fixture.awayTeamLogoUrl} teamName={fixture.awayTeamName} />
              {fixture.awayTeamName} @ <TeamCrest logoUrl={fixture.homeTeamLogoUrl} teamName={fixture.homeTeamName} />
              {fixture.homeTeamName}
            </p>
            <p className="text-sm text-text-secondary">
              <LocalDateTime iso={fixture.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            </p>
            {fixture.internalStatus === "COMPLETED" && fixture.homeScore != null && fixture.awayScore != null && (
              <p className="text-sm font-medium text-text-primary">
                Final: {fixture.awayTeamName} {fixture.awayScore} — {fixture.homeTeamName} {fixture.homeScore}
              </p>
            )}
            {fixture.internalStatus === "CANCELLED" && <p className="text-sm font-medium text-text-primary">This game was cancelled.</p>}
            <PostCommunityBadges communities={communities} />
          </div>

          <div className="border-t border-border-subtle pt-4">
            {primaryMarketDetail ? (
              <MarketPredictionCard market={primaryMarketDetail} userId={user.id} includeParticipants={false} />
            ) : (
              <p className="text-sm text-text-secondary">No markets are available for this game yet.</p>
            )}
          </div>

          {otherMarkets.length > 0 && (
            <div className="space-y-2 border-t border-border-subtle pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">More markets for this game</p>
              <ul className="space-y-1">
                {otherMarkets.map((m) => (
                  <li key={m.id}>
                    <Link href={`/markets/${m.id}`} className="text-sm text-text-primary underline">
                      {m.question}
                    </Link>
                  </li>
                ))}
              </ul>
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

          {primaryMarketDetail && (
            <div className="border-t border-border-subtle pt-4">
              <MarketParticipants
                marketId={primaryMarketDetail.id}
                viewerId={user.id}
                yesLabel={primaryMarketDetail.yesLabel}
                noLabel={primaryMarketDetail.noLabel}
                viewerHasPick={Boolean(viewerPrediction)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
