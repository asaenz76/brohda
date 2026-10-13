import { beforeEach, describe, expect, it, vi } from "vitest";

// What the (mocked) platform_settings read returns, and every database call retention makes.
let settingsRow: Record<string, unknown> | null = { background_job_retention_days: 14 };
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResults: Array<{ data: number | null; error: { message: string } | null }> = [];
let tablesTouched: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      tablesTouched.push(table);
      return { select: () => ({ eq: () => ({ single: async () => ({ data: settingsRow, error: null }) }) }) };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResults.shift() ?? { data: 0, error: null };
    },
  }),
}));

const { runBackgroundJobsRetention, isValidRetentionDays, BACKGROUND_JOBS_DELETE_BATCH_SIZE, BACKGROUND_JOBS_BATCHES_PER_CRON_TICK, BACKGROUND_JOBS_KEEP_LATEST_PER_JOB } =
  await import("@/lib/jobs/retention");

beforeEach(() => {
  settingsRow = { background_job_retention_days: 14 };
  rpcCalls = [];
  rpcResults = [];
  tablesTouched = [];
});

describe("isValidRetentionDays", () => {
  it("accepts only whole numbers of days of at least 1", () => {
    expect(isValidRetentionDays(14)).toBe(true);
    expect(isValidRetentionDays(1)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "14", null, undefined, {}, [14]]) {
      expect(isValidRetentionDays(bad), `${String(bad)} must not be a valid window`).toBe(false);
    }
  });
});

describe("runBackgroundJobsRetention — fail-safe", () => {
  it("deletes nothing when the setting row is missing", async () => {
    settingsRow = null;
    const result = await runBackgroundJobsRetention();
    expect(result).toEqual({ batchesRun: 0, rowsDeleted: 0, retentionDays: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it("deletes nothing when the setting is malformed (null, zero, negative, fractional, a string)", async () => {
    for (const bad of [null, 0, -5, 2.5, "14", Number.NaN]) {
      settingsRow = { background_job_retention_days: bad };
      const result = await runBackgroundJobsRetention();
      expect(result.retentionDays, `${String(bad)}`).toBeNull();
      expect(result.rowsDeleted).toBe(0);
    }
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("runBackgroundJobsRetention — deleting", () => {
  it("passes the configured window and the newest-50 guard to the one database function", async () => {
    settingsRow = { background_job_retention_days: 21 };
    await runBackgroundJobsRetention();
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      fn: "delete_old_background_jobs_rows",
      args: { p_retention_days: 21, p_batch_size: BACKGROUND_JOBS_DELETE_BATCH_SIZE, p_keep_latest_per_job: BACKGROUND_JOBS_KEEP_LATEST_PER_JOB },
    });
    expect(BACKGROUND_JOBS_KEEP_LATEST_PER_JOB).toBe(50);
  });

  it("keeps going while batches come back full, and stops at the first short batch", async () => {
    rpcResults = [
      { data: BACKGROUND_JOBS_DELETE_BATCH_SIZE, error: null },
      { data: BACKGROUND_JOBS_DELETE_BATCH_SIZE, error: null },
      { data: 250, error: null },
    ];
    const result = await runBackgroundJobsRetention();
    expect(result).toEqual({ batchesRun: 3, rowsDeleted: 2250, retentionDays: 14 });
    expect(rpcCalls).toHaveLength(3);
  });

  it("caps the work of one tick", async () => {
    rpcResults = Array.from({ length: BACKGROUND_JOBS_BATCHES_PER_CRON_TICK + 5 }, () => ({ data: BACKGROUND_JOBS_DELETE_BATCH_SIZE, error: null }));
    const result = await runBackgroundJobsRetention();
    expect(result.batchesRun).toBe(BACKGROUND_JOBS_BATCHES_PER_CRON_TICK);
    expect(result.rowsDeleted).toBe(BACKGROUND_JOBS_BATCHES_PER_CRON_TICK * BACKGROUND_JOBS_DELETE_BATCH_SIZE);
  });

  it("surfaces a database error with its real message instead of swallowing it", async () => {
    rpcResults = [{ data: null, error: { message: "canceling statement due to statement timeout" } }];
    await expect(runBackgroundJobsRetention()).rejects.toThrow("canceling statement due to statement timeout");
  });

  it("reads only the retention setting and calls only the retention function — it never touches another table", async () => {
    rpcResults = [{ data: 5, error: null }];
    await runBackgroundJobsRetention();
    expect(new Set(tablesTouched)).toEqual(new Set(["platform_settings"]));
    expect(new Set(rpcCalls.map((c) => c.fn))).toEqual(new Set(["delete_old_background_jobs_rows"]));
  });
});
