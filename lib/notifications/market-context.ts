import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";
import { listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { getMarketSubject } from "@/lib/prediction-markets/selection-labels";

/**
 * What a market-scoped notification needs about its Market: a human subject
 * for the body copy ("Washington Commanders @ Indianapolis Colts · Moneyline",
 * from the shared presentation — the original question only when the Market
 * can't be described that way), and the Game's published Post (when one
 * exists) so the notification can be stamped with post_id and land on the
 * Post. lib/notifications/links.ts reads the stamped post_id/market_id — no
 * per-row lookup at read time.
 */
export async function getMarketNotificationContext(marketId: string): Promise<{ subject: string; postId: string | null }> {
  const admin = createAdminClient();
  const [{ data }, postIdByMarketId, sources] = await Promise.all([
    admin.from("markets").select("question").eq("id", marketId).maybeSingle(),
    listPostIdsForMarkets([marketId]),
    listChoiceSourcesByMarketIds([marketId]),
  ]);
  return { subject: getMarketSubject(sources.get(marketId) ?? {}, data?.question), postId: postIdByMarketId.get(marketId) ?? null };
}
