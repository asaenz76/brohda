import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const upsertMarketMock = vi.fn();
vi.mock("@/lib/prediction-markets/repository", () => ({
  upsertMarket: upsertMarketMock,
}));

function fakeMarket(id: string): NormalizedMarket {
  return {
    provider: "polymarket",
    providerMarketId: id,
    providerEventId: null,
    question: `Q ${id}`,
    description: null,
    status: "ACTIVE",
    price: { yes: 0.5, no: 0.5, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "no_filters_configured",
    providerMetadata: {},
  };
}

function fakeProvider(events: unknown[], enabled = true) {
  return {
    name: "polymarket",
    isEnabled: () => enabled,
    async *listMarkets() {
      for (const event of events) yield event as never;
    },
  };
}

const getPredictionMarketProviderMock = vi.fn();
vi.mock("@/lib/prediction-markets/provider-registry", () => ({
  getPredictionMarketProvider: (name: string) => getPredictionMarketProviderMock(name),
}));

const { ingestFromProvider } = await import("@/lib/prediction-markets/ingest");

describe("ingestFromProvider", () => {
  afterEach(() => {
    upsertMarketMock.mockReset();
    getPredictionMarketProviderMock.mockReset();
  });

  it("throws for an unregistered provider", async () => {
    getPredictionMarketProviderMock.mockReturnValue(null);
    await expect(ingestFromProvider("unknown", { maxResults: 10 })).rejects.toThrow(/unknown/i);
  });

  it("throws when the provider is registered but not enabled", async () => {
    getPredictionMarketProviderMock.mockReturnValue(fakeProvider([], false));
    await expect(ingestFromProvider("polymarket", { maxResults: 10 })).rejects.toThrow(/not enabled/i);
  });

  it("tallies discovered/eligible/skipped correctly from a mix of ineligible and eligible events", async () => {
    getPredictionMarketProviderMock.mockReturnValue(
      fakeProvider([
        { kind: "ineligible", providerMarketId: "m1", reason: "not_active" },
        { kind: "eligible", result: { ok: true, market: fakeMarket("m2") } },
      ]),
    );
    upsertMarketMock.mockResolvedValueOnce({ id: "uuid-2", outcome: "inserted" });

    const result = await ingestFromProvider("polymarket", { maxResults: 10 });
    expect(result.counts).toEqual({ discovered: 2, eligible: 1, inserted: 1, updated: 0, skipped: 1, failed: 0 });
  });

  it("counts a normalization failure as failed, and keeps processing the rest", async () => {
    getPredictionMarketProviderMock.mockReturnValue(
      fakeProvider([
        { kind: "eligible", result: { ok: false, providerMarketId: "bad1", reason: "schema validation failed" } },
        { kind: "eligible", result: { ok: true, market: fakeMarket("m2") } },
      ]),
    );
    upsertMarketMock.mockResolvedValueOnce({ id: "uuid-2", outcome: "inserted" });

    const result = await ingestFromProvider("polymarket", { maxResults: 10 });
    expect(result.counts.failed).toBe(1);
    expect(result.counts.inserted).toBe(1);
    expect(result.failures).toEqual([{ providerMarketId: "bad1", reason: "schema validation failed" }]);
  });

  it("isolates a persistence failure for one market from the rest of the run", async () => {
    getPredictionMarketProviderMock.mockReturnValue(
      fakeProvider([
        { kind: "eligible", result: { ok: true, market: fakeMarket("m1") } },
        { kind: "eligible", result: { ok: true, market: fakeMarket("m2") } },
      ]),
    );
    upsertMarketMock
      .mockRejectedValueOnce(new Error("unique constraint violation"))
      .mockResolvedValueOnce({ id: "uuid-2", outcome: "updated" });

    const result = await ingestFromProvider("polymarket", { maxResults: 10 });
    expect(result.counts.failed).toBe(1);
    expect(result.counts.updated).toBe(1);
    expect(result.failures[0]).toMatchObject({ providerMarketId: "m1", reason: "unique constraint violation" });
  });

  it("distinguishes inserted from updated outcomes", async () => {
    getPredictionMarketProviderMock.mockReturnValue(
      fakeProvider([
        { kind: "eligible", result: { ok: true, market: fakeMarket("m1") } },
        { kind: "eligible", result: { ok: true, market: fakeMarket("m2") } },
      ]),
    );
    upsertMarketMock
      .mockResolvedValueOnce({ id: "uuid-1", outcome: "inserted" })
      .mockResolvedValueOnce({ id: "uuid-2", outcome: "updated" });

    const result = await ingestFromProvider("polymarket", { maxResults: 10 });
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.updated).toBe(1);
  });
});
