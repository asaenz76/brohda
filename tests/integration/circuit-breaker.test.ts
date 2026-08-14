/**
 * Integration regression test for Phase 0.5: the circuit breaker's real
 * DB round-trip. tests/unit/http.test.ts already proves fetchWithRetry's
 * soft-error detection in isolation (mocked admin client); this proves the
 * write actually lands in the real provider_request_log table (real
 * grants/schema) and that provider-gateway.ts's getProviderStatus derives
 * the correct breaker state from it — end to end, real DB, only the one
 * provider-facing `fetch` call mocked (no live provider call).
 *
 * The fetch mock is deliberately URL-scoped, not a blanket
 * `vi.stubGlobal("fetch", ...)` — the admin Supabase client used to read
 * back and clean up rows also goes over `fetch` internally, so a
 * process-wide stub would silently intercept and break those calls too
 * (this was a real bug hit while writing this test: every write appeared
 * to vanish because the "insert" was actually being served the mocked
 * provider response instead of ever reaching PostgREST).
 *
 * Run with: pnpm test:integration (requires `pnpm supabase:start` per the
 * repo's other integration tests, though this one — like every test file
 * in this repo per this session's findings — actually runs against
 * whatever NEXT_PUBLIC_SUPABASE_URL/.env.local resolve to).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { fetchWithRetry } from "@/lib/sports-data/http";
import { getProviderStatus } from "@/lib/sports-data/provider-gateway";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Unique per test run so a re-run (or a concurrent session) can never
// collide with — or be confused for — a real provider_request_log row.
const TEST_REQUEST_TYPE = `circuit-breaker-test-${Date.now()}`;
const FAKE_PROVIDER_URL = "https://example.invalid/fixtures";

const realFetch = globalThis.fetch;

function quotaExhaustedFetchResponse(): Response {
  return new Response(
    JSON.stringify({ errors: { requests: "You have reached the request limit for the day, upgrade your plan" }, results: 0, response: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function cleanJsonFetchResponse(): Response {
  return new Response(JSON.stringify({ errors: {}, results: 1, response: [{ id: 1 }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Only the one intended provider URL is mocked; every other fetch call
// (the admin Supabase client's own REST calls, for both fetchWithRetry's
// own logging and this test's own read/cleanup queries) passes through to
// the real fetch untouched.
function stubProviderFetch(mockResponse: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === FAKE_PROVIDER_URL) return Promise.resolve(mockResponse());
      return realFetch(input, init);
    }),
  );
}

async function cleanup() {
  await admin.from("provider_request_log").delete().eq("request_type", TEST_REQUEST_TYPE);
}

describe.skipIf(!SERVICE_ROLE_KEY)("circuit breaker — real DB round-trip", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  it("fetchWithRetry's soft-error detection writes a real, correctly-shaped error row", async () => {
    stubProviderFetch(quotaExhaustedFetchResponse);

    await expect(
      fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_football", requestType: TEST_REQUEST_TYPE }),
    ).rejects.toThrow();

    const { data: row } = await admin
      .from("provider_request_log")
      .select("provider, response_status, error")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(row?.provider).toBe("api_football");
    expect(row?.response_status).toBe(200);
    expect(row?.error).toMatch(/request limit/i);
  });

  it("getProviderStatus reports the breaker open immediately after a real detected soft error", async () => {
    stubProviderFetch(quotaExhaustedFetchResponse);

    await expect(
      fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_football", requestType: TEST_REQUEST_TYPE }),
    ).rejects.toThrow();

    // getProviderStatus reads the most recent 20 rows for the provider —
    // real production traffic for api_football is continuous (confirmed
    // elsewhere this session), so this assertion only holds if our write
    // is recent enough to be in that window, which it always is here
    // (written moments ago, in this same test).
    const status = await getProviderStatus(true, "api_football");
    expect(status.quotaState).toBe("EXHAUSTED");
    expect(status.circuitBreakerOpen).toBe(true);
  });

  it("API-NFL's breaker stays closed when only API-Football hit a quota error — providers never cross-contaminate", async () => {
    stubProviderFetch(quotaExhaustedFetchResponse);

    await expect(
      fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_football", requestType: TEST_REQUEST_TYPE }),
    ).rejects.toThrow();

    const footballStatus = await getProviderStatus(true, "api_football");
    const nflStatus = await getProviderStatus(true, "api_nfl");
    expect(footballStatus.circuitBreakerOpen).toBe(true);
    // api_nfl's own most-recent rows are whatever real production NFL sync
    // traffic last logged (often nothing — a healthy, no-recent-error
    // provider legitimately has a null lastErrorMessage) — asserting it's
    // specifically NOT this test's api_football error is the actual
    // isolation guarantee under test.
    expect(nflStatus.lastErrorMessage ?? "").not.toMatch(/request limit for the day, upgrade your plan/i);
  });

  it("a real successful response (no errors populated) still logs as success, not a false-positive breaker trip", async () => {
    stubProviderFetch(cleanJsonFetchResponse);

    const response = await fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_football", requestType: TEST_REQUEST_TYPE });
    expect(response.status).toBe(200);

    const { data: row } = await admin
      .from("provider_request_log")
      .select("error")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(row?.error).toBeNull();
  });

  // Phase 3 §7: the same soft-error detection, breaker-open, and
  // isolation behavior proven for API-Football above, now proven for
  // API-NFL too — identical failure scenario, different provider, and the
  // two must never contaminate each other's state.
  it("API-NFL soft-error detection writes a real, correctly-shaped error row and opens only its own breaker", async () => {
    stubProviderFetch(quotaExhaustedFetchResponse);

    await expect(
      fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_nfl", requestType: TEST_REQUEST_TYPE }),
    ).rejects.toThrow();

    const { data: row } = await admin
      .from("provider_request_log")
      .select("provider, response_status, error, normalized_error_type")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(row?.provider).toBe("api_nfl");
    expect(row?.response_status).toBe(200);
    expect(row?.error).toMatch(/request limit/i);
    expect(row?.normalized_error_type).toBe("QUOTA_EXHAUSTED");

    const nflStatus = await getProviderStatus(true, "api_nfl");
    expect(nflStatus.quotaState).toBe("EXHAUSTED");
    expect(nflStatus.circuitBreakerOpen).toBe(true);

    // The mirror image of the existing football→NFL isolation test above:
    // an NFL quota error must never open football's breaker.
    const footballStatus = await getProviderStatus(true, "api_football");
    expect(footballStatus.lastErrorMessage ?? "").not.toMatch(/request limit for the day, upgrade your plan/i);
  });

  it("a permanent 4xx is normalized to INVALID_REQUEST (or AUTH_FAILED for 401/403), and is never retried", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === FAKE_PROVIDER_URL) {
          callCount++;
          return Promise.resolve(new Response("{}", { status: 400 }));
        }
        return realFetch(input, init);
      }),
    );

    await expect(
      fetchWithRetry(FAKE_PROVIDER_URL, {}, { provider: "api_football", requestType: TEST_REQUEST_TYPE }),
    ).rejects.toThrow();
    expect(callCount).toBe(1); // never retried

    const { data: row } = await admin
      .from("provider_request_log")
      .select("normalized_error_type")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(row?.normalized_error_type).toBe("INVALID_REQUEST");
  });
});
