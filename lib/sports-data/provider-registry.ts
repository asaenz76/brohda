import "server-only";
import { apiFootballProvider } from "./api-football-provider";
import { apiNflProvider } from "./api-nfl-provider";
import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER, type FixtureProvider } from "./provider-names";
import type { SportsDataProvider } from "./types";

// The smallest routing abstraction the app actually needs (Phase 3 spec
// §3) — a lookup from a fixture's own `provider` column to the adapter
// that knows how to talk to it. Every event/fixture already carries this
// identity; nothing should ever infer it from sport, a numeric external
// id, a league id, a UI route, or a template name (spec §1) — this map is
// the one place that translates identity into behavior.
const REGISTRY: Record<FixtureProvider, SportsDataProvider> = {
  [API_FOOTBALL_PROVIDER]: apiFootballProvider,
  [API_NFL_PROVIDER]: apiNflProvider,
};

export function isKnownProvider(providerName: string): providerName is FixtureProvider {
  return providerName === API_FOOTBALL_PROVIDER || providerName === API_NFL_PROVIDER;
}

/** Resolves a provider identity string to its adapter, or `null` for
 * anything not in REGISTRY — never throws, never falls back to football.
 * Callers that need "fail loudly on an unknown provider" should check the
 * result explicitly (see UnsupportedOperationError in provider-errors.ts
 * for the typed-throw version of that same decision). */
export function getSportsProvider(providerName: string): SportsDataProvider | null {
  return isKnownProvider(providerName) ? REGISTRY[providerName] : null;
}
