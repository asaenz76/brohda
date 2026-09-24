import { describe, expect, it, vi } from "vitest";
import { JOB_REGISTRY } from "@/lib/jobs/registry";

let backgroundJobsRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== "background_jobs") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          order: () => ({
            limit: async () => ({ data: backgroundJobsRows, error: null }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/admin-settings/repository", () => ({
  getBrohdaSettings: async () => ({
    operations: { settlementBatchSize: 500, gradingBatchSize: 200, challengeResolutionBatchSize: 200, jobStalenessMultiplier: 3 },
  }),
}));

const { getJobHealth } = await import("@/lib/reports/fetch");

describe("getJobHealth", () => {
  it("returns exactly one entry per job in the registry, including sync-fixtures-nfl (the previously-mismatched name)", async () => {
    backgroundJobsRows = [];
    const health = await getJobHealth();
    const ids = health.jobs.map((j) => j.job.id).sort();
    expect(ids).toEqual([...JOB_REGISTRY.map((j) => j.id)].sort());
    expect(ids).toContain("sync-fixtures-nfl");
  });

  it("classifies a job with no rows as never_run", async () => {
    backgroundJobsRows = [];
    const health = await getJobHealth();
    const entry = health.jobs.find((j) => j.job.id === "grade-predictions")!;
    expect(entry.status).toBe("never_run");
  });

  it("classifies a job with a recent clean success as healthy", async () => {
    const now = new Date();
    backgroundJobsRows = [
      {
        job_name: "grade-predictions",
        status: "success",
        result: { examined: 5, failures: [] },
        error: null,
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        duration_ms: 100,
      },
    ];
    const health = await getJobHealth();
    const entry = health.jobs.find((j) => j.job.id === "grade-predictions")!;
    expect(entry.status).toBe("healthy");
  });

  it("classifies a job with a recent degraded result as degraded, using the live jobStalenessMultiplier from settings", async () => {
    const now = new Date();
    backgroundJobsRows = [
      {
        job_name: "settle-monetary-positions",
        status: "degraded",
        result: { candidates: 2, settledWin: 1, settledVoid: 0, notEligible: 0, alreadySettled: 0, invariantViolations: 1, failures: [] },
        error: null,
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        duration_ms: 100,
      },
    ];
    const health = await getJobHealth();
    const entry = health.jobs.find((j) => j.job.id === "settle-monetary-positions")!;
    expect(entry.status).toBe("degraded");
  });

  it("classifies a job whose only run failed as failed", async () => {
    const now = new Date();
    backgroundJobsRows = [
      {
        job_name: "lock-pools",
        status: "error",
        result: null,
        error: "connection refused",
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        duration_ms: 100,
      },
    ];
    const health = await getJobHealth();
    const entry = health.jobs.find((j) => j.job.id === "lock-pools")!;
    expect(entry.status).toBe("failed");
    expect(entry.lastError).toBe("connection refused");
  });
});
