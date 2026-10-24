import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Whether the self-service /register page currently creates accounts.
 * Readable by anyone — both the pre-auth /register page and the login page's
 * "Create an account" link need this before any session exists — but ONLY
 * through public.public_platform_settings, the one narrow surface a visitor
 * may read (the rest of platform_settings is operational configuration and
 * is read by the server with the service role). */
export async function getRegistrationEnabled(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("public_platform_settings")
    .select("registration_enabled")
    .single();

  return data?.registration_enabled ?? false;
}
