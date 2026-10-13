import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Cron run history (`background_jobs`) is one row per run and, until this existed, nothing ever deleted one: ~359,000 rows / 220 MB (about two thirds of
// the production database) after ~80 days, ~274,000 of them from jobs that no longer exist. Job Health, the readiness loader and the reports only read the
// most recent few hundred rows, so older history is safe to discard.
//
// How long to keep is an operator setting (platform_settings.background_job_retention_days, migration 195; owner-approved default 14 days). The structural
// numbers below are not policy: they bound the work of one cron tick, exactly as the provider request log's retention does.
//
// This only ever deletes from `background_jobs`, through the one service-role-only database function `delete_old_background_jobs_rows` — nothing else is
// touched.

/** Rows deleted per database call — small enough to stay under the 8 s statement timeout every PostgREST call runs under. */
export const BACKGROUND_JOBS_DELETE_BATCH_SIZE = 1_000;

/** Caps how many batches one cron invocation runs, so a large backlog drains over several ticks instead of one long request. */
export const BACKGROUND_JOBS_BATCHES_PER_CRON_TICK = 20;

/**
 * The newest rows of EVERY job name are never deleted, however old. A job that runs rarely (or was discontinued) still shows its last known runs, and Job
 * Health can never regress to "never run" because of pruning. Well above the 200–300 recent rows any reader fetches in total.
 */
export const BACKGROUND_JOBS_KEEP_LATEST_PER_JOB = 50;

export interface BackgroundJobsRetentionResult {
  batchesRun: number;
  rowsDeleted: number;
  /** The window applied, or null when the setting was missing or malformed (nothing is deleted then — fail safe). */
  retentionDays: number | null;
}

/** A usable retention window is a whole number of days, at least 1. Anything else (null, 0, negative, fractional, NaN, a string) deletes nothing. */
export function isValidRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export async function runBackgroundJobsRetention(): Promise<BackgroundJobsRetentionResult> {
  const admin = createAdminClient();
  const result: BackgroundJobsRetentionResult = { batchesRun: 0, rowsDeleted: 0, retentionDays: null };

  const { data: settings } = await admin.from("platform_settings").select("background_job_retention_days").eq("id", true).single();
  const retentionDays: unknown = settings?.background_job_retention_days;
  if (!isValidRetentionDays(retentionDays)) return result;
  result.retentionDays = retentionDays;

  for (let i = 0; i < BACKGROUND_JOBS_BATCHES_PER_CRON_TICK; i++) {
    const { data: deletedCount, error } = await admin.rpc("delete_old_background_jobs_rows", {
      p_retention_days: retentionDays,
      p_batch_size: BACKGROUND_JOBS_DELETE_BATCH_SIZE,
      p_keep_latest_per_job: BACKGROUND_JOBS_KEEP_LATEST_PER_JOB,
    });
    // PostgREST errors are plain objects, not Error instances — wrap so the real message reaches background_jobs.error.
    if (error) throw new Error(error.message);

    result.batchesRun++;
    result.rowsDeleted += deletedCount ?? 0;

    if ((deletedCount ?? 0) < BACKGROUND_JOBS_DELETE_BATCH_SIZE) break;
  }

  return result;
}
