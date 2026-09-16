import { describe, expect, it } from "vitest";
import { formatClosesAt } from "@/lib/prediction-markets/discovery/format";

describe("formatClosesAt", () => {
  it("formats a valid ISO date into a short consumer-friendly label", () => {
    expect(formatClosesAt("2027-01-01T04:59:00Z")).toBe("Jan 1, 2027");
  });

  it("returns null for a missing close time", () => {
    expect(formatClosesAt(null)).toBeNull();
  });

  it("returns null for an unparseable value rather than throwing", () => {
    expect(formatClosesAt("not-a-date")).toBeNull();
  });
});
