import { DISABLED_GAME_CONTEXT, GAME_CONTEXT_DEFAULTS } from "@/lib/game-context/config";
import type { ContextFixture, GameContextConfig } from "@/lib/game-context/types";

// Builders for Game Context tests: a team's season as a string of results, and the upcoming Game that follows it.

export const CONFIG: GameContextConfig = { enabled: true, ...GAME_CONTEXT_DEFAULTS };
export { DISABLED_GAME_CONTEXT };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(6, "0")}`;
const DAY = 86_400_000;
const SEASON_OPENER = Date.UTC(2026, 8, 10, 17, 0, 0);

export const NFL = { provider: "api_nfl", sport: "american_football", season: "2026" } as const;
export const regularSeason = (week: number) => `Regular Season - Week ${week}`;

export interface GameOverrides extends Partial<ContextFixture> {
  week?: number;
}

/** One stored Game. By default a finished NFL regular-season Game, 24–17 to the home team. */
export function game(o: GameOverrides = {}): ContextFixture {
  const week = o.week ?? 1;
  const { week: _week, ...rest } = o;
  void _week;
  return {
    id: nextId("fx"),
    provider: NFL.provider,
    sport: NFL.sport,
    season: NFL.season,
    round: regularSeason(week),
    homeTeamExternalId: "h",
    awayTeamExternalId: "a",
    homeTeamName: "Home Team",
    awayTeamName: "Away Team",
    scheduledStartUtc: new Date(SEASON_OPENER + week * 7 * DAY).toISOString(),
    internalStatus: "COMPLETED",
    homeScore: 24,
    awayScore: 17,
    ...rest,
  };
}

export const teamName = (id: string) => `Team ${id.toUpperCase()}`;

/**
 * `teamId`'s finished Games, oldest first, one per week starting at `startWeek`: each character of `results` is W, L or T for that Game. `venues` is the same length of H / A
 * (default: all home). Opponents are fresh unique teams, so no accidental head-to-head.
 */
export function season(teamId: string, results: string, venues?: string, startWeek = 1): ContextFixture[] {
  const v = venues ?? "H".repeat(results.length);
  if (v.length !== results.length) throw new Error("venues and results must be the same length");
  return [...results].map((r, i) => {
    const week = startWeek + i;
    const opp = `${teamId}-opp${week}`;
    const home = v[i] === "H";
    const mine = r === "W" ? 24 : r === "T" ? 20 : 13;
    const theirs = r === "W" ? 17 : r === "T" ? 20 : 27;
    return game({
      week,
      homeTeamExternalId: home ? teamId : opp,
      awayTeamExternalId: home ? opp : teamId,
      homeTeamName: home ? teamName(teamId) : `Opp ${opp}`,
      awayTeamName: home ? `Opp ${opp}` : teamName(teamId),
      homeScore: home ? mine : theirs,
      awayScore: home ? theirs : mine,
    });
  });
}

/** The upcoming Game between two teams, scheduled after every `season()` Game (week 40 by default). */
export function upcoming(homeId: string, awayId: string, o: GameOverrides = {}): ContextFixture {
  return game({
    week: o.week ?? 40,
    homeTeamExternalId: homeId,
    awayTeamExternalId: awayId,
    homeTeamName: teamName(homeId),
    awayTeamName: teamName(awayId),
    internalStatus: "NOT_STARTED",
    homeScore: null,
    awayScore: null,
    ...o,
  });
}

/** A head-to-head Game between the two teams, already played. `winner` is the team id that won it. */
export function meeting(homeId: string, awayId: string, winner: string | null, week: number, o: GameOverrides = {}): ContextFixture {
  const homeWon = winner === homeId;
  return game({
    week,
    homeTeamExternalId: homeId,
    awayTeamExternalId: awayId,
    homeTeamName: teamName(homeId),
    awayTeamName: teamName(awayId),
    homeScore: winner === null ? 20 : homeWon ? 31 : 14,
    awayScore: winner === null ? 20 : homeWon ? 14 : 31,
    ...o,
  });
}

/** Deterministic shuffle (so the test is reproducible) to prove results never depend on the order rows arrive in. */
export function shuffled<T>(items: readonly T[], seed = 7): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
