import "server-only";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDegradedResult } from "./health";

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
    const degraded = isDegradedResult(result);

    await admin.from("background_jobs").insert({
      job_name: jobName,
      status: degraded ? "degraded" : "success",
      result: result as object,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    });

    // Milestone R13.9 (§9): a job that completes without throwing but
    // reports per-item failures or a financial invariant_violation must
    // never be operationally silent — recording "degraded" in
    // background_jobs is necessary but not sufficient, since nothing
    // proactively watches that table. This is the one place every
    // degraded lifecycle run passes through, so it's the correct place
    // to raise it in the existing Sentry integration rather than
    // console.log-and-continue. Never automatically repairs anything —
    // detection and alerting only.
    if (degraded) {
      const resultRecord = result as Record<string, unknown>;
      const invariantViolations =
        typeof resultRecord.invariantViolations === "number" ? resultRecord.invariantViolations : 0;
      const failureCount = Array.isArray(resultRecord.failures) ? resultRecord.failures.length : 0;

      Sentry.captureMessage(
        invariantViolations > 0
          ? `${jobName}: financial invariant violation requires manual review`
          : `${jobName}: completed with per-item failures`,
        {
          level: invariantViolations > 0 ? "error" : "warning",
          tags: { job: jobName, status: "degraded" },
          extra: {
            failureCount,
            invariantViolations,
            // Non-secret internal object ids only — never user/financial
            // detail beyond that, per §9's explicit instruction.
            failedIds: Array.isArray(resultRecord.failures)
              ? resultRecord.failures.map((f) => (f as Record<string, unknown>).predictionId ??
                  (f as Record<string, unknown>).challengeId ??
                  (f as Record<string, unknown>).positionId ??
                  "unknown")
              : [],
          },
        },
      );
    }

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
