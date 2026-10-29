import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type RateLimitVerdict = "allowed" | "limited" | "unavailable";

/**
 * Shared core behind every rate-limited endpoint (spec §19: "login, entry, share-link resolution"). Backed by the `check_and_increment_rate_limit` Postgres function (one atomic upsert — see migration 221),
 * which only the service role may execute: an identifier is chosen by the server, never by a caller, so nobody can spend another person's allowance.
 * "unavailable" means the check itself could not be made; each caller decides what that means for it.
 */
export async function checkRateLimitVerdict(identifier: string, windowSeconds: number, maxAttempts: number): Promise<RateLimitVerdict> {
  try {
    const { data, error } = await createAdminClient().rpc("check_and_increment_rate_limit", {
      p_identifier: identifier,
      p_window_seconds: windowSeconds,
      p_max_attempts: maxAttempts,
    });
    if (error) {
      console.error("Rate limit check failed:", error.message);
      return "unavailable";
    }
    return data === true ? "allowed" : "limited";
  } catch (error) {
    console.error("Rate limit check failed:", error instanceof Error ? error.message : "unknown error");
    return "unavailable";
  }
}

/**
 * True when the attempt is allowed. Fails OPEN when the check cannot be made — a transient hiccup shouldn't lock out real users, and each caller's own backstop (Supabase Auth throttling,
 * wallet balance checks, etc.) still applies. Callers that create accounts use checkRateLimitVerdict and decide for themselves.
 */
export async function checkRateLimit(identifier: string, windowSeconds: number, maxAttempts: number): Promise<boolean> {
  return (await checkRateLimitVerdict(identifier, windowSeconds, maxAttempts)) !== "limited";
}
