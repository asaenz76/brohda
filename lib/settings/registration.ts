import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Whether the self-service /register page currently creates accounts.
 * Readable by anyone (RLS grants anon+authenticated select) since both the
 * pre-auth /register page and the login page's "Create an account" link
 * need this before any session exists. */
export async function getRegistrationEnabled(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("registration_enabled")
    .eq("id", true)
    .single();

  return data?.registration_enabled ?? false;
}
