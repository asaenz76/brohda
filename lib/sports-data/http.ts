import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

export class PermanentProviderError extends Error {}

type FetchWithRetryOptions = {
  provider: string;
  requestType: string;
  requestParams?: Record<string, unknown>;
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
          durationMs: Date.now() - startedAt,
        });
        throw new PermanentProviderError(`Provider returned permanent error ${response.status}`);
      }

      lastError = new Error(`Provider returned retryable error ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentProviderError) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  await logRequest({
    ...options,
    error: lastError instanceof Error ? lastError.message : "unknown error",
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
      duration_ms: params.durationMs,
    });
  } catch {
    // Logging must never break the actual sync/import flow.
  }
}
