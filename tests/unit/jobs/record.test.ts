import { beforeEach, describe, expect, it, vi } from "vitest";

const captureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureMessage: (...args: unknown[]) => captureMessage(...args) }));

let lockAcquired = true;
let inserted: Array<Record<string, unknown>> = [];
let released: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "try_acquire_cron_lock") return { data: lockAcquired, error: null };
      if (fn === "release_cron_lock") {
        released.push(args.p_job_name as string);
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table !== "background_jobs") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return { data: null, error: null };
        },
      };
    },
  }),
}));

// Imported after the mocks above so recordJobRun picks up the mocked modules.
const { recordJobRun } = await import("@/lib/jobs/record");

beforeEach(() => {
  lockAcquired = true;
  inserted = [];
  released = [];
  captureMessage.mockClear();
});

describe("recordJobRun — status classification", () => {
  it("records status success and never calls Sentry for a clean result", async () => {
    const result = await recordJobRun("grade-predictions", async () => ({ examined: 5, graded: 5, failures: [] }));
    expect(result).toEqual({ examined: 5, graded: 5, failures: [] });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("success");
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("records status degraded and calls Sentry with a warning-level message when there are per-item failures", async () => {
    await recordJobRun("grade-predictions", async () => ({
      examined: 200,
      graded: 199,
      failures: [{ predictionId: "p1", error: "boom" }],
    }));
    expect(inserted[0].status).toBe("degraded");
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0];
    expect(message).toContain("per-item failures");
    expect(options.level).toBe("warning");
    expect(options.tags).toEqual({ job: "grade-predictions", status: "degraded" });
    expect(options.extra.failureCount).toBe(1);
    expect(options.extra.failedIds).toEqual(["p1"]);
  });

  it("records status degraded and calls Sentry with an error-level message for a financial invariant violation", async () => {
    await recordJobRun("settle-monetary-positions", async () => ({
      candidates: 3,
      settledWin: 1,
      settledVoid: 1,
      notEligible: 0,
      alreadySettled: 0,
      invariantViolations: 1,
      failures: [],
    }));
    expect(inserted[0].status).toBe("degraded");
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0];
    expect(message).toContain("invariant violation");
    expect(options.level).toBe("error");
    expect(options.extra.invariantViolations).toBe(1);
  });

  it("still records status error and rethrows when fn() throws — degraded classification never applies", async () => {
    await expect(
      recordJobRun("grade-predictions", async () => {
        throw new Error("hard failure");
      }),
    ).rejects.toThrow("hard failure");
    expect(inserted[0].status).toBe("error");
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("skips fn() entirely and writes no row when the overlap lock is already held", async () => {
    lockAcquired = false;
    const fn = vi.fn();
    const result = await recordJobRun("grade-predictions", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(result).toEqual({ skipped: true, reason: expect.stringContaining("grade-predictions") });
  });

  it("always releases the lock, including after a thrown error", async () => {
    await expect(
      recordJobRun("grade-predictions", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect(released).toEqual(["grade-predictions"]);
  });
});
