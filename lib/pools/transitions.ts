import type { PoolStatus } from "./card-state";

// Spec §11.5's transition table, verbatim, with one documented extension:
// the diagram only shows LOCKED -> VOIDED, but §16.8's prose is explicit
// that the below-minimum-entries case at lock time is CANCELLED (not
// VOIDED) — the more specific rule wins. Everything else matches the spec
// text exactly, including REVERSAL_FAILED_MANUAL_REVIEW's two exits.
const TRANSITIONS: Record<PoolStatus, readonly PoolStatus[]> = {
  DRAFT: ["SCHEDULED", "OPEN", "CANCELLED"],
  SCHEDULED: ["OPEN", "CANCELLED"],
  OPEN: ["LOCKED", "CANCELLED"],
  LOCKED: ["AWAITING_RESULT", "VOIDED", "CANCELLED"],
  AWAITING_RESULT: ["READY_FOR_REVIEW", "VOIDED"],
  READY_FOR_REVIEW: ["SETTLED", "VOIDED"],
  SETTLED: ["SETTLEMENT_REVERSED", "REVERSAL_FAILED_MANUAL_REVIEW"],
  VOIDED: [],
  CANCELLED: [],
  SETTLEMENT_REVERSED: ["READY_FOR_REVIEW"],
  REVERSAL_FAILED_MANUAL_REVIEW: ["SETTLEMENT_REVERSED", "SETTLED"],
};

/** Spec §11.5: "arbitrary status updates are rejected." */
export function isValidTransition(from: PoolStatus, to: PoolStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
