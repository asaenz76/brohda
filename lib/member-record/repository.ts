import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseMemberRecordSummary } from "./format";
import type { MemberOpponent, MemberRecordSummary } from "./types";

// Brohda 2.1 M5 — the one read path for a Member's record. Two read-only functions on the service role (nothing is written, nothing is cached) and one profile lookup for the opponents' names: a constant
// number of queries however long the Member's history is. Visibility is the caller's job: the same graded-only aggregates the public profile already showed (accuracy, Call BS record) — never a pending pick.

export interface MemberRecord {
  summary: MemberRecordSummary;
  opponents: MemberOpponent[];
}

export const MOST_PLAYED_OPPONENTS = 3;

export async function getMemberRecord(userId: string, client: Pick<ReturnType<typeof createAdminClient>, "rpc" | "from"> = createAdminClient()): Promise<MemberRecord | null> {
  const [summaryResult, opponentsResult] = await Promise.all([
    client.rpc("member_record_summary", { p_user_id: userId, p_form: 10 }),
    client.rpc("member_call_bs_opponents", { p_user_id: userId, p_limit: MOST_PLAYED_OPPONENTS }),
  ]);
  if (summaryResult.error) throw summaryResult.error;
  if (opponentsResult.error) throw opponentsResult.error;
  const summary = parseMemberRecordSummary(summaryResult.data);
  if (!summary) return null;

  const rows = (opponentsResult.data ?? []) as Array<{ opponent_id: string; wins: number; losses: number; voids: number; matchups: number }>;
  let opponents: MemberOpponent[] = [];
  if (rows.length > 0) {
    const { data: profiles, error } = await client.from("user_profiles").select("id, display_name, username, is_active").in("id", rows.map((r) => r.opponent_id));
    if (error) throw error;
    const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));
    // An opponent whose account is gone or deactivated is left out of the list (their results still count in the record).
    opponents = rows.flatMap((r) => {
      const p = byId.get(r.opponent_id);
      if (!p || p.is_active === false) return [];
      return [{ opponentId: r.opponent_id, name: (p.display_name as string | null)?.trim() || (p.username as string | null) || "A Member", username: (p.username as string | null) ?? null, wins: r.wins, losses: r.losses, voids: r.voids, matchups: r.matchups }];
    });
  }
  return { summary, opponents };
}
