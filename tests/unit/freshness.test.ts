import { describe, expect, it } from "vitest";
import { isFresh } from "@/lib/utils/freshness";

describe("isFresh", () => {
  it("returns true when the age is under the TTL", () => {
    const fetchedAt = new Date(Date.now() - 1000).toISOString();
    expect(isFresh(fetchedAt, 5000)).toBe(true);
  });

  it("returns false when the age exceeds the TTL", () => {
    const fetchedAt = new Date(Date.now() - 10_000).toISOString();
    expect(isFresh(fetchedAt, 5000)).toBe(false);
  });

  it("returns false at exactly the TTL boundary", () => {
    const fetchedAt = new Date(Date.now() - 5000).toISOString();
    expect(isFresh(fetchedAt, 5000)).toBe(false);
  });
});
