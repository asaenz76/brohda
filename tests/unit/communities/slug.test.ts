import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/communities/slug";

describe("slugify", () => {
  it("lowercases and hyphenates a team name", () => {
    expect(slugify("New York Giants")).toBe("new-york-giants");
  });

  it("strips punctuation", () => {
    expect(slugify("St. Louis Rams")).toBe("st-louis-rams");
  });

  it("collapses non-alphanumeric runs into a single hyphen", () => {
    expect(slugify("A/B  --  C")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  NFL  ")).toBe("nfl");
  });

  it("is deterministic — the same input always produces the same slug", () => {
    expect(slugify("American Football")).toBe(slugify("American Football"));
  });

  it("converts a sport_key with underscores into a hyphenated slug", () => {
    expect(slugify("american_football")).toBe("american-football");
  });
});
