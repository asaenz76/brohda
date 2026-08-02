import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LockResult {
  checked: number;
  locked: number;
  failed: number;
  advancedToAwaitingResult: number;
  cancelledBelowMinimum: number;
  /** Every valid entry landed on the same side (all YES or all NO) —
   * balanced-participation check, TEMPLATE_GRADED pools only (see
   * pools.participation_rule_version). */
  cancelledOneSided: number;
  /** Binary options couldn't be resolved to exactly one YES and one NO —
   * an integrity issue, not a normal outcome; needs an admin. */
  manualReview: number;
}

// PostgREST returns a to-one embed as an object, but without generated types
// we can't be sure how it deserializes — handle both shapes.
function unwrapEmbed<T>(raw: unknown): T | null {
  return (Array.isArray(raw) ? raw[0] : raw) as T | null;
}

/**
 * Auto-lock job (spec §15/§16.8): OPEN -> LOCKED once `now() >= locks_at`,
 * or immediately if the linked fixture has already kicked off early. In the
 * same run — "when the lock job fires" per §16.8's own wording — every
 * LOCKED pool (freshly locked this run or already LOCKED from a prior run
 * still waiting to advance) is advanced via the atomic
 * `advance_or_cancel_locked_pool` RPC: below `min_total_entries` cancels
 * and refunds (MINIMUM_ENTRIES_NOT_REACHED); a TEMPLATE_GRADED pool
 * (participation_rule_version = 2) where every valid entry landed on the
 * same side cancels and refunds too (ONE_SIDED_POOL); unresolvable binary
 * options route to MANUAL_REVIEW; otherwise the pool advances to
 * AWAITING_RESULT, handing off to lib/pools/settle.ts's
 * `processAwaitingResults()` (a separate job, since that step depends on
 * fixture-sync data catching up, not a clock). The whole read-decide-act
 * sequence happens under one row lock inside the RPC, closing the race two
 * overlapping cron runs could previously hit reading state in JS first.
 */
export async function lockDuePools(): Promise<LockResult> {
  const admin = createAdminClient();
  const result: LockResult = {
    checked: 0,
    locked: 0,
    failed: 0,
    advancedToAwaitingResult: 0,
    cancelledBelowMinimum: 0,
    cancelledOneSided: 0,
    manualReview: 0,
  };

  const { data: openPools } = await admin
    .from("pools")
    .select("id, locks_at, fixtures(internal_status)")
    .eq("status", "OPEN");

  const now = Date.now();

  for (const pool of openPools ?? []) {
    result.checked++;

    const fixture = unwrapEmbed<{ internal_status?: string }>(pool.fixtures);
    const internalStatus = fixture?.internal_status;

    const pastLockTime = new Date(pool.locks_at).getTime() <= now;
    const fixtureStartedEarly = internalStatus != null && internalStatus !== "NOT_STARTED";

    if (!pastLockTime && !fixtureStartedEarly) continue;

    const { error } = await admin
      .from("pools")
      .update({ status: "LOCKED" })
      .eq("id", pool.id)
      .eq("status", "OPEN");

    if (error) {
      result.failed++;
    } else {
      result.locked++;
    }
  }

  const { data: lockedPools } = await admin.from("pools").select("id").eq("status", "LOCKED");

  for (const pool of lockedPools ?? []) {
    const { data: updatedPool, error } = await admin.rpc("advance_or_cancel_locked_pool", {
      p_pool_id: pool.id,
    });
    if (error || !updatedPool) continue;

    if (updatedPool.status === "AWAITING_RESULT") {
      result.advancedToAwaitingResult++;
    } else if (updatedPool.status === "MANUAL_REVIEW") {
      result.manualReview++;
    } else if (updatedPool.void_reason === "ONE_SIDED_POOL") {
      result.cancelledOneSided++;
    } else if (updatedPool.void_reason === "MINIMUM_ENTRIES_NOT_REACHED") {
      result.cancelledBelowMinimum++;
    }
  }

  return result;
}
