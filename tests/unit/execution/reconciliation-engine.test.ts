import { describe, expect, it } from "vitest";
import { compareExpectedToAuthoritative } from "@/lib/execution/reconciliation/engine";
import type { ExpectedOrderState, SimulatedProviderState } from "@/lib/execution/reconciliation/types";

// Milestone 5.5 reconciliation decision table (STEP 21-23) — pure, no I/O.
// Exercises every scenario STEP 22 names, using only the simulated
// authoritative-state vocabulary (lib/execution/reconciliation/types.ts).

function expected(overrides: Partial<ExpectedOrderState> = {}): ExpectedOrderState {
  return { lifecycleState: "CONFIRMED", filledAmountCents: null, ...overrides };
}

describe("compareExpectedToAuthoritative", () => {
  it("expected success matches provider state -> IN_SYNC", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 }), {
      outcome: "ACCEPTED",
      filledAmountCents: 1000,
    });
    expect(result.result).toBe("IN_SYNC");
    expect(result.mismatchDetails).toBeNull();
  });

  it("Brohda thinks success, provider says missing -> MISMATCH", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 }), { outcome: "MISSING" });
    expect(result.result).toBe("MISMATCH");
    expect(result.mismatchDetails).not.toBeNull();
  });

  it("Brohda still pending (timed out) but provider accepted -> UPDATED", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "CONFIRMED" }), { outcome: "ACCEPTED", filledAmountCents: 500 });
    expect(result.result).toBe("UPDATED");
  });

  it("provider reports duplicate -> MANUAL_REVIEW_REQUIRED, regardless of expected state", () => {
    expect(compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 }), { outcome: "DUPLICATE" }).result).toBe(
      "MANUAL_REVIEW_REQUIRED",
    );
    expect(compareExpectedToAuthoritative(expected({ lifecycleState: "CONFIRMED" }), { outcome: "DUPLICATE" }).result).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("partial-fill-like simulated state — matching amount is IN_SYNC, differing amount is MISMATCH", () => {
    const matching = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 400 }), {
      outcome: "PARTIAL",
      filledAmountCents: 400,
    });
    expect(matching.result).toBe("IN_SYNC");

    const differing = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 }), {
      outcome: "PARTIAL",
      filledAmountCents: 400,
    });
    expect(differing.result).toBe("MISMATCH");
  });

  it("cancellation-like simulated state — consistent with a rejection is IN_SYNC", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_REJECTED" }), { outcome: "CANCELLED" });
    expect(result.result).toBe("IN_SYNC");
  });

  it("provider unavailable -> PENDING, never a mismatch", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 }), { outcome: "UNAVAILABLE" });
    expect(result.result).toBe("PENDING");
    expect(result.mismatchDetails).toBeNull();
  });

  it("conflicting state -> MISMATCH", () => {
    const result: SimulatedProviderState = { outcome: "INCONSISTENT" };
    expect(compareExpectedToAuthoritative(expected({ lifecycleState: "CONFIRMED" }), result).result).toBe("MISMATCH");
  });

  it("delayed state arrival -> PENDING", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "CONFIRMED" }), { outcome: "DELAYED" });
    expect(result.result).toBe("PENDING");
  });

  it("never auto-resolves a rejected-vs-accepted disagreement as anything but MISMATCH", () => {
    const result = compareExpectedToAuthoritative(expected({ lifecycleState: "SIMULATED_REJECTED" }), { outcome: "ACCEPTED", filledAmountCents: 1000 });
    expect(result.result).toBe("MISMATCH");
  });
});
