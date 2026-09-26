import { Sparkles } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getSocialFeed } from "@/lib/communities/feed";
import { SocialFeedCard } from "@/components/discovery/SocialFeedCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";

/**
 * The canonical Brohda 2.0 social discovery surface (Stage 4A remediation
 * of the Stage 4 audit's P0 finding — an ordinary user previously had no
 * in-app way to reach a Post/Market/Community at all). Route/nav slot
 * (`/markets`, the "Discover" tab) unchanged from Milestone 2's own
 * discovery surface — already gated by requireSocialPredictionAccess()
 * and already hidden while social_prediction_enabled=false, so evolving
 * its content carries no legacy-breakage risk: this route has never been
 * reachable by an ordinary user in production. Milestone 2's own
 * Market-only browse engine (getDiscoveryFeed, discovery_categories, the
 * admin category/sort-rule CRUD) is untouched, just no longer this page's
 * data source — it predates the canonical Post/Community/Comments model
 * (bypasses Posts entirely, links to /markets/[id] rather than /post/[id])
 * and is superseded here, not deleted (still reachable at /markets/[id]
 * as a direct deep link, e.g. from a Post's "other Markets" list).
 *
 * The legacy money-pools feed at /feed is completely untouched and remains
 * the default entry point for any user this flag doesn't yet cover — no
 * collision, since this route only ever becomes reachable once
 * social_prediction_enabled=true for that specific user.
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
            <SocialFeedCard key={item.post.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
