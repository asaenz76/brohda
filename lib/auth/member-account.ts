import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Explicitly types a freshly created auth user as a MEMBER, BEFORE its profile is written. Idempotent (a second call is a no-op) and refuses — by
 * throwing — if the login is already typed anything else (a Sponsor), so no Member-creation path (self-registration, invitation, admin-created) can ever
 * turn a Sponsor login into a Member. The database trigger on user_profiles enforces the same rule independently.
 */
export async function typeAccountAsMember(db: SupabaseClient, userId: string): Promise<void> {
  const { error } = await db.from("account_types").upsert({ user_id: userId, account_type: "MEMBER" }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw error;
  const { data, error: readError } = await db.from("account_types").select("account_type").eq("user_id", userId).single();
  if (readError) throw readError;
  if (data.account_type !== "MEMBER") throw new Error("account_is_not_a_member");
}
