import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Rows older than this are safe to discard — provider_request_log is a
// debug/observability log (lib/sports-data/http.ts), nothing in the app
// reads rows this old.
//
// Set to 3 (not the more generous 30 originally planned) on 2026-08-16:
// the brohda Supabase project was created 2026-07-23, so at a 30-day
// window this job would delete nothing until 2026-08-22 — no help for
// the active quota emergency (908MB/3.87M rows, 210% over the Free-tier
// database-size limit, in a grace period) that motivated building this
// job in the first place. A 3-day window makes most of the existing
// backlog immediately prunable. Safe to raise back toward 30 once the
// project is back under quota and the backlog has drained.
export const PROVIDER_REQUEST_LOG_RETENTION_DAYS = 3;

// Rows deleted per RPC call — bounds a single database round trip.
//
// 10,000 was the original guess and it's too big: every PostgREST/RPC
// call — service_role included — runs under the `authenticator` login
// role's session-level `statement_timeout=8s` (SET ROLE doesn't reset
// session GUCs set before it), and a 10k-row delete against this table's
// 3 indexes (pkey, created_at, provider+created_at) blew past that in
// production on 2026-08-16 (Postgres error 57014, "canceling statement
// due to statement timeout") once real rows were actually being deleted.
// 1,000 leaves comfortable headroom under the 8s ceiling.
export const PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE = 1_000;

// Bounded work per cron tick (same convention as
// IMPORT_CHUNKS_PER_CRON_TICK, lib/competitions/constants.ts): caps how
// many batches one invocation runs so a large backlog drains over several
// ticks instead of one long-running request. At the initial ~3.87M-row
// backlog this clears in well under a day at the job's 5-minute cadence;
// once caught up, daily growth (~56k rows/day) clears in a single tick.
export const PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK = 20;

export interface ProviderRequestLogRetentionResult {
  batchesRun: number;
  rowsDeleted: number;
}

export async function runProviderRequestLogRetention(): Promise<ProviderRequestLogRetentionResult> {
  const admin = createAdminClient();
  const result: ProviderRequestLogRetentionResult = { batchesRun: 0, rowsDeleted: 0 };

  for (let i = 0; i < PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK; i++) {
    const { data: deletedCount, error } = await admin.rpc("delete_old_provider_request_log_rows", {
      p_retention_days: PROVIDER_REQUEST_LOG_RETENTION_DAYS,
      p_batch_size: PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE,
    });
    // Postgrest errors are plain objects, not Error instances — recordJobRun's
    // `error instanceof Error ? error.message : String(error)` stringifies a
    // raw one to the useless "[object Object]" in background_jobs.error. Wrap
    // it here so a real failure (e.g. a statement-timeout, as hit in
    // production on 2026-08-16) is actually readable without pulling Vercel
    // function logs.
    if (error) throw new Error(error.message);

    result.batchesRun++;
    result.rowsDeleted += deletedCount ?? 0;

    if ((deletedCount ?? 0) < PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE) break;
  }

  return result;
}
