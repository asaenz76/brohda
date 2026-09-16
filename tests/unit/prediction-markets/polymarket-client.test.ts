import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMarketsPage } from "@/lib/prediction-markets/providers/polymarket/client";
import { PolymarketPermanentError, PolymarketTransientError, PolymarketValidationError } from "@/lib/prediction-markets/providers/polymarket/errors";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function marketFixture(id: string) {
  return { id, question: `Question ${id}` };
}

describe("fetchMarketsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses a single, final page (plain array, no cursor)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([marketFixture("m1"), marketFixture("m2")]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketsPage({ limit: 100 });
    expect(result.rawMarkets).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("parses a page with a cursor, indicating more pages follow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [marketFixture("m1")], next_cursor: "abc123" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketsPage({ limit: 100 });
    expect(result.rawMarkets).toHaveLength(1);
    expect(result.nextCursor).toBe("abc123");
  });

  it("parses the CONFIRMED real Gamma envelope shape — { $schema, markets: [...], next_cursor } — live-verified 2026-09-15 against gamma-api.polymarket.com", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ $schema: "https://gamma-api.polymarket.com/schemas/MarketsKeysetListResponse.json", markets: [marketFixture("m1"), marketFixture("m2")], next_cursor: "realcursor" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketsPage({ limit: 100 });
    expect(result.rawMarkets).toHaveLength(2);
    expect(result.nextCursor).toBe("realcursor");
  });

  it("forwards the cursor on the next request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMarketsPage({ limit: 100, afterCursor: "abc123" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("after_cursor")).toBe("abc123");
  });

  it("treats an empty page as the final page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketsPage({ limit: 100 });
    expect(result.rawMarkets).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("retries on a 429 rate-limit response, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse([marketFixture("m1")]));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchMarketsPage({ limit: 100 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.rawMarkets).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on a 5xx response, then throws PolymarketTransientError after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchMarketsPage({ limit: 100 });
    const expectation = expect(promise).rejects.toBeInstanceOf(PolymarketTransientError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a permanent 4xx error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketsPage({ limit: 100 })).rejects.toBeInstanceOf(PolymarketPermanentError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly and safely on malformed (non-JSON) responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketsPage({ limit: 100 })).rejects.toBeInstanceOf(PolymarketValidationError);
  });

  it("fails explicitly when the response envelope shape doesn't match the documented schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unexpected: "shape" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketsPage({ limit: 100 })).rejects.toBeInstanceOf(PolymarketValidationError);
  });

  it("passes individual market items through unvalidated — per-market validation is the adapter's job, not the client's, so one malformed item never fails the whole page fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ notAMarket: true }, marketFixture("m2")]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketsPage({ limit: 100 });
    expect(result.rawMarkets).toHaveLength(2);
  });
});
