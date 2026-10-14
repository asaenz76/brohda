import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MessagingConfig, RateLimitPolicy } from "@/lib/messaging/config";

// Messaging rate limits. The windows and caps come from platform_settings, never from constants here. They go through messaging_rate_limit (service role only, migration 198) with an identifier the server
// builds from the AUTHENTICATED Member — NOT through the shared client-callable limiter, which any signed-in Member could call with someone else's identifier to burn that person's allowance.
// Unlike the shared limiter this FAILS CLOSED: if the limiter cannot answer, the action is refused rather than allowed (a send needs the same database anyway). The database-side rules — the capability,
// the unanswered-request cap, the duplicate-content rule — are enforced independently of it.

async function limit(prefix: string, userId: string, policy: RateLimitPolicy): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("messaging_rate_limit", { p_identifier: `${prefix}:${userId}`, p_window_seconds: policy.windowSeconds, p_max_attempts: policy.max });
  return !error && data === true;
}

/** Sending, unsending, blocking, muting: ordinary conversation traffic. */
export const checkMessagingSendRateLimit = (userId: string, c: MessagingConfig) => limit("msg_send", userId, c.sendRate);
/** Starting a new conversation or sending a request: tighter, because it reaches someone who has not agreed to hear from you. */
export const checkMessagingRequestRateLimit = (userId: string, c: MessagingConfig) => limit("msg_request", userId, c.requestRate);
export const checkMessagingReportRateLimit = (userId: string, c: MessagingConfig) => limit("msg_report", userId, c.reportRate);
