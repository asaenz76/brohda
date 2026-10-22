import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * One generation per Game at a time. Scheduled and Admin generation both take this lease (the existing cron overlap-guard primitive, `try_acquire_cron_lock`, scoped to the Game), so an Admin Generate and a scheduled run, two overlapping scheduler invocations or two workers can never run the
 * pipeline on the same Game at once, and never pay for the same research twice. The lease expires on its own (a hard-crashed run never blocks a Game for long) and is released as soon as the run ends. The database write is still serialised separately, and its uniqueness is untouched.
 */
const LEASE_SECONDS = 10 * 60;
const leaseName = (fixtureId: string) => `game-preview-generation:${fixtureId}`;

export async function withGameGenerationLock<T>(fixtureId: string, fn: () => Promise<T>, ttlSeconds: number = LEASE_SECONDS): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const admin = createAdminClient();
  const { data: acquired } = await admin.rpc("try_acquire_cron_lock", { p_job_name: leaseName(fixtureId), p_ttl_seconds: ttlSeconds });
  if (!acquired) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await admin.rpc("release_cron_lock", { p_job_name: leaseName(fixtureId) });
  }
}
