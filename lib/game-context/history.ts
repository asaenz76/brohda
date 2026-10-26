import { getSportConfig, canEndLevel } from "@/lib/sports-data/sport-registry";
import type { ContextFixture } from "./types";

// Brohda 2.1 M3 — a team's stored regular-season history, classified for the fact calculators. Pure.
//
// Every stored Game of the team before the target Game is exactly one of:
//   RESULT   a COMPLETED Game with both scores (W / L, or T where the sport can end level) — the only thing that can extend or break a streak;
//   IGNORED  CANCELLED or POSTPONED — no result exists, so it is neither a win nor a loss and never breaks a sequence;
//   UNSAFE   anything else that sits before the target: a Game still NOT_STARTED / LIVE / UNKNOWN / SUSPENDED / ABANDONED / AWARDED, a COMPLETED Game with a missing score, a level final in a sport that cannot
//            end level. Brohda cannot say what happened (or whether the sequence is intact), so any fact whose walk reaches it is unprovable and is not produced. Fail closed.

export type Venue = "HOME" | "AWAY";
export type ResultMark = "W" | "L" | "T";

export interface TimelineEntry {
  fixtureId: string;
  startUtc: string;
  venue: Venue;
  kind: "RESULT" | "IGNORED" | "UNSAFE";
  /** Set only for kind RESULT. */
  result: ResultMark | null;
  /** The team's own score and the opponent's, for kind RESULT. */
  scored: number | null;
  conceded: number | null;
  opponentTeamId: string | null;
}

const IGNORED_STATUSES = new Set(["CANCELLED", "POSTPONED"]);

const isScore = (n: number | null): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Stable chronological order: by start time, then id — never the order the database happened to return. */
export const compareChronologically = (a: { startUtc: string; fixtureId: string }, b: { startUtc: string; fixtureId: string }): number => {
  const d = Date.parse(a.startUtc) - Date.parse(b.startUtc);
  return d !== 0 ? d : a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0;
};

export function classifyForTeam(f: ContextFixture, teamId: string): TimelineEntry {
  const venue: Venue = f.homeTeamExternalId === teamId ? "HOME" : "AWAY";
  const opponentTeamId = venue === "HOME" ? f.awayTeamExternalId : f.homeTeamExternalId;
  const base = { fixtureId: f.id, startUtc: f.scheduledStartUtc, venue, opponentTeamId };
  const unsafe: TimelineEntry = { ...base, kind: "UNSAFE", result: null, scored: null, conceded: null };
  if (IGNORED_STATUSES.has(f.internalStatus)) return { ...base, kind: "IGNORED", result: null, scored: null, conceded: null };
  if (f.internalStatus !== "COMPLETED" || !isScore(f.homeScore) || !isScore(f.awayScore)) return unsafe;
  const scored = venue === "HOME" ? f.homeScore : f.awayScore;
  const conceded = venue === "HOME" ? f.awayScore : f.homeScore;
  if (scored === conceded) {
    // Only a sport that can end level has ties (the NFL); anywhere else a level final is an inconsistent provider result the grader refuses too.
    return canEndLevel(f.sport) ? { ...base, kind: "RESULT", result: "T", scored, conceded } : unsafe;
  }
  return { ...base, kind: "RESULT", result: scored > conceded ? "W" : "L", scored, conceded };
}

/**
 * The regular-season Games of `teamId` that were scheduled before `target`, oldest first. Same provider, same sport, same provider season, the sport's regular-season marker in `round`,
 * not the target itself. A Game with a missing team id can never be attributed to a team and is not here (the audit found none; see the report).
 */
export function teamTimeline(history: readonly ContextFixture[], target: ContextFixture, teamId: string): TimelineEntry[] {
  const config = getSportConfig(target.sport);
  const prefix = config?.regularSeason?.roundPrefix;
  if (!prefix) return [];
  const targetStart = Date.parse(target.scheduledStartUtc);
  return history
    .filter(
      (f) =>
        f.id !== target.id &&
        f.provider === target.provider &&
        f.sport === target.sport &&
        f.season === target.season &&
        f.round !== null &&
        f.round.startsWith(prefix) &&
        (f.homeTeamExternalId === teamId || f.awayTeamExternalId === teamId) &&
        Date.parse(f.scheduledStartUtc) < targetStart,
    )
    .map((f) => classifyForTeam(f, teamId))
    .sort(compareChronologically);
}

