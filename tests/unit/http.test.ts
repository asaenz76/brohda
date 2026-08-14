import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });
const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

function loggedInsertPayload(callIndex = 0): Record<string, unknown> {
  return insertMock.mock.calls[callIndex]?.[0] as Record<string, unknown>;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { fetchWithRetry, PermanentProviderError, ProviderSoftError } from "@/lib/sports-data/http";

// The real, observed API-Sports response shape for a quota-exhausted
// request — HTTP 200, `errors` populated (confirmed live for both
// API-Football and API-NFL, same envelope convention). This is the exact
// shape that used to be logged as a plain success (see the regression
// tests below) because fetchWithRetry only ever checked response.ok.
function quotaExhaustedResponse(): Response {
  return new Response(
    JSON.stringify({ errors: { requests: "You have reached the request limit for the day, upgrade your plan" }, results: 0, response: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function cleanJsonResponse(): Response {
  return new Response(JSON.stringify({ errors: {}, results: 2, response: [{ id: 1 }, { id: 2 }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    insertMock.mockClear();
    fromMock.mockClear();
  });

  it("returns the response on success without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com", {}, {
      provider: "test",
      requestType: "search",
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on a 500 and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com", {}, {
      provider: "test",
      requestType: "search",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com", {}, {
      provider: "test",
      requestType: "search",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a non-429 4xx (permanent validation error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://example.com", {}, { provider: "test", requestType: "search" }),
    ).rejects.toThrow(PermanentProviderError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry cap on persistent 5xx errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com", {}, {
      provider: "test",
      requestType: "search",
    });
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Regression tests for the actual HTTP-200 + quota-error response shape
  // (Phase 0.5): previously fetchWithRetry only checked response.ok, so
  // this exact shape was logged as a plain success and never reached
  // provider-gateway.ts's circuit breaker at all.
  describe("provider soft-error detection (HTTP 200, JSON errors populated)", () => {
    it("throws ProviderSoftError instead of returning the response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(quotaExhaustedResponse());
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" }),
      ).rejects.toThrow(ProviderSoftError);
    });

    it("never retries a soft error — one fetch call only, same reasoning as a permanent 4xx", async () => {
      const fetchMock = vi.fn().mockResolvedValue(quotaExhaustedResponse());
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" }),
      ).rejects.toThrow(ProviderSoftError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("logs it as a real error (not success) in provider_request_log, with a message the quota-pattern matcher recognizes", async () => {
      const fetchMock = vi.fn().mockResolvedValue(quotaExhaustedResponse());
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" }),
      ).rejects.toThrow();

      expect(fromMock).toHaveBeenCalledWith("provider_request_log");
      expect(insertMock).toHaveBeenCalledTimes(1);
      const logged = loggedInsertPayload();
      expect(logged.provider).toBe("api_football");
      expect(logged.response_status).toBe(200);
      expect(logged.error).not.toBeNull();
      expect(logged.error).toMatch(/request limit/i);
      expect(logged.response_snippet).toContain("You have reached the request limit");
    });

    it("does not false-positive on a genuine successful response with an empty errors object", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cleanJsonResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" });
      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(loggedInsertPayload().error).toBeNull();
    });

    it("does not false-positive on a non-JSON success body (existing plain-text-ok behavior stays intact)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" });
      expect(result.status).toBe(200);
      expect(loggedInsertPayload().error).toBeNull();
    });

    it("logs the correct provider for an API-NFL soft error — the two providers' logs never cross", async () => {
      const fetchMock = vi.fn().mockResolvedValue(quotaExhaustedResponse());
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchWithRetry("https://example.com", {}, { provider: "api_nfl", requestType: "get_season_fixtures" }),
      ).rejects.toThrow(ProviderSoftError);

      expect(loggedInsertPayload().provider).toBe("api_nfl");
    });

    it("the response body is still fully readable by the caller after a soft-error peek that didn't trigger (clone leaves the original stream intact)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cleanJsonResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchWithRetry("https://example.com", {}, { provider: "api_football", requestType: "get_season_fixtures" });
      const body = await result.json();
      expect(body.response).toHaveLength(2);
    });
  });
});
