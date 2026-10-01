import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase F (Brohda 2.0 redesign, spec §28) — "avoid making /markets/[id]
// the primary social destination" for a Prediction history row. A
// Prediction only stores `market_id`; the canonical social destination is
// the Market's Game's Post, two joins away (market -> fixture -> post,
// posts.fixture_id is unique — at most one Post per Game). Batched: two
// queries total regardless of how many Predictions are being resolved,
// never one query per row.

/**
 * marketId -> its Game's published Post id, for every market id given.
 * A market id is simply absent from the returned Map if its fixture has
 * no Post, or that Post isn't published yet — callers fall back to
 * `/markets/[id]` only for exactly those, per spec §28's own "if
 * historical records cannot currently resolve Post cleanly" allowance.
 */
export async function listPostIdsForMarkets(marketIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (marketIds.length === 0) return result;

  const admin = createAdminClient();
  const { data: markets, error: marketsError } = await admin.from("markets").select("id, fixture_id").in("id", marketIds);
  if (marketsError) throw marketsError;
  if (!markets || markets.length === 0) return result;

  const fixtureIds = [...new Set(markets.map((m) => m.fixture_id as string))];
  const { data: posts, error: postsError } = await admin.from("posts").select("id, fixture_id").in("fixture_id", fixtureIds).not("published_at", "is", null);
  if (postsError) throw postsError;

  const postIdByFixtureId = new Map((posts ?? []).map((p) => [p.fixture_id as string, p.id as string]));
  for (const market of markets) {
    const postId = postIdByFixtureId.get(market.fixture_id as string);
    if (postId) result.set(market.id as string, postId);
  }
  return result;
}
