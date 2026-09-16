import { describe, expect, it } from "vitest";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";

describe("deriveConsumerStatus", () => {
  it("maps ACTIVE to ACTIVE", () => {
    expect(deriveConsumerStatus("ACTIVE", null)).toBe("ACTIVE");
  });

  it("maps CLOSED with no resolved outcome to CLOSED, not RESOLVED", () => {
    expect(deriveConsumerStatus("CLOSED", null)).toBe("CLOSED");
  });

  it("maps CLOSED with a genuine resolved outcome to RESOLVED", () => {
    expect(deriveConsumerStatus("CLOSED", "Yes")).toBe("RESOLVED");
  });

  it("never fabricates RESOLVED for an ACTIVE market even if resolvedOutcome were somehow set", () => {
    expect(deriveConsumerStatus("ACTIVE", "Yes")).toBe("ACTIVE");
  });

  it("returns null (no consumer status) for INACTIVE", () => {
    expect(deriveConsumerStatus("INACTIVE", null)).toBeNull();
  });

  it("returns null (no consumer status) for ARCHIVED", () => {
    expect(deriveConsumerStatus("ARCHIVED", null)).toBeNull();
  });
});
