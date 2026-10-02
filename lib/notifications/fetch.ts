import "server-only";
import { createClient } from "@/lib/supabase/server";
import { NOTIFICATION_CENTER_TYPES } from "./center";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  transaction_id: string | null;
  /** Populated for type=prediction_graded (lib/notifications/predictions.ts) and, as of the Call BS exclusivity addendum, every CALL_BS_* type (lib/notifications/challenges.ts) — the canonical Post this notification is about. See lib/notifications/links.ts's resolveNotificationHref, which prefers market_id over this for prediction_graded but prefers this over market_id for CALL_BS_* types. */
  post_id: string | null;
  /** Populated for type=prediction_graded and every CALL_BS_* type — the specific Market this notification is about. See lib/notifications/links.ts's resolveNotificationHref for the per-type priority between this and post_id. */
  market_id: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * RLS already scopes this to the caller's own rows
 * (notifications_own_only). Phase G — scoped to NOTIFICATION_CENTER_TYPES,
 * so the nav badge count can never disagree with what /notifications
 * actually renders (a legacy/disabled-feature unread row would otherwise
 * inflate the badge while staying invisible in the center itself).
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("type", NOTIFICATION_CENTER_TYPES)
    .is("read_at", null);

  return count ?? 0;
}

/** Phase G — scoped to NOTIFICATION_CENTER_TYPES (see that module's own exhaustive classification comment) so every caller (the /notifications page, the toast poll) sees the same redesigned-center set. */
export async function getNotifications(userId: string): Promise<NotificationRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, transaction_id, post_id, market_id, read_at, created_at")
    .eq("user_id", userId)
    .in("type", NOTIFICATION_CENTER_TYPES)
    .order("created_at", { ascending: false });

  return data ?? [];
}
