/**
 * What the generation system is told about the Game, beyond who plays whom: the SEASON IDENTIFIER the platform stores, the COMPETITION PHASE, and the scheduled start with its timezone. The season is never inferred from the calendar year alone
 * (a March report and an October Game are in different seasons even though both are "2026"), and the phase keeps preseason, regular season and playoffs apart.
 */
export type CompetitionPhase = "preseason" | "regular_season" | "playoffs";

/** The phase from the provider's round label ("Regular Season - Week 6", "Preseason - 2", "Playoffs - Conference Finals", "Finals"). A fixture with no round label is a regular-season Game. */
export function competitionPhase(round: string | null | undefined): CompetitionPhase {
  const r = (round ?? "").toLowerCase();
  if (/pre-?season|exhibition|training camp/.test(r)) return "preseason";
  if (/play-?offs?|finals?|semi-?finals?|conference (final|semi)|wild card|divisional|super bowl|stanley cup|round of|first round|second round|play-?in/.test(r)) return "playoffs";
  return "regular_season";
}

/**
 * When the current season began for the leagues whose seasons run autumn to spring (NFL, NBA, NHL), taken from the SUPPLIED season identifier ("2026" or "2026-2027" → the season that starts in 2026): a report published before July 1 of that year is last season's news, whatever
 * it says (the offseason from July is the new season's context). Null when the identifier is missing or the competition has a different calendar: then no date rule is applied.
 */
export function currentSeasonStart(game: { season?: string | null; competition?: string | null }): Date | null {
  if (!game.competition || !/^(NFL|NBA|NHL)$/i.test(game.competition.trim())) return null;
  const year = Number(String(game.season ?? "").match(/\b(19|20)\d{2}\b/)?.[0]);
  return Number.isFinite(year) ? new Date(Date.UTC(year, 6, 1)) : null;
}

/** The scheduled start in UTC and, when the venue's timezone is known, in local time ("Tue Oct 20, 2026, 7:30 PM America/Chicago"). */
export function describeStart(kickoffUtc: string, timezone: string | null | undefined): string {
  const utc = `${kickoffUtc} (UTC)`;
  if (!timezone) return utc;
  try {
    const local = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(kickoffUtc));
    return `${utc}; local: ${local} ${timezone}`;
  } catch {
    return utc;
  }
}
