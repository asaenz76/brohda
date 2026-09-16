import "server-only";
import { polymarketAdapter } from "./providers/polymarket/adapter";
import { POLYMARKET_PROVIDER, type PredictionMarketProviderName } from "./provider-names";
import type { PredictionMarketProvider } from "./types";

// Same routing discipline as lib/sports-data/provider-registry.ts, applied
// to a deliberately separate registry (see provider-names.ts's comment for
// why). One provider registered today; the type system, not a runtime
// assumption, is what would need to grow to add a second — this map is
// intentionally the ONLY place that translates a provider identity string
// into behavior.
const REGISTRY: Record<PredictionMarketProviderName, PredictionMarketProvider> = {
  [POLYMARKET_PROVIDER]: polymarketAdapter,
};

export function isKnownPredictionMarketProvider(
  providerName: string,
): providerName is PredictionMarketProviderName {
  return providerName === POLYMARKET_PROVIDER;
}

/**
 * Resolves a provider identity string to its adapter, or `null` for
 * anything not in REGISTRY — never throws. Mirrors
 * lib/sports-data/provider-registry.ts's getSportsProvider exactly: an
 * unknown provider is a normal, expected outcome a caller must check for,
 * not an exceptional one.
 */
export function getPredictionMarketProvider(providerName: string): PredictionMarketProvider | null {
  return isKnownPredictionMarketProvider(providerName) ? REGISTRY[providerName] : null;
}
