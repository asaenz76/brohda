import { describe, expect, it } from "vitest";
import { computeMarketCategoryIds } from "@/lib/prediction-markets/discovery/category-mapping";

describe("computeMarketCategoryIds", () => {
  it("matches a market tag to its mapped category, case-insensitively", () => {
    const result = computeMarketCategoryIds("polymarket", ["Politics"], [{ categoryId: "cat-1", provider: "polymarket", providerTag: "politics" }]);
    expect(result).toEqual(["cat-1"]);
  });

  it("proves consumer behavior does not depend on any fixed/hard-coded category name — an arbitrary, non-standard category name works identically", () => {
    const result = computeMarketCategoryIds(
      "polymarket",
      ["Underwater Basket Weaving Championships"],
      [{ categoryId: "cat-xyz", provider: "polymarket", providerTag: "underwater basket weaving championships" }],
    );
    expect(result).toEqual(["cat-xyz"]);
  });

  it("silently skips an unmapped tag — never throws", () => {
    expect(() => computeMarketCategoryIds("polymarket", ["SomeUnmappedTag"], [])).not.toThrow();
    expect(computeMarketCategoryIds("polymarket", ["SomeUnmappedTag"], [])).toEqual([]);
  });

  it("ignores a mapping belonging to a different provider", () => {
    const result = computeMarketCategoryIds("polymarket", ["politics"], [{ categoryId: "cat-1", provider: "some_other_provider", providerTag: "politics" }]);
    expect(result).toEqual([]);
  });

  it("returns multiple matched categories when multiple tags match", () => {
    const result = computeMarketCategoryIds(
      "polymarket",
      ["politics", "world"],
      [
        { categoryId: "cat-1", provider: "polymarket", providerTag: "politics" },
        { categoryId: "cat-2", provider: "polymarket", providerTag: "world" },
      ],
    );
    expect(result.sort()).toEqual(["cat-1", "cat-2"]);
  });

  it("de-duplicates when two tags map to the same category", () => {
    const result = computeMarketCategoryIds(
      "polymarket",
      ["politics", "elections"],
      [
        { categoryId: "cat-1", provider: "polymarket", providerTag: "politics" },
        { categoryId: "cat-1", provider: "polymarket", providerTag: "elections" },
      ],
    );
    expect(result).toEqual(["cat-1"]);
  });

  it("returns an empty array for a market with no tags at all", () => {
    expect(computeMarketCategoryIds("polymarket", [], [{ categoryId: "cat-1", provider: "polymarket", providerTag: "politics" }])).toEqual([]);
  });
});
