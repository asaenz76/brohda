// Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md, Reputation +
// Leaderboards). Turns Brohda's existing immutable `predictions`/
// `challenges` history into visible social reputation. Deliberately
// derives from Picks and free Challenges ONLY — never from
// wallet_balances/wallet_transactions/wallet_reservations/
// monetary_proposals/monetary_positions/monetary_position_settlements.
// See docs/architecture/reputation-leaderboards.md.

/**
 * A user's canonical prediction record (§5-8). `accuracy` is null when
 * `decided === 0` — never a fabricated 0%. `void` is counted but never
 * contributes to `decided` or `accuracy`. `eligibleForLeaderboard` is
 * derived from the CURRENT configured minimum — never persisted, never
 * cached on the user's own row.
 */
export interface UserPredictionRecord {
  correct: number;
  incorrect: number;
  void: number;
  decided: number;
  /** null when decided === 0 — a user with no decided Picks is unranked, not a 0%-accurate predictor. */
  accuracy: number | null;
  minDecidedForLeaderboard: number;
  eligibleForLeaderboard: boolean;
}

/** The separate, wallet-independent head-to-head record from R7's free Challenges (§20-25). Only RESOLVED Challenges ever contribute. */
export interface UserCallBsRecord {
  wins: number;
  losses: number;
  void: number;
}

export type LeaderboardPeriod = "ALL_TIME" | "WEEK" | "MONTH";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  correct: number;
  incorrect: number;
  void: number;
  decided: number;
  accuracy: number;
  /** Sequential, 1-based, unique per page — never a shared RANK()-style tie (see repository.ts's own comment for why). */
  rank: number;
  /** The total count of leaderboard-eligible users for this period, for pagination UI (not just this page's row count). */
  totalEligible: number;
}
