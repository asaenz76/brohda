import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS entirely — only ever use this from
 * trusted server code (server actions, route handlers, scripts) for the
 * specific operations the spec calls out as admin/service-role-only
 * (role/is_active changes, invitation issuance, audit log writes, avatar
 * storage writes). Never import this into client components.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
