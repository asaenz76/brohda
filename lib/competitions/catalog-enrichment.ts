// Pure helpers for the "All competitions" catalog view — deliberately
// separate from status.ts (which governs already-imported competitions'
// operational status) since these operate on the raw provider catalog,
// most of which is never imported at all.
import type { LeagueSeason, LeagueSeasonCoverage } from "@/lib/sports-data/types";

// A season starting within this many days counts as "coming up soon"
// rather than merely "off season, nothing happening" — matches the
// approved season-state rules exactly.
const STARTS_SOON_WINDOW_DAYS = 45;
// A season that ended this recently is still worth flagging distinctly
// from one that's been over for a while.
const RECENTLY_ENDED_WINDOW_DAYS = 30;

/**
 * Picks the one season to display for a competition: the provider's
 * current season if it has one, else the nearest season that hasn't
 * started yet, else the most recently completed one. Never returns null
 * unless the competition has literally no seasons at all.
 */
export function resolveDisplaySeason(seasons: LeagueSeason[], now: number = Date.now()): LeagueSeason | null {
  if (seasons.length === 0) return null;

  const current = seasons.find((s) => s.current);
  if (current) return current;

  const future = seasons
    .filter((s) => new Date(s.startDate).getTime() > now)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (future.length > 0) return future[0];

  const past = seasons
    .filter((s) => new Date(s.endDate).getTime() <= now)
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  if (past.length > 0) return past[0];

  return seasons[0];
}

export type SeasonState = "IN_SEASON" | "STARTS_SOON" | "OFF_SEASON" | "RECENTLY_ENDED" | "UNKNOWN";

export const SEASON_STATE_LABEL: Record<SeasonState, string> = {
  IN_SEASON: "In season",
  STARTS_SOON: "Starts soon",
  OFF_SEASON: "Off season",
  RECENTLY_ENDED: "Recently ended",
  UNKNOWN: "Unknown dates",
};

/**
 * The approved season-state rules, applied to whichever season
 * resolveDisplaySeason picked. "In season" deliberately requires more than
 * provider_current alone — a corroborating signal (an upcoming fixture, or
 * the provider's own current flag) must also agree, since provider_current
 * has been observed live to disagree with the actual fixture calendar.
 * `hasUpcomingFixtures` is optional — undefined (never checked, e.g. an
 * un-imported, non-priority catalog entry) does NOT count as a
 * contradiction on its own, only an explicit `false` does.
 */
export function computeSeasonState(
  season: LeagueSeason | null,
  options: { now?: number; hasUpcomingFixtures?: boolean } = {},
): SeasonState {
  if (!season || !season.startDate || !season.endDate) return "UNKNOWN";
  const now = options.now ?? Date.now();
  const start = new Date(season.startDate).getTime();
  const end = new Date(season.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return "UNKNOWN";

  if (now >= start && now <= end) {
    const contradicted = season.current === false && options.hasUpcomingFixtures === false;
    return contradicted ? "OFF_SEASON" : "IN_SEASON";
  }

  const daysUntilStart = (start - now) / 86_400_000;
  if (daysUntilStart > 0) {
    return daysUntilStart <= STARTS_SOON_WINDOW_DAYS ? "STARTS_SOON" : "OFF_SEASON";
  }

  const daysSinceEnd = (now - end) / 86_400_000;
  return daysSinceEnd <= RECENTLY_ENDED_WINDOW_DAYS ? "RECENTLY_ENDED" : "OFF_SEASON";
}

// The 5 most operationally important coverage facts, shown by default —
// the rest (Standings/Injuries/Predictions) are available via
// getFullCoverageSummary for a tooltip/expanded detail row.
export type CoverageMark = "YES" | "NO" | "UNKNOWN";

export interface CoverageIndicator {
  label: string;
  mark: CoverageMark;
}

function markFor(value: boolean | undefined | null): CoverageMark {
  if (value == null) return "UNKNOWN";
  return value ? "YES" : "NO";
}

export function getPrimaryCoverageSummary(coverage: LeagueSeasonCoverage | null): CoverageIndicator[] {
  return [
    { label: "Fixtures", mark: coverage ? "YES" : "UNKNOWN" },
    { label: "Events", mark: markFor(coverage?.fixtures.events) },
    { label: "Lineups", mark: markFor(coverage?.fixtures.lineups) },
    { label: "Players", mark: markFor(coverage?.players) },
    { label: "Odds", mark: markFor(coverage?.odds) },
  ];
}

export function getFullCoverageSummary(coverage: LeagueSeasonCoverage | null): CoverageIndicator[] {
  return [
    ...getPrimaryCoverageSummary(coverage),
    { label: "Standings", mark: markFor(coverage?.standings) },
    { label: "Injuries", mark: markFor(coverage?.injuries) },
    { label: "Predictions", mark: markFor(coverage?.predictions) },
  ];
}
