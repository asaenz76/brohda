import { currentStreak, lastNRecord, priorMeetings, teamTimeline, type Venue } from "./history";
import type { ContextFixture, FactSide, FactType, GameContextConfig, GameContextFact } from "./types";

// Brohda 2.1 M3 — candidate generation: every fact about a Game's two teams that the stored history PROVES and that clears the configured minimums. Pure and deterministic.
// Ranking inputs live here (`score`), the choice between candidates in ./rank.ts, the words in ./render.ts.

/** Score weights. Code, not settings: they encode the ranking intuition (a 7-game streak beats a 7–3 last-10) and change only through review. */
export const SCORE = {
  streakPerGame: 10,
  venueStreakPerGame: 10,
  /** A streak that is the team's WHOLE season ("5–0") is rarer than one that merely is current. */
  wholeSeasonBonus: 15,
  /** "Last N" scores in proportion to its window (decisive/N of this), so it tops out at 40 and any streak of 5+ always outranks it: a 7-game streak beats 7–3 in the last 10 (which, at 28, is not even worth saying). */
  lastNScale: 40,
  seriesSingle: 30,
  seriesSplit: 30,
  seriesSweep: 45,
  seriesSweepPerExtraMeeting: 5,
} as const;

/** Tie-break order when two facts score the same: earlier = preferred. */
export const FACT_PRIORITY: readonly FactType[] = [
  "WIN_STREAK",
  "LOSS_STREAK",
  "SEASON_UNBEATEN",
  "SEASON_WINLESS",
  "HOME_WIN_STREAK",
  "HOME_LOSS_STREAK",
  "AWAY_WIN_STREAK",
  "AWAY_LOSS_STREAK",
  "SERIES_SWEEP",
  "LAST_N",
  "SERIES_SPLIT",
  "SERIES_SINGLE",
];

export const isWinningFact = (t: FactType): boolean => t === "WIN_STREAK" || t === "SEASON_UNBEATEN" || t === "HOME_WIN_STREAK" || t === "AWAY_WIN_STREAK";
export const isLosingFact = (t: FactType): boolean => t === "LOSS_STREAK" || t === "SEASON_WINLESS" || t === "HOME_LOSS_STREAK" || t === "AWAY_LOSS_STREAK";

interface TeamRef {
  side: "HOME" | "AWAY";
  id: string;
  name: string;
  opponentName: string;
}

function teamFacts(team: TeamRef, history: readonly ContextFixture[], target: ContextFixture, config: GameContextConfig, season: string): GameContextFact[] {
  const timeline = teamTimeline(history, target, team.id);
  const base = { side: team.side as FactSide, subjectTeamName: team.name, opponentTeamName: team.opponentName, season, scope: "REGULAR_SEASON" as const };
  const facts: GameContextFact[] = [];

  const any = currentStreak(timeline);
  if (any && any.length >= (any.mark === "W" ? config.minWinStreak : config.minLossStreak)) {
    const type: FactType = any.coversWholeSample ? (any.mark === "W" ? "SEASON_UNBEATEN" : "SEASON_WINLESS") : any.mark === "W" ? "WIN_STREAK" : "LOSS_STREAK";
    facts.push({ ...base, type, values: { streak: any.length }, supportingFixtureIds: any.fixtureIds, score: SCORE.streakPerGame * any.length + (any.coversWholeSample ? SCORE.wholeSeasonBonus : 0) });
  }

  const venue: Venue = team.side;
  const atVenue = currentStreak(timeline, venue);
  // A home/road streak adds something only when it says more than the overall streak already does.
  if (atVenue && atVenue.length >= config.minVenueStreak && !(any && any.mark === atVenue.mark && any.length >= atVenue.length)) {
    const type: FactType = venue === "HOME" ? (atVenue.mark === "W" ? "HOME_WIN_STREAK" : "HOME_LOSS_STREAK") : atVenue.mark === "W" ? "AWAY_WIN_STREAK" : "AWAY_LOSS_STREAK";
    facts.push({ ...base, type, values: { streak: atVenue.length }, supportingFixtureIds: atVenue.fixtureIds, score: SCORE.venueStreakPerGame * atVenue.length });
  }

  const record = lastNRecord(timeline, config.lastN);
  if (record && (record.wins >= config.lastNMinDecisive || record.losses >= config.lastNMinDecisive)) {
    // "5–0 in its last 5" is just the 5-game streak again.
    const redundant = any && ((record.losses === 0 && any.mark === "W") || (record.wins === 0 && any.mark === "L")) && any.length >= record.sample;
    if (!redundant) {
      facts.push({ ...base, type: "LAST_N", values: { wins: record.wins, losses: record.losses, sample: record.sample }, supportingFixtureIds: record.fixtureIds, score: Math.round((SCORE.lastNScale * Math.max(record.wins, record.losses)) / record.sample) });
    }
  }
  return facts;
}

function seriesFacts(home: TeamRef, away: TeamRef, history: readonly ContextFixture[], target: ContextFixture, season: string): GameContextFact[] {
  const series = priorMeetings(history, target, home.id, away.id);
  if (!series || series.meetings === 0) return [];
  const base = { side: "BOTH" as const, season, scope: "REGULAR_SEASON" as const, supportingFixtureIds: series.fixtureIds };
  const swept = series.meetings >= 2 && (series.homeWins === series.meetings || series.awayWins === series.meetings);
  if (swept) {
    const homeSwept = series.homeWins === series.meetings;
    const [winner, loser] = homeSwept ? [home, away] : [away, home];
    return [{ ...base, type: "SERIES_SWEEP", subjectTeamName: winner.name, opponentTeamName: loser.name, values: { meetings: series.meetings }, score: SCORE.seriesSweep + SCORE.seriesSweepPerExtraMeeting * (series.meetings - 2) }];
  }
  if (series.meetings === 2) {
    return [{ ...base, type: "SERIES_SPLIT", subjectTeamName: home.name, opponentTeamName: away.name, values: { meetings: 2 }, score: SCORE.seriesSplit }];
  }
  if (series.meetings === 1 && series.lastMeeting) {
    const [winner, loser] = series.lastMeeting.winnerIsHome ? [home, away] : [away, home];
    return [{ ...base, type: "SERIES_SINGLE", subjectTeamName: winner.name, opponentTeamName: loser.name, values: { meetings: 1, winnerScore: series.lastMeeting.winnerScore, loserScore: series.lastMeeting.loserScore }, score: SCORE.seriesSingle }];
  }
  return [];
}

/** Every provable fact about the Game, all scores included (the caller applies `minScore`). Caller has already checked the Game itself is eligible. */
export function generateCandidates(target: ContextFixture, history: readonly ContextFixture[], config: GameContextConfig, season: string, homeId: string, awayId: string): GameContextFact[] {
  const home: TeamRef = { side: "HOME", id: homeId, name: target.homeTeamName, opponentName: target.awayTeamName };
  const away: TeamRef = { side: "AWAY", id: awayId, name: target.awayTeamName, opponentName: target.homeTeamName };
  return [...teamFacts(home, history, target, config, season), ...teamFacts(away, history, target, config, season), ...(config.seriesEnabled ? seriesFacts(home, away, history, target, season) : [])];
}
