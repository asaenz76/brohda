import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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

/**
 * Phase G (spec §32) — the batched, many-users sibling of
 * getUserPredictionRecord above, for exactly the "many comments, many
 * commenters" case this file's own header comment anticipated ("any
 * future Post/participant surface"). Mirrors
 * lib/predictions/repository.ts's getPickAggregatesForMarkets — one query
 * via the admin client (predictions' own RLS is own-row-only, the same
 * reason get_user_prediction_record itself needs SECURITY DEFINER to read
 * across users), computing the exact same math as that RPC in memory
 * rather than adding a second SQL function for what's already a trivial
 * GROUP BY: decided = correct + incorrect, VOID counted but excluded from
 * the denominator, accuracy null exactly when decided === 0. A requested
 * userId with no GRADED predictions at all still gets a full
 * zero-everything record in the returned Map (never omitted), matching
 * formatReputation's own "omit the reputation line entirely" handling for
 * that exact shape.
 */
export async function getUserPredictionRecords(userIds: string[]): Promise<Map<string, UserPredictionRecord>> {
  const result = new Map<string, UserPredictionRecord>();
  if (userIds.length === 0) return result;

  const admin = createAdminClient();
  const [{ data, error }, { data: policyRow }] = await Promise.all([
    admin.from("predictions").select("user_id, result").in("user_id", userIds).eq("lifecycle_state", "GRADED"),
    admin.from("platform_settings").select("leaderboard_min_decided_picks").eq("id", true).single(),
  ]);
  if (error) throw error;
  const minDecided = policyRow?.leaderboard_min_decided_picks ?? 5;

  const tally = new Map<string, { correct: number; incorrect: number; void: number }>();
  for (const row of (data ?? []) as { user_id: string; result: "CORRECT" | "INCORRECT" | "VOID" }[]) {
    const bucket = tally.get(row.user_id) ?? { correct: 0, incorrect: 0, void: 0 };
    if (row.result === "CORRECT") bucket.correct += 1;
    else if (row.result === "INCORRECT") bucket.incorrect += 1;
    else bucket.void += 1;
    tally.set(row.user_id, bucket);
  }

  for (const userId of userIds) {
    const bucket = tally.get(userId) ?? { correct: 0, incorrect: 0, void: 0 };
    const decided = bucket.correct + bucket.incorrect;
    result.set(userId, {
      correct: bucket.correct,
      incorrect: bucket.incorrect,
      void: bucket.void,
      decided,
      accuracy: decided > 0 ? bucket.correct / decided : null,
      minDecidedForLeaderboard: minDecided,
      eligibleForLeaderboard: decided > 0 && decided >= minDecided,
    });
  }
  return result;
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
