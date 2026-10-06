import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Wraps close_finished_markets(): a Market whose Game is terminal (COMPLETED or CANCELLED) and whose Picks are all graded moves
 * ACTIVE -> CLOSED, the existing terminal state. Never reopens, never uses ARCHIVED (grading treats ARCHIVED as VOID), never touches
 * INACTIVE, results, Picks, challenges or money; idempotent. Returns the ids closed by THIS call.
 */
export async function closeFinishedMarkets(limit = 200): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("close_finished_markets", { p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as string[]).map(String);
}
