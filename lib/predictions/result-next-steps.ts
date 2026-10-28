import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserPredictionRecord } from "@/lib/reputation/repository";
import { getLeaderboardConfig } from "@/lib/leaderboard/config";
import { getWeeklyLeaderboard } from "@/lib/leaderboard/repository";

// Brohda 2.1 M7 — what a Member sees when they come back to a Game whose result is in: their Record, where they stand this week (only while the weekly leaderboard is on), and a way to Pick another Game. Everything here is
// ALREADY stored (the Record and the weekly standing are derived at read time from the same rows as everywhere else); this only connects it to the moment someone looks at a result. Read on the result pages only, and
// only when the viewer has a graded Pick on that Market, so no other page pays for it. Fails soft: a failure shows the result without this block.

export interface ResultNextStepsData {
  record: { correct: number; incorrect: number };
  /** Null while the leaderboard is off, or for an account that is never ranked (staff). */
  weekly: { ranked: boolean; rank: number | null; decided: number; needed: number; minDecided: number } | null;
}

export async function loadResultNextSteps(userId: string, marketId: string): Promise<ResultNextStepsData | null> {
  const { count, error } = await createAdminClient().from("predictions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("market_id", marketId).eq("lifecycle_state", "GRADED").in("result", ["CORRECT", "INCORRECT", "VOID"]);
  if (error || !count) return null;
  try {
    const [record, config] = await Promise.all([getUserPredictionRecord(userId), getLeaderboardConfig()]);
    let weekly: ResultNextStepsData["weekly"] = null;
    if (config) {
      const board = await getWeeklyLeaderboard(userId).catch(() => null);
      const me = board?.viewer;
      if (board && me && me.eligible) weekly = { ranked: me.ranked, rank: me.rank, decided: me.decided, needed: me.needed, minDecided: board.minDecided };
    }
    return { record: { correct: record.correct, incorrect: record.incorrect }, weekly };
  } catch (e) {
    console.error("[result-next-steps] failed; showing the result without it:", e instanceof Error ? e.message : e);
    return null;
  }
}
