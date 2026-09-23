import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { UserPredictionRecord, UserCallBsRecord, LeaderboardEntry, LeaderboardPeriod } from "./types";

// Milestone R11 — the ONE canonical query/service layer for reputation
// (§59): Profile, Leaderboard, and any future Post/participant surface
// (§57-58) all funnel through this file rather than each independently
// recalculating the record. Uses the request-scoped, `authenticated`-role
// client (lib/supabase/server.ts) — NOT the admin client — mirroring
// exactly how the pre-existing, equivalent public-aggregate RPCs
// (get_profile_stats, get_leaderboard, get_pick_count) are already called
// directly from Server Components in this codebase: each of the three
// underlying SQL functions is itself `security definer` (deliberately
// bypassing `predictions`' own own-row-only RLS to expose only safe,
// already-Pick-public aggregate fields), and is granted to `authenticated`
// generally — any signed-in viewer may read anyone's reputation, exactly
// as broadly as a Pick or a RESOLVED Challenge is already itself visible
// as social content.

export async function getUserPredictionRecord(userId: string): Promise<UserPredictionRecord> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_user_prediction_record", { p_user_id: userId }).single();
  if (error) throw error;
  const row = data as {
    correct: number;
    incorrect: number;
    void: number;
    decided: number;
    accuracy: number | null;
    min_decided_for_leaderboard: number;
    eligible_for_leaderboard: boolean;
  };
  return {
    correct: row.correct,
    incorrect: row.incorrect,
    void: row.void,
    decided: row.decided,
    accuracy: row.accuracy === null ? null : Number(row.accuracy),
    minDecidedForLeaderboard: row.min_decided_for_leaderboard,
    eligibleForLeaderboard: row.eligible_for_leaderboard,
  };
}

export async function getUserCallBsRecord(userId: string): Promise<UserCallBsRecord> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_call_bs_record", { p_user_id: userId }).single();
  if (error) throw error;
  const row = data as { wins: number; losses: number; void: number };
  return { wins: row.wins, losses: row.losses, void: row.void };
}

export interface PredictionLeaderboardPage {
  entries: LeaderboardEntry[];
  totalEligible: number;
}

/**
 * The ranked, paginated, period-scoped leaderboard (§9-14, §29-33).
 * Plain LIMIT/OFFSET, not a keyset cursor — this codebase has no
 * established cursor-pagination convention anywhere (confirmed by direct
 * audit: every existing "paginated" RPC in this codebase is plain
 * LIMIT/order, never a `p_cursor`/`p_after` parameter), so introducing one
 * here would be inventing a new pattern rather than following an existing
 * one. LIMIT/OFFSET is bounded, deterministic, and sufficient for a
 * leaderboard's realistic page-through depth.
 */
export async function getPredictionLeaderboard(period: LeaderboardPeriod, limit = 50, offset = 0): Promise<PredictionLeaderboardPage> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_prediction_leaderboard", { p_period: period, p_limit: limit, p_offset: offset });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    user_id: string;
    display_name: string;
    username: string | null;
    avatar_url: string | null;
    correct: number;
    incorrect: number;
    void: number;
    decided: number;
    accuracy: number;
    rank: number;
    total_eligible: number;
  }>;
  return {
    entries: rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      username: row.username,
      avatarUrl: row.avatar_url,
      correct: row.correct,
      incorrect: row.incorrect,
      void: row.void,
      decided: row.decided,
      accuracy: Number(row.accuracy),
      rank: Number(row.rank),
      totalEligible: Number(row.total_eligible),
    })),
    totalEligible: rows.length > 0 ? Number(rows[0].total_eligible) : 0,
  };
}
