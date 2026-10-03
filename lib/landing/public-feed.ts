import "server-only";
import { getSocialFeed, type FeedItem } from "@/lib/communities/feed";
import { getSocialPredictionAccessPolicy } from "@/lib/social/access";

/**
 * How many Game Posts the logged-out front door shows. A presentation size
 * (one screen-and-a-bit of timeline), not product policy — the feed's own
 * eligibility and ordering rules decide WHICH Posts qualify.
 */
export const PUBLIC_FEED_LIMIT = 10;

/**
 * The Game Posts a logged-out visitor sees on `/`: the exact same canonical
 * social feed a member sees on Home (same eligibility — only Games that
 * haven't kicked off — same deterministic ordering, same batched enrichment
 * of Market/sentiment/comment counts), asked for with no viewer. It is
 * deliberately NOT a second feed engine.
 *
 * Privacy: `anon` can read none of these tables directly (no RLS policy, no
 * grant), so this is a server-side read through the service role with the
 * feed's own explicit field selection. What reaches the page is limited to
 * what the feed already computes: platform-published Game Posts, their
 * fixture/team/competition fields, aggregate Pick sentiment and a comment
 * COUNT. No commenter identity, no comment text, no per-user Pick and no
 * profile data is read here, because none of that is public today (Post
 * detail and Profiles both sit behind login).
 *
 * Fails closed with the same switch the rest of the social product uses: if
 * the social product is off, the front door shows no Games rather than a
 * door onto pages members themselves can't open.
 *
 * `limit` exists so tests that assert on a specific seeded Game can look past
 * whatever else a shared database holds; the page always uses the default.
 */
export async function getPublicFrontDoorFeed(limit: number = PUBLIC_FEED_LIMIT): Promise<FeedItem[]> {
  const { enabled } = await getSocialPredictionAccessPolicy();
  if (!enabled) return [];
  return getSocialFeed(null, limit);
}
