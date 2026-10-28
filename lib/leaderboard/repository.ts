import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseWeeklyLeaderboard } from "./format";
import type { WeeklyLeaderboard } from "./types";

// Brohda 2.1 M6 — the one read path for the weekly leaderboard: ONE read-only database function on the service role (nothing is written, nothing is cached, no per-row lookups), so the cost is the same
// number of queries however many Members play. Who may see it is the page's job (signed in, and only while the capability is on).

export async function getWeeklyLeaderboard(viewerId: string | null, client: Pick<ReturnType<typeof createAdminClient>, "rpc"> = createAdminClient()): Promise<WeeklyLeaderboard | null> {
  const { data, error } = await client.rpc("get_weekly_leaderboard", { p_viewer_id: viewerId });
  if (error) throw error;
  return parseWeeklyLeaderboard(data);
}
