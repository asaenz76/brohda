import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async () => ({ data: null, error: null }),
    }),
  }),
}));

import { fetchWithRetry, PermanentProviderError } from "@/lib/sports-data/http";

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
});
