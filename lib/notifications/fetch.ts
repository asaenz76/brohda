import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  pool_id: string | null;
  transaction_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** RLS already scopes this to the caller's own rows (notifications_own_only). */
export async function getUnreadCount(userId: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);

  return count ?? 0;
}

export async function getNotifications(userId: string): Promise<NotificationRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, pool_id, transaction_id, read_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return data ?? [];
}
