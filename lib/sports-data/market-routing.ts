import "server-only";
import { getFixtureMarketsAction } from "@/lib/actions/odds";
import { supports } from "./provider-capabilities";
import type { NormalizedFixtureMarkets } from "./types";

/**
 * The one place pool-creation code asks "does this fixture have
 * odds-driven market data" — Phase 3 spec §13: routes by the fixture's own
 * provider via provider-capabilities.ts's "markets" capability rather than
 * each call site independently comparing against API_FOOTBALL_PROVIDER
 * (lib/actions/pools.ts previously had this exact ternary in two places).
 * A fixture whose provider doesn't support markets (NFL today, or any
 * future non-market provider) returns null immediately — this is a
 * capability check, not a fallback attempt: getFixtureMarketsAction itself
 * would throw on a provider mismatch (its own assertProvider guard), so
 * this only ever calls it for a provider confirmed to support it.
 */
export async function getMarketsForFixture(fixture: {
  externalFixtureId: string | null;
  provider: string;
}): Promise<NormalizedFixtureMarkets | null> {
  if (!fixture.externalFixtureId) return null;
  if (!supports(fixture.provider, "markets")) return null;
  return getFixtureMarketsAction(fixture.externalFixtureId, fixture.provider);
}
