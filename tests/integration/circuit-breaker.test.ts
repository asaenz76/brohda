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
 * Run with: pnpm test:integration (requires `pnpm supabase:start` — see
 * tests/integration/helpers/test-env.ts for how this and every other
 * integration test resolves its Supabase target).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { fetchWithRetry } from "@/lib/sports-data/http";
import { getProviderStatus } from "@/lib/sports-data/provider-gateway";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

// Unique per test run so a re-run (or a concurrent session) can never
// collide with — or be confused for — a real provider_request_log row.
const TEST_REQUEST_TYPE = `circuit-breaker-test-${Date.now()}`;
const FAKE_PROVIDER_URL = "https://example.invalid/fixtures";

// Phase 4.1: provider_request_log is a real, continuously-growing
// production table (3.5M+ rows from real cron traffic) — cleanup()
// used to delete by `.eq("request_type", ...)` alone, which has no
// supporting index (request_type isn't indexed at all) and forced a full
// table scan on every afterEach, intermittently exceeding Vitest's
// default 10s hookTimeout. Bounding by `created_at` first lets Postgres
// use idx_provider_request_log_created_at to narrow before the
// request_type filter ever runs — same fix already proven in
// provider-infrastructure.test.ts's own cleanup(), just never applied
// here. A slow/timed-out cleanup wasn't just an annoyance: Vitest doesn't
// cancel the in-flight delete on a hook timeout, so it kept running
// server-side and could delete a LATER test's just-written row before
// that test's own read-back ran — the exact cause of two other failures
// in this file that looked unrelated at first (both read back `undefined`
// instead of a real row).
const CLEANUP_SINCE = new Date(Date.now() - 3600_000).toISOString();

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
  await admin.from("provider_request_log").delete().gte("created_at", CLEANUP_SINCE).eq("request_type", TEST_REQUEST_TYPE);
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

    const { data: row, error: readError } = await admin
      .from("provider_request_log")
      .select("provider, response_status, error")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    // Fails loudly on a genuine read-back miss (e.g. PGRST116, "0 rows")
    // instead of leaving every assertion below to fail confusingly against
    // `undefined`.
    expect(readError).toBeNull();
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

    const { data: row, error: readError } = await admin
      .from("provider_request_log")
      .select("error")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(readError).toBeNull();
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

    const { data: row, error: readError } = await admin
      .from("provider_request_log")
      .select("provider, response_status, error, normalized_error_type")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(readError).toBeNull();
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

    const { data: row, error: readError } = await admin
      .from("provider_request_log")
      .select("normalized_error_type")
      .eq("request_type", TEST_REQUEST_TYPE)
      .single();
    expect(readError).toBeNull();
    expect(row?.normalized_error_type).toBe("INVALID_REQUEST");
  });
});
