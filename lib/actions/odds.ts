"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { suggestMinimumGoalsFromExactDistribution, suggestMinimumGoalsFromOdds } from "@/lib/pools/templates/goals-odds";
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

  const odds = await apiFootballProvider.getFixtureOdds(externalFixtureId);
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

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < MARKET_CACHE_TTL_MS) {
    return cached.normalized_markets;
  }

  const fresh = await apiFootballProvider.getFixtureMarkets(externalFixtureId);
  if (fresh) {
    await adminClient
      .from("fixture_odds_cache")
      .upsert({ external_fixture_id: externalFixtureId, normalized_markets: fresh, fetched_at: new Date().toISOString() });
  }
  return fresh;
}
