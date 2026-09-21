import "server-only";
import { polymarketExecutionAdapter } from "./providers/polymarket/adapter";
import { POLYMARKET_PROVIDER, type PredictionMarketProviderName } from "@/lib/prediction-markets/provider-names";
import type { ExecutionQuoteProvider } from "./types";

// Same routing discipline as lib/prediction-markets/provider-registry.ts,
// applied to the separate execution-quote domain (lib/execution/types.ts's
// own comment explains why this is not folded into that registry). One
// provider registered today.
const REGISTRY: Record<PredictionMarketProviderName, ExecutionQuoteProvider> = {
  [POLYMARKET_PROVIDER]: polymarketExecutionAdapter,
};

export function getExecutionQuoteProvider(providerName: string): ExecutionQuoteProvider | null {
  return providerName === POLYMARKET_PROVIDER ? REGISTRY[providerName] : null;
}
