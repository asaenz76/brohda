import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { listActiveMarketsForFixture } from "@/lib/prediction-markets/repository";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { getPostConversation } from "@/lib/post-comments/repository";
import { MarketPredictionCard } from "@/components/predictions/MarketPredictionCard";
import { PostConversation } from "@/components/posts/PostConversation";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import Link from "next/link";

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
 * Market state and Pick locking. No Community badges, no Challenge
 * controls, no monetary controls — those belong to later milestones
 * (R4/R7/R9).
 */
export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const post = await getPublishedPostById(id);
  if (!post) notFound();

  const fixture = await getFixtureForPostPresentation(post.fixtureId);
  if (!fixture) notFound();

  const [activeMarkets, policy, conversation] = await Promise.all([
    listActiveMarketsForFixture(post.fixtureId),
    getPostPublicationPolicy(),
    getPostConversation(post.id),
  ]);
  const primaryMarket = selectPrimaryMarket(activeMarkets, policy.primaryMarketTemplatePriority);
  const primaryMarketDetail = primaryMarket ? await getMarketDetail(primaryMarket.id) : null;
  const otherMarkets = activeMarkets.filter((m) => m.id !== primaryMarket?.id);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Post detail</h1>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <p className="text-xl font-semibold text-text-primary">
            {fixture.awayTeamName} @ {fixture.homeTeamName}
          </p>
          {fixture.competitionName && <p className="text-sm text-text-secondary">{fixture.competitionName}</p>}
          <p className="text-sm text-text-secondary">
            <LocalDateTime iso={fixture.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          </p>
          {fixture.internalStatus === "COMPLETED" && fixture.homeScore != null && fixture.awayScore != null && (
            <p className="text-sm font-medium text-text-primary">
              Final: {fixture.awayTeamName} {fixture.awayScore} — {fixture.homeTeamName} {fixture.homeScore}
            </p>
          )}
          {fixture.internalStatus === "CANCELLED" && <p className="text-sm font-medium text-text-primary">This game was cancelled.</p>}
        </CardContent>
      </Card>

      {primaryMarketDetail ? (
        <MarketPredictionCard market={primaryMarketDetail} userId={user.id} />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-secondary">No markets are available for this game yet.</p>
          </CardContent>
        </Card>
      )}

      {otherMarkets.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-6">
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <PostConversation
            postId={post.id}
            viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
            initialComments={conversation}
          />
        </CardContent>
      </Card>
    </div>
  );
}
