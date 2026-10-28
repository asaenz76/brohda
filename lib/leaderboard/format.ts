import type { LeaderboardEntry, LeaderboardViewer, WeeklyLeaderboard } from "./types";

// Brohda 2.1 M6 — parsing and wording for the weekly leaderboard. The parser FAILS CLOSED: anything that is not exactly the shape get_weekly_leaderboard returns is null, and the page then shows its
// "couldn't load" state instead of a half-trusted ranking.

const TIME_ZONE = "America/Costa_Rica";

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseEntry(raw: unknown): LeaderboardEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.rank) || r.rank < 1 || typeof r.user_id !== "string" || !isInt(r.correct) || !isInt(r.incorrect) || !isInt(r.decided) || r.decided !== r.correct + r.incorrect || r.decided === 0) return null;
  const accuracy = Number(r.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) return null;
  return {
    rank: r.rank,
    tied: r.tied === true,
    userId: r.user_id,
    displayName: typeof r.display_name === "string" && r.display_name.trim() ? r.display_name.trim() : typeof r.username === "string" && r.username ? r.username : "A Member",
    username: typeof r.username === "string" && r.username ? r.username : null,
    avatarUrl: typeof r.avatar_url === "string" && r.avatar_url ? r.avatar_url : null,
    correct: r.correct,
    incorrect: r.incorrect,
    decided: r.decided,
    accuracy,
  };
}

function parseViewer(raw: unknown): LeaderboardViewer | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.eligible === false) return { eligible: false, reason: r.reason === "not_ranked_account" ? "not_ranked_account" : "unknown" };
  if (r.eligible !== true || !isInt(r.correct) || !isInt(r.incorrect) || !isInt(r.decided) || !isInt(r.needed) || typeof r.ranked !== "boolean") return undefined;
  const rank = r.rank === null || r.rank === undefined ? null : r.rank;
  if (rank !== null && (!isInt(rank) || rank < 1)) return undefined;
  if (r.ranked && rank === null) return undefined;
  const accuracy = r.accuracy === null || r.accuracy === undefined ? null : Number(r.accuracy);
  if (accuracy !== null && !Number.isFinite(accuracy)) return undefined;
  return { eligible: true, ranked: r.ranked, rank, correct: r.correct, incorrect: r.incorrect, decided: r.decided, accuracy, needed: r.needed };
}

export function parseWeeklyLeaderboard(raw: unknown): WeeklyLeaderboard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isIso(r.week_start) || !isIso(r.week_end) || !isInt(r.min_decided) || r.min_decided < 1 || !isInt(r.top_n) || !isInt(r.total_ranked) || !Array.isArray(r.entries)) return null;
  const entries: LeaderboardEntry[] = [];
  for (const item of r.entries) {
    const entry = parseEntry(item);
    if (!entry) return null;
    entries.push(entry);
  }
  const viewer = parseViewer(r.me);
  if (viewer === undefined) return null;
  return { weekStart: r.week_start, weekEnd: r.week_end, minDecided: r.min_decided, topN: r.top_n, totalRanked: r.total_ranked, entries, viewer };
}

/** "8–2" — the raw record, always first. */
export function weeklyRecord(correct: number, incorrect: number): string {
  return `${correct}–${incorrect}`;
}

/** "80%" (whole percent, rounded the same way the profile does). */
export function accuracyPercent(accuracy: number): string {
  return `${Math.round(accuracy * 100)}%`;
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE });

/** "Oct 26 – Nov 1": the week as Costa Rica sees it (the end instant is the next Monday 00:00, so the last day shown is the Sunday before it). */
export function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const start = new Date(weekStart);
  const lastDay = new Date(new Date(weekEnd).getTime() - 1);
  return `${dayFormat.format(start)} – ${dayFormat.format(lastDay)}`;
}

/** "4 days left", "6 hours left", "Less than an hour left", "Ending now". */
export function timeLeftLabel(weekEnd: string, now: Date): string {
  const ms = new Date(weekEnd).getTime() - now.getTime();
  if (ms <= 0) return "Ending now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "Less than an hour left";
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/** The one-sentence rule, in the words the page uses. */
export function qualificationRule(minDecided: number): string {
  return `${minDecided} decided ${minDecided === 1 ? "Pick" : "Picks"} this week to qualify. Ranked by accuracy, then most correct.`;
}

/** "You need 2 more Picks" / "You need 1 more Pick". */
export function picksNeededLabel(needed: number): string {
  return `You need ${needed} more ${needed === 1 ? "Pick" : "Picks"}`;
}
