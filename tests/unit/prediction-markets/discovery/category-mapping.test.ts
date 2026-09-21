import { describe, expect, it } from "vitest";
import { computeMarketCategoryIds } from "@/lib/prediction-markets/discovery/category-mapping";

describe("computeMarketCategoryIds", () => {
  it("matches a market tag to its mapped category, case-insensitively", () => {
    const result = computeMarketCategoryIds("api-sports", ["Politics"], [{ categoryId: "cat-1", provider: "api-sports", providerTag: "politics" }]);
    expect(result).toEqual(["cat-1"]);
  });

  it("proves consumer behavior does not depend on any fixed/hard-coded category name — an arbitrary, non-standard category name works identically", () => {
    const result = computeMarketCategoryIds(
      "api-sports",
      ["Underwater Basket Weaving Championships"],
      [{ categoryId: "cat-xyz", provider: "api-sports", providerTag: "underwater basket weaving championships" }],
    );
    expect(result).toEqual(["cat-xyz"]);
  });

  it("silently skips an unmapped tag — never throws", () => {
    expect(() => computeMarketCategoryIds("api-sports", ["SomeUnmappedTag"], [])).not.toThrow();
    expect(computeMarketCategoryIds("api-sports", ["SomeUnmappedTag"], [])).toEqual([]);
  });

  it("ignores a mapping belonging to a different provider", () => {
    const result = computeMarketCategoryIds("api-sports", ["politics"], [{ categoryId: "cat-1", provider: "some_other_provider", providerTag: "politics" }]);
    expect(result).toEqual([]);
  });

  it("returns multiple matched categories when multiple tags match", () => {
    const result = computeMarketCategoryIds(
      "api-sports",
      ["politics", "world"],
      [
        { categoryId: "cat-1", provider: "api-sports", providerTag: "politics" },
        { categoryId: "cat-2", provider: "api-sports", providerTag: "world" },
      ],
    );
    expect(result.sort()).toEqual(["cat-1", "cat-2"]);
  });

  it("de-duplicates when two tags map to the same category", () => {
    const result = computeMarketCategoryIds(
      "api-sports",
      ["politics", "elections"],
      [
        { categoryId: "cat-1", provider: "api-sports", providerTag: "politics" },
        { categoryId: "cat-1", provider: "api-sports", providerTag: "elections" },
      ],
    );
    expect(result).toEqual(["cat-1"]);
  });

  it("returns an empty array for a market with no tags at all", () => {
    expect(computeMarketCategoryIds("api-sports", [], [{ categoryId: "cat-1", provider: "api-sports", providerTag: "politics" }])).toEqual([]);
  });
});
