import "server-only";
import { getUserCohortKeys } from "./cohorts";
import { listActiveKillSwitches, pickHighestPrecedenceSwitch } from "./kill-switches";
import type { ExecutionKillSwitch, ExecutionPolicy, KillSwitchScope } from "./types";

// Milestone 5.5 execution control plane (STEP 4-6) — the ONE place that
// answers "is execution currently allowed?" before any quote/confirmation
// proceeds. A future real-execution flow calls this exact same function
// before any provider mutation — nothing here is simulation-specific.
//
// Fail-safe behavior: a database error while reading kill switches denies
// the request (fail CLOSED), a deliberate divergence from
// getExecutionPolicy()'s own fail-open convention (that function guards
// generic product policy; this one guards an operator's explicit "stop
// this" signal, and failing open here would silently defeat the point of
// having a kill switch at all — see docs/architecture/execution-operational-safety.md).

export type ControlPlaneDenialReason = "EXECUTION_DISABLED" | "ROLLOUT_BLOCKED";

export type ControlPlaneResult =
  | { allowed: true; cohortKeys: string[] }
  | { allowed: false; reason: ControlPlaneDenialReason; blockedBySwitch?: { id: string; scope: KillSwitchScope; target: string | null } };

export interface ControlPlaneInput {
  userId: string;
  provider: string;
  marketId: string;
  /** Null until a real jurisdiction signal exists (Milestone 6) — the JURISDICTION scope is exercised structurally, never with real geography today. */
  jurisdiction: string | null;
}

/**
 * The full match decision — both "has this switch expired" and "does its
 * scope/target genuinely correspond to this request" — evaluated entirely
 * in application code over the small set of enabled switches
 * (kill-switches.ts's own comment explains why this beats a
 * string-interpolated OR-filter query).
 */
function switchIsApplicable(s: ExecutionKillSwitch, input: ControlPlaneInput, cohortKeys: string[], now: Date): boolean {
  if (s.expiresAt !== null && now.getTime() >= new Date(s.expiresAt).getTime()) return false;

  switch (s.scope) {
    case "GLOBAL":
      return true;
    case "PROVIDER":
      return s.target === input.provider;
    case "JURISDICTION":
      return input.jurisdiction !== null && s.target === input.jurisdiction;
    case "USER":
      return s.target === input.userId;
    case "MARKET":
      return s.target === input.marketId;
    case "COHORT":
      return s.target !== null && cohortKeys.includes(s.target);
  }
}

export async function checkExecutionControlPlane(input: ControlPlaneInput, policy: ExecutionPolicy): Promise<ControlPlaneResult> {
  let cohortKeys: string[];
  let enabledSwitches: ExecutionKillSwitch[];
  const now = new Date();

  try {
    cohortKeys = await getUserCohortKeys(input.userId);
    enabledSwitches = await listActiveKillSwitches();
  } catch {
    // Fail CLOSED — see this module's own header comment.
    return { allowed: false, reason: "EXECUTION_DISABLED" };
  }

  const applicable = enabledSwitches.filter((s) => switchIsApplicable(s, input, cohortKeys, now));
  const blocking = pickHighestPrecedenceSwitch(applicable);
  if (blocking) {
    return { allowed: false, reason: "EXECUTION_DISABLED", blockedBySwitch: { id: blocking.id, scope: blocking.scope, target: blocking.target } };
  }

  // Rollout/cohort policy — the final gate before "execution allowed"
  // (STEP 6's own "cohort policy -> execution allowed" ordering). Unlike
  // kill switches (blocklist semantics: any match denies), this is an
  // allowlist gate: only relevant at all when the operator has switched
  // rollout to COHORT_RESTRICTED.
  if (policy.rolloutMode === "COHORT_RESTRICTED" && cohortKeys.length === 0) {
    return { allowed: false, reason: "ROLLOUT_BLOCKED" };
  }

  return { allowed: true, cohortKeys };
}
