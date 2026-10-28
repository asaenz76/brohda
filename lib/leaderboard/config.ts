import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeaderboardConfig } from "./types";

// The one place the weekly leaderboard's policy is read. It comes from platform_settings (migration 219) — nothing here is a constant — and the capability FAILS CLOSED: only a successfully read, literal
// `true` with valid numbers is ON; a missing row, a malformed value or an unreadable setting is OFF (no navigation entry, no page).

export function parseLeaderboardConfig(row: { leaderboard_enabled?: unknown; leaderboard_weekly_min_decided_picks?: unknown; leaderboard_top_n?: unknown } | null | undefined): LeaderboardConfig | null {
  if (!row || row.leaderboard_enabled !== true) return null;
  const min = row.leaderboard_weekly_min_decided_picks;
  const top = row.leaderboard_top_n;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > 50) return null;
  if (typeof top !== "number" || !Number.isInteger(top) || top < 3 || top > 100) return null;
  return { weeklyMinDecidedPicks: min, topN: top };
}

/** The policy, or null when the leaderboard is off or cannot be read. Cached for the request, so the shell and the page share one read. */
export const getLeaderboardConfig = cache(async (): Promise<LeaderboardConfig | null> => {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select("leaderboard_enabled, leaderboard_weekly_min_decided_picks, leaderboard_top_n").eq("id", true).single();
    if (error) return null;
    return parseLeaderboardConfig(data);
  } catch {
    return null;
  }
});

export async function isLeaderboardEnabled(): Promise<boolean> {
  return (await getLeaderboardConfig()) !== null;
}

/** The stored policy as the Super Admin card shows it — the raw values, whether or not the leaderboard is on (an unreadable row shows the safe defaults and "off"). */
export async function getLeaderboardPolicyForAdmin(): Promise<{ enabled: boolean; weeklyMinDecidedPicks: number; topN: number }> {
  const { data } = await createAdminClient().from("platform_settings").select("leaderboard_enabled, leaderboard_weekly_min_decided_picks, leaderboard_top_n").eq("id", true).maybeSingle();
  const min = data?.leaderboard_weekly_min_decided_picks;
  const top = data?.leaderboard_top_n;
  return {
    enabled: data?.leaderboard_enabled === true,
    weeklyMinDecidedPicks: typeof min === "number" && Number.isInteger(min) && min >= 1 && min <= 50 ? min : 5,
    topN: typeof top === "number" && Number.isInteger(top) && top >= 3 && top <= 100 ? top : 20,
  };
}
