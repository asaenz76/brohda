import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { revalidatePath } from "next/cache";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";

/**
 * Refreshes the surfaces a Market-scoped social/money action changes: the
 * Market page and the Game's canonical Post (the primary social surface).
 * Exact paths only — no broad revalidation. A failed Post lookup is logged
 * and never fails the action the user just completed.
 */
export async function revalidateMarketSurfaces(marketId: string, extraPaths: string[] = []): Promise<void> {
  revalidatePath(`/markets/${marketId}`);
  for (const path of extraPaths) revalidatePath(path);
  try {
    const postId = (await listPostIdsForMarkets([marketId])).get(marketId);
    if (postId) revalidatePath(`/post/${postId}`);
  } catch (error) {
    console.error(`[revalidate] could not resolve the Post to revalidate for market ${marketId}:`, errorMessage(error));
  }
}
