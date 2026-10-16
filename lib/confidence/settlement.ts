import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// The safety net for Confidence settlement. Settlement normally happens INSIDE the grading transaction (a database trigger on the PENDING -> GRADED transition), so this finds nothing. If a settlement was ever
// deferred (it is contained, never allowed to block grading), this settles those stakes on the next tick. It only looks at ACTIVE stakes whose Pick is already graded, through a partial index — never a rewalk of
// every stake or every Pick. It is independent of the capability switches: a reserved stake settles regardless.

export interface ConfidenceSettlementSweepResult {
  settled: number;
}

export async function runConfidenceSettlementSweep(): Promise<ConfidenceSettlementSweepResult> {
  const { data, error } = await createAdminClient().rpc("confidence_settle_pending", { p_limit: 200 });
  // PostgREST errors are plain objects, not Error instances — wrap so the real message reaches background_jobs.error.
  if (error) throw new Error(error.message);
  return { settled: Number((data as { settled?: number } | null)?.settled ?? 0) };
}
