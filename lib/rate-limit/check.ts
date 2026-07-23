import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Shared core behind every rate-limited endpoint (spec §19: "login, entry,
 * share-link resolution"). Backed by the `check_and_increment_rate_limit`
 * Postgres function (see supabase/migrations/*_rate_limits.sql). Fails open
 * on a DB error — a transient hiccup shouldn't lock out real users; each
 * caller's own backstop (Supabase Auth throttling, wallet balance checks,
 * etc.) still applies regardless.
 */
export async function checkRateLimit(
  identifier: string,
  windowSeconds: number,
  maxAttempts: number,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
    p_identifier: identifier,
    p_window_seconds: windowSeconds,
    p_max_attempts: maxAttempts,
  });

  if (error) {
    console.error("Rate limit check failed:", error.message);
    return true;
  }

  return data === true;
}
