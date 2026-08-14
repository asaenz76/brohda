"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";
import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER, type FixtureProvider } from "@/lib/sports-data/provider-names";
import { suggestMinimumGoalsFromExactDistribution, suggestMinimumGoalsFromOdds } from "@/lib/pools/templates/goals-odds";
import { estimateNflFixtureLines, type NflFixtureLineEstimates } from "@/lib/pools/templates/nfl-odds";
import { isFresh } from "@/lib/utils/freshness";
import type { NormalizedFixtureMarkets } from "@/lib/sports-data/types";

/**
 * Every odds/markets action below takes the fixture's own `provider`
 * column as an explicit argument and refuses to proceed on a mismatch,
 * rather than assuming a provider from the function's own name or from
 * the shape of `externalFixtureId`. This is the fix for a real incident:
 * selecting an NFL fixture in the pool wizard used to send its API-NFL
 * numeric game ID to API-Football's `/odds` endpoint, because the shared
 * recommendation/markets path had no sport or provider check at all.
 * External fixture IDs are only unique within a provider's own numbering
 * — a mismatched provider here is a real bug, not a degraded-data case,
 * so it throws instead of silently returning null or falling back.
 */
function assertProvider(actual: string, expected: FixtureProvider, actionName: string): void {
  if (actual !== expected) {
    throw new Error(
      `${actionName} only supports "${expected}" fixtures, but was called with provider "${actual}". ` +
        "Provider must be derived from the fixture itself, never assumed.",
    );
  }
}

export interface FixtureGoalsLines {
  matchLine: number | null;
  firstHalfLine: number | null;
  homeTeamLine: number | null;
  awayTeamLine: number | null;
}

/**
 * Backs the pool-creation wizard's goals-template prefill
 * (app/(admin)/admin/pools/new/pool-template-builder.tsx) — plain
 * read-only async call, not a useActionState mutation, mirroring
 * getTeamSquadAction's shape. Only ever returns four integers (or null);
 * the underlying bookmaker odds never leave apiFootballProvider. `provider`
 * is the caller's fixture.provider — this football-only market never
 * silently runs for a non-football fixture (see assertProvider above).
 */
export async function getFixtureGoalsLinesAction(externalFixtureId: string, provider: string): Promise<FixtureGoalsLines> {
  await requireAdminOrAbove();
  assertProvider(provider, API_FOOTBALL_PROVIDER, "getFixtureGoalsLinesAction");

  // Best-effort, same as getFixtureMarketsAction below: a fixture with no
  // real provider coverage (no odds posted, provider outage, or — for a
  // dev-seed/synthetic fixture — an external_fixture_id the provider
  // rejects outright) must not break the wizard. Without this catch, a
  // thrown ProviderApiError here surfaces as an unhandled rejection on the
  // client's un-caught `.then()`, permanently soft-locking the wizard.
  const odds = await apiFootballProvider.getFixtureOdds(externalFixtureId).catch(() => null);
  if (!odds) return { matchLine: null, firstHalfLine: null, homeTeamLine: null, awayTeamLine: null };

  return {
    matchLine: suggestMinimumGoalsFromOdds(odds.matchGoalsLines),
    firstHalfLine: suggestMinimumGoalsFromOdds(odds.firstHalfGoalsLines),
    homeTeamLine: suggestMinimumGoalsFromExactDistribution(odds.homeTeamGoalsDistributions),
    awayTeamLine: suggestMinimumGoalsFromExactDistribution(odds.awayTeamGoalsDistributions),
  };
}

// Freshness over minimizing requests, per the product decision behind
// this cache: 5 minutes, not the 20-30 minutes a pure rate-limit-driven
// cache would use — current API usage is low enough that this is purely
// about not re-fetching on every wizard render, not about quota.
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;

interface FixtureOddsCacheRow {
  normalized_markets: NormalizedFixtureMarkets;
  fetched_at: string;
}

/**
 * Odds-driven recommendations' normalized market data for one fixture —
 * cache-per-fixture, refreshed only when stale (never a scheduled sync,
 * never the full odds catalog). Reads/writes fixture_odds_cache directly
 * via the admin client since this cache has no per-user shape and is
 * never read by anything except this function.
 *
 * `provider` is the caller's fixture.provider, not inferred from
 * `externalFixtureId` — external IDs are only unique within one provider's
 * own numbering, so an NFL and a football fixture can legitimately share
 * the same numeric ID. This football-only market never runs for a
 * non-football fixture (see assertProvider above), and the cache key
 * includes provider so a same-numbered NFL/football pair can never read
 * or overwrite each other's cached markets.
 */
export async function getFixtureMarketsAction(
  externalFixtureId: string,
  provider: string,
): Promise<NormalizedFixtureMarkets | null> {
  await requireAdminOrAbove();
  assertProvider(provider, API_FOOTBALL_PROVIDER, "getFixtureMarketsAction");
  const adminClient = createAdminClient();

  const { data: cached } = await adminClient
    .from("fixture_odds_cache")
    .select("normalized_markets, fetched_at")
    .eq("provider", provider)
    .eq("external_fixture_id", externalFixtureId)
    .maybeSingle<FixtureOddsCacheRow>();

  if (cached && isFresh(cached.fetched_at, MARKET_CACHE_TTL_MS)) {
    return cached.normalized_markets;
  }

  // Best-effort — see getFixtureGoalsLinesAction's comment above. Without
  // this catch, getFixtureQuestionContextAction's Promise.all rejects
  // whole, so the wizard's step 2 never resolves questionContext and gets
  // stuck on "Checking existing pools on this fixture…" forever, even
  // though a markets-fetch failure was always meant to be recoverable
  // (rankRecommendations already treats null markets as "no markets
  // fetched" and falls back to the static prior).
  const fresh = await apiFootballProvider.getFixtureMarkets(externalFixtureId).catch(() => null);
  if (fresh) {
    await adminClient
      .from("fixture_odds_cache")
      .upsert({ provider, external_fixture_id: externalFixtureId, normalized_markets: fresh, fetched_at: new Date().toISOString() });
  }
  return fresh;
}

/**
 * Backs the pool-creation wizard's NFL_SPREAD/NFL_GAME_TOTAL/
 * NFL_TEAM_TOTAL prefill — plain read-only async call, same uncached
 * shape as getFixtureGoalsLinesAction above (called at most once per
 * wizard template-selection, not worth a cache table for V1). Returns
 * null on any provider failure (best-effort, same reasoning as the two
 * actions above) rather than throwing into an un-caught client `.then()`.
 *
 * result.spread is a best-effort, UNCONFIRMED estimate — see nfl-odds.ts's
 * file header for why. Every caller must present it as needing manual
 * verification, never with the same confidence as the other three fields.
 *
 * `provider` is the caller's fixture.provider — this NFL-only market never
 * silently runs for a non-NFL fixture (see assertProvider above); the
 * mirror image of the api_football guard above.
 */
export async function getNflFixtureLinesAction(externalFixtureId: string, provider: string): Promise<NflFixtureLineEstimates | null> {
  await requireAdminOrAbove();
  assertProvider(provider, API_NFL_PROVIDER, "getNflFixtureLinesAction");

  const odds = await apiNflProvider.getFixtureRawOdds(externalFixtureId).catch(() => null);
  if (!odds) return null;
  return estimateNflFixtureLines(odds);
}
