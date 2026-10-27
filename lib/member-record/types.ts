// Brohda 2.1 M5 — a Member's competitive record, derived at read time from the canonical prediction and Call BS history (supabase/migrations/..218_member_record_summary.sql). Nothing here is stored,
// cached or writable. Pure types; see lib/member-record/format.ts for how each number is shown and docs/architecture/member-record.md for the rules.

export interface RecordCounts {
  correct: number;
  incorrect: number;
}

export interface MemberRecordSummary {
  correct: number;
  incorrect: number;
  void: number;
  /** The most recent decided picks, newest first: W = correct, L = incorrect. VOID and pending picks are not in it. */
  form: Array<"W" | "L">;
  /** The run the most recent decided picks are in, or null with no decided pick. VOID and pending picks neither extend nor break it. */
  currentStreak: { kind: "CORRECT" | "INCORRECT"; length: number } | null;
  bestCorrectStreak: number;
  thisWeek: RecordCounts;
  /** Graded picks that had Confidence behind them (a count of picks, never an amount or a score). */
  confidence: RecordCounts & { picks: number };
  bySport: Array<RecordCounts & { sport: string; void: number }>;
  bySeason: Array<RecordCounts & { sport: string; season: string }>;
}

export interface MemberOpponent {
  opponentId: string;
  name: string;
  username: string | null;
  wins: number;
  losses: number;
  voids: number;
  matchups: number;
}