export interface StreakWalk {
  mark: "W" | "L";
  length: number;
  /** True when the streak runs back to the first Game that counts (every counted Game this season was the same result). */
  coversWholeSample: boolean;
  /** The Games that prove it, most recent first. */
  fixtureIds: string[];
}

/**
 * The team's current streak, optionally counting only home or only road Games. Walks back from the most recent counted Game:
 *   - IGNORED entries are skipped; entries of the other venue are skipped when a venue is given;
 *   - the first RESULT fixes the sign (a tie means no streak);
 *   - the streak is PROVEN only when something ends it (the opposite result or a tie) or the history runs out — meeting an UNSAFE entry first means it might be longer or might not exist: null.
 */
export function currentStreak(timeline: readonly TimelineEntry[], venue?: Venue): StreakWalk | null {
  let mark: "W" | "L" | null = null;
  const ids: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === "IGNORED") continue;
    if (venue && e.venue !== venue) continue;
    if (e.kind === "UNSAFE") return null;
    if (e.result === "T") {
      if (mark === null) return null;
      return { mark, length: ids.length, coversWholeSample: false, fixtureIds: ids };
    }
    const m = e.result as "W" | "L";
    if (mark === null) mark = m;
    if (m !== mark) return { mark, length: ids.length, coversWholeSample: false, fixtureIds: ids };
    ids.push(e.fixtureId);
  }
  if (mark === null) return null;
  return { mark, length: ids.length, coversWholeSample: true, fixtureIds: ids };
}

export interface RecordWindow {
  wins: number;
  losses: number;
  sample: number;
  fixtureIds: string[];
}

/** The record over EXACTLY the last `n` counted Games, or null: fewer than n results, a tie inside the window, or an UNSAFE Game before n results were collected. */
export function lastNRecord(timeline: readonly TimelineEntry[], n: number): RecordWindow | null {
  let wins = 0;
  let losses = 0;
  const ids: string[] = [];
  for (let i = timeline.length - 1; i >= 0 && ids.length < n; i--) {
    const e = timeline[i];
    if (e.kind === "IGNORED") continue;
    if (e.kind === "UNSAFE" || e.result === "T") return null;
    if (e.result === "W") wins++;
    else losses++;
    ids.push(e.fixtureId);
  }
  return ids.length === n ? { wins, losses, sample: n, fixtureIds: ids } : null;
}

export interface Series {
  meetings: number;
  /** Wins of the Game's home team / away team across the prior meetings. */
  homeWins: number;
  awayWins: number;
  /** The most recent meeting's score, from the home team's and the away team's point of view. */
  lastMeeting: { winnerIsHome: boolean; winnerScore: number; loserScore: number } | null;
  fixtureIds: string[];
}

/**
 * Earlier regular-season meetings of the two teams this season. null when a meeting is UNSAFE or level (unprovable / no wording for it); a Series with 0 meetings when they have not met yet.
 */
export function priorMeetings(history: readonly ContextFixture[], target: ContextFixture, homeId: string, awayId: string): Series | null {
  const homeTimeline = teamTimeline(history, target, homeId).filter((e) => e.opponentTeamId === awayId);
  let homeWins = 0;
  let awayWins = 0;
  let meetings = 0;
  for (const e of homeTimeline) {
    if (e.kind === "IGNORED") continue;
    if (e.kind === "UNSAFE" || e.result === "T") return null;
    meetings++;
    if (e.result === "W") homeWins++;
    else awayWins++;
  }
  const counted = homeTimeline.filter((e) => e.kind === "RESULT");
  const last = counted[counted.length - 1];
  return {
    meetings,
    homeWins,
    awayWins,
    lastMeeting: last && last.scored !== null && last.conceded !== null ? { winnerIsHome: last.result === "W", winnerScore: Math.max(last.scored, last.conceded), loserScore: Math.min(last.scored, last.conceded) } : null,
    fixtureIds: counted.map((e) => e.fixtureId).reverse(),
  };
}
