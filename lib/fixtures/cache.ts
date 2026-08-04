import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NormalizedFixture } from "@/lib/sports-data/types";
import type { DateRangePreset } from "./date-window";

// Suggested TTLs from the date-first fixture discovery spec — a
// narrower/more time-sensitive window is worth re-checking sooner.
const TTL_MINUTES_BY_PRESET: Record<DateRangePreset, number> = {
  today: 5,
  tomorrow: 10,
  today_tomorrow: 10,
  next_3_days: 15,
  next_7_days: 20,
  custom: 30,
};

export interface FixtureDateSearchCacheKey {
  provider: string;
  timeZone: string;
  utcFrom: string; // ISO instant
  utcTo: string; // ISO instant
  competitionExternalId: string | null;
}

/** Reads a cached provider search — returns null on a miss OR an expired
 * row (an expired row is treated identically to "not cached," never
 * returned as if it were still fresh). */
export async function getCachedFixtureSearch(key: FixtureDateSearchCacheKey): Promise<NormalizedFixture[] | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from("fixture_date_search_cache")
    .select("results, expires_at")
    .eq("provider", key.provider)
    .eq("time_zone", key.timeZone)
    .eq("utc_from", key.utcFrom)
    .eq("utc_to", key.utcTo)
    .eq("competition_external_id", key.competitionExternalId ?? "")
    .maybeSingle();

  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.results as NormalizedFixture[];
}

/** Writes a fresh provider search into the cache — callers must only
 * call this after a successful provider response; a failed search must
 * never be cached as if it were a valid (possibly empty) result. */
export async function setCachedFixtureSearch(
  key: FixtureDateSearchCacheKey,
  preset: DateRangePreset,
  results: NormalizedFixture[],
): Promise<void> {
  const adminClient = createAdminClient();
  const ttlMinutes = TTL_MINUTES_BY_PRESET[preset] ?? TTL_MINUTES_BY_PRESET.custom;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();

  await adminClient.from("fixture_date_search_cache").upsert(
    {
      provider: key.provider,
      time_zone: key.timeZone,
      utc_from: key.utcFrom,
      utc_to: key.utcTo,
      competition_external_id: key.competitionExternalId ?? "",
      results,
      fixture_count: results.length,
      fetched_at: now.toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: "provider,time_zone,utc_from,utc_to,competition_external_id" },
  );

  // Best-effort cleanup of anything already expired, keeping the table
  // small without needing a dedicated cron for what's otherwise a
  // low-volume admin-only cache.
  await adminClient.from("fixture_date_search_cache").delete().lt("expires_at", now.toISOString());
}
