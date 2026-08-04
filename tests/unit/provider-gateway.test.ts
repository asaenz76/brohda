import { describe, expect, it } from "vitest";
import { isQuotaExhaustedError } from "@/lib/sports-data/provider-gateway";

describe("isQuotaExhaustedError", () => {
  it("matches the real API-Football daily-limit phrasing", () => {
    expect(isQuotaExhaustedError(new Error("You have reached the request limit for the day"))).toBe(true);
  });

  it("matches the real API-Football per-minute rate-limit phrasing", () => {
    expect(isQuotaExhaustedError(new Error("Too many requests. You have exceeded the limit of requests per minute."))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isQuotaExhaustedError(new Error("QUOTA EXCEEDED"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isQuotaExhaustedError(new Error("Network timeout"))).toBe(false);
    expect(isQuotaExhaustedError(new Error("Fixture not found"))).toBe(false);
  });

  it("handles a non-Error thrown value without crashing", () => {
    expect(isQuotaExhaustedError("rate limit hit")).toBe(true);
    expect(isQuotaExhaustedError(null)).toBe(false);
  });
});
