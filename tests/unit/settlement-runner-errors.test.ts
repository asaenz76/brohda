import { describe, expect, it, vi } from "vitest";

// A Supabase/PostgREST failure arrives as a plain object, not an Error. The job
// summary is the only place an operator sees why a run went "degraded", so it
// must carry the real text — this is the exact shape that read "[object Object]"
// in production between a deploy and its migration.
const repository = vi.hoisted(() => ({
  expireStaleMonetaryProposals: vi.fn(),
  listSettlementEligiblePositionIds: vi.fn(),
  settleMonetaryPosition: vi.fn(),
  getMonetaryPositionById: vi.fn(),
}));
vi.mock("@/lib/monetary/repository", () => repository);
vi.mock("@/lib/notifications/monetary-settlements", () => ({ createSettlementNotifications: vi.fn() }));
vi.mock("@/lib/notifications/monetary-proposals", () => ({ createMonetaryProposalExpiredNotification: vi.fn() }));

import { runSettlementJob } from "@/lib/monetary/settlement-runner";
import { isDegradedResult } from "@/lib/jobs/health";

describe("runSettlementJob failure reporting", () => {
  it("records a plain-object sweep failure with its real message, still settles, and reads as degraded", async () => {
    repository.expireStaleMonetaryProposals.mockRejectedValue({ message: "Could not find the function public.expire_stale_monetary_proposals", code: "PGRST202" });
    repository.listSettlementEligiblePositionIds.mockResolvedValue(["pos-1"]);
    repository.settleMonetaryPosition.mockResolvedValue({ outcome: "already_settled" });

    const summary = await runSettlementJob();

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].error).toContain("proposal expiry sweep failed");
    expect(summary.failures[0].error).toContain("expire_stale_monetary_proposals");
    expect(summary.failures[0].error).not.toContain("[object Object]");
    expect(summary.alreadySettled).toBe(1); // settlement was not blocked by the sweep failing
    expect(isDegradedResult(summary)).toBe(true);
  });

  it("records a plain-object settlement failure with its real message", async () => {
    repository.expireStaleMonetaryProposals.mockResolvedValue([]);
    repository.listSettlementEligiblePositionIds.mockResolvedValue(["pos-2"]);
    repository.settleMonetaryPosition.mockRejectedValue({ message: "deadlock detected" });

    const summary = await runSettlementJob();
    expect(summary.failures).toEqual([{ positionId: "pos-2", error: "deadlock detected" }]);
  });
});
