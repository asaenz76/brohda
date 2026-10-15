import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Gives every eligible existing Member their Confidence account and the one initial grant, in bounded batches, only while the capability is ON. Idempotent and race-safe in the database
// (confidence_bootstrap_member); this only loops it a bounded number of times per cron tick. No-op while OFF.

/** Members processed per database call. A structural bound on one call's work, not policy. */
export const CONFIDENCE_BOOTSTRAP_BATCH = 200;
/** Calls per cron tick, so a large population drains over several ticks. */
export const CONFIDENCE_BOOTSTRAP_ROUNDS_PER_TICK = 10;

export interface ConfidenceBootstrapResult {
  enabled: boolean;
  rounds: number;
  processed: number;
  remaining: number;
}

export async function runConfidenceBootstrap(): Promise<ConfidenceBootstrapResult> {
  const admin = createAdminClient();
  const result: ConfidenceBootstrapResult = { enabled: false, rounds: 0, processed: 0, remaining: 0 };
  for (let i = 0; i < CONFIDENCE_BOOTSTRAP_ROUNDS_PER_TICK; i++) {
    const { data, error } = await admin.rpc("confidence_bootstrap_batch", { p_limit: CONFIDENCE_BOOTSTRAP_BATCH });
    // PostgREST errors are plain objects, not Error instances — wrap so the real message reaches background_jobs.error.
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as { enabled?: boolean; processed?: number; remaining?: number };
    if (row.enabled !== true) return result;
    result.enabled = true;
    result.rounds++;
    result.processed += row.processed ?? 0;
    result.remaining = row.remaining ?? 0;
    if ((row.remaining ?? 0) === 0 || (row.processed ?? 0) === 0) break;
  }
  return result;
}
