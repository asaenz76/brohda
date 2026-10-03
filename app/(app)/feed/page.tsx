import { Sparkles, TrendingUp } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getSocialFeed } from "@/lib/communities/feed";
import { listCommunitiesByType } from "@/lib/communities/discovery";
import { DISCOVERY_EMPTY_COPY, DISCOVERY_TAB_TYPE, parseDiscoveryTab } from "@/lib/communities/discovery-tabs";
import { getSocialPredictionAccessPolicy } from "@/lib/social/access";
import { GamePostCard } from "@/components/posts/GamePostCard";
import { DiscoveryTabNav } from "@/components/discovery/DiscoveryTabNav";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Phase C (Brohda 2.0 redesign) — /feed is now the canonical Home
 * timeline: a social timeline of canonical Game Posts, reusing the exact
 * same engine (getSocialFeed, lib/communities/feed.ts) and card
 * (GamePostCard) as /markets ("Discovery" 's current temporary content —
 * see that page's own comment for why the two aren't yet different).
 * Zero-follow behavior, followed-Community prioritization, and canonical
 * one-Post-per-Post deduplication are all inherited unchanged from that
 * existing engine, not rebuilt here (spec §7 — "audit before writing a
 * replacement... do not create a second social feed engine").
 *
 * This route previously rendered Brohda V1's Pools feed (open pools,
 * sport/league filters, tiered entries, a Stories row of Pool-entry
 * activity). All of that is retired from Home per spec §5-6 — Pool test
 * data required no consumer-facing preservation (André's own product
 * clarification), and the legacy implementation is fully superseded here,
 * not layered underneath. Pool backend/schema/jobs/admin tooling are
 * untouched — this is consumer removal only.
 *
 * Deliberately `requireUser()`, NOT `requireSocialPredictionAccess()`:
 * that guard redirects an ineligible user to /feed when
 * social_prediction_enabled is off (lib/social/access.ts) — a safe
 * fallback back when /feed was still Pools content. Now that /feed IS
 * the Brohda 2.0 Home with no non-Brohda-2.0 fallback left to redirect
 * to, calling that guard from this exact page would self-redirect
 * forever the moment the flag is ever false. Every OTHER Brohda 2.0
 * route (/markets, /post/[id], /community/[slug], ...) keeps using
 * requireSocialPredictionAccess() unchanged — their fallback destination
 * (this page) still exists and is still correct.
 */
export default async function FeedPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { tab: tabParam } = await searchParams;

  // The same header and tab bar the logged-out front door shows: "Upcoming games" over Sports | Leagues | Teams.
  // Sports is the Game Post timeline; Leagues and Teams are Discovery's own Community lists (with follow controls,
  // since there is a viewer). Like the Discovery page itself, the Community tabs only exist while the social
  // product is on — otherwise this is just the timeline.
  const showTabs = isAdminOrAbove(user) || (await getSocialPredictionAccessPolicy()).enabled;
  const tab = showTabs ? parseDiscoveryTab(tabParam) : "sports";

  const [feed, communities] = await Promise.all([
    tab === "sports" ? getSocialFeed(user.id) : Promise.resolve([]),
    tab === "sports" ? Promise.resolve([]) : listCommunitiesByType(DISCOVERY_TAB_TYPE[tab], user.id),
  ]);

  return (
    <div className="space-y-3">
      <ColumnHeader title="Upcoming games" icon={TrendingUp}>
        {showTabs && <DiscoveryTabNav active={tab} basePath="/feed" />}
      </ColumnHeader>

      {tab === "sports" ? (
        feed.length === 0 ? (
          <EmptyFeedState icon={Sparkles} title="Nothing happening right now" description="New games show up here as soon as they're on the board." />
        ) : (
          feed.map((item) => <GamePostCard key={item.post.id} item={item} />)
        )
      ) : communities.length === 0 ? (
        <EmptyFeedState icon={Sparkles} title={DISCOVERY_EMPTY_COPY[tab]} description="Check back soon — this grows as Brohda covers more games." />
      ) : (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {communities.map((item) => (
            <DiscoveryRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
