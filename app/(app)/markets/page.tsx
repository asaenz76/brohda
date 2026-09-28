import { Sparkles } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getSocialFeed } from "@/lib/communities/feed";
import { GamePostCard } from "@/components/posts/GamePostCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";

/**
 * Phase C (Brohda 2.0 redesign, spec §23) update: /feed is now the
 * canonical Home timeline (app/(app)/feed/page.tsx) — this route is no
 * longer the only reachable Brohda 2.0 feed, and its content is
 * temporarily identical to Home's (same getSocialFeed()/GamePostCard).
 * This is intentional, not an oversight: the bottom nav's "Discovery" tab
 * still points here (spec §28 — "Discovery nav may continue using its
 * documented temporary route mapping until the next phase"; Discovery
 * itself, Sports/Leagues/Teams tabs into the Community graph, is a later
 * phase's build). Retiring this route now (e.g. redirecting it to /feed)
 * would collapse Home and Discovery into the same nav destination, which
 * is a worse interim state than the current harmless duplication — so
 * this phase's own "audit and redirect /markets -> /feed if safe" note is
 * resolved as NOT safe yet, specifically for that reason. Revisit once
 * real Discovery ships and can take over this nav slot's actual
 * destination.
 *
 * Milestone 2's own Market-only browse engine (getDiscoveryFeed,
 * discovery_categories, the admin category/sort-rule CRUD) remains
 * untouched and dormant — it predates the canonical Post/Community/
 * Comments model and was never wired to a reachable consumer page; not
 * this route's data source either, before or after this change.
 */
export default async function MarketsPage() {
  const user = await requireSocialPredictionAccess();
  const feed = await getSocialFeed(user.id);

  return (
    <div className="space-y-[18px] sm:space-y-[22px]">
      <h1 className="sr-only">Discover</h1>

      {feed.length === 0 ? (
        <EmptyFeedState icon={Sparkles} title="No games right now" description="Check back soon for new games and predictions." />
      ) : (
        <div className="space-y-3">
          {feed.map((item) => (
            <GamePostCard key={item.post.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
