import type { PoolType } from "./templates";

export type WinningSide = "HOME" | "AWAY" | "DRAW";

export type WinningOptionReason =
  | "ADVANCED_IN_REGULATION"
  | "ADVANCED_IN_EXTRA_TIME"
  | "ADVANCED_ON_PENALTIES"
  | "REGULATION_HOME_WIN"
  | "REGULATION_DRAW"
  | "REGULATION_AWAY_WIN";

export interface FixtureScoresForSettlement {
  homeScore: number | null;
  awayScore: number | null;
  regulationHomeScore: number | null;
  regulationAwayScore: number | null;
  extraTimeHomeScore: number | null;
  extraTimeAwayScore: number | null;
  penaltyHomeScore: number | null;
  penaltyAwayScore: number | null;
}

export interface WinningSideResult {
  side: WinningSide | null;
  reason: WinningOptionReason | null;
  requiresManualVerification: boolean;
}

/**
 * Mirrors `prepare_pool_settlement`'s winning-side determination (the SQL
 * function is authoritative — this is a pure, unit-testable copy of the same
 * algorithm for documentation and regression coverage). No precomputed
 * winner columns exist on `fixtures`; the side is derived from score columns
 * Phase 3 already syncs.
 *
 * WHO_WILL_ADVANCE (spec §16.2, "never regulation score alone"): prefer
 * penalty scores when present; else fall back to the final score
 * (home_score/away_score, which includes extra time but excludes penalty
 * goals per API-Football's own semantics); ambiguous otherwise.
 *
 * REGULATION_RESULT (spec §16.3): the 90-minute score only
 * (regulationHomeScore/regulationAwayScore, API-Football's `score.fulltime`
 * even when extra time was played) — never inferred from the aggregate
 * score when ET/penalties were played.
 */
export function determineWinningSide(
  poolType: PoolType,
  fixture: FixtureScoresForSettlement,
): WinningSideResult {
  if (poolType === "WHO_WILL_ADVANCE") {
    if (
      fixture.penaltyHomeScore != null &&
      fixture.penaltyAwayScore != null &&
      fixture.penaltyHomeScore !== fixture.penaltyAwayScore
    ) {
      return {
        side: fixture.penaltyHomeScore > fixture.penaltyAwayScore ? "HOME" : "AWAY",
        reason: "ADVANCED_ON_PENALTIES",
        requiresManualVerification: false,
      };
    }

    if (
      fixture.homeScore != null &&
      fixture.awayScore != null &&
      fixture.homeScore !== fixture.awayScore
    ) {
      const wentToExtraTime = fixture.extraTimeHomeScore != null || fixture.extraTimeAwayScore != null;
      return {
        side: fixture.homeScore > fixture.awayScore ? "HOME" : "AWAY",
        reason: wentToExtraTime ? "ADVANCED_IN_EXTRA_TIME" : "ADVANCED_IN_REGULATION",
        requiresManualVerification: false,
      };
    }

    return { side: null, reason: null, requiresManualVerification: true };
  }

  // REGULATION_RESULT
  if (fixture.regulationHomeScore != null && fixture.regulationAwayScore != null) {
    if (fixture.regulationHomeScore > fixture.regulationAwayScore) {
      return { side: "HOME", reason: "REGULATION_HOME_WIN", requiresManualVerification: false };
    }
    if (fixture.regulationHomeScore < fixture.regulationAwayScore) {
      return { side: "AWAY", reason: "REGULATION_AWAY_WIN", requiresManualVerification: false };
    }
    return { side: "DRAW", reason: "REGULATION_DRAW", requiresManualVerification: false };
  }

  return { side: null, reason: null, requiresManualVerification: true };
}

export interface SettlementMath {
  houseFeeAmount: number;
  netPrizePool: number;
  payoutPerEntry: number;
  roundingRemainder: number;
}

/**
 * Integer-only settlement math (spec §16.7/Decision 3) — mirrors the SQL:
 * house fee is a truncating bps cut of the gross pool, the remainder of
 * dividing the net pool among winners is truncated per-entry and the
 * leftover always goes to the house, never redistributed.
 */
export function computeSettlementMath(
  grossPool: number,
  houseFeeBps: number,
  winningEntryCount: number,
): SettlementMath {
  const houseFeeAmount = Math.trunc((grossPool * houseFeeBps) / 10000);
  const netPrizePool = grossPool - houseFeeAmount;

  if (winningEntryCount <= 0) {
    return { houseFeeAmount, netPrizePool, payoutPerEntry: 0, roundingRemainder: 0 };
  }

  const payoutPerEntry = Math.trunc(netPrizePool / winningEntryCount);
  const roundingRemainder = netPrizePool - payoutPerEntry * winningEntryCount;

  return { houseFeeAmount, netPrizePool, payoutPerEntry, roundingRemainder };
}

export interface FeeRetainedRefund {
  feeAmount: number;
  netRefund: number;
}

/**
 * Combo pools' "zero winners on the graded-correct side" refund: unlike
 * every other refund reason (full amount, no fee — confirm_pool_refund
 * never computes a fee at all), the coordinator still earns its cut here,
 * as if the pool had settled normally. Computed per-entry, truncating like
 * every other bps calculation in this app, so netRefund + feeAmount always
 * equals entryAmount exactly (no separate rounding-remainder bucket needed,
 * unlike the multi-way payout split in computeSettlementMath). Mirrors
 * confirm_combo_refund_fee_retained's SQL exactly.
 */
export function computeFeeRetainedRefund(entryAmount: number, houseFeeBps: number): FeeRetainedRefund {
  const feeAmount = Math.trunc((entryAmount * houseFeeBps) / 10000);
  return { feeAmount, netRefund: entryAmount - feeAmount };
}

/** Spec §16.8: the lock job's below-minimum check. */
export function isBelowMinimum(validEntryCount: number, minTotalEntries: number): boolean {
  return validEntryCount < minTotalEntries;
}

/** Spec §16.8: a valid result mapping to an option nobody selected. */
export function isNoWinner(winningEntryCount: number): boolean {
  return winningEntryCount === 0;
}

/** Spec §16.8: every valid entry selected the winning option. */
export function isAllWinner(winningEntryCount: number, totalValidEntries: number): boolean {
  return totalValidEntries > 0 && winningEntryCount === totalValidEntries;
}
