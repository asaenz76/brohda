import { notFound } from "next/navigation";
import { Rss } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getCommunityBySlug } from "@/lib/communities/repository";
import { getCommunityIdentity, getCommunityTypeLabel } from "@/lib/communities/presentation";
import { isFollowingCommunity } from "@/lib/communities/follows";
import { getCommunityTimeline } from "@/lib/communities/feed";
import { CommunityFollowButton } from "@/components/communities/CommunityFollowButton";
import { Card, CardContent } from "@/components/ui/card";
import { TeamCrest } from "@/components/TeamCrest";
import { GamePostCard } from "@/components/posts/GamePostCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";

/**
 * Community detail (Phase E, Brohda 2.0 redesign) — the canonical
 * Community experience: a social topic/profile timeline (spec §0), not a
 * sports-data dashboard, market browser, team stats page, or directory.
 * Identity → Follow state → relevant Game Posts → conversation (spec §1) —
 * never stats/odds/markets/standings/money.
 *
 * Community remains affinity/distribution, never Post ownership (spec
 * §2): the timeline below reuses the exact same canonical Post/Market data
 * and GamePostCard presentation as Home, via getCommunityTimeline (spec
 * §27 — one shared enrichment core, not a second Community-specific Game
 * Post design). Every Post here still links to its one canonical
 * `/post/[id]` — entering a Post through a Community never creates or
 * routes to a copy.
 *
 * No follower count (spec §23 — omitted by default; no existing product
 * reason to add one) and no description (spec §24 — no such field/system
 * exists on `communities`; none invented). League context for a TEAM
 * Community, and Sport context for a LEAGUE Community, are also omitted at
 * the header level: `teams`/`leagues` carry no canonical relation to a
 * parent league/sport today (confirmed against the schema), so showing one
 * here would mean guessing from a fixture's own `competition_name` rather
 * than genuine identity data — the per-Post Community badges (league,
 * sport, opposing team) already surface that context where it IS canonical
 * (spec §13), so the header doesn't need to invent it.
 */
export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { slug } = await params;

  const community = await getCommunityBySlug(slug);
  if (!community || !community.active) notFound();

  const [identity, following, timeline] = await Promise.all([
    getCommunityIdentity(community),
    isFollowingCommunity(user.id, community.id),
    getCommunityTimeline(community.id, user.id),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Community</h1>

      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <div className="flex items-center gap-3">
            <TeamCrest logoUrl={identity.logoUrl} teamName={identity.displayName} className="size-10" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{getCommunityTypeLabel(community.type)}</p>
              <p className="text-xl font-semibold text-text-primary">{identity.displayName}</p>
            </div>
          </div>
          <CommunityFollowButton communityId={community.id} initiallyFollowing={following} />
        </CardContent>
      </Card>

      {timeline.length === 0 ? (
        <EmptyFeedState icon={Rss} title="Nothing happening here right now." description="Check back soon — this fills up as Brohda covers more games." />
      ) : (
        timeline.map((item) => <GamePostCard key={item.post.id} item={item} />)
      )}
    </div>
  );
}
