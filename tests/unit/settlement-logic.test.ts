import { describe, expect, it } from "vitest";
import {
  computeFeeRetainedRefund,
  computeSettlementMath,
  determineWinningSide,
  isAllWinner,
  isBelowMinimum,
  isNoWinner,
} from "@/lib/pools/settlement-logic";

const emptyScores = {
  homeScore: null,
  awayScore: null,
  regulationHomeScore: null,
  regulationAwayScore: null,
  extraTimeHomeScore: null,
  extraTimeAwayScore: null,
  penaltyHomeScore: null,
  penaltyAwayScore: null,
};

describe("determineWinningSide", () => {
  describe("WHO_WILL_ADVANCE", () => {
    it("prefers penalty scores when present", () => {
      const result = determineWinningSide("WHO_WILL_ADVANCE", {
        ...emptyScores,
        homeScore: 1,
        awayScore: 1,
        penaltyHomeScore: 4,
        penaltyAwayScore: 3,
      });
      expect(result).toEqual({
        side: "HOME",
        reason: "ADVANCED_ON_PENALTIES",
        requiresManualVerification: false,
      });
    });

    it("falls back to the final score when no penalties were played", () => {
      const result = determineWinningSide("WHO_WILL_ADVANCE", {
        ...emptyScores,
        homeScore: 1,
        awayScore: 2,
      });
      expect(result).toEqual({
        side: "AWAY",
        reason: "ADVANCED_IN_REGULATION",
        requiresManualVerification: false,
      });
    });

    it("labels a decisive extra-time score distinctly from regulation", () => {
      const result = determineWinningSide("WHO_WILL_ADVANCE", {
        ...emptyScores,
        homeScore: 2,
        awayScore: 1,
        extraTimeHomeScore: 1,
        extraTimeAwayScore: 0,
      });
      expect(result.reason).toBe("ADVANCED_IN_EXTRA_TIME");
    });

    it("requires manual verification when scores are level with no penalty record", () => {
      const result = determineWinningSide("WHO_WILL_ADVANCE", {
        ...emptyScores,
        homeScore: 1,
        awayScore: 1,
      });
      expect(result).toEqual({ side: null, reason: null, requiresManualVerification: true });
    });

    it("requires manual verification when scores are missing entirely", () => {
      expect(determineWinningSide("WHO_WILL_ADVANCE", emptyScores).requiresManualVerification).toBe(
        true,
      );
    });
  });

  describe("REGULATION_RESULT", () => {
    it("uses the 90-minute score only, ignoring extra time/penalties", () => {
      const result = determineWinningSide("REGULATION_RESULT", {
        ...emptyScores,
        regulationHomeScore: 1,
        regulationAwayScore: 1,
        extraTimeHomeScore: 1,
        extraTimeAwayScore: 0,
        penaltyHomeScore: 4,
        penaltyAwayScore: 3,
      });
      // Same fixture as the WHO_WILL_ADVANCE penalty-shootout example above,
      // but REGULATION_RESULT must read it as a Draw — spec §16.3's example.
      expect(result).toEqual({
        side: "DRAW",
        reason: "REGULATION_DRAW",
        requiresManualVerification: false,
      });
    });

    it("home win / away win from the regulation score", () => {
      expect(
        determineWinningSide("REGULATION_RESULT", {
          ...emptyScores,
          regulationHomeScore: 2,
          regulationAwayScore: 0,
        }),
      ).toMatchObject({ side: "HOME", reason: "REGULATION_HOME_WIN" });

      expect(
        determineWinningSide("REGULATION_RESULT", {
          ...emptyScores,
          regulationHomeScore: 0,
          regulationAwayScore: 2,
        }),
      ).toMatchObject({ side: "AWAY", reason: "REGULATION_AWAY_WIN" });
    });

    it("requires manual verification when the regulation score is missing", () => {
      const result = determineWinningSide("REGULATION_RESULT", emptyScores);
      expect(result).toEqual({ side: null, reason: null, requiresManualVerification: true });
    });
  });
});

describe("computeSettlementMath", () => {
  it("computes house fee, net pool, and per-entry payout", () => {
    const math = computeSettlementMath(10_000, 1000, 6); // $100, 10%, 6 winners
    expect(math.houseFeeAmount).toBe(1000);
    expect(math.netPrizePool).toBe(9000);
    expect(math.payoutPerEntry).toBe(1500);
    expect(math.roundingRemainder).toBe(0);
  });

  it("truncates the per-entry payout and credits the remainder to the house", () => {
    const math = computeSettlementMath(1000, 0, 3); // $10, 0 winners fee, 3 winners
    expect(math.payoutPerEntry).toBe(333);
    expect(math.roundingRemainder).toBe(1);
    expect(math.payoutPerEntry * 3 + math.roundingRemainder).toBe(math.netPrizePool);
  });

  it("remainder is zero with a single winner", () => {
    const math = computeSettlementMath(999, 0, 1);
    expect(math.payoutPerEntry).toBe(999);
    expect(math.roundingRemainder).toBe(0);
  });

  it("zero winners produces zero payout and zero remainder", () => {
    const math = computeSettlementMath(1000, 0, 0);
    expect(math.payoutPerEntry).toBe(0);
    expect(math.roundingRemainder).toBe(0);
  });
});

describe("computeFeeRetainedRefund", () => {
  it("truncates the fee and refunds the rest, summing exactly to the entry amount", () => {
    const result = computeFeeRetainedRefund(1000, 1000); // $10, 10% fee
    expect(result.feeAmount).toBe(100);
    expect(result.netRefund).toBe(900);
    expect(result.feeAmount + result.netRefund).toBe(1000);
  });

  it("truncates in the house's favor on an uneven split, still summing exactly", () => {
    const result = computeFeeRetainedRefund(105, 1000); // 10.5 -> truncates to 10
    expect(result.feeAmount).toBe(10);
    expect(result.netRefund).toBe(95);
    expect(result.feeAmount + result.netRefund).toBe(105);
  });

  it("zero house fee refunds the full amount", () => {
    const result = computeFeeRetainedRefund(1000, 0);
    expect(result.feeAmount).toBe(0);
    expect(result.netRefund).toBe(1000);
  });
});

describe("isBelowMinimum / isNoWinner / isAllWinner", () => {
  it("isBelowMinimum", () => {
    expect(isBelowMinimum(1, 2)).toBe(true);
    expect(isBelowMinimum(2, 2)).toBe(false);
  });

  it("isNoWinner", () => {
    expect(isNoWinner(0)).toBe(true);
    expect(isNoWinner(1)).toBe(false);
  });

  it("isAllWinner", () => {
    expect(isAllWinner(5, 5)).toBe(true);
    expect(isAllWinner(3, 5)).toBe(false);
    expect(isAllWinner(0, 0)).toBe(false); // no entries at all is not "all winning"
  });
});
