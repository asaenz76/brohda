// Brohda 2.1 M6 — the weekly leaderboard, as the application sees it (parsed from get_weekly_leaderboard; see lib/leaderboard/format.ts for the fail-closed parser).

export interface LeaderboardEntry {
  /** Shared by Members whose records are identical (1, 1, 3). */
  rank: number;
  tied: boolean;
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  correct: number;
  incorrect: number;
  decided: number;
  /** 0..1, exact to four places. */
  accuracy: number;
}

/** The viewer's own standing. A staff or deactivated account is never ranked (`eligible: false`). */
export type LeaderboardViewer =
  | { eligible: false; reason: "not_ranked_account" | "unknown" }
  | { eligible: true; ranked: boolean; rank: number | null; correct: number; incorrect: number; decided: number; accuracy: number | null; needed: number };

export interface WeeklyLeaderboard {
  /** ISO instants: Monday 00:00 America/Costa_Rica and the next Monday 00:00. */
  weekStart: string;
  weekEnd: string;
  /** Decided picks this week needed to be ranked. */
  minDecided: number;
  topN: number;
  totalRanked: number;
  entries: LeaderboardEntry[];
  viewer: LeaderboardViewer | null;
}

/** The policy the page reads: null when the leaderboard is off or the settings cannot be read (it fails closed). */
export interface LeaderboardConfig {
  weeklyMinDecidedPicks: number;
  topN: number;
}
