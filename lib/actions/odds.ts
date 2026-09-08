"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";
import { API_NFL_PROVIDER, type FixtureProvider } from "@/lib/sports-data/provider-names";
import { estimateNflFixtureLines, type NflFixtureLineEstimates } from "@/lib/pools/templates/nfl-odds";

/**
 * Every odds action below takes the fixture's own `provider` column as an
 * explicit argument and refuses to proceed on a mismatch, rather than
 * assuming a provider from the function's own name or from the shape of
 * `externalFixtureId`. This is the fix for a real incident: selecting an
 * NFL fixture in the pool wizard used to send its API-NFL numeric game ID
 * to Association football's (Association football is retired) `/odds`
 * endpoint, because the shared recommendation/markets path had no sport or
 * provider check at all. External fixture IDs are only unique within a
 * provider's own numbering — a mismatched provider here is a real bug, not
 * a degraded-data case, so it throws instead of silently returning null or
 * falling back.
 */
function assertProvider(actual: string, expected: FixtureProvider, actionName: string): void {
  if (actual !== expected) {
    throw new Error(
      `${actionName} only supports "${expected}" fixtures, but was called with provider "${actual}". ` +
        "Provider must be derived from the fixture itself, never assumed.",
    );
  }
}

/**
 * Backs the pool-creation wizard's NFL_SPREAD/NFL_GAME_TOTAL/
 * NFL_TEAM_TOTAL prefill — plain read-only async call, called at most once
 * per wizard template-selection, not worth a cache table for V1. Returns
 * null on any provider failure (best-effort — a fixture with the provider
 * disabled, no odds posted yet, or a fetch failure still leaves the wizard
 * usable) rather than throwing into an un-caught client `.then()`.
 *
 * result.spread is a best-effort, UNCONFIRMED estimate — see nfl-odds.ts's
 * file header for why. Every caller must present it as needing manual
 * verification, never with the same confidence as the other three fields.
 *
 * `provider` is the caller's fixture.provider — this NFL-only market never
 * silently runs for a non-NFL fixture (see assertProvider above).
 */
export async function getNflFixtureLinesAction(externalFixtureId: string, provider: string): Promise<NflFixtureLineEstimates | null> {
  await requireAdminOrAbove();
  assertProvider(provider, API_NFL_PROVIDER, "getNflFixtureLinesAction");

  const odds = await apiNflProvider.getFixtureRawOdds(externalFixtureId).catch(() => null);
  if (!odds) return null;
  return estimateNflFixtureLines(odds);
}
