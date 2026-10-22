import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_REGISTRY } from "@/lib/jobs/registry";
import { isDegradedResult } from "@/lib/jobs/health";
import { emptyAutomationReport } from "@/lib/game-previews/scheduler";

const automation = vi.fn();
const recorded = vi.fn();
vi.mock("@/lib/game-previews/automation", () => ({ runGamePreviewAutomation: () => automation() }));
vi.mock("@/lib/jobs/record", () => ({
  recordJobRun: async (name: string, fn: () => Promise<unknown>, ttl?: number) => {
    recorded(name, ttl);
    return fn();
  },
}));

import { GET, maxDuration } from "@/app/api/cron/game-previews/route";

const request = (auth?: string) => new Request("http://localhost/api/cron/game-previews", { headers: auth ? { authorization: auth } : {} });

describe("/api/cron/game-previews: the scheduled automation's own entry point", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    automation.mockReset();
    recorded.mockReset();
    automation.mockResolvedValue(emptyAutomationReport());
  });

  it("requires the cron secret: nothing runs without it", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer undefined"))).status).toBe(401);
    expect(automation).not.toHaveBeenCalled();
  });

  it("runs the automation once under the shared overlap lock (named game-previews, outliving the function limit), and returns its report", async () => {
    const response = await GET(request("Bearer test-secret"));
    expect(response.status).toBe(200);
    expect(automation).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith("game-previews", 15 * 60);
    expect(await response.json()).toMatchObject({ enabled: false, attempted: 0 });
    expect(maxDuration).toBe(300);
  });

  it("(A) with generation off, the report is the disabled no-op: Job Health reads it as 'feature disabled', not as a failure", async () => {
    const report = emptyAutomationReport();
    expect(report).toMatchObject({ enabled: false, policyEnabled: false, attempted: 0, failed: 0, failures: [] });
    expect(isDegradedResult(report)).toBe(false);
  });

  it("a technical failure, a halt or a hide make the job degraded (failures), a needs_review does not", () => {
    expect(isDegradedResult(emptyAutomationReport({ enabled: true, needsReview: 3, attempted: 3 }))).toBe(false);
    expect(isDegradedResult(emptyAutomationReport({ enabled: true, failed: 1 }))).toBe(true);
    expect(isDegradedResult(emptyAutomationReport({ enabled: true, failures: [{ step: "hidden:fx", error: "hidden" }] }))).toBe(true);
  });

  it("the job is registered once, on its own route, with a daily cadence (so Job Health does not call a daily job stale)", () => {
    const job = JOB_REGISTRY.find((j) => j.id === "game-previews");
    expect(job).toMatchObject({ route: "/api/cron/game-previews", expectedCadenceMinutes: 1440 });
    expect(JOB_REGISTRY.filter((j) => j.route === "/api/cron/game-previews")).toHaveLength(1);
    expect(new Set(JOB_REGISTRY.map((j) => j.id)).size).toBe(JOB_REGISTRY.length);
  });
});
