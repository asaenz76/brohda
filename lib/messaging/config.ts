import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";

// The one place Messaging policy is read. Everything here comes from platform_settings (migration 198) — nothing is a constant in code — and the capability FAILS CLOSED: only a successfully read,
// literal `true` is ON; a missing row, a malformed value or an unreadable setting is OFF.

export interface RateLimitPolicy {
  windowSeconds: number;
  max: number;
}

export interface MessagingConfig {
  enabled: boolean;
  maxMessageLength: number;
  maxUnansweredRequests: number;
  unsendWindowSeconds: number;
  pollIntervalSeconds: number;
  sendRate: RateLimitPolicy;
  requestRate: RateLimitPolicy;
  reportRate: RateLimitPolicy;
}

const COLUMNS =
  "messaging_enabled, messaging_max_message_length, messaging_max_unanswered_requests, messaging_unsend_window_seconds, messaging_poll_interval_seconds, messaging_send_rate_window_seconds, messaging_send_rate_max, messaging_request_rate_window_seconds, messaging_request_rate_max, messaging_report_rate_window_seconds, messaging_report_rate_max";

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** The policy, or null when it cannot be read or any value is malformed — callers treat null as OFF. */
export const getMessagingConfig = cache(async (): Promise<MessagingConfig | null> => {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select(COLUMNS).eq("id", true).single();
    if (error || !data || data.messaging_enabled !== true) return null;
    const numbers = [
      data.messaging_max_message_length, data.messaging_max_unanswered_requests, data.messaging_poll_interval_seconds, data.messaging_send_rate_window_seconds, data.messaging_send_rate_max,
      data.messaging_request_rate_window_seconds, data.messaging_request_rate_max, data.messaging_report_rate_window_seconds, data.messaging_report_rate_max,
    ];
    if (!numbers.every(isPositiveInt) || typeof data.messaging_unsend_window_seconds !== "number" || data.messaging_unsend_window_seconds < 0) return null;
    return {
      enabled: true,
      maxMessageLength: data.messaging_max_message_length,
      maxUnansweredRequests: data.messaging_max_unanswered_requests,
      unsendWindowSeconds: data.messaging_unsend_window_seconds,
      pollIntervalSeconds: data.messaging_poll_interval_seconds,
      sendRate: { windowSeconds: data.messaging_send_rate_window_seconds, max: data.messaging_send_rate_max },
      requestRate: { windowSeconds: data.messaging_request_rate_window_seconds, max: data.messaging_request_rate_max },
      reportRate: { windowSeconds: data.messaging_report_rate_window_seconds, max: data.messaging_report_rate_max },
    };
  } catch {
    return null;
  }
});

/**
 * Is Messaging ON? Used on every signed-in page by the shell, so it reads ONE boolean (not the whole policy) and is de-duplicated within a render. FAILS CLOSED: only a successfully read literal `true`.
 * The pages that actually show Messaging read and validate the full policy through getMessagingConfig.
 */
export const isMessagingEnabled = cache(async (): Promise<boolean> => {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select("messaging_enabled").eq("id", true).single();
    return !error && data?.messaging_enabled === true;
  } catch {
    return false;
  }
});

/** The raw settings for the Super Admin card, even while the capability is OFF. Throws if unreadable — nothing is invented. */
export async function getMessagingSettingsForAdmin(): Promise<Record<string, number | boolean | null>> {
  const { data, error } = await createAdminClient().from("platform_settings").select("*").eq("id", true).single();
  if (error || !data) throw new Error("Could not read the Messaging settings.");
  const out: Record<string, number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) if (key.startsWith("messaging_")) out[key] = value as number | boolean | null;
  return out;
}
