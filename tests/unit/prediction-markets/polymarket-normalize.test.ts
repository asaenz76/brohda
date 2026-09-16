import { describe, expect, it } from "vitest";
import { mapPrices, mapStatus, normalizePolymarketMarket } from "@/lib/prediction-markets/providers/polymarket/normalize";
import { rawGammaMarketSchema } from "@/lib/prediction-markets/providers/polymarket/schema";

function rawMarket(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "0xabc",
    slug: "will-x-happen",
    question: "Will X happen?",
    description: "A test market.",
    conditionId: "0xcond",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.62", "0.38"],
    active: true,
    closed: false,
    archived: false,
    startDateIso: "2026-01-01T00:00:00Z",
    endDateIso: "2026-02-01T00:00:00Z",
    closedTime: null,
    liquidity: "12345.67",
    volume24hr: "890.12",
    umaResolutionStatus: null,
    resolvedBy: null,
    ...overrides,
  };
  return rawGammaMarketSchema.parse(base);
}

describe("mapStatus", () => {
  it("maps active=true to ACTIVE", () => {
    expect(mapStatus({ active: true, closed: false, archived: false })).toBe("ACTIVE");
  });

  it("maps closed=true to CLOSED even if active is also true", () => {
    expect(mapStatus({ active: true, closed: true, archived: false })).toBe("CLOSED");
  });

  it("maps archived=true to ARCHIVED regardless of active/closed", () => {
    expect(mapStatus({ active: true, closed: true, archived: true })).toBe("ARCHIVED");
  });

  it("maps everything absent/false to INACTIVE — never assumes CLOSED", () => {
    expect(mapStatus({ active: false, closed: false, archived: false })).toBe("INACTIVE");
    expect(mapStatus({})).toBe("INACTIVE");
  });
});

describe("mapPrices", () => {
  it("reads YES and NO prices independently, never derives one from the other", () => {
    const result = mapPrices({ outcomes: ["Yes", "No"], outcomePrices: ["0.62", "0.30"] });
    expect(result.yes).toBe(0.62);
    expect(result.no).toBe(0.3);
    // Confirms this is read, not derived — 0.3 !== 1 - 0.62 (0.38).
    expect(result.no).not.toBeCloseTo(1 - (result.yes ?? 0));
    expect(result.outcomeLabels).toEqual({ yes: "Yes", no: "No" });
  });

  it("parses a JSON-encoded string form of outcomes/outcomePrices", () => {
    const result = mapPrices({ outcomes: JSON.stringify(["Yes", "No"]), outcomePrices: JSON.stringify(["0.5", "0.5"]) });
    expect(result.yes).toBe(0.5);
    expect(result.no).toBe(0.5);
  });

  it("returns null for both prices when outcomes/outcomePrices are missing", () => {
    const result = mapPrices({});
    expect(result.yes).toBeNull();
    expect(result.no).toBeNull();
    expect(result.outcomeLabels).toBeNull();
  });

  it("returns null for both prices when the arrays are mismatched length", () => {
    const result = mapPrices({ outcomes: ["Yes", "No"], outcomePrices: ["0.5"] });
    expect(result.yes).toBeNull();
    expect(result.no).toBeNull();
  });

  it("returns null for both prices when outcomes is unparseable garbage", () => {
    const result = mapPrices({ outcomes: "not json", outcomePrices: "[1,2]" });
    expect(result.yes).toBeNull();
    expect(result.no).toBeNull();
  });

  it("leaves the unmatched side null when only one outcome label is recognizable", () => {
    const result = mapPrices({ outcomes: ["Yes", "Maybe"], outcomePrices: ["0.7", "0.3"] });
    expect(result.yes).toBe(0.7);
    expect(result.no).toBeNull();
  });
});

describe("normalizePolymarketMarket", () => {
  it("normalizes a well-formed market with full price/status/timing data", () => {
    const result = normalizePolymarketMarket(rawMarket(), { ingestionSource: "no_filters_configured" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.market.provider).toBe("polymarket");
    expect(result.market.providerMarketId).toBe("0xabc");
    expect(result.market.question).toBe("Will X happen?");
    expect(result.market.status).toBe("ACTIVE");
    expect(result.market.price.yes).toBe(0.62);
    expect(result.market.price.no).toBe(0.38);
    expect(result.market.liquidity).toBe(12345.67);
    expect(result.market.volume24hr).toBe(890.12);
    expect(result.market.opensAt).toBe("2026-01-01T00:00:00Z");
    expect(result.market.closesAt).toBe("2026-02-01T00:00:00Z");
    expect(result.market.resolvedOutcome).toBeNull();
    expect(result.market.ingestionSource).toBe("no_filters_configured");
  });

  it("honestly represents an unavailable price as null, not zero or a derived value", () => {
    const raw = rawMarket({ outcomes: null, outcomePrices: null });
    const result = normalizePolymarketMarket(raw, { ingestionSource: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.market.price.yes).toBeNull();
    expect(result.market.price.no).toBeNull();
  });

  it("honestly represents unavailable liquidity/volume as null, never zero", () => {
    const raw = rawMarket({ liquidity: null, volume24hr: null });
    const result = normalizePolymarketMarket(raw, { ingestionSource: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.market.liquidity).toBeNull();
    expect(result.market.volume24hr).toBeNull();
  });

  it("passes through raw resolution fields without inventing a resolved outcome", () => {
    const raw = rawMarket({ closed: true, umaResolutionStatus: "resolved", resolvedBy: "UMA" });
    const result = normalizePolymarketMarket(raw, { ingestionSource: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.market.resolutionStatus).toBe("resolved");
    expect(result.market.resolvedBy).toBe("UMA");
    // Milestone 1 never derives a resolved outcome — see normalize.ts's comment.
    expect(result.market.resolvedOutcome).toBeNull();
  });

  it("retains the raw provider object in metadata for diagnostics", () => {
    const raw = rawMarket({ someFutureField: "unrecognized" });
    const result = normalizePolymarketMarket(raw, { ingestionSource: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.market.providerMetadata.someFutureField).toBe("unrecognized");
  });
});
