import { describe, expect, it } from "vitest";
import { getSportsProvider, isKnownProvider } from "@/lib/sports-data/provider-registry";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";

describe("provider registry", () => {
  it("resolves api_football to the football adapter", () => {
    expect(getSportsProvider("api_football")).toBe(apiFootballProvider);
  });

  it("resolves api_nfl to the NFL adapter", () => {
    expect(getSportsProvider("api_nfl")).toBe(apiNflProvider);
  });

  it("returns null for an unknown provider — never falls back to football", () => {
    expect(getSportsProvider("api_basketball")).toBeNull();
    expect(getSportsProvider("")).toBeNull();
    expect(getSportsProvider("API_FOOTBALL")).toBeNull(); // case-sensitive, no fuzzy match
  });

  it("isKnownProvider matches getSportsProvider's own notion of known", () => {
    expect(isKnownProvider("api_football")).toBe(true);
    expect(isKnownProvider("api_nfl")).toBe(true);
    expect(isKnownProvider("api_basketball")).toBe(false);
  });
});
