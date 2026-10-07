import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Is Sponsored Game Posts ON? The canonical sponsorship capability (platform_settings.sponsorship_enabled). FAILS CLOSED: only a successfully read,
 * literal `true` is ON — a missing row, a malformed value or an unreadable setting is OFF. (The database applies the same rule to every sponsor action.)
 */
export async function isSponsorshipEnabled(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("platform_settings").select("sponsorship_enabled").eq("id", true).single();
    if (error || !data) return false;
    return data.sponsorship_enabled === true;
  } catch {
    return false;
  }
}
