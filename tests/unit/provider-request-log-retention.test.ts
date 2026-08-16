import { afterEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import {
  PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK,
  PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE,
  PROVIDER_REQUEST_LOG_RETENTION_DAYS,
  runProviderRequestLogRetention,
} from "@/lib/sports-data/provider-request-log-retention";

describe("runProviderRequestLogRetention", () => {
  afterEach(() => {
    rpcMock.mockClear();
  });

  it("stops after one batch when fewer rows than the batch size were deleted", async () => {
    rpcMock.mockResolvedValueOnce({ data: 42, error: null });

    const result = await runProviderRequestLogRetention();

    expect(result).toEqual({ batchesRun: 1, rowsDeleted: 42 });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("delete_old_provider_request_log_rows", {
      p_retention_days: PROVIDER_REQUEST_LOG_RETENTION_DAYS,
      p_batch_size: PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE,
    });
  });

  it("keeps batching while a batch is full, up to the per-tick cap", async () => {
    rpcMock.mockResolvedValue({ data: PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE, error: null });

    const result = await runProviderRequestLogRetention();

    expect(result).toEqual({
      batchesRun: PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK,
      rowsDeleted: PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK * PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE,
    });
    expect(rpcMock).toHaveBeenCalledTimes(PROVIDER_REQUEST_LOG_BATCHES_PER_CRON_TICK);
  });

  it("stops early once a batch comes back empty", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE, error: null })
      .mockResolvedValueOnce({ data: 0, error: null });

    const result = await runProviderRequestLogRetention();

    expect(result).toEqual({ batchesRun: 2, rowsDeleted: PROVIDER_REQUEST_LOG_DELETE_BATCH_SIZE });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("throws a real Error on an RPC error, not the raw Postgrest error object", async () => {
    // Postgrest errors (what supabase-js actually returns) are plain
    // objects, not Error instances — e.g. the statement-timeout error hit
    // in production. Asserting against this shape catches recordJobRun's
    // `error instanceof Error ? error.message : String(error)` collapsing
    // an unwrapped raw object to the unreadable "[object Object]".
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" },
    });

    await expect(runProviderRequestLogRetention()).rejects.toThrow("canceling statement due to statement timeout");
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
