"use server";

// Phase 2 (local-first football browsing): the only two data-fetching
// entry points normal /admin/fixtures browsing calls. Neither imports
// apiFootballProvider, directly or transitively — queryLocalFixturesByX
// (lib/fixtures/local-browse.ts) only ever touches the local `fixtures`,
// `pools`, `fixtures_available_for_pool_creation`, and
// `league_season_imports` tables. That's what makes spec §1's "zero
// live API-Football requests during ordinary browsing" true by
// construction, not by convention.
import { requireAdminOrAbove } from "@/lib/auth/session";
import { DEFAULT_FIXTURES_TIMEZONE, isDateWindowError, resolveFixtureDateWindow, type DateRangePreset, type FixtureDateWindow } from "@/lib/fixtures/date-window";
import { queryLocalFixturesByCompetitionSeason, queryLocalFixturesByDateWindow, type LocalFixtureBrowseResult } from "@/lib/fixtures/local-browse";
import { isSupportedCompetition } from "@/lib/sports-data/supported-competitions";

export interface BrowseFixturesByDateInput {
  preset: DateRangePreset;
  customFromDate?: string;
  customToDate?: string;
  includeUnsupported?: boolean;
}

export type BrowseFixturesByDateResult =
  | { success: true; window: FixtureDateWindow; result: LocalFixtureBrowseResult }
  | { success: false; error: string };

export async function browseFixturesByDateAction(input: BrowseFixturesByDateInput): Promise<BrowseFixturesByDateResult> {
  await requireAdminOrAbove();

  const windowResult = resolveFixtureDateWindow(input.preset, {
    customFromDate: input.customFromDate,
    customToDate: input.customToDate,
  });
  if (isDateWindowError(windowResult)) {
    return { success: false, error: windowResult.error };
  }

  const result = await queryLocalFixturesByDateWindow(windowResult, { includeUnsupported: input.includeUnsupported });
  return { success: true, window: windowResult, result };
}

export type BrowseFixturesByCompetitionResult =
  | { success: true; result: LocalFixtureBrowseResult }
  | { success: false; error: string };

export async function browseFixturesByCompetitionSeasonAction(
  externalLeagueId: string,
  season: string,
): Promise<BrowseFixturesByCompetitionResult> {
  await requireAdminOrAbove();

  // The selector only ever offers supported+imported pairs, but this is
  // still enforced server-side — the same "no silent bypass" discipline
  // spec §8 requires of the fixture-ID import path, applied here too, in
  // case a stale/hand-crafted request ever reaches this action directly.
  if (!isSupportedCompetition(externalLeagueId)) {
    return { success: false, error: "This competition is not currently supported." };
  }

  const result = await queryLocalFixturesByCompetitionSeason(externalLeagueId, season, DEFAULT_FIXTURES_TIMEZONE);
  return { success: true, result };
}
