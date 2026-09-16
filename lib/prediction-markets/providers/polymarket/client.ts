import "server-only";
import { rawGammaListResponseSchema } from "./schema";
import { PolymarketPermanentError, PolymarketTransientError, PolymarketValidationError } from "./errors";

// Gamma API — Polymarket's public, unauthenticated market-discovery service
// (docs.polymarket.com/api-reference/predictions/overview: "Public market
// data is available without credentials"). This client only ever calls this
// base URL's read-only list endpoint — no CLOB, no trading, no wallet
// interaction of any kind. See docs/architecture/prediction-market-provider.md
// for the full research trail.
const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

// No documented rate limit was found in official Polymarket docs at
// research time (see the architecture doc). This is our own conservative,
// undocumented-by-the-provider default, not a provider-mandated value —
// kept small deliberately since Milestone 1 has no production scheduling
// anyway (roadmap STEP 17).
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchMarketsPageParams {
  /** Cursor from a previous page's response; omit for the first page. Gamma's `/markets/keyset` is cursor-based, not offset-based (docs.polymarket.com/market-data/discover-markets). */
  afterCursor?: string;
  limit: number;
  /** Maps to Gamma's documented `closed` filter. */
  closed?: boolean;
  /** Maps to Gamma's documented `tag_id` filter. */
  tagId?: string;
}

export interface FetchMarketsPageResult {
  /** Unvalidated per-market items — the adapter validates each one individually so a single malformed market never fails the whole page (see schema.ts's comment on rawGammaListResponseSchema). */
  rawMarkets: unknown[];
  nextCursor: string | null;
}

/**
 * Fetches one page of `/markets/keyset`. Retries transient failures
 * (network error, 5xx, 429) with exponential backoff; permanent 4xx errors
 * and schema-validation failures are never retried — a malformed response
 * will fail identically on immediate retry (mirrors the retry/no-retry
 * split already established in lib/sports-data/http.ts for a different
 * provider, applied here as its own, provider-specific implementation
 * rather than a shared import — Polymarket's error-signaling convention,
 * plain HTTP status codes, is different enough from API-Sports' "200 with
 * a populated `errors` field" convention that sharing the helper would
 * mean smuggling one provider's assumptions into the other's client).
 */
export async function fetchMarketsPage(params: FetchMarketsPageParams): Promise<FetchMarketsPageResult> {
  const url = new URL("/markets/keyset", GAMMA_BASE_URL);
  url.searchParams.set("limit", String(params.limit));
  if (params.afterCursor) url.searchParams.set("after_cursor", params.afterCursor);
  if (params.closed != null) url.searchParams.set("closed", String(params.closed));
  if (params.tagId) url.searchParams.set("tag_id", params.tagId);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) {
        return parseListResponse(await safeJson(response));
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new PolymarketTransientError(`Gamma API returned ${response.status}`);
      } else {
        throw new PolymarketPermanentError(`Gamma API returned permanent error ${response.status}`);
      }
    } catch (error) {
      if (error instanceof PolymarketPermanentError || error instanceof PolymarketValidationError) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gamma API request failed");
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PolymarketValidationError("Gamma API response was not valid JSON");
  }
}

function parseListResponse(body: unknown): FetchMarketsPageResult {
  const result = rawGammaListResponseSchema.safeParse(body);
  if (!result.success) {
    throw new PolymarketValidationError(`Gamma API list response did not match the expected shape: ${result.error.message}`);
  }

  if (Array.isArray(result.data)) {
    // A plain-array response has no documented cursor field — treat it as
    // the final page rather than guessing at a continuation token that
    // isn't there.
    return { rawMarkets: result.data, nextCursor: null };
  }

  // Confirmed real shape (live-verified 2026-09-15): `{ markets: [...],
  // next_cursor }`. The `data` variant is kept as a fallback for a
  // different endpoint/version, not the primary case.
  const rawMarkets = "markets" in result.data ? result.data.markets : result.data.data;
  return {
    rawMarkets,
    nextCursor: result.data.next_cursor ?? result.data.nextCursor ?? null,
  };
}
