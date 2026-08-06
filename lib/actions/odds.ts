"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { suggestMinimumGoalsFromExactDistribution, suggestMinimumGoalsFromOdds } from "@/lib/pools/templates/goals-odds";
import { isFresh } from "@/lib/utils/freshness";
import type { NormalizedFixtureMarkets } from "@/lib/sports-data/types";

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
 * the underlying bookmaker odds never leave apiFootballProvider.
 */
export async function getFixtureGoalsLinesAction(externalFixtureId: string): Promise<FixtureGoalsLines> {
  await requireAdminOrAbove();

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
 */
export async function getFixtureMarketsAction(externalFixtureId: string): Promise<NormalizedFixtureMarkets | null> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: cached } = await adminClient
    .from("fixture_odds_cache")
    .select("normalized_markets, fetched_at")
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
      .upsert({ external_fixture_id: externalFixtureId, normalized_markets: fresh, fetched_at: new Date().toISOString() });
  }
  return fresh;
}
