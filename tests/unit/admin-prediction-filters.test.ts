import { describe, expect, it } from "vitest";
import { ADMIN_SEARCH_MAX_LENGTH, hasActiveAdminPredictionFilters, parseAdminPredictionFilters } from "@/lib/predictions/admin-rows";

describe("parseAdminPredictionFilters — only recognised, well-formed filters survive", () => {
  it("reads every filter", () => {
    expect(parseAdminPredictionFilters({ q: "  carlos ", state: "GRADED", result: "VOID", from: "2026-10-01", to: "2026-10-31" })).toEqual({
      query: "carlos",
      state: "GRADED",
      result: "VOID",
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("an empty URL is no filter at all", () => {
    expect(parseAdminPredictionFilters({})).toEqual({});
    expect(hasActiveAdminPredictionFilters({})).toBe(false);
    expect(hasActiveAdminPredictionFilters({ result: "NONE" })).toBe(true);
  });

  it("drops unknown states and results, so a hand-edited URL can't pass anything through", () => {
    expect(parseAdminPredictionFilters({ state: "DELETE", result: "WON; drop table" })).toEqual({});
  });

  it("drops malformed or impossible dates", () => {
    expect(parseAdminPredictionFilters({ from: "10/01/2026", to: "tomorrow" })).toEqual({});
    expect(parseAdminPredictionFilters({ from: "2026-13-45" })).toEqual({});
    expect(parseAdminPredictionFilters({ from: "2026-10-01'; --" })).toEqual({});
  });

  it("caps the search text and takes the first value of a repeated parameter", () => {
    expect(parseAdminPredictionFilters({ q: "a".repeat(500) }).query).toHaveLength(ADMIN_SEARCH_MAX_LENGTH);
    expect(parseAdminPredictionFilters({ q: ["first", "second"] }).query).toBe("first");
    expect(parseAdminPredictionFilters({ q: "   " })).toEqual({});
  });
});
