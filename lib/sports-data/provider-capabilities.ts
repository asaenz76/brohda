import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER, type FixtureProvider } from "./provider-names";

// Both ApiFootballProvider and ApiNflProvider type-check against
// SportsDataProvider — every method exists on both — but several of
// NFL's are silent no-op stubs (return [] / null, never throw), each with
// its own "not implemented for V1" comment in api-nfl-provider.ts. That
// makes "the interface has this method" and "this provider genuinely
// does something useful here" two different questions, and nothing in
// the type system distinguishes them. This is the second one, kept
// deliberately small — only the capabilities that are actually stubbed
// on one provider today (Phase 3 spec §4: "keep this small and grounded
// in actual current needs"), not a speculative full capability grid for
// providers/operations that don't exist yet.
export type ProviderCapability = "markets" | "team_search" | "league_type" | "fixture_events" | "squad_data";

const CAPABILITY_MATRIX: Record<FixtureProvider, ReadonlySet<ProviderCapability>> = {
  [API_FOOTBALL_PROVIDER]: new Set<ProviderCapability>(["markets", "team_search", "league_type", "fixture_events", "squad_data"]),
  // NFL's markets-equivalent data comes from apiNflProvider.getFixtureRawOdds
  // — a distinct, NFL-only method (not part of SportsDataProvider) with its
  // own already-provider-checked call site (lib/actions/odds.ts's
  // getNflFixtureLinesAction). "markets" here means specifically
  // getFixtureOdds/getFixtureMarkets, which NFL does not implement.
  [API_NFL_PROVIDER]: new Set<ProviderCapability>([]),
};

/** Whether `provider` genuinely implements `capability` — not merely
 * whether the method exists on the interface. Use this to branch/skip
 * explicitly instead of calling a capability-gated method and treating
 * its stubbed empty/null return as "provider confirmed: nothing here." */
export function supports(provider: string, capability: ProviderCapability): boolean {
  const capabilities = CAPABILITY_MATRIX[provider as FixtureProvider];
  return capabilities ? capabilities.has(capability) : false;
}
