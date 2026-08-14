import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyProviderError } from "./provider-errors";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

export class PermanentProviderError extends Error {}

/**
 * A provider-level soft error — API-Sports (both API-Football and API-NFL,
 * same envelope convention) signals quota exhaustion and other request
 * failures with an HTTP 200 whose JSON body has a populated `errors` field
 * (confirmed live: `{"errors":{"requests":"You have reached the request
 * limit for the day..."},"results":0,"response":[]}`). Previously this was
 * only ever detected by each provider's own parseApiFootballBody/
 * parseApiNflBody, called *after* fetchWithRetry had already logged the
 * response as a plain success — meaning provider_request_log, and every
 * circuit-breaker read derived from it (provider-gateway.ts), never saw
 * this failure at all. Detected here instead, at the one shared layer both
 * providers' HTTP calls pass through, so the log and the breaker are
 * correct regardless of which provider or endpoint made the call.
 */
export class ProviderSoftError extends Error {}

// Every real 200-status API-Sports response has an `errors` field, normally
// empty (`{}`/`[]`) on success — only a *populated* one is a failure. This
// mirrors parseApiFootballBody/parseApiNflBody's own check exactly, kept
// here as a second, earlier read of the same convention (not a replacement
// for those — they remain the defense-in-depth check against any body
// shape this generic peek doesn't recognize).
async function detectSoftError(response: Response): Promise<{ message: string; snippet: string } | null> {
  let body: unknown;
  try {
    // .clone() so this peek never consumes the body the caller's own
    // parseApiFootballBody/parseApiNflBody still needs to read afterward.
    body = await response.clone().json();
  } catch {
    return null; // Not JSON (or malformed) — not this convention, not our call to judge.
  }
  if (body == null || typeof body !== "object" || !("errors" in body)) return null;

  const errors = (body as { errors?: unknown }).errors;
  const hasErrors = errors != null && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors as object).length > 0);
  if (!hasErrors) return null;

  const summary = Array.isArray(errors)
    ? errors.map(String).join("; ")
    : Object.values(errors as Record<string, unknown>).map(String).join("; ");
  return { message: `Provider request failed: ${summary}`, snippet: JSON.stringify(body).slice(0, 500) };
}

type FetchWithRetryOptions = {
  provider: string;
  requestType: string;
  requestParams?: Record<string, unknown>;
  // Phase 3 spec §8: which kind of caller made this request — distinct
  // scheduled jobs, manual admin actions, pool creation, discovery, and
  // troubleshooting lookups from each other in provider_request_log,
  // without requiring every call site to populate it (optional; a request
  // logged without one is just less filterable later, never a hard
  // requirement to add).
  callerCategory?: "manual_admin" | "scheduled_sync" | "pool_creation" | "discovery" | "troubleshooting";
};

/**
 * Wraps `fetch` with exponential backoff on retryable failures (5xx, 429,
 * network errors) up to MAX_ATTEMPTS. Permanent validation errors (other
 * 4xx) are never retried, per spec §9. Every terminal outcome is logged to
 * `provider_request_log` for caching/debugging — logging failures never
 * break the caller.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        const softError = await detectSoftError(response);
        if (softError) {
          // Never retried — same reasoning as the permanent-4xx branch
          // below: a quota-exhausted (or otherwise provider-rejected)
          // request will fail identically on immediate retry, so retrying
          // only spends more of the same exhausted quota. Logged as a real
          // error (not the plain success this used to be) so
          // provider-gateway.ts's circuit breaker actually sees it. Every
          // soft error observed so far is the quota-exhaustion convention
          // — known directly here, no message-pattern guess needed.
          await logRequest({
            ...options,
            responseStatus: response.status,
            responseSnippet: softError.snippet,
            error: softError.message,
            normalizedErrorType: "QUOTA_EXHAUSTED",
            durationMs: Date.now() - startedAt,
          });
          throw new ProviderSoftError(softError.message);
        }

        await logRequest({
          ...options,
          responseStatus: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const snippet = await safeSnippet(response);
        await logRequest({
          ...options,
          responseStatus: response.status,
          responseSnippet: snippet,
          error: `permanent error: ${response.status}`,
          normalizedErrorType: response.status === 401 || response.status === 403 ? "AUTH_FAILED" : "INVALID_REQUEST",
          durationMs: Date.now() - startedAt,
        });
        throw new PermanentProviderError(`Provider returned permanent error ${response.status}`);
      }

      lastError = new Error(`Provider returned retryable error ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentProviderError || error instanceof ProviderSoftError) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  await logRequest({
    ...options,
    error: lastError instanceof Error ? lastError.message : "unknown error",
    normalizedErrorType: classifyProviderError(lastError),
    durationMs: Date.now() - startedAt,
  });

  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeSnippet(response: Response): Promise<string> {
  try {
    const text = await response.clone().text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

async function logRequest(params: {
  provider: string;
  requestType: string;
  requestParams?: Record<string, unknown>;
  responseStatus?: number;
  responseSnippet?: string;
  error?: string;
  normalizedErrorType?: string;
  callerCategory?: string;
  durationMs: number;
}) {
  try {
    const admin = createAdminClient();
    await admin.from("provider_request_log").insert({
      provider: params.provider,
      request_type: params.requestType,
      request_params: params.requestParams ?? null,
      response_status: params.responseStatus ?? null,
      response_snippet: params.responseSnippet ?? null,
      error: params.error ?? null,
      normalized_error_type: params.normalizedErrorType ?? null,
      caller_category: params.callerCategory ?? null,
      duration_ms: params.durationMs,
    });
  } catch {
    // Logging must never break the actual sync/import flow.
  }
}
