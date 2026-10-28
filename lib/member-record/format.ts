import { getSportConfig } from "@/lib/sports-data/sport-registry";
import type { MemberRecordSummary, RecordCounts } from "./types";

// Brohda 2.1 M5 — how a record is SHOWN. Pure; every rule that decides what a Member sees lives here so it is tested once and the profile, the identity line and the comments agree.
//
// The raw record ("7–3") is always shown; a percentage is shown only once a Member has at least `minDecided` decided picks (the existing, configurable `leaderboard_min_decided_picks`), because "1 of 1"
// reads as 100% and means nothing. Void is never in a denominator.

export const MIN_DECIDED_FALLBACK = 5;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const counts = (v: unknown): RecordCounts | null => {
  const o = v as Record<string, unknown> | null;
  return o && isCount(o.correct) && isCount(o.incorrect) ? { correct: o.correct, incorrect: o.incorrect } : null;
};

/** Fail-closed parse of member_record_summary(): anything malformed is "no summary" (the profile then simply omits the card), never a half-trusted number. */
export function parseMemberRecordSummary(raw: unknown): MemberRecordSummary | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  if (!isCount(o.correct) || !isCount(o.incorrect) || !isCount(o.void) || !isCount(o.best_correct_streak)) return null;
  const form = o.form;
  if (!Array.isArray(form) || !form.every((r) => r === "W" || r === "L")) return null;
  const thisWeek = counts(o.this_week);
  const conf = counts(o.confidence);
  const confPicks = (o.confidence as Record<string, unknown> | null)?.picks;
  if (!thisWeek || !conf || !isCount(confPicks)) return null;
  const streakRaw = o.current_streak as { kind?: unknown; length?: unknown } | null;
  let currentStreak: MemberRecordSummary["currentStreak"] = null;
  if (streakRaw !== null) {
    if ((streakRaw?.kind !== "CORRECT" && streakRaw?.kind !== "INCORRECT") || !isCount(streakRaw.length)) return null;
    currentStreak = { kind: streakRaw.kind, length: streakRaw.length };
  }
  const bySport: MemberRecordSummary["bySport"] = [];
  for (const row of Array.isArray(o.by_sport) ? o.by_sport : []) {
    const c = counts(row);
    const r = row as Record<string, unknown>;
    if (!c || typeof r.sport !== "string" || !isCount(r.void)) return null;
    bySport.push({ sport: r.sport, ...c, void: r.void });
  }
  const bySeason: MemberRecordSummary["bySeason"] = [];
  for (const row of Array.isArray(o.by_season) ? o.by_season : []) {
    const c = counts(row);
    const r = row as Record<string, unknown>;
    if (!c || typeof r.sport !== "string" || typeof r.season !== "string") return null;
    bySeason.push({ sport: r.sport, season: r.season, ...c });
  }
  return { correct: o.correct, incorrect: o.incorrect, void: o.void, form: form as Array<"W" | "L">, currentStreak, bestCorrectStreak: o.best_correct_streak, thisWeek, confidence: { ...conf, picks: confPicks }, bySport, bySeason };
}

/** "7–3". */
export const recordLabel = ({ correct, incorrect }: RecordCounts): string => `${correct}–${incorrect}`;

/**
 * The accuracy percentage, or null when it should not be shown: nothing decided, or fewer decided picks than the configured minimum. A minimum of 0 or 1 shows it as soon as there is one decided pick
 * (the percentage is never fabricated for zero).
 */
export function percentIfEnough({ correct, incorrect }: RecordCounts, minDecided: number): number | null {
  const decided = correct + incorrect;
  if (decided === 0 || decided < Math.max(1, minDecided)) return null;
  return Math.round((correct / decided) * 100);
}

export function streakLabel(streak: MemberRecordSummary["currentStreak"]): string | null {
  if (!streak) return null;
  if (streak.length === 1) return streak.kind === "CORRECT" ? "Last pick correct" : "Last pick incorrect";
  return streak.kind === "CORRECT" ? `${streak.length} correct in a row` : `${streak.length} misses in a row`;
}

/**
 * "Best: 8 correct in a row" — the longest run of correct picks, said when it is worth saying: more than one pick, and not already what the Member is on right now (a current CORRECT run that equals the best IS
 * the best, so it is not repeated). A current run of misses never hides it: being on a losing streak says nothing about the best winning one (M6 fix; M5 compared the run lengths whatever their kind).
 */
export function bestStreakLabel(streak: MemberRecordSummary["currentStreak"], bestCorrectStreak: number): string | null {
  if (bestCorrectStreak < 2) return null;
  if (streak && streak.kind === "CORRECT" && streak.length >= bestCorrectStreak) return null;
  return `Best: ${bestCorrectStreak} correct in a row`;
}

/** "Last 10: 7–3" from the form sequence (decided picks only). Null with no decided pick. */
export function formLabel(form: Array<"W" | "L">): string | null {
  if (form.length === 0) return null;
  const wins = form.filter((r) => r === "W").length;
  return `Last ${form.length}: ${wins}–${form.length - wins}`;
}

/** What a screen reader hears for the form chips, newest first. */
export const formSpoken = (form: Array<"W" | "L">): string => form.map((r) => (r === "W" ? "correct" : "incorrect")).join(", ");

/** "NFL" for a stored sport key; an unknown key reads as the key itself, never as a guess. */
export function sportName(sport: string): string {
  return getSportConfig(sport)?.label ?? (sport === "unknown" ? "Other" : sport);
}

/** The accuracy line of the identity: a percentage once there is enough to mean something, the raw record before that. */
export function identityRecordText(rep: { correct?: number; incorrect?: number; decided: number; accuracy: number | null; minDecidedForLeaderboard?: number }): { percent: number | null; record: string | null } {
  if (rep.accuracy === null) return { percent: null, record: null };
  const hasRecord = rep.correct !== undefined && rep.incorrect !== undefined;
  const hide = hasRecord && rep.minDecidedForLeaderboard !== undefined && rep.decided < Math.max(1, rep.minDecidedForLeaderboard);
  if (hide) return { percent: null, record: recordLabel({ correct: rep.correct!, incorrect: rep.incorrect! }) };
  return { percent: Math.round(rep.accuracy * 100), record: null };
}
