import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";

/**
 * What a market-scoped notification needs about its Market: the question
 * for the body copy, and the Game's published Post (when one exists) so the
 * notification can be stamped with post_id and land on the Post.
 * lib/notifications/links.ts reads the stamped post_id/market_id — no
 * per-row lookup at read time.
 */
export async function getMarketNotificationContext(marketId: string): Promise<{ question: string; postId: string | null }> {
  const admin = createAdminClient();
  const [{ data }, postIdByMarketId] = await Promise.all([
    admin.from("markets").select("question").eq("id", marketId).maybeSingle(),
    listPostIdsForMarkets([marketId]),
  ]);
  return { question: data?.question ?? "a market", postId: postIdByMarketId.get(marketId) ?? null };
}
