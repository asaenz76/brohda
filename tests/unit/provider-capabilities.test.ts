import { describe, expect, it } from "vitest";
import { supports } from "@/lib/sports-data/provider-capabilities";

describe("provider capabilities", () => {
  it("API-NFL supports none of the modeled capabilities — its stubbed methods return empty/null, never real data", () => {
    expect(supports("api_nfl", "team_search")).toBe(false);
    expect(supports("api_nfl", "league_type")).toBe(false);
    expect(supports("api_nfl", "fixture_events")).toBe(false);
    expect(supports("api_nfl", "squad_data")).toBe(false);
  });

  it("an unknown provider supports nothing", () => {
    expect(supports("api_basketball", "team_search")).toBe(false);
  });
});
