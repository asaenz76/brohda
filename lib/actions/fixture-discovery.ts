"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { isDateWindowError, resolveFixtureDateWindow, type DateRangePreset } from "@/lib/fixtures/date-window";
import { searchFixturesForDateWindow, type FixtureDiscoveryResult } from "@/lib/fixtures/discovery";

export interface SearchFixturesByDateInput {
  preset: DateRangePreset;
  customFromDate?: string;
  customToDate?: string;
  competitionExternalId?: string;
  forceRefresh?: boolean;
}

// Two independent failure modes, deliberately not collapsed into one:
// `success: false` is a validation failure (bad/oversized/inverted date
// range) — caught before any provider request is ever made, per spec
// §11 ("a safe validation message rather than a provider request").
// `success: true` with `result.error` set is a real provider failure
// (network/rate-limit/5xx) — the search was attempted and failed, which
// the UI must render as a distinct "provider search failed" empty state,
// never silently as zero results.
export type SearchFixturesByDateResult =
  | { success: true; result: FixtureDiscoveryResult }
  | { success: false; error: string };

export async function searchFixturesByDateAction(input: SearchFixturesByDateInput): Promise<SearchFixturesByDateResult> {
  await requireAdminOrAbove();

  const windowResult = resolveFixtureDateWindow(input.preset, {
    customFromDate: input.customFromDate,
    customToDate: input.customToDate,
  });
  if (isDateWindowError(windowResult)) {
    return { success: false, error: windowResult.error };
  }

  const result = await searchFixturesForDateWindow(apiFootballProvider, windowResult, {
    competitionExternalId: input.competitionExternalId,
    forceRefresh: input.forceRefresh,
  });
  return { success: true, result };
}
