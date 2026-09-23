import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPastEffectiveLock } from "@/lib/predictions/lock";
import { getPickLockPolicy } from "@/lib/predictions/policy";
import { isCallBsEnabled } from "./policy";
import type { ChallengeParticipant } from "./types";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Milestone R7 §42-43: the smallest Post/Market participant presentation
// necessary to make Call BS discoverable — never exposes private profile
// fields, wallet info, email, or hidden metadata. `predictions` RLS is
// own-row-only (R5, unchanged), so this deliberately runs on the service
// role (like R6's getPostConversation) rather than loosening that RLS —
// only the fields a viewer actually needs (identity, selected side,
// Call-BS eligibility) are ever returned.

interface ParticipantRow {
  id: string;
  user_id: string;
  selected_outcome: PredictionOutcome;
  lifecycle_state: "PENDING" | "GRADED";
  locked_at: string | null;
}

/**
 * Every user's current Pick on a Market, safe-presentation only, with a
 * server-computed `canCallBs` for the current viewer. `canCallBs` is false
 * for the viewer's own row, for a same-side participant, whenever either
 * Pick is graded or the effective Challenge cutoff has passed, whenever
 * the viewer has no Pick of their own on this Market yet, whenever Call BS
 * is disabled platform-wide, and whenever a PENDING or ACCEPTED Challenge
 * already links the viewer's Pick to this specific participant's Pick (a
 * presentation-only anti-redundancy check — the database's own uniqueness
 * guarantee only need cover the PENDING case; this simply avoids offering
 * a confusing "Call BS" prompt the backend would reject as a duplicate, or
 * a second one once the two are already facing off).
 */
export async function getMarketParticipants(
  marketId: string,
  viewerId: string,
  scheduledStartUtc: string,
): Promise<ChallengeParticipant[]> {
  const admin = createAdminClient();

  const [{ data: rows, error }, enabled, lockPolicy] = await Promise.all([
    admin.from("predictions").select("id, user_id, selected_outcome, lifecycle_state, locked_at").eq("market_id", marketId),
    isCallBsEnabled(),
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
      .from("challenges")
      .select("challenger_prediction_id, recipient_prediction_id")
      .in("status", ["PENDING", "ACCEPTED"])
      .or(`challenger_prediction_id.eq.${viewerRow.id},recipient_prediction_id.eq.${viewerRow.id}`);
    if (existingError) throw existingError;
    existingPairPredictionIds = new Set(
      (existing ?? []).flatMap((c) => [c.challenger_prediction_id, c.recipient_prediction_id]).filter((id) => id !== viewerRow.id),
    );
  }

  const userIds = [...new Set(participantRows.map((r) => r.user_id))];
  // Same reasoning as lib/post-comments/repository.ts's own author lookup:
  // `public_profiles` grants SELECT to `authenticated` only, not
  // `service_role` — read the same unconditional columns straight from
  // user_profiles instead.
  const { data: profileRows, error: profileError } = await admin
    .from("user_profiles")
    .select("id, display_name, username, avatar_url")
    .eq("is_active", true)
    .in("id", userIds);
  if (profileError) throw profileError;
  const profilesById = new Map((profileRows ?? []).map((p) => [p.id, p]));

  return participantRows.map((row): ChallengeParticipant => {
    const profile = profilesById.get(row.user_id);
    const canCallBs = Boolean(
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
      canCallBs,
    };
  });
}
