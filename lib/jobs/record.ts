import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Generous relative to every job's actual observed duration (sub-second
// to a few seconds today) — long enough to never expire mid-run, short
// enough that a hard-crashed run (one that skips the finally-block
// release below) self-heals well within a normal support window rather
// than blocking that job indefinitely.
const DEFAULT_LOCK_TTL_SECONDS = 10 * 60;

export interface JobSkipped {
  skipped: true;
  reason: string;
}

export function isJobSkipped(value: unknown): value is JobSkipped {
  return typeof value === "object" && value !== null && (value as { skipped?: unknown }).skipped === true;
}

/**
 * Wraps a cron job's existing function with run-history persistence (spec
 * §18's `background_jobs` table) — nothing about the job itself changes,
 * this just times it and writes one row after it settles. Rethrows on
 * failure so the calling route's existing error handling is unchanged.
 *
 * Also the overlap guard every cron route shares: acquires a named lock
 * (try_acquire_cron_lock, 20260101000108_cron_job_overlap_guard.sql)
 * before running `fn`, and skips the tick entirely — no `fn` call, no
 * `background_jobs` row — if a previous invocation of the same job name
 * still holds it. Real motivating incident: sync-fixtures once took 4-5
 * minutes per run but fired every 1 minute with no such guard, so
 * concurrent runs stacked up and multiplied provider request volume
 * roughly 20x (see SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md's root
 * cause). The lock always releases in `finally`, whether `fn` succeeded,
 * threw, or (via the TTL) was simply never released by a crashed run.
 */
export async function recordJobRun<T>(
  jobName: string,
  fn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_LOCK_TTL_SECONDS,
): Promise<T | JobSkipped> {
  const admin = createAdminClient();

  const { data: acquired } = await admin.rpc("try_acquire_cron_lock", {
    p_job_name: jobName,
    p_ttl_seconds: ttlSeconds,
  });
  if (!acquired) {
    return { skipped: true, reason: `a previous ${jobName} run still holds the overlap lock` };
  }

  const startedAt = new Date();

  try {
    const result = await fn();
    const finishedAt = new Date();

    await admin.from("background_jobs").insert({
      job_name: jobName,
      status: "success",
      result: result as object,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    });

    return result;
  } catch (error) {
    const finishedAt = new Date();

    await admin.from("background_jobs").insert({
      job_name: jobName,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    });

    throw error;
  } finally {
    await admin.rpc("release_cron_lock", { p_job_name: jobName });
  }
}
