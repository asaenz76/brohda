// Brohda 2.1 M3 — structured, DETERMINISTIC evidence computed from Brohda's own Game results (the `fixtures` table).
//
// Head-to-head, current form, streaks and rest are facts a database can answer exactly, so they are computed here — never recalled or calculated by a model. Each fact is an EvidenceItem of kind
// STRUCTURED_DATA (the highest authority), carrying the compact result list it was computed from. A team's facts are OMITTED, not guessed, when its schedule data looks incomplete (a past Game
// that never reached a final status) or too old: an honest gap beats a confident wrong streak.
import type { EvidenceItem, GameContext } from "./types";

export interface HistoryFixture {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeExternalId: string | null;
  awayExternalId: string | null;
  startUtc: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
}

const FINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "POSTPONED", "AWARDED", "SUSPENDED"]);
/** A final Game with no score (cancelled/awarded) is not a result. */
const isResult = (f: HistoryFixture): boolean => f.status === "COMPLETED" && f.homeScore !== null && f.awayScore !== null;

const norm = (s: string): string => s.trim().toLowerCase();
const teamIs = (f: HistoryFixture, side: "home" | "away", name: string, externalId: string | null): boolean => {
  const fName = side === "home" ? f.homeTeam : f.awayTeam;
  const fId = side === "home" ? f.homeExternalId : f.awayExternalId;
  return externalId && fId ? externalId === fId : norm(fName) === norm(name);
};
const involves = (f: HistoryFixture, name: string, externalId: string | null): boolean => teamIs(f, "home", name, externalId) || teamIs(f, "away", name, externalId);

interface TeamGame {
  fixtureId: string;
  startUtc: string;
  opponent: string;
  teamScore: number;
  opponentScore: number;
  home: boolean;
  outcome: "W" | "L" | "T";
}
function teamGames(rows: readonly HistoryFixture[], name: string, externalId: string | null): TeamGame[] {
  const games: TeamGame[] = [];
  for (const f of rows) {
    if (!isResult(f) || !involves(f, name, externalId)) continue;
    const home = teamIs(f, "home", name, externalId);
    const teamScore = (home ? f.homeScore : f.awayScore) as number;
    const opponentScore = (home ? f.awayScore : f.homeScore) as number;
    games.push({ fixtureId: f.id, startUtc: f.startUtc, opponent: home ? f.awayTeam : f.homeTeam, teamScore, opponentScore, home, outcome: teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "T" });
  }
  return games.sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc));
}

/** True when a past Game of this team never reached a final status: the schedule data cannot be trusted to give a form or a rest figure. */
function scheduleIncomplete(rows: readonly HistoryFixture[], name: string, externalId: string | null, now: Date): boolean {
  return rows.some((f) => involves(f, name, externalId) && Date.parse(f.startUtc) < now.getTime() - 8 * 3_600_000 && !FINAL_STATUSES.has(f.status));
}

const dateLabel = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Longest-run helper over an outcome list that starts at the most recent Game. */
const currentRun = (outcomes: readonly string[]): { outcome: string; length: number } => {
  const first = outcomes[0];
  let n = 0;
  while (n < outcomes.length && outcomes[n] === first) n++;
  return { outcome: first, length: n };
};

export interface StructuredOptions {
  /** How many most-recent meetings / games to summarise. */
  window: number;
  /** A team whose latest result is older than this is not "in form": its form facts are omitted. */
  maxFormGapDays: number;
}
export const DEFAULT_STRUCTURED_OPTIONS: StructuredOptions = { window: 5, maxFormGapDays: 14 };

