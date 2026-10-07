import "server-only";
import { apiNflProvider } from "./api-nfl-provider";
import { apiNbaProvider, apiNhlProvider } from "./api-sports-provider";
import { API_NBA_PROVIDER, API_NFL_PROVIDER, API_NHL_PROVIDER, type FixtureProvider } from "./provider-names";
import type { SportsDataProvider, SportsOddsProvider } from "./types";

// The smallest routing abstraction the app actually needs — a lookup from
// a fixture's own `provider` column to the adapter that knows how to talk
// to it. Every event/fixture already carries this identity; nothing should
// ever infer it from sport, a numeric external id, a league id, a UI
// route, or a template name — this map is the one place that translates
// identity into behavior.
//
// A provider identity appears here only when an adapter exists for it. MLB is a declared identity (provider-names.ts) with deliberately NO
// adapter, so it cannot ingest or publish anything until a launch milestone registers one.
const REGISTRY: Partial<Record<FixtureProvider, SportsOddsProvider>> = {
  [API_NFL_PROVIDER]: apiNflProvider,
  [API_NBA_PROVIDER]: apiNbaProvider,
  [API_NHL_PROVIDER]: apiNhlProvider,
};

export function isKnownProvider(providerName: string): providerName is FixtureProvider {
  return Object.prototype.hasOwnProperty.call(REGISTRY, providerName);
}

/** Resolves a provider identity string to its adapter, or `null` for
 * anything not in REGISTRY — never throws. Callers that need "fail loudly
 * on an unknown provider" should check the result explicitly (see
 * UnsupportedOperationError in provider-errors.ts for the typed-throw
 * version of that same decision). */
export function getSportsProvider(providerName: string): SportsDataProvider | null {
  return isKnownProvider(providerName) ? (REGISTRY[providerName] ?? null) : null;
}

/** The same adapter, typed as one that can also supply raw bookmaker odds (every registered provider can). */
export function getOddsProvider(providerName: string): SportsOddsProvider | null {
  return isKnownProvider(providerName) ? (REGISTRY[providerName] ?? null) : null;
}
