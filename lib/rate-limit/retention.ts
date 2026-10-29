import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

const BATCH = 5000;
const MAX_BATCHES = 10;
// Every limiter window is an hour or less; two days keeps a row long past anything it could still limit.
const KEEP = "2 days";

/** Deletes rate-limit rows whose window ended long ago (the table gained one row per distinct key and never lost any). Bounded per run; the next run continues. */
export async function runRateLimitRetention(): Promise<{ rowsDeleted: number }> {
  const admin = createAdminClient();
  let rowsDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await admin.rpc("prune_rate_limits", { p_older_than: KEEP, p_batch: BATCH });
    if (error) throw new Error(error.message);
    const deleted = typeof data === "number" ? data : 0;
    rowsDeleted += deleted;
    if (deleted < BATCH) break;
  }
  return { rowsDeleted };
}
