import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// The Messaging retention purge, driven entirely by platform_settings (durations, and the master switch messaging_retention_purge_enabled, which is OFF by default). The database function does the work in
// bounded, indexed batches and protects open moderation cases and retention holds; this only loops it a bounded number of times per cron tick. It deletes nothing itself and reads no message content.

/** Rows removed per category per database call. A structural bound on one call's work, not policy. */
export const MESSAGING_PURGE_BATCH_SIZE = 500;
/** Caps the calls one cron tick makes, so a large backlog drains over several ticks. */
export const MESSAGING_PURGE_ROUNDS_PER_TICK = 10;

export interface MessagingRetentionResult {
  /** False when the master switch is off (or unreadable): nothing was deleted. */
  enabled: boolean;
  rounds: number;
  removed: Record<string, number>;
}

export async function runMessagingRetention(): Promise<MessagingRetentionResult> {
  const admin = createAdminClient();
  const result: MessagingRetentionResult = { enabled: false, rounds: 0, removed: {} };
  for (let i = 0; i < MESSAGING_PURGE_ROUNDS_PER_TICK; i++) {
    const { data, error } = await admin.rpc("messaging_purge_expired", { p_batch: MESSAGING_PURGE_BATCH_SIZE });
    // PostgREST errors are plain objects, not Error instances — wrap so the real message reaches background_jobs.error.
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Record<string, number | boolean>;
    if (row.enabled !== true) return result;
    result.enabled = true;
    result.rounds++;
    let full = false;
    for (const [key, value] of Object.entries(row)) {
      if (key === "enabled" || typeof value !== "number") continue;
      result.removed[key] = (result.removed[key] ?? 0) + value;
      if (value >= MESSAGING_PURGE_BATCH_SIZE) full = true;
    }
    if (!full) break;
  }
  return result;
}
