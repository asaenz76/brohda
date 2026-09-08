import { describe, expect, it } from "vitest";
import { resolveVenueTimezone } from "@/lib/sports-data/timezone";

describe("resolveVenueTimezone", () => {
  it("resolves a known city", () => {
    expect(resolveVenueTimezone("Tokyo", null)).toBe("Asia/Tokyo");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveVenueTimezone("  CHICAGO  ", null)).toBe("America/Chicago");
  });

  it("resolves a multi-word city", () => {
    expect(resolveVenueTimezone("Kansas City", null)).toBe("America/Chicago");
  });

  it("falls back to the competition default for an unknown city", () => {
    expect(resolveVenueTimezone("Nowheresville", "Europe/Oslo")).toBe("Europe/Oslo");
  });

  it("falls back to the platform default when nothing else is available", () => {
    expect(resolveVenueTimezone(null, null)).toBe("America/Costa_Rica");
    expect(resolveVenueTimezone(undefined, undefined)).toBe("America/Costa_Rica");
  });

  it("falls back to the platform default for an unknown city with no competition default", () => {
    expect(resolveVenueTimezone("Nowheresville", null)).toBe("America/Costa_Rica");
  });
});
