import { describe, expect, it } from "vitest";
import { computeJobHealth, isDegradedResult, type BackgroundJobRow } from "@/lib/jobs/health";
import type { JobDefinition } from "@/lib/jobs/registry";

const JOB: JobDefinition = {
  id: "grade-predictions",
  displayName: "Grade predictions",
  route: "/api/cron/grade-predictions",
  category: "brohda-social",
  criticality: "critical",
  expectedCadenceMinutes: 2,
};

const FLAG_GATED_JOB: JobDefinition = {
  id: "ingest-nfl-markets",
  displayName: "Ingest NFL markets",
  route: "/api/cron/ingest-nfl-markets",
  category: "brohda-social",
  criticality: "standard",
  expectedCadenceMinutes: 15,
};

const NOW = new Date("2026-01-01T12:00:00.000Z");
const STALENESS_MULTIPLIER = 3;

function row(overrides: Partial<BackgroundJobRow>): BackgroundJobRow {
  return {
    job_name: JOB.id,
    status: "success",
    result: {},
    error: null,
    started_at: "2026-01-01T11:59:00.000Z",
    finished_at: "2026-01-01T12:00:00.000Z",
    duration_ms: 500,
    ...overrides,
  };
}

describe("isDegradedResult", () => {
  it("is false for a plain non-object result", () => {
    expect(isDegradedResult(null)).toBe(false);
    expect(isDegradedResult(undefined)).toBe(false);
    expect(isDegradedResult(42)).toBe(false);
  });

  it("is false when failures is an empty array", () => {
    expect(isDegradedResult({ failures: [] })).toBe(false);
  });

  it("is true when failures has at least one entry", () => {
    expect(isDegradedResult({ failures: [{ predictionId: "p1", error: "boom" }] })).toBe(true);
  });

  it("is true when invariantViolations is greater than zero", () => {
    expect(isDegradedResult({ invariantViolations: 1, failures: [] })).toBe(true);
  });

  it("is false when invariantViolations is zero", () => {
    expect(isDegradedResult({ invariantViolations: 0, failures: [] })).toBe(false);
  });

  it("is true when a legacy-style failed counter is greater than zero", () => {
    expect(isDegradedResult({ checked: 10, failed: 2 })).toBe(true);
  });

  it("is false when a legacy-style failed counter is zero", () => {
    expect(isDegradedResult({ checked: 10, failed: 0 })).toBe(false);
  });
});

describe("computeJobHealth", () => {
  it("is never_run when no row exists for this job", () => {
    const entry = computeJobHealth(JOB, [], NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("never_run");
    expect(entry.lastAttemptedAt).toBeNull();
    expect(entry.lastSuccessfulAt).toBeNull();
  });

  it("is healthy for a recent clean success", () => {
    const rows = [row({ finished_at: "2026-01-01T11:59:00.000Z", status: "success", result: { examined: 5, failures: [] } })];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("healthy");
    expect(entry.lastSuccessfulAt).toBe("2026-01-01T11:59:00.000Z");
  });

  it("is no_op_healthy for a recent run whose result reports its feature flag disabled", () => {
    const rows = [
      row({
        job_name: FLAG_GATED_JOB.id,
        finished_at: "2026-01-01T11:59:00.000Z",
        status: "success",
        result: { ranAt: "2026-01-01T11:59:00.000Z", policyEnabled: false, fixturesExamined: 0, outcomes: [], failures: [] },
      }),
    ];
    const entry = computeJobHealth(FLAG_GATED_JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("no_op_healthy");
  });

  it("is stale when the last run finished long before the cadence * multiplier window", () => {
    // 2-minute cadence * 3x multiplier = 6-minute staleness window; last run 20 minutes ago.
    const rows = [row({ finished_at: "2026-01-01T11:40:00.000Z", status: "success", result: { examined: 5, failures: [] } })];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("stale");
  });

  it("a stale no-op is still reported as stale, not no_op_healthy — the scheduler itself may have stopped firing", () => {
    const rows = [
      row({
        job_name: FLAG_GATED_JOB.id,
        finished_at: "2026-01-01T09:00:00.000Z", // 3 hours ago, cadence 15min * 3x = 45min window
        status: "success",
        result: { policyEnabled: false, fixturesExamined: 0, outcomes: [], failures: [] },
      }),
    ];
    const entry = computeJobHealth(FLAG_GATED_JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("stale");
  });

  it("is failed when the latest row is a whole-job error, regardless of staleness", () => {
    const rows = [row({ finished_at: "2026-01-01T11:59:59.000Z", status: "error", error: "boom", result: null })];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("failed");
    expect(entry.lastError).toBe("boom");
  });

  it("is degraded when the latest recent row has per-item failures but did not throw", () => {
    const rows = [
      row({
        finished_at: "2026-01-01T11:59:00.000Z",
        status: "degraded",
        result: { examined: 200, graded: 199, failures: [{ predictionId: "p1", error: "boom" }] },
      }),
    ];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("degraded");
    expect(entry.lastResultSummary).toContain("1 failed");
  });

  it("distinguishes 199 succeeded / 1 failed (degraded) from 200 succeeded / 0 failed (healthy)", () => {
    const degradedRows = [
      row({ finished_at: "2026-01-01T11:59:00.000Z", status: "degraded", result: { examined: 200, failures: [{ predictionId: "p1", error: "x" }] } }),
    ];
    const healthyRows = [
      row({ finished_at: "2026-01-01T11:59:00.000Z", status: "success", result: { examined: 200, failures: [] } }),
    ];
    expect(computeJobHealth(JOB, degradedRows, NOW, STALENESS_MULTIPLIER).status).toBe("degraded");
    expect(computeJobHealth(JOB, healthyRows, NOW, STALENESS_MULTIPLIER).status).toBe("healthy");
  });

  it("reports a financial invariant violation as degraded with a distinct summary", () => {
    const rows = [
      row({
        job_name: "settle-monetary-positions",
        finished_at: "2026-01-01T11:59:00.000Z",
        status: "degraded",
        result: { candidates: 3, settledWin: 1, settledVoid: 1, notEligible: 0, alreadySettled: 0, invariantViolations: 1, failures: [] },
      }),
    ];
    const settlementJob: JobDefinition = { ...JOB, id: "settle-monetary-positions" };
    const entry = computeJobHealth(settlementJob, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("degraded");
    expect(entry.lastResultSummary).toContain("invariant violation");
  });

  it("finds the most recent successful-or-degraded run for lastSuccessfulAt even when the very latest row failed", () => {
    const rows = [
      row({ finished_at: "2026-01-01T11:59:00.000Z", status: "error", error: "transient", result: null }),
      row({ finished_at: "2026-01-01T11:57:00.000Z", status: "success", result: { examined: 1, failures: [] } }),
    ];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("failed");
    expect(entry.lastSuccessfulAt).toBe("2026-01-01T11:57:00.000Z");
  });

  it("ignores rows belonging to other jobs", () => {
    const rows = [row({ job_name: "unrelated-job", finished_at: "2026-01-01T11:59:00.000Z" })];
    const entry = computeJobHealth(JOB, rows, NOW, STALENESS_MULTIPLIER);
    expect(entry.status).toBe("never_run");
  });
});
