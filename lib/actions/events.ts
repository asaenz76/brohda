"use server";

// Phase 4 (Unified Events Admin Experience): the one data-fetching entry
// point normal /admin/events browsing calls. queryLocalEventsByDateWindow
// (lib/fixtures/local-browse.ts) only ever touches the local `fixtures`,
// `pools`, `fixtures_available_for_pool_creation`, and
// `league_season_imports` tables — no import of either provider client,
// directly or transitively. That is what makes spec §6's "zero live
// sports-provider requests during ordinary Events browsing" true by
// construction, not by convention, exactly like fixture-browse.ts's
// existing football-only actions.
import { requireAdminOrAbove } from "@/lib/auth/session";
import { DEFAULT_FIXTURES_TIMEZONE, isDateWindowError, resolveFixtureDateWindow, type DateRangePreset, type FixtureDateWindow } from "@/lib/fixtures/date-window";
import { queryLocalEventsByDateWindow, type EventSport, type LocalFixtureBrowseResult } from "@/lib/fixtures/local-browse";

export interface BrowseEventsInput {
  preset: DateRangePreset;
  customFromDate?: string;
  customToDate?: string;
  sports?: EventSport[];
  includeUnsupported?: boolean;
}

export type BrowseEventsResult =
  | { success: true; window: FixtureDateWindow; result: LocalFixtureBrowseResult }
  | { success: false; error: string };

export async function browseEventsAction(input: BrowseEventsInput): Promise<BrowseEventsResult> {
  await requireAdminOrAbove();

  const windowResult = resolveFixtureDateWindow(input.preset, {
    timeZone: DEFAULT_FIXTURES_TIMEZONE,
    customFromDate: input.customFromDate,
    customToDate: input.customToDate,
  });
  if (isDateWindowError(windowResult)) {
    return { success: false, error: windowResult.error };
  }

  const result = await queryLocalEventsByDateWindow(windowResult, {
    sports: input.sports,
    includeUnsupported: input.includeUnsupported,
  });
  return { success: true, window: windowResult, result };
}
