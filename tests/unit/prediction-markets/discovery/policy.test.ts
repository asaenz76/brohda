import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFreshness, type FreshnessPolicy } from "@/lib/prediction-markets/discovery/policy";

// classifyFreshness is a pure function taking the policy as an explicit
// parameter — these tests inject their own policy values rather than
// depending on whatever platform_settings currently holds in any given
// environment, matching the standing rule's "tests should consume or
// explicitly override the policy rather than duplicate its production
// value."
const TEST_POLICY: FreshnessPolicy = { freshWithinMinutes: 60, staleWithinMinutes: 24 * 60 };

describe("classifyFreshness", () => {
  const NOW = new Date("2026-01-01T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString();
  }

  it("classifies a recent sync with a price as FRESH", () => {
    expect(classifyFreshness(minutesAgo(5), true, TEST_POLICY)).toBe("FRESH");
  });

  it("classifies exactly the fresh-threshold boundary as FRESH", () => {
    expect(classifyFreshness(minutesAgo(TEST_POLICY.freshWithinMinutes), true, TEST_POLICY)).toBe("FRESH");
  });

  it("classifies just past the fresh threshold as STALE", () => {
    expect(classifyFreshness(minutesAgo(TEST_POLICY.freshWithinMinutes + 1), true, TEST_POLICY)).toBe("STALE");
  });

  it("classifies just past the stale threshold as UNAVAILABLE", () => {
    expect(classifyFreshness(minutesAgo(TEST_POLICY.staleWithinMinutes + 1), true, TEST_POLICY)).toBe("UNAVAILABLE");
  });

  it("classifies as UNAVAILABLE regardless of recency when there is no usable price", () => {
    expect(classifyFreshness(minutesAgo(1), false, TEST_POLICY)).toBe("UNAVAILABLE");
  });

  it("honors a completely different, explicitly-injected policy — proving thresholds are not hard-coded into the classifier itself", () => {
    const tightPolicy: FreshnessPolicy = { freshWithinMinutes: 5, staleWithinMinutes: 10 };
    expect(classifyFreshness(minutesAgo(6), true, tightPolicy)).toBe("STALE");
    expect(classifyFreshness(minutesAgo(11), true, tightPolicy)).toBe("UNAVAILABLE");
  });
});
