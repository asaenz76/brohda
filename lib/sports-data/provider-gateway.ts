import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// API-Football's real, observed soft-error phrasing for the two quota
// conditions confirmed live this session: the daily cap ("You have
// reached the request limit for the day...") and the per-minute rate
// limit ("Too many requests. You have exceeded the limit of requests per
// minute..."). Matched case-insensitively and loosely (substring, not an
// exact string) since the provider's exact wording isn't a documented,
// stable contract — this is read from ProviderApiError.message, itself
// built from the raw `errors` object api-football-provider.ts already
// parses out of a 200 response.
const QUOTA_ERROR_PATTERN = /request limit|too many requests|rate limit|quota/i;

/** Whether a caught error looks like a provider quota/rate-limit
 * condition rather than some other failure (network error, malformed
 * response, genuine 4xx/5xx) — the signal every multi-competition loop
 * (discovery sync, recommendation cache refresh) needs to stop entirely
 * instead of burning its remaining calls on guaranteed-to-fail requests. */
export function isQuotaExhaustedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return QUOTA_ERROR_PATTERN.test(message);
}

export type ProviderQuotaState = "OK" | "EXHAUSTED" | "UNKNOWN";

export interface ProviderStatus {
  enabled: boolean;
  quotaState: ProviderQuotaState;
  lastSuccessfulRequestAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  requestsLast24h: number;
  circuitBreakerOpen: boolean;
}

// How far back a quota-pattern error still counts as "the breaker is
// open" — API-Football's daily quota resets on a fixed clock we don't
// know exactly, and the per-minute limit clears itself within a minute,
// so this is a conservative "assume still exhausted for a while" window
// rather than a precise reset-time calculation (which would need a real
// value from the provider's response headers — not confirmed available
// on the plan this session observed).
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60_000;

/**
 * Derives provider health entirely from provider_request_log — no
 * separate state table to keep in sync, and it's already the durable,
 * cross-invocation record every provider call writes to (see
 * lib/sports-data/http.ts's fetchWithRetry). Backs the admin Provider
 * Status panel and can be reused by any caller that wants to check
 * "is it even worth trying" before looping over many competitions.
 *
 * `provider` defaults to "api_football" so every existing call site keeps
 * working unchanged; a second provider (e.g. "api_nfl") gets its own
 * independent circuit-breaker/quota read by passing its own provider key
 * — provider_request_log already has a `provider` column per row, so
 * this is a filter parameter, not a schema or behavior change.
 */
export async function getProviderStatus(
  providerEnabled: boolean,
  provider: string = "api_football",
): Promise<ProviderStatus> {
  if (!providerEnabled) {
    return {
      enabled: false,
      quotaState: "UNKNOWN",
      lastSuccessfulRequestAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      requestsLast24h: 0,
      circuitBreakerOpen: false,
    };
  }

  const adminClient = createAdminClient();
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [{ data: recentRows }, { count: requestsLast24h }] = await Promise.all([
    adminClient
      .from("provider_request_log")
      .select("response_status, error, created_at")
      .eq("provider", provider)
      .order("created_at", { ascending: false })
      .limit(20),
    adminClient
      .from("provider_request_log")
      .select("*", { count: "exact", head: true })
      .eq("provider", provider)
      .gte("created_at", since24h),
  ]);

  const rows = recentRows ?? [];
  const lastSuccess = rows.find((r) => !r.error);
  const lastError = rows.find((r) => r.error);

  let quotaState: ProviderQuotaState = "UNKNOWN";
  let circuitBreakerOpen = false;
  if (lastError && isQuotaExhaustedError(new Error(lastError.error ?? ""))) {
    const errorAgeMs = Date.now() - new Date(lastError.created_at).getTime();
    quotaState = "EXHAUSTED";
    circuitBreakerOpen = errorAgeMs < CIRCUIT_BREAKER_COOLDOWN_MS;
  } else if (rows.length > 0) {
    quotaState = "OK";
  }

  return {
    enabled: true,
    quotaState,
    lastSuccessfulRequestAt: lastSuccess?.created_at ?? null,
    lastErrorAt: lastError?.created_at ?? null,
    lastErrorMessage: lastError?.error ?? null,
    requestsLast24h: requestsLast24h ?? 0,
    circuitBreakerOpen,
  };
}
