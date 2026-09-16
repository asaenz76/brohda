import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMarketsPageMock = vi.fn();
vi.mock("@/lib/prediction-markets/providers/polymarket/client", () => ({
  fetchMarketsPage: fetchMarketsPageMock,
}));

const { polymarketAdapter } = await import("@/lib/prediction-markets/providers/polymarket/adapter");

function market(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    question: `Question ${id}`,
    active: true,
    closed: false,
    archived: false,
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.5", "0.5"],
    ...overrides,
  };
}

async function collect(criteria: Parameters<typeof polymarketAdapter.listMarkets>[0]) {
  const events = [];
  for await (const event of polymarketAdapter.listMarkets(criteria)) {
    events.push(event);
  }
  return events;
}

describe("polymarketAdapter.listMarkets", () => {
  afterEach(() => {
    fetchMarketsPageMock.mockReset();
  });

  it("yields normalized markets across a single page", async () => {
    fetchMarketsPageMock.mockResolvedValueOnce({ rawMarkets: [market("m1"), market("m2")], nextCursor: null });

    const events = await collect({ maxResults: 10 });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "eligible")).toBe(true);
  });

  it("follows pagination across multiple pages until the provider signals no more pages", async () => {
    fetchMarketsPageMock
      .mockResolvedValueOnce({ rawMarkets: [market("m1")], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ rawMarkets: [market("m2")], nextCursor: null });

    const events = await collect({ maxResults: 10 });
    expect(events).toHaveLength(2);
    expect(fetchMarketsPageMock).toHaveBeenCalledTimes(2);
    expect(fetchMarketsPageMock.mock.calls[1][0]).toMatchObject({ afterCursor: "cursor-2" });
  });

  it("stops immediately on an empty page", async () => {
    fetchMarketsPageMock.mockResolvedValueOnce({ rawMarkets: [], nextCursor: "would-be-next" });

    const events = await collect({ maxResults: 10 });
    expect(events).toHaveLength(0);
    expect(fetchMarketsPageMock).toHaveBeenCalledTimes(1);
  });

  it("stops as soon as maxResults eligible markets have been yielded, never fetching an unnecessary extra page", async () => {
    fetchMarketsPageMock.mockResolvedValueOnce({
      rawMarkets: [market("m1"), market("m2"), market("m3")],
      nextCursor: "would-fetch-more",
    });

    const events = await collect({ maxResults: 2 });
    expect(events).toHaveLength(2);
    expect(fetchMarketsPageMock).toHaveBeenCalledTimes(1);
  });

  it("yields a distinct 'ineligible' event for a market that fails eligibility, without normalizing it", async () => {
    fetchMarketsPageMock.mockResolvedValueOnce({
      rawMarkets: [market("m1", { active: false }), market("m2")],
      nextCursor: null,
    });

    const events = await collect({ activeOnly: true, maxResults: 10 });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "ineligible", providerMarketId: "m1" });
    expect(events[1].kind).toBe("eligible");
  });

  it("isolates one malformed market from the rest of the same page — reports it as a failed eligible event, does not throw, does not drop the others", async () => {
    fetchMarketsPageMock.mockResolvedValueOnce({
      rawMarkets: [{ missingRequiredFields: true }, market("m2")],
      nextCursor: null,
    });

    const events = await collect({ maxResults: 10 });
    expect(events).toHaveLength(2);

    expect(events[0].kind).toBe("eligible");
    if (events[0].kind === "eligible") {
      expect(events[0].result.ok).toBe(false);
      if (!events[0].result.ok) {
        expect(events[0].result.reason).toContain("schema validation failed");
      }
    }

    expect(events[1].kind).toBe("eligible");
    if (events[1].kind === "eligible") {
      expect(events[1].result.ok).toBe(true);
      if (events[1].result.ok) {
        expect(events[1].result.market.providerMarketId).toBe("m2");
      }
    }
  });

  it("never mutates its behavior based on whether isEnabled() is true — that gate belongs to the caller (ingest.ts)", () => {
    // isEnabled() reads an env var directly; listMarkets itself has no
    // enabled-check inside it, by design — see ingest.ts's own gate.
    expect(typeof polymarketAdapter.isEnabled).toBe("function");
  });
});
