// A Pick's state, derived — never stored. The database function pick_state(user, market) (migration 211) is the authority; this is the same derivation for code that already holds the Pick, its stake and the
// deadline in memory (a feed page builds many cards from one read), kept identical by a parity test. Lock sources overlap (a staked Pick may also be in an accepted Call BS), so the headline state follows a fixed
// precedence: graded/void, then Confidence, then Call BS, then the deadline, then editable.
//
// T-10 is Brohda's only Member prediction deadline: `windowOpen` is whether it has not passed yet. In the browser/feed this is DISPLAY only — the database decides, with its own clock, after its locks.

export type PickStateName = "NO_PICK" | "UNSTAKED_EDITABLE" | "UNSTAKED_LOCKED_T10" | "STAKED_LOCKED_CONFIDENCE" | "LOCKED_CALL_BS" | "GRADED" | "VOID" | "LOCKED_OTHER";

export type PickLockSource = "CONFIDENCE" | "CALL_BS" | "T10";

export interface PickStateInput {
  /** The Member's Pick on this Market, or null. */
  prediction: { lifecycleState: "PENDING" | "GRADED"; result: "CORRECT" | "INCORRECT" | "VOID" | null; lockedAt: string | null; lockReason: string | null } | null;
  /** Whether a Confidence stake exists behind the Pick. */
  staked: boolean;
  /** Whether an accepted Call BS involves the Pick (the Pick's stored lock reason is CHALLENGE_ACCEPTED, or the caller knows of the challenge). */
  acceptedCallBs: boolean;
  /** Whether the Game is still NOT_STARTED and T-10 has not passed. */
  windowOpen: boolean;
}

export interface PickState {
  state: PickStateName;
  lockSources: PickLockSource[];
  /** The team may still be changed (only an unstaked, unlocked Pick before T-10 — or choosing one when there is none). */
  canChangeTeam: boolean;
  /** Confidence may still be attached: ungraded, unstaked, before T-10 — an accepted Call BS does not prevent it (the team is already locked; Confidence is independent of Call BS). */
  canAttachConfidence: boolean;
}

export function derivePickState({ prediction, staked, acceptedCallBs, windowOpen }: PickStateInput): PickState {
  if (!prediction) return { state: "NO_PICK", lockSources: [], canChangeTeam: windowOpen, canAttachConfidence: false };
  const graded = prediction.lifecycleState === "GRADED";
  const timingLocked = !graded && (!windowOpen || prediction.lockReason === "CUTOFF");
  const lockSources: PickLockSource[] = [];
  if (staked) lockSources.push("CONFIDENCE");
  if (acceptedCallBs || prediction.lockReason === "CHALLENGE_ACCEPTED") lockSources.push("CALL_BS");
  if (timingLocked) lockSources.push("T10");

  let state: PickStateName;
  if (graded && prediction.result === "VOID") state = "VOID";
  else if (graded) state = "GRADED";
  else if (staked) state = "STAKED_LOCKED_CONFIDENCE";
  else if (lockSources.includes("CALL_BS")) state = "LOCKED_CALL_BS";
  else if (timingLocked) state = "UNSTAKED_LOCKED_T10";
  else if (prediction.lockedAt !== null) state = "LOCKED_OTHER";
  else state = "UNSTAKED_EDITABLE";

  return {
    state,
    lockSources,
    canChangeTeam: state === "UNSTAKED_EDITABLE",
    canAttachConfidence: !graded && !staked && windowOpen && prediction.lockReason !== "CUTOFF",
  };
}