export function buildStructuredEvidence(game: GameContext, rows: readonly HistoryFixture[], now: Date, newId: () => string, options: StructuredOptions = DEFAULT_STRUCTURED_OPTIONS): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const history = rows.filter((f) => f.id !== game.fixtureId && Date.parse(f.startUtc) < Date.parse(game.kickoffUtc));
  const make = (key: string, value: string | null, subject: EvidenceItem["subjectTeam"], title: string, factText: string, excerpt: string | null, asOf: string | null): EvidenceItem => ({
    id: newId(),
    kind: "STRUCTURED_DATA",
    authority: 95,
    canonicalId: `brohda:fixtures:${game.fixtureId}:${key}`,
    url: null,
    publisher: "Brohda game data",
    title,
    publishedAt: null,
    retrievedAt: now.toISOString(),
    evidenceType: "STRUCTURED",
    factKey: key,
    factValue: value,
    subjectTeam: subject,
    factText: factText.slice(0, 600),
    excerpt: excerpt ? excerpt.slice(0, 400) : null,
    asOf,
    status: "USABLE",
    statusReason: null,
  });

  // ---- Head to head -------------------------------------------------------------------------------------------------------------------------------
  const homeGames = teamGames(history, game.homeTeam, game.homeTeamExternalId);
  const awayGames = teamGames(history, game.awayTeam, game.awayTeamExternalId);
  const meetings = homeGames.filter((g) => norm(g.opponent) === norm(game.awayTeam) || awayGames.some((a) => a.fixtureId === g.fixtureId)).slice(0, options.window);
  if (meetings.length >= 2) {
    const homeWins = meetings.filter((m) => m.outcome === "W").length;
    const awayWins = meetings.filter((m) => m.outcome === "L").length;
    const ties = meetings.length - homeWins - awayWins;
    const list = meetings.map((m) => `${shortDate(m.startUtc)}: ${game.homeTeam} ${m.teamScore}-${m.opponentScore} ${game.awayTeam}`.replace(/ \d+-\d+ /, ` ${m.teamScore}-${m.opponentScore} `)).join("; ");
    items.push(
      make(
        "h2h:record",
        null,
        "BOTH",
        "Head-to-head results",
        `In their last ${meetings.length} meetings in Brohda's results data, ${game.homeTeam} won ${homeWins} and ${game.awayTeam} won ${awayWins}${ties ? ` (${plural(ties, "tie", "ties")})` : ""}.`,
        list,
        meetings[0].startUtc,
      ),
    );
    const last = meetings[0];
    const winner = last.outcome === "W" ? game.homeTeam : last.outcome === "L" ? game.awayTeam : null;
    items.push(
      make(
        "h2h:last",
        winner ? "DECIDED" : "TIE",
        "BOTH",
        "Most recent meeting",
        winner
          ? `${winner} won the most recent meeting ${Math.max(last.teamScore, last.opponentScore)}-${Math.min(last.teamScore, last.opponentScore)} on ${dateLabel(last.startUtc)}.`
          : `The most recent meeting ended level, ${last.teamScore}-${last.opponentScore}, on ${dateLabel(last.startUtc)}.`,
        null,
        last.startUtc,
      ),
    );
    const run = currentRun(meetings.map((m) => m.outcome));
    if (run.length >= 3 && run.outcome !== "T") {
      const streaker = run.outcome === "W" ? game.homeTeam : game.awayTeam;
      items.push(make("h2h:streak", streaker, "BOTH", "Head-to-head streak", `${streaker} has won the last ${run.length} meetings against ${streaker === game.homeTeam ? game.awayTeam : game.homeTeam} in Brohda's results data.`, list, last.startUtc));
    }
  }

  // ---- Form and rest, per team ----------------------------------------------------------------------------------------------------------------------
  const teams: Array<{ side: "HOME" | "AWAY"; name: string; extId: string | null; games: TeamGame[] }> = [
    { side: "HOME", name: game.homeTeam, extId: game.homeTeamExternalId, games: homeGames },
    { side: "AWAY", name: game.awayTeam, extId: game.awayTeamExternalId, games: awayGames },
  ];
  const lastStart: Partial<Record<"HOME" | "AWAY", number>> = {};
  for (const t of teams) {
    if (scheduleIncomplete(history, t.name, t.extId, now)) continue;
    const recent = t.games.slice(0, options.window);
    if (recent.length < 3) continue;
    const ageDays = (now.getTime() - Date.parse(recent[0].startUtc)) / 86_400_000;
    if (ageDays > options.maxFormGapDays) continue;
    lastStart[t.side] = Date.parse(recent[0].startUtc);
    const wins = recent.filter((g) => g.outcome === "W").length;
    const losses = recent.filter((g) => g.outcome === "L").length;
    const list = recent.map((g) => `${shortDate(g.startUtc)}: ${g.outcome} ${g.teamScore}-${g.opponentScore} ${g.home ? "vs" : "at"} ${g.opponent}`).join("; ");
    items.push(make(`form:${t.side.toLowerCase()}`, `${wins}-${losses}`, t.side, `${t.name} recent results`, `${t.name} won ${wins} of their last ${recent.length} games (${wins}-${losses}${recent.length - wins - losses ? `, ${recent.length - wins - losses} tied` : ""}).`, list, recent[0].startUtc));
    const run = currentRun(t.games.map((g) => g.outcome));
    if (run.length >= 3 && run.outcome !== "T") {
      items.push(make(`streak:${t.side.toLowerCase()}`, `${run.outcome}${run.length}`, t.side, `${t.name} streak`, `${t.name} ${run.outcome === "W" ? "has won" : "has lost"} ${run.length} straight games in Brohda's results data.`, list, t.games[0].startUtc));
    }
    const lastGame = recent[0];
    items.push(
      make(
        `last:${t.side.toLowerCase()}`,
        lastGame.outcome,
        t.side,
        `${t.name} last result`,
        `${t.name} ${lastGame.outcome === "W" ? "beat" : lastGame.outcome === "L" ? "lost to" : "tied with"} ${lastGame.opponent} ${lastGame.teamScore}-${lastGame.opponentScore} ${lastGame.home ? "at home" : "on the road"} on ${dateLabel(lastGame.startUtc)}.`,
        null,
        lastGame.startUtc,
      ),
    );
  }
  if (lastStart.HOME !== undefined && lastStart.AWAY !== undefined) {
    const kick = Date.parse(game.kickoffUtc);
    const homeRest = Math.floor((kick - lastStart.HOME) / 86_400_000);
    const awayRest = Math.floor((kick - lastStart.AWAY) / 86_400_000);
    if (Math.abs(homeRest - awayRest) >= 2) {
      const rested = homeRest > awayRest ? game.homeTeam : game.awayTeam;
      const tired = homeRest > awayRest ? game.awayTeam : game.homeTeam;
      const [more, less] = homeRest > awayRest ? [homeRest, awayRest] : [awayRest, homeRest];
      items.push(make("rest:difference", rested, "BOTH", "Rest between games", `${rested} has had ${more} days since its last game; ${tired} has had ${less}.`, null, new Date(Math.max(lastStart.HOME, lastStart.AWAY)).toISOString()));
    }
  }
  return items;
}
