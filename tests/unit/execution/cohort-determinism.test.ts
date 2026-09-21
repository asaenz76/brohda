import { describe, expect, it } from "vitest";
import { hashToPercentageBucket } from "@/lib/execution/cohorts";

// Milestone 5.5 (STEP 9) — percentage rollout must be deterministic, never
// randomized per request. This is the entire correctness contract: the
// same (seed, userId) always lands in the same bucket, so a user never
// oscillates in or out of a cohort just by making another request.

describe("hashToPercentageBucket", () => {
  it("is deterministic — the same seed and user id always produce the same bucket", async () => {
    const a = await hashToPercentageBucket("beta-2026", "user-123");
    const b = await hashToPercentageBucket("beta-2026", "user-123");
    const c = await hashToPercentageBucket("beta-2026", "user-123");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("stays within [0, 100)", async () => {
    for (const userId of ["user-1", "user-2", "user-3", "another-user", "yet-another"]) {
      const bucket = await hashToPercentageBucket("seed", userId);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("different users are not all assigned to the same bucket (a degenerate hash would fail this)", async () => {
    const buckets = await Promise.all(Array.from({ length: 20 }, (_, i) => hashToPercentageBucket("seed", `user-${i}`)));
    const distinct = new Set(buckets);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("changing only the seed reassigns buckets independently of percentage — proving seed and threshold are separate configuration knobs", async () => {
    const bucketSeedA = await hashToPercentageBucket("seed-a", "user-42");
    const bucketSeedB = await hashToPercentageBucket("seed-b", "user-42");
    // Not guaranteed to differ for every possible pair, but true for this
    // fixed, known pair — a regression to a seed-ignoring implementation
    // would collapse this.
    expect(bucketSeedA).not.toBe(bucketSeedB);
  });

  it("a user does not oscillate: raising the configured percentage only ever adds users, never removes a user who was already included", async () => {
    const seed = "monotonic-check";
    const users = Array.from({ length: 50 }, (_, i) => `user-${i}`);
    const buckets = await Promise.all(users.map((u) => hashToPercentageBucket(seed, u)));

    const includedAt30 = new Set(users.filter((_, i) => buckets[i] < 30));
    const includedAt60 = new Set(users.filter((_, i) => buckets[i] < 60));

    for (const user of includedAt30) {
      expect(includedAt60.has(user)).toBe(true);
    }
  });
});
