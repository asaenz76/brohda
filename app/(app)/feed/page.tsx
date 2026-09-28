import { Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getSocialFeed } from "@/lib/communities/feed";
import { GamePostCard } from "@/components/posts/GamePostCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";

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
export default async function FeedPage() {
  const user = await requireUser();
  const feed = await getSocialFeed(user.id);

  return (
    <div className="space-y-3">
      <h1 className="sr-only">Home</h1>

      {feed.length === 0 ? (
        <EmptyFeedState icon={Sparkles} title="Nothing happening right now" description="New games show up here as soon as they're on the board." />
      ) : (
        feed.map((item) => <GamePostCard key={item.post.id} item={item} />)
      )}
    </div>
  );
}
