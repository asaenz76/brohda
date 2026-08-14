// A small, shared classification over whatever a provider call actually
// threw — Phase 3 spec §10. Existing error classes (PermanentProviderError/
// ProviderSoftError in http.ts, ProviderApiError per-provider) stay as the
// throw sites; this only normalizes what they mean for logging/health,
// preserving the original message for diagnostics rather than discarding
// it. Never includes secrets/headers — every message here already comes
// from a provider's own JSON error body or a generic fetch failure, never
// from request construction.
//
// Deliberately message-pattern-based rather than `instanceof
// PermanentProviderError`/`instanceof ProviderSoftError` — those classes
// live in http.ts, which this module must stay independent of (http.ts's
// own logRequest calls classifyProviderError for every terminal outcome;
// importing back from provider-errors.ts would be circular). Each class's
// message is itself distinctive enough to classify by pattern (see the
// permanent-error message shape below), so no import is needed.
export type ProviderErrorType =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED_OPERATION"
  | "UNKNOWN";

/** Thrown by a call site that explicitly checked provider-capabilities.ts's
 * `supports()` and found the operation genuinely unavailable — spec §3's
 * "fail explicitly ... do not silently route to football" and §4's "do
 * not rely on catching 'method not implemented' exceptions as normal
 * flow" (this is the one typed exception meant to be caught deliberately,
 * not a stand-in for a stub's silent empty return). */
export class UnsupportedOperationError extends Error {
  constructor(provider: string, operation: string) {
    super(`${provider} does not support ${operation}.`);
    this.name = "UnsupportedOperationError";
  }
}

// Daily-quota and per-minute-rate-limit wording, split from http.ts's
// broader QUOTA_ERROR_PATTERN (which deliberately keeps them merged for
// the single "should this batch stop" signal isQuotaExhaustedError gives
// callers) — here they're kept apart because the taxonomy has a slot for
// each. Same live-observed API-Sports phrasing http.ts's own comment
// documents.
const DAILY_QUOTA_PATTERN = /request limit|quota/i;
const RATE_LIMIT_PATTERN = /too many requests|rate limit/i;
const AUTH_PATTERN = /unauthorized|invalid.*api.?key|forbidden|\b401\b|\b403\b/i;
const MALFORMED_PATTERN = /json|malformed|unexpected token/i;
const UNAVAILABLE_PATTERN = /network|fetch failed|econnrefused|econnreset|etimedout|enotfound/i;
// http.ts's PermanentProviderError message shape exactly ("Provider
// returned permanent error 404") — the status code is the only
// distinguishing detail, so 401/403 (an auth failure wearing a generic
// permanent-error message) is pulled out before falling through to the
// generic "some other 4xx" case.
const PERMANENT_ERROR_PATTERN = /^Provider returned permanent error (\d+)$/;

export function classifyProviderError(error: unknown): ProviderErrorType {
  if (error instanceof UnsupportedOperationError) return "UNSUPPORTED_OPERATION";

  const message = error instanceof Error ? error.message : String(error);

  if (RATE_LIMIT_PATTERN.test(message)) return "RATE_LIMITED";
  if (DAILY_QUOTA_PATTERN.test(message)) return "QUOTA_EXHAUSTED";
  if (AUTH_PATTERN.test(message)) return "AUTH_FAILED";

  const permanentMatch = PERMANENT_ERROR_PATTERN.exec(message);
  if (permanentMatch) {
    const status = Number(permanentMatch[1]);
    return status === 401 || status === 403 ? "AUTH_FAILED" : "INVALID_REQUEST";
  }

  if (MALFORMED_PATTERN.test(message)) return "MALFORMED_RESPONSE";
  if (UNAVAILABLE_PATTERN.test(message)) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN";
}
