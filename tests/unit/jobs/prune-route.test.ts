import { beforeEach, describe, expect, it, vi } from "vitest";

let providerLogResult: () => Promise<unknown>;
let backgroundJobsResult: () => Promise<unknown>;
let messagingResult: () => Promise<unknown>;
let confidenceResult: () => Promise<unknown>;
const providerLogCalls = vi.fn();
const backgroundJobsCalls = vi.fn();
const messagingCalls = vi.fn();
const confidenceCalls = vi.fn();

vi.mock("@/lib/sports-data/provider-request-log-retention", () => ({
  runProviderRequestLogRetention: () => {
    providerLogCalls();
    return providerLogResult();
  },
}));
vi.mock("@/lib/jobs/retention", () => ({
  runBackgroundJobsRetention: () => {
    backgroundJobsCalls();
    return backgroundJobsResult();
  },
}));
vi.mock("@/lib/messaging/retention", () => ({
  runMessagingRetention: () => {
    messagingCalls();
    return messagingResult();
  },
}));
vi.mock("@/lib/confidence/bootstrap", () => ({
  runConfidenceBootstrap: () => {
    confidenceCalls();
    return confidenceResult();
  },
}));
// recordJobRun is exercised by its own tests; here it just runs the job and hands the result back.
vi.mock("@/lib/jobs/record", () => ({ recordJobRun: async (_name: string, fn: () => Promise<unknown>) => fn() }));

const { GET } = await import("@/app/api/cron/prune-provider-request-log/route");

function request(authorization?: string): Request {
  return new Request("https://example.test/api/cron/prune-provider-request-log", { headers: authorization ? { authorization } : {} });
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  providerLogCalls.mockClear();
  backgroundJobsCalls.mockClear();
  messagingCalls.mockClear();
  confidenceCalls.mockClear();
  confidenceResult = async () => ({ enabled: false, rounds: 0, processed: 0, remaining: 0 });
  messagingResult = async () => ({ enabled: false, rounds: 0, removed: {} });
  providerLogResult = async () => ({ batchesRun: 1, rowsDeleted: 7 });
  backgroundJobsResult = async () => ({ batchesRun: 2, rowsDeleted: 1500, retentionDays: 14 });
});

describe("prune-provider-request-log cron route", () => {
  it("is refused without the bearer secret, and prunes nothing", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect(providerLogCalls).not.toHaveBeenCalled();
    expect(backgroundJobsCalls).not.toHaveBeenCalled();
  });

  it("is refused when no CRON_SECRET is configured at all", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer undefined"))).status).toBe(401);
    expect(backgroundJobsCalls).not.toHaveBeenCalled();
  });

  it("runs both retentions on the one existing path and reports both", async () => {
    const response = await GET(request("Bearer test-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      batchesRun: 1,
      rowsDeleted: 7,
      backgroundJobs: { batchesRun: 2, rowsDeleted: 1500, retentionDays: 14 },
      messaging: { enabled: false, rounds: 0, removed: {} },
      confidence: { enabled: false, rounds: 0, processed: 0, remaining: 0 },
      failures: [],
    });
  });

  it("a failure pruning the request log never skips run-history pruning, and is reported so Job Health reads degraded", async () => {
    providerLogResult = async () => {
      throw new Error("log prune failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(backgroundJobsCalls).toHaveBeenCalledTimes(1);
    expect(body.backgroundJobs.rowsDeleted).toBe(1500);
    expect(body.failures).toEqual([{ step: "provider_request_log", error: "log prune failed" }]);
  });

  it("a failure pruning run history never skips request-log pruning, and is reported", async () => {
    backgroundJobsResult = async () => {
      throw new Error("history prune failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(providerLogCalls).toHaveBeenCalledTimes(1);
    expect(body.rowsDeleted).toBe(7);
    expect(body.backgroundJobs).toBeNull();
    expect(body.failures).toEqual([{ step: "background_jobs", error: "history prune failed" }]);
  });

  it("Messaging retention runs on the same path in its own failure domain: its failure skips nothing else and is reported", async () => {
    messagingResult = async () => {
      throw new Error("messaging purge failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(providerLogCalls).toHaveBeenCalledTimes(1);
    expect(backgroundJobsCalls).toHaveBeenCalledTimes(1);
    expect(body.rowsDeleted).toBe(7);
    expect(body.backgroundJobs.rowsDeleted).toBe(1500);
    expect(body.messaging).toBeNull();
    expect(body.failures).toEqual([{ step: "messaging_retention", error: "messaging purge failed" }]);
  });

  it("an earlier failure never skips Messaging retention", async () => {
    providerLogResult = async () => {
      throw new Error("log prune failed");
    };
    backgroundJobsResult = async () => {
      throw new Error("history prune failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(messagingCalls).toHaveBeenCalledTimes(1);
    expect(body.messaging).toEqual({ enabled: false, rounds: 0, removed: {} });
    expect(body.failures).toHaveLength(2);
  });

  it("Confidence bootstrap runs on the same path in its own failure domain: its failure skips nothing else and is reported", async () => {
    confidenceResult = async () => {
      throw new Error("confidence bootstrap failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(providerLogCalls).toHaveBeenCalledTimes(1);
    expect(backgroundJobsCalls).toHaveBeenCalledTimes(1);
    expect(messagingCalls).toHaveBeenCalledTimes(1);
    expect(body.confidence).toBeNull();
    expect(body.failures).toEqual([{ step: "confidence_bootstrap", error: "confidence bootstrap failed" }]);
  });

  it("an earlier failure never skips the Confidence bootstrap", async () => {
    messagingResult = async () => {
      throw new Error("messaging purge failed");
    };
    const body = await (await GET(request("Bearer test-secret"))).json();
    expect(confidenceCalls).toHaveBeenCalledTimes(1);
    expect(body.confidence).toEqual({ enabled: false, rounds: 0, processed: 0, remaining: 0 });
  });
});
