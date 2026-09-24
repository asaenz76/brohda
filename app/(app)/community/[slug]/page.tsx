import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getCommunityBySlug } from "@/lib/communities/repository";
import { getCommunityDisplayName } from "@/lib/communities/presentation";
import { isFollowingCommunity } from "@/lib/communities/follows";
import { getCommunityFeed } from "@/lib/communities/feed";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { CommunityFollowButton } from "@/components/communities/CommunityFollowButton";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";

/**
 * Community detail (Milestone R4, docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Community + Distribution) — the minimum surface proving the domain
 * works: Community identity, follow/unfollow, and the canonical Posts
 * distributed to it. Every Post here links to its one canonical
 * `/post/[id]` — entering a Post through a Community never creates or
 * routes to a copy (§27).
 *
 * No Comments, no Community chat, no user-created Posts, no moderators —
 * this is affinity + distribution only (§26).
 */
export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { slug } = await params;

  const community = await getCommunityBySlug(slug);
  if (!community || !community.active) notFound();

  const [displayName, following, posts] = await Promise.all([
    getCommunityDisplayName(community),
    isFollowingCommunity(user.id, community.id),
    getCommunityFeed(community.id),
  ]);

  const fixtures = await Promise.all(posts.map((post) => getFixtureForPostPresentation(post.fixtureId)));

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Community detail</h1>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{community.type}</p>
          <p className="text-xl font-semibold text-text-primary">{displayName}</p>
          <CommunityFollowButton communityId={community.id} initiallyFollowing={following} />
        </CardContent>
      </Card>

      {posts.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-secondary">No games are posted to this community yet.</p>
          </CardContent>
        </Card>
      ) : (
        posts.map((post, i) => {
          const fixture = fixtures[i];
          return (
            <Link key={post.id} href={`/post/${post.id}`}>
              <Card className="transition hover:border-text-muted">
                <CardContent className="space-y-1 pt-6">
                  {fixture ? (
                    <>
                      <p className="text-base font-semibold text-text-primary">
                        {fixture.awayTeamName} @ {fixture.homeTeamName}
                      </p>
                      <p className="text-sm text-text-secondary">
                        <LocalDateTime iso={fixture.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-text-secondary">Game details unavailable.</p>
                  )}
                </CardContent>
              </Card>
            </Link>
          );
        })
      )}
    </div>
  );
}
