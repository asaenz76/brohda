import { describe, expect, it } from "vitest";
import {
  getPredictionMarketProvider,
  isKnownPredictionMarketProvider,
} from "@/lib/prediction-markets/provider-registry";
import { POLYMARKET_PROVIDER } from "@/lib/prediction-markets/provider-names";

describe("prediction-market provider registry", () => {
  it("recognizes the registered Polymarket provider identity", () => {
    expect(isKnownPredictionMarketProvider(POLYMARKET_PROVIDER)).toBe(true);
  });

  it("resolves the Polymarket identity to its adapter", () => {
    const provider = getPredictionMarketProvider(POLYMARKET_PROVIDER);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe(POLYMARKET_PROVIDER);
  });

  it("returns null for an unknown provider identity, never throws", () => {
    expect(() => getPredictionMarketProvider("some_future_provider")).not.toThrow();
    expect(getPredictionMarketProvider("some_future_provider")).toBeNull();
  });

  it("does not recognize an unknown provider identity", () => {
    expect(isKnownPredictionMarketProvider("kalshi")).toBe(false);
  });

  it("does not accidentally register a sports-data provider identity", () => {
    expect(isKnownPredictionMarketProvider("api_nfl")).toBe(false);
  });
});
