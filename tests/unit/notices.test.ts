import { describe, expect, it } from "vitest";
import { buildNoticeCopy, voidReasonLabel } from "@/lib/pools/notices";

const base = {
  poolStatus: "LOCKED" as const,
  fixtureInternalStatus: "NOT_STARTED" as const,
  voidReason: null,
  entryStatus: null,
  entryAmount: 0,
  finalPayout: null,
};

describe("buildNoticeCopy", () => {
  it("LOCKED, no anomaly -> the standard locked notice", () => {
    expect(buildNoticeCopy(base)).toEqual({
      type: "LOCKED",
      message: "Choices are locked. Waiting for kickoff.",
    });
  });

  it("LOCKED/AWAITING_RESULT + anomaly fixture -> pending notice, before any void has happened", () => {
    expect(
      buildNoticeCopy({ ...base, fixtureInternalStatus: "SUSPENDED" }),
    ).toEqual({
      type: "SUSPENDED_PENDING",
      message: "Match Suspended. Choices are closed while we wait for an official update.",
    });
    expect(
      buildNoticeCopy({
        ...base,
        poolStatus: "AWAITING_RESULT",
        fixtureInternalStatus: "POSTPONED",
      }),
    ).toEqual({
      type: "POSTPONED_PENDING",
      message: "Match Postponed. Choices are closed while we wait for an official update.",
    });
  });

  it("READY_FOR_REVIEW (and its reversal-adjacent aliases) -> neutral pending-review copy", () => {
    for (const poolStatus of [
      "READY_FOR_REVIEW",
      "SETTLEMENT_REVERSED",
      "REVERSAL_FAILED_MANUAL_REVIEW",
    ] as const) {
      expect(buildNoticeCopy({ ...base, poolStatus })).toEqual({
        type: "READY_FOR_REVIEW",
        message: "Match complete. Results are pending review.",
      });
    }
  });

  it("LOCKED for a CUSTOM pool -> non-sports wording, no 'kickoff'", () => {
    expect(buildNoticeCopy({ ...base, poolType: "CUSTOM" })).toEqual({
      type: "LOCKED",
      message: "Choices are locked. Waiting for the result.",
    });
  });

  it("READY_FOR_REVIEW for a CUSTOM pool -> non-sports wording, no 'Match complete'", () => {
    expect(
      buildNoticeCopy({ ...base, poolStatus: "READY_FOR_REVIEW", poolType: "CUSTOM" }),
    ).toEqual({
      type: "READY_FOR_REVIEW",
      message: "Voting has ended. Results are pending review.",
    });
  });

  it("SETTLED + WON -> the celebratory payout copy (X.5.14)", () => {
    expect(
      buildNoticeCopy({
        ...base,
        poolStatus: "SETTLED",
        entryStatus: "WON",
        finalPayout: 1800,
      }),
    ).toEqual({ type: "SETTLED_WON", message: "You won $18.00" });
  });

  it("SETTLED + LOST without labels -> no notice yet (avoids a bare/shaming message)", () => {
    expect(buildNoticeCopy({ ...base, poolStatus: "SETTLED", entryStatus: "LOST" })).toBeNull();
  });

  it("SETTLED + LOST with labels -> X.5.14's losing copy", () => {
    expect(
      buildNoticeCopy({
        ...base,
        poolStatus: "SETTLED",
        entryStatus: "LOST",
        winningOptionLabel: "Spain",
        selectedOptionLabel: "France",
      }),
    ).toEqual({ type: "SETTLED_LOST", message: "Spain won. Your choice was France." });
  });

  describe("VOIDED / CANCELLED — X.7.6-11 copy", () => {
    it("no entry -> the generic no-refund-wording copy (X.7.10), regardless of reason", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
          entryStatus: null,
        }),
      ).toEqual({
        type: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
        message: "This pool has been voided and all entries have been refunded.",
      });
    });

    it("postponed, with entry -> X.7.6", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        }),
      ).toEqual({
        type: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
        message:
          "Match Postponed. This pool has been voided. Your $10.00 entry fee has been automatically credited back to your balance.",
      });
    });

    it("cancelled, with entry -> X.7.7", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_CANCELLED",
          entryStatus: "REFUNDED",
          entryAmount: 500,
        })?.message,
      ).toBe(
        "Match Cancelled. This pool has been voided. Your $5.00 entry fee has been automatically credited back to your balance.",
      );
    });

    it("abandoned, with entry -> X.7.8", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_ABANDONED",
          entryStatus: "REFUNDED",
          entryAmount: 500,
        })?.message,
      ).toBe(
        "Match Abandoned. This pool has been voided. Your $5.00 entry fee has been automatically credited back to your balance.",
      );
    });

    it("suspended and voided (day elapsed), with entry -> X.7.9's second copy variant", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY",
          entryStatus: "REFUNDED",
          entryAmount: 500,
        })?.message,
      ).toBe(
        "Match Suspended. The match was not completed today, so this pool has been voided. Your $5.00 entry fee has been credited back to your balance.",
      );
    });

    it("below minimum entries -> X.7.11's cancellation copy, pool status CANCELLED", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "CANCELLED",
          voidReason: "MINIMUM_ENTRIES_NOT_REACHED",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toBe(
        "Not enough players joined. This pool has been cancelled and your $10.00 entry has been credited back to your balance.",
      );
    });

    it("no winning entries -> X.7.11's no-winner copy", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "NO_WINNING_ENTRIES",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toBe(
        "Nobody picked the winning outcome, so this pool has been refunded. Your $10.00 entry has been credited back to your balance.",
      );
    });

    it("all entries winning -> X.7.11's all-winner copy", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "ALL_ENTRIES_WINNING",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toBe(
        "Everyone picked the winner! This pool has been refunded — no fee taken. Your $10.00 entry has been credited back to your balance.",
      );
    });

    it("combo pool with zero winners on the graded side -> refund copy shows the net-of-fee amount", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "NO_WINNING_ENTRIES_FEE_RETAINED",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
          houseFeeBasisPoints: 1000, // 10%
        })?.message,
      ).toBe(
        "Nobody picked the graded outcome, so this pool has been refunded. Your $9.00 entry (net of the platform fee) has been credited back to your balance.",
      );
    });

    it("combo pool voided for a Did Not Play leg -> full refund, no fee mentioned", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "COMBO_PLAYER_DID_NOT_PLAY",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toBe(
        "A featured player did not take the pitch, so this pool has been voided — no fee taken. Your $10.00 entry has been credited back to your balance.",
      );
    });

    it("AWARDED and UNKNOWN get reasonable non-literal copy in the same tone", () => {
      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_AWARDED",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toContain("Match Awarded.");

      expect(
        buildNoticeCopy({
          ...base,
          poolStatus: "VOIDED",
          voidReason: "MATCH_STATUS_UNKNOWN",
          entryStatus: "REFUNDED",
          entryAmount: 1000,
        })?.message,
      ).toContain("could not be confirmed");
    });
  });
});

describe("voidReasonLabel", () => {
  it("translates every pool_void_reason enum value to a short, plain-text label", () => {
    const reasons = [
      "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
      "MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY",
      "MATCH_ABANDONED",
      "MATCH_CANCELLED",
      "MATCH_AWARDED",
      "MATCH_STATUS_UNKNOWN",
      "MINIMUM_ENTRIES_NOT_REACHED",
      "NO_WINNING_ENTRIES",
      "ALL_ENTRIES_WINNING",
      "ADMIN_MANUAL_CANCEL",
      "NO_WINNING_ENTRIES_FEE_RETAINED",
      "COMBO_PLAYER_DID_NOT_PLAY",
    ];

    for (const reason of reasons) {
      const label = voidReasonLabel(reason);
      expect(label).not.toContain("_");
      expect(label).not.toBe(reason);
    }
  });

  it("passes free-text reasons (e.g. admin notes) through unchanged", () => {
    expect(voidReasonLabel("Self-service account closure")).toBe("Self-service account closure");
  });
});
