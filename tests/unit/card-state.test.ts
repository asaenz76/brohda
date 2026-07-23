import { describe, expect, it } from "vitest";
import { deriveCardState } from "@/lib/pools/card-state";

describe("deriveCardState", () => {
  it("OPEN + no entry -> OPEN_PRE_VOTE", () => {
    expect(deriveCardState({ status: "OPEN" }, { internalStatus: "NOT_STARTED" }, null)).toBe(
      "OPEN_PRE_VOTE",
    );
  });

  it("OPEN + active entry -> OPEN_POST_VOTE", () => {
    expect(deriveCardState({ status: "OPEN" }, { internalStatus: "NOT_STARTED" }, "ACTIVE")).toBe(
      "OPEN_POST_VOTE",
    );
  });

  it("LOCKED + fixture not started -> LOCKED", () => {
    expect(deriveCardState({ status: "LOCKED" }, { internalStatus: "NOT_STARTED" }, "ACTIVE")).toBe(
      "LOCKED",
    );
  });

  it("LOCKED + fixture LIVE -> LIVE", () => {
    expect(deriveCardState({ status: "LOCKED" }, { internalStatus: "LIVE" }, "ACTIVE")).toBe(
      "LIVE",
    );
  });

  it("LOCKED + fixture HALFTIME/EXTRA_TIME/PENALTIES -> LIVE", () => {
    for (const status of ["HALFTIME", "EXTRA_TIME", "PENALTIES"] as const) {
      expect(deriveCardState({ status: "LOCKED" }, { internalStatus: status }, "ACTIVE")).toBe(
        "LIVE",
      );
    }
  });

  it("AWAITING_RESULT behaves like LOCKED", () => {
    expect(
      deriveCardState({ status: "AWAITING_RESULT" }, { internalStatus: "NOT_STARTED" }, "ACTIVE"),
    ).toBe("LOCKED");
    expect(
      deriveCardState({ status: "AWAITING_RESULT" }, { internalStatus: "LIVE" }, "ACTIVE"),
    ).toBe("LIVE");
  });

  it("LOCKED/AWAITING_RESULT + anomaly fixture -> notice shown before the pool actually voids (X.7.3)", () => {
    for (const status of ["LOCKED", "AWAITING_RESULT"] as const) {
      expect(deriveCardState({ status }, { internalStatus: "POSTPONED" }, "ACTIVE")).toBe(
        "POSTPONED_NOTICE",
      );
      expect(deriveCardState({ status }, { internalStatus: "CANCELLED" }, "ACTIVE")).toBe(
        "CANCELLED_NOTICE",
      );
      expect(deriveCardState({ status }, { internalStatus: "SUSPENDED" }, "ACTIVE")).toBe(
        "SUSPENDED_NOTICE",
      );
      expect(deriveCardState({ status }, { internalStatus: "ABANDONED" }, "ACTIVE")).toBe(
        "CANCELLED_NOTICE",
      );
    }
  });

  it("LOCKED/AWAITING_RESULT + AWARDED/UNKNOWN fixture falls back to LOCKED (no dedicated bucket)", () => {
    expect(deriveCardState({ status: "LOCKED" }, { internalStatus: "AWARDED" }, "ACTIVE")).toBe(
      "LOCKED",
    );
    expect(deriveCardState({ status: "LOCKED" }, { internalStatus: "UNKNOWN" }, "ACTIVE")).toBe(
      "LOCKED",
    );
  });

  it("SETTLED + user won -> SETTLED_WON", () => {
    expect(deriveCardState({ status: "SETTLED" }, { internalStatus: "COMPLETED" }, "WON")).toBe(
      "SETTLED_WON",
    );
  });

  it("SETTLED + user lost -> SETTLED_LOST", () => {
    expect(deriveCardState({ status: "SETTLED" }, { internalStatus: "COMPLETED" }, "LOST")).toBe(
      "SETTLED_LOST",
    );
  });

  it("SETTLED + no entry -> SETTLED_LOST (no neutral bucket exists)", () => {
    expect(deriveCardState({ status: "SETTLED" }, { internalStatus: "COMPLETED" }, null)).toBe(
      "SETTLED_LOST",
    );
  });

  it("VOIDED + fixture POSTPONED -> POSTPONED_NOTICE", () => {
    expect(deriveCardState({ status: "VOIDED" }, { internalStatus: "POSTPONED" }, null)).toBe(
      "POSTPONED_NOTICE",
    );
  });

  it("VOIDED + fixture CANCELLED -> CANCELLED_NOTICE", () => {
    expect(deriveCardState({ status: "VOIDED" }, { internalStatus: "CANCELLED" }, null)).toBe(
      "CANCELLED_NOTICE",
    );
  });

  it("VOIDED + fixture SUSPENDED -> SUSPENDED_NOTICE", () => {
    expect(deriveCardState({ status: "VOIDED" }, { internalStatus: "SUSPENDED" }, null)).toBe(
      "SUSPENDED_NOTICE",
    );
  });

  it("VOIDED + fixture ABANDONED -> CANCELLED_NOTICE", () => {
    expect(deriveCardState({ status: "VOIDED" }, { internalStatus: "ABANDONED" }, null)).toBe(
      "CANCELLED_NOTICE",
    );
  });

  it("VOIDED + no matching fixture anomaly -> VOIDED", () => {
    expect(deriveCardState({ status: "VOIDED" }, { internalStatus: "COMPLETED" }, null)).toBe(
      "VOIDED",
    );
  });

  it("CANCELLED -> CANCELLED_NOTICE", () => {
    expect(deriveCardState({ status: "CANCELLED" }, { internalStatus: "NOT_STARTED" }, null)).toBe(
      "CANCELLED_NOTICE",
    );
  });

  it("READY_FOR_REVIEW / SETTLEMENT_REVERSED / REVERSAL_FAILED_MANUAL_REVIEW -> READY_FOR_REVIEW", () => {
    for (const status of [
      "READY_FOR_REVIEW",
      "SETTLEMENT_REVERSED",
      "REVERSAL_FAILED_MANUAL_REVIEW",
    ] as const) {
      expect(deriveCardState({ status }, { internalStatus: "COMPLETED" }, "ACTIVE")).toBe(
        "READY_FOR_REVIEW",
      );
    }
  });

  it("DRAFT/SCHEDULED fall back to OPEN_PRE_VOTE", () => {
    expect(deriveCardState({ status: "DRAFT" }, { internalStatus: "NOT_STARTED" }, null)).toBe(
      "OPEN_PRE_VOTE",
    );
    expect(deriveCardState({ status: "SCHEDULED" }, { internalStatus: "NOT_STARTED" }, null)).toBe(
      "OPEN_PRE_VOTE",
    );
  });

  it("VOID/REFUNDED entry status does not count as having entered", () => {
    expect(deriveCardState({ status: "OPEN" }, { internalStatus: "NOT_STARTED" }, "VOID")).toBe(
      "OPEN_PRE_VOTE",
    );
    expect(
      deriveCardState({ status: "OPEN" }, { internalStatus: "NOT_STARTED" }, "REFUNDED"),
    ).toBe("OPEN_PRE_VOTE");
  });

  it("OPEN + locksAt in the past -> LOCKED, even though pools.status hasn't caught up yet", () => {
    const pastLocksAt = new Date(Date.now() - 60_000).toISOString();
    expect(
      deriveCardState({ status: "OPEN", locksAt: pastLocksAt }, { internalStatus: "NOT_STARTED" }, null),
    ).toBe("LOCKED");
    expect(
      deriveCardState(
        { status: "OPEN", locksAt: pastLocksAt },
        { internalStatus: "NOT_STARTED" },
        "ACTIVE",
      ),
    ).toBe("LOCKED");
  });

  it("OPEN + locksAt in the future -> unaffected (still pre/post vote)", () => {
    const futureLocksAt = new Date(Date.now() + 60_000).toISOString();
    expect(
      deriveCardState({ status: "OPEN", locksAt: futureLocksAt }, { internalStatus: "NOT_STARTED" }, null),
    ).toBe("OPEN_PRE_VOTE");
    expect(
      deriveCardState(
        { status: "OPEN", locksAt: futureLocksAt },
        { internalStatus: "NOT_STARTED" },
        "ACTIVE",
      ),
    ).toBe("OPEN_POST_VOTE");
  });

  it("OPEN + no locksAt provided -> unaffected (existing callers without the field keep working)", () => {
    expect(deriveCardState({ status: "OPEN" }, { internalStatus: "NOT_STARTED" }, null)).toBe(
      "OPEN_PRE_VOTE",
    );
  });
});
