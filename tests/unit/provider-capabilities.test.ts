import { describe, expect, it } from "vitest";
import { supports } from "@/lib/sports-data/provider-capabilities";

describe("provider capabilities", () => {
  it("API-Football supports every modeled capability", () => {
    expect(supports("api_football", "markets")).toBe(true);
    expect(supports("api_football", "team_search")).toBe(true);
    expect(supports("api_football", "league_type")).toBe(true);
    expect(supports("api_football", "fixture_events")).toBe(true);
    expect(supports("api_football", "squad_data")).toBe(true);
  });

  it("API-NFL supports none of the modeled capabilities — its stubbed methods return empty/null, never real data", () => {
    expect(supports("api_nfl", "markets")).toBe(false);
    expect(supports("api_nfl", "team_search")).toBe(false);
    expect(supports("api_nfl", "league_type")).toBe(false);
    expect(supports("api_nfl", "fixture_events")).toBe(false);
    expect(supports("api_nfl", "squad_data")).toBe(false);
  });

  it("an unknown provider supports nothing — never defaults to football's capabilities", () => {
    expect(supports("api_basketball", "markets")).toBe(false);
  });
});
