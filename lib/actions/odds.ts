"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { suggestMinimumGoalsFromExactDistribution, suggestMinimumGoalsFromOdds } from "@/lib/pools/templates/goals-odds";

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
