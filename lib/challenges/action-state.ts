import type { Challenge } from "./types";

/**
 * What the single Call BS control for one opposing participant row shows.
 * Which of these a viewer sees is decided server-side (never inferred
 * client-side) — see deriveChallengeActionState below.
 */
export type ChallengeActionState =
  | { kind: "call_bs"; recipientPredictionId: string }
  | { kind: "outgoing_pending" }
  | { kind: "incoming_pending"; challengeId: string }
  | { kind: "accepted" }
  | { kind: "declined" }
  // Exclusivity addendum: a PENDING challenge this viewer was tracking
  // became EXPIRED without ever being declined or hitting cutoff from
  // THIS viewer's own action — most commonly because one of its two
  // participants accepted a different Call BS on this Market first. Also
  // used for a PENDING challenge whose cutoff has passed (see below). The
  // exact reason is never fabricated (EXPIRED alone doesn't distinguish
  // cutoff/edit-invalidation/displacement — see accept_call_bs()'s own
  // comment), so this one generic state covers all of them.
  | { kind: "unavailable"; /** Brohda 2.1: set only when the Call BS ended because one of the two Members changed their Pick (expiry_reason PICK_CHANGED), so the row can say so. */ pickChanged?: true }
  // No Call BS exists between this pair, and none can: the participant is already in an accepted Call BS with someone else on
  // this Market (the 1-v-1 rule). Shown instead of silence so a missing button reads as a rule, not a bug.
  | { kind: "in_call_bs" }
  // M4: this Member called BS on the viewer and the viewer can answer it in the "Your Call BS" block at the top of the Post, so a row further down says so instead of repeating Accept / Decline.
  | { kind: "called_on_you" };

/** On the Post, an incoming Call BS is answered in one place (the "Your Call BS" block); every row below only names it. Any other state is unchanged. */
export function withIncomingAnsweredAbove(state: ChallengeActionState | null): ChallengeActionState | null {
  return state?.kind === "incoming_pending" ? { kind: "called_on_you" } : state;
}

/**
 * The pure per-row decision behind MarketParticipants' Call BS control —
 * no I/O, unit-testable.
 *
 * `challenges` are the viewer's own Challenges on this Market (already
 * scoped to the viewer by listChallengesForMarketAndUser). A terminal-state
 * Challenge between this exact pair never blocks a fresh one later, so more
 * than one can match a pair at once (one EXPIRED, one newly PENDING):
 * ACCEPTED, then PENDING, then EXPIRED take priority for display.
 * DECLINED/RESOLVED are deliberately never matched — those only ever show
 * via the client's own ephemeral post-action state.
 *
 * Expiry of a PENDING Challenge is lazy in the database: nothing sweeps a
 * PENDING row to EXPIRED when cutoff passes — it flips the next time
 * someone tries to accept it (accept_call_bs() is authoritative and always
 * rejects past cutoff). So the UI must not trust `status = PENDING` alone:
 * once cutoff has passed, a PENDING row is rendered as unavailable instead
 * of offering an Accept/Decline the server would only refuse.
 */
export function deriveChallengeActionState({
  viewerId,
  participantPredictionId,
  canCallBs,
  pairedInCallBs = false,
  challenges,
  pastCutoff,
}: {
  viewerId: string;
  participantPredictionId: string;
  canCallBs: boolean;
  pairedInCallBs?: boolean;
  challenges: Challenge[];
  pastCutoff: boolean;
}): ChallengeActionState | null {
  const pairChallenges = challenges.filter(
    (c) =>
      (c.status === "PENDING" || c.status === "ACCEPTED" || c.status === "EXPIRED") &&
      ((c.challengerUserId === viewerId && c.recipientPredictionId === participantPredictionId) ||
        (c.recipientUserId === viewerId && c.challengerPredictionId === participantPredictionId)),
  );
  const active =
    pairChallenges.find((c) => c.status === "ACCEPTED") ??
    pairChallenges.find((c) => c.status === "PENDING") ??
    pairChallenges.find((c) => c.status === "EXPIRED");

  if (active) {
    if (active.status === "ACCEPTED") return { kind: "accepted" };
    if (active.status === "EXPIRED") return active.expiryReason === "PICK_CHANGED" ? { kind: "unavailable", pickChanged: true } : { kind: "unavailable" };
    if (pastCutoff) return { kind: "unavailable" };
    if (active.challengerUserId === viewerId) return { kind: "outgoing_pending" };
    return { kind: "incoming_pending", challengeId: active.id };
  }

  if (canCallBs) return { kind: "call_bs", recipientPredictionId: participantPredictionId };
  if (pairedInCallBs) return { kind: "in_call_bs" };
  return null;
}
