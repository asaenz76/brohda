"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getNotifications, getUnreadCount } from "@/lib/notifications/fetch";
import { attachNotificationHrefs } from "@/lib/notifications/links";

export interface NotificationPollState {
  unreadCount: number;
  latestId: string | null;
  latestType: string | null;
  latestTitle: string | null;
  latestBody: string | null;
  latestHref: string | null;
}

// Backs NotificationToast's client-side polling (Decision 5: poll the
// existing unread-count query, no realtime subscription infra).
export async function getNotificationPollStateAction(): Promise<NotificationPollState> {
  const user = await requireUser();
  const [unreadCount, notifications] = await Promise.all([
    getUnreadCount(user.id),
    getNotifications(user.id),
  ]);
  const [latest] = attachNotificationHrefs(notifications.slice(0, 1));

  return {
    unreadCount,
    latestId: latest?.id ?? null,
    latestType: latest?.type ?? null,
    latestTitle: latest?.title ?? null,
    latestBody: latest?.body ?? null,
    latestHref: latest?.href ?? null,
  };
}

// notifications RLS only grants `select` to authenticated — marking read is
// a service-role write, scoped to the caller's own rows by requireUser(),
// never trusting a client-supplied user id.
export async function markNotificationsReadAction() {
  const user = await requireUser();
  const admin = createAdminClient();

  await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);

  revalidatePath("/notifications");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks ONE notification read — the one the Member just opened. Scoped to the caller's own row by requireUser(); a client-supplied id for someone else's notification (or a malformed one) matches nothing and
 * changes nothing. Idempotent. "Mark all read" stays as the bulk action.
 */
export async function markNotificationReadAction(notificationId: string): Promise<void> {
  const user = await requireUser();
  if (typeof notificationId !== "string" || !UUID.test(notificationId)) return;
  await createAdminClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", user.id)
    .is("read_at", null);
}
