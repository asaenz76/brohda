import type { MarketRecord } from "../repository";
import { classifyFreshness, type FreshnessPolicy } from "./policy";
import { formatProbabilityPercent } from "./probability";
import { deriveConsumerStatus } from "./status";
import type { DiscoveryCategoryRef, DiscoveryMarketCard, DiscoveryMarketDetail } from "./types";

/**
 * The ONLY place a `MarketRecord` (Milestone 1's internal repository
 * shape — still carries `provider`, `providerMarketId`, `providerEventId`,
 * `categoryTags`) becomes a consumer-facing view model. Every field listed
 * in roadmap STEP 3's "do not expose" list is deliberately absent from the
 * return type here, not merely unused — `DiscoveryMarketCard`/
 * `DiscoveryMarketDetail` (types.ts) have no field that could carry them.
 */

export function toDiscoveryMarketCard(market: MarketRecord, categories: DiscoveryCategoryRef[], freshnessPolicy: FreshnessPolicy): DiscoveryMarketCard | null {
  const status = deriveConsumerStatus(market.status, market.resolvedOutcome);
  if (status === null) return null;

  const yesPercent = formatProbabilityPercent(market.yesPrice);
  const noPercent = formatProbabilityPercent(market.noPrice);

  return {
    id: market.id,
    question: market.question,
    categories,
    yesPercent,
    noPercent,
    status,
    closesAt: market.closesAt,
    freshness: classifyFreshness(market.lastSyncedAt, yesPercent != null || noPercent != null, freshnessPolicy),
  };
}

export function toDiscoveryMarketDetail(
  market: MarketRecord,
  categories: DiscoveryCategoryRef[],
  freshnessPolicy: FreshnessPolicy,
): DiscoveryMarketDetail | null {
  const card = toDiscoveryMarketCard(market, categories, freshnessPolicy);
  if (!card) return null;
  return {
    ...card,
    description: market.description,
    resolvedOutcome: market.resolvedOutcome,
  };
}
