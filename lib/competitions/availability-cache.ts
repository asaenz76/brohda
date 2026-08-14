import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { SUPPORTED_COMPETITIONS } from "@/lib/sports-data/supported-competitions";
import { getProviderStatus, isQuotaExhaustedError } from "@/lib/sports-data/provider-gateway";
import { API_FOOTBALL_PROVIDER } from "@/lib/sports-data/provider-names";
import { shouldReserveQuota } from "@/lib/sports-data/quota-reserve";
import { isFresh } from "@/lib/utils/freshness";
import {
  AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS,
  AVAILABILITY_CACHE_TTL_WITH_FIXTURES_HOURS,
  RECOMMENDATION_WINDOW_DAYS,
} from "./constants";

export interface AvailabilityCacheRefreshResult {
  checked: number;
  refreshed: number;
  errors: number;
}

/**
 * Keeps the Recommended tab's provider-availability data warm on a
 * schedule so opening the page reads from the database, never fanning out
 * live across every SUPPORTED_COMPETITIONS entry — see the "Recommended
 * availability cache" design. A row is only re-checked once its own TTL
 * has elapsed (shorter for a league that had upcoming fixtures last time,
 * since that's the more time-sensitive case); everything else is skipped
 * this tick.
 */
export async function refreshRecommendationAvailabilityCache(
  options: { force?: boolean } = {},
): Promise<AvailabilityCacheRefreshResult> {
  const adminClient = createAdminClient();
  const result: AvailabilityCacheRefreshResult = { checked: 0, refreshed: 0, errors: 0 };

  if (!apiFootballProvider.isEnabled()) return result;

  // Checked before spending any requests — if the breaker is already open
  // from a recent quota error, every call this tick would fail
  // identically; skip it entirely and keep serving the existing cache.
  const status = await getProviderStatus(true, API_FOOTBALL_PROVIDER);
  if (status.circuitBreakerOpen) return result;
  if (await shouldReserveQuota(API_FOOTBALL_PROVIDER)) return result;

  const { data: cachedRows } = await adminClient
    .from("competition_availability_cache")
    .select("external_league_id, season, upcoming_fixture_count, checked_at")
    .eq("provider", API_FOOTBALL_PROVIDER);
  const cacheByLeague = new Map((cachedRows ?? []).map((row) => [row.external_league_id, row]));

  const now = Date.now();
  const competitions = SUPPORTED_COMPETITIONS.filter((c) => c.enabled && c.externalLeagueId != null);

  for (const competition of competitions) {
    const externalLeagueId = competition.externalLeagueId!;
    result.checked += 1;
    const cached = cacheByLeague.get(externalLeagueId);
    if (cached && !options.force) {
      const ttlHours = cached.upcoming_fixture_count > 0
        ? AVAILABILITY_CACHE_TTL_WITH_FIXTURES_HOURS
        : AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS;
      if (isFresh(cached.checked_at, ttlHours * 3600_000)) continue; // not due yet
    }

    try {
      const league = await apiFootballProvider.getLeagueById(externalLeagueId);
      const currentSeason = league?.seasons.find((s) => s.current);
      if (!currentSeason) {
        await upsertCacheRow(adminClient, externalLeagueId, cached?.season ?? "", 0, null, null);
        result.refreshed += 1;
        continue;
      }

      const fixtures = await apiFootballProvider.getSeasonFixtures(externalLeagueId, currentSeason.year);
      const windowEnd = now + RECOMMENDATION_WINDOW_DAYS * 86_400_000;
      const withinWindow = fixtures.filter((f) => {
        const t = new Date(f.scheduledStartUtc).getTime();
        return t > now && t <= windowEnd;
      });
      const nextFixtureAt = withinWindow.reduce<string | null>(
        (earliest, f) => (!earliest || f.scheduledStartUtc < earliest ? f.scheduledStartUtc : earliest),
        null,
      );

      await upsertCacheRow(adminClient, externalLeagueId, currentSeason.year, withinWindow.length, nextFixtureAt, null);
      result.refreshed += 1;
    } catch (err) {
      result.errors += 1;
      // Existing cache is deliberately kept (never overwritten with a
      // zero/error result) — see upsertCacheRow's call below, which
      // preserves cached?.upcoming_fixture_count rather than zeroing it.
      await upsertCacheRow(
        adminClient,
        externalLeagueId,
        cached?.season ?? "",
        cached?.upcoming_fixture_count ?? 0,
        null,
        err instanceof Error ? err.message : "Availability check failed",
      );

      // Once the provider reports quota exhaustion, every remaining
      // competition in this loop would fail identically — stop spending
      // requests on guaranteed failures rather than retrying through the
      // whole list (spec: "Do not retry. ... Serve cached or persisted
      // data instead.").
      if (isQuotaExhaustedError(err)) break;
    }
  }

  return result;
}

async function upsertCacheRow(
  adminClient: ReturnType<typeof createAdminClient>,
  externalLeagueId: string,
  season: string,
  upcomingFixtureCount: number,
  nextFixtureAt: string | null,
  checkError: string | null,
) {
  await adminClient.from("competition_availability_cache").upsert(
    {
      provider: API_FOOTBALL_PROVIDER,
      external_league_id: externalLeagueId,
      season,
      upcoming_fixture_count: upcomingFixtureCount,
      next_fixture_at: nextFixtureAt,
      window_days: RECOMMENDATION_WINDOW_DAYS,
      checked_at: new Date().toISOString(),
      check_error: checkError,
    },
    { onConflict: "provider,external_league_id,season" },
  );
}
