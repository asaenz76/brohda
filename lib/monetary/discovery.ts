import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPastEffectiveLock } from "@/lib/predictions/lock";
import { getPickLockPolicy } from "@/lib/predictions/policy";
import { isMonetaryP2pEnabled } from "./policy";
import type { MonetaryParticipant } from "./types";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Milestone R9 §42-43 (mirrors lib/challenges/discovery.ts's own
// getMarketParticipants exactly): the smallest Post/Market participant
// presentation necessary to make direct monetary proposals discoverable.
// Runs on the service role for the same reason challenges' own discovery
// does — `predictions` RLS stays own-row-only.

interface ParticipantRow {
  id: string;
  user_id: string;
  selected_outcome: PredictionOutcome;
  lifecycle_state: "PENDING" | "GRADED";
  locked_at: string | null;
}

/**
 * Every user's current Pick on a Market, safe-presentation only, with a
 * server-computed `canProposeMoney` for the current viewer. Deliberately
 * does NOT check `locked_at` — a locked Pick may still gain further free
 * Challenges or monetary Positions (multiplicity, R7 + R9 both preserve
 * this), so only `lifecycle_state` (GRADED) and the effective cutoff gate
 * eligibility, exactly mirroring canCallBs's own reasoning. Does NOT check
 * the viewer's own wallet balance either — that's enforced inside
 * propose_money() at creation time, not here (§ recipient-does-not-need-
 * funds-to-receive applies symmetrically: discovery never depends on
 * either side's funding state).
 */
export async function getMonetaryParticipants(
  marketId: string,
  viewerId: string,
  scheduledStartUtc: string,
): Promise<MonetaryParticipant[]> {
  const admin = createAdminClient();

  const [{ data: rows, error }, enabled, lockPolicy] = await Promise.all([
    admin.from("predictions").select("id, user_id, selected_outcome, lifecycle_state, locked_at").eq("market_id", marketId),
    isMonetaryP2pEnabled(),
    getPickLockPolicy(),
  ]);
  if (error) throw error;
  const participantRows = (rows ?? []) as ParticipantRow[];
  if (participantRows.length === 0) return [];

  const viewerRow = participantRows.find((r) => r.user_id === viewerId) ?? null;
  const pastCutoff = isPastEffectiveLock(scheduledStartUtc, lockPolicy.lockMinutesBeforeKickoff, new Date());

  let existingPairPredictionIds = new Set<string>();
  if (viewerRow && enabled && !pastCutoff && viewerRow.lifecycle_state !== "GRADED") {
    const { data: existing, error: existingError } = await admin
      .from("monetary_proposals")
      .select("proposer_prediction_id, recipient_prediction_id")
      .in("status", ["PENDING", "ACCEPTED"])
      .or(`proposer_prediction_id.eq.${viewerRow.id},recipient_prediction_id.eq.${viewerRow.id}`);
    if (existingError) throw existingError;
    existingPairPredictionIds = new Set(
      (existing ?? []).flatMap((p) => [p.proposer_prediction_id, p.recipient_prediction_id]).filter((id) => id !== viewerRow.id),
    );
  }

  const userIds = [...new Set(participantRows.map((r) => r.user_id))];
  // Same public_profiles-grants-authenticated-not-service_role workaround
  // as lib/challenges/discovery.ts.
  const { data: profileRows, error: profileError } = await admin
    .from("user_profiles")
    .select("id, display_name, username, avatar_url")
    .eq("is_active", true)
    .in("id", userIds);
  if (profileError) throw profileError;
  const profilesById = new Map((profileRows ?? []).map((p) => [p.id, p]));

  return participantRows.map((row): MonetaryParticipant => {
    const profile = profilesById.get(row.user_id);
    const canProposeMoney = Boolean(
      viewerRow &&
        enabled &&
        !pastCutoff &&
        row.user_id !== viewerId &&
        row.selected_outcome !== viewerRow.selected_outcome &&
        row.lifecycle_state !== "GRADED" &&
        viewerRow.lifecycle_state !== "GRADED" &&
        !existingPairPredictionIds.has(row.id),
    );
    return {
      userId: row.user_id,
      displayName: profile?.display_name ?? "Unknown",
      username: profile?.username ?? null,
      avatarUrl: profile?.avatar_url ?? null,
      predictionId: row.id,
      selectedOutcome: row.selected_outcome,
      canProposeMoney,
    };
  });
}
