import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isBelowMinimum } from "@/lib/pools/settlement-logic";

export interface LockResult {
  checked: number;
  locked: number;
  failed: number;
  advancedToAwaitingResult: number;
  cancelledBelowMinimum: number;
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
 * still waiting to advance) is checked against `min_total_entries`: below
 * minimum cancels and refunds automatically via `confirm_pool_refund`;
 * otherwise it advances to AWAITING_RESULT, handing off to
 * lib/pools/settle.ts's `processAwaitingResults()` (a separate job, since
 * that step depends on fixture-sync data catching up, not a clock).
 */
export async function lockDuePools(): Promise<LockResult> {
  const admin = createAdminClient();
  const result: LockResult = {
    checked: 0,
    locked: 0,
    failed: 0,
    advancedToAwaitingResult: 0,
    cancelledBelowMinimum: 0,
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

  const { data: lockedPools } = await admin
    .from("pools")
    .select("id, min_total_entries, pool_options(entry_count)")
    .eq("status", "LOCKED");

  for (const pool of lockedPools ?? []) {
    const options = (pool.pool_options ?? []) as { entry_count: number }[];
    const validEntryCount = options.reduce((sum, o) => sum + o.entry_count, 0);

    if (isBelowMinimum(validEntryCount, pool.min_total_entries)) {
      const { error } = await admin.rpc("confirm_pool_refund", {
        p_pool_id: pool.id,
        p_void_reason: "MINIMUM_ENTRIES_NOT_REACHED",
        p_idempotency_key: `${pool.id}:void:MINIMUM_ENTRIES_NOT_REACHED`,
      });
      if (!error) result.cancelledBelowMinimum++;
    } else {
      const { error } = await admin
        .from("pools")
        .update({ status: "AWAITING_RESULT" })
        .eq("id", pool.id)
        .eq("status", "LOCKED");
      if (!error) result.advancedToAwaitingResult++;
    }
  }

  return result;
}
