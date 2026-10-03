import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Notification delivery is never silent. Supabase reports an insert failure
// in the result object rather than throwing, so every insert here checks it
// explicitly. The create* functions throw on failure; callers choose policy
// through deliverNotification():
//   - Server actions log the failure and let the already-committed domain
//     action stand (the same "an optional, best-effort notification must
//     never make a successful mutation look like a failure" policy as
//     maybeCreatePredictionGradedNotification in ./predictions.ts).
//   - Jobs record the failure on their run summary so job health reads
//     "degraded" instead of a quietly missing notification.

export async function insertNotificationRows(label: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("notifications").insert(rows);
  if (error) throw new Error(`${label} notification insert failed: ${error.message}`);
}

export type NotificationDelivery = { delivered: true } | { delivered: false; error: string };

/**
 * Runs one notification without ever throwing. A failure is logged with the
 * subject's id (enough to diagnose or re-send by hand) and returned.
 */
export async function deliverNotification(scope: string, label: string, subjectId: string, send: () => Promise<void>): Promise<NotificationDelivery> {
  try {
    await send();
    return { delivered: true };
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[${scope}] ${label} notification failed for ${subjectId} — the underlying action itself is unaffected:`, message);
    return { delivered: false, error: message };
  }
}
