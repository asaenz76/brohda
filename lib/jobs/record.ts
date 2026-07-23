import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Wraps a cron job's existing function with run-history persistence (spec
 * §18's `background_jobs` table) — nothing about the job itself changes,
 * this just times it and writes one row after it settles. Rethrows on
 * failure so the calling route's existing error handling is unchanged.
 */
export async function recordJobRun<T>(jobName: string, fn: () => Promise<T>): Promise<T> {
  const admin = createAdminClient();
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
  }
}
