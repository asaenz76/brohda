import type { MarketRecord } from "../repository";
import { getChoicePresentation, getSelectionLabel, type SelectionLabelSource } from "../selection-labels";
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

/** The Game's two team names, needed for the template-aware choice labels. Absent → the shared presentation falls back, never guesses. */
export interface MatchupTeams {
  homeTeamName: string | null;
  awayTeamName: string | null;
  sport?: string | null;
}

export function toDiscoveryMarketCard(
  market: MarketRecord,
  categories: DiscoveryCategoryRef[],
  freshnessPolicy: FreshnessPolicy,
  teams: MatchupTeams | null = null,
): DiscoveryMarketCard | null {
  const status = deriveConsumerStatus(market.status, market.resolvedOutcome);
  if (status === null) return null;

  const yesPercent = formatProbabilityPercent(market.yesPrice);
  const noPercent = formatProbabilityPercent(market.noPrice);
  const source: SelectionLabelSource = { ...market, homeTeamName: teams?.homeTeamName ?? null, awayTeamName: teams?.awayTeamName ?? null, sport: teams?.sport ?? null };
  const presentation = getChoicePresentation(source);

  return {
    id: market.id,
    question: market.question,
    categories,
    yesPercent,
    noPercent,
    status,
    closesAt: market.closesAt,
    freshness: classifyFreshness(market.lastSyncedAt, yesPercent != null || noPercent != null, freshnessPolicy),
    yesLabel: getSelectionLabel(source, "YES"),
    noLabel: getSelectionLabel(source, "NO"),
    choices: presentation.choices,
    marketLabel: presentation.marketLabel,
  };
}

export function toDiscoveryMarketDetail(
  market: MarketRecord,
  categories: DiscoveryCategoryRef[],
  freshnessPolicy: FreshnessPolicy,
  teams: MatchupTeams | null = null,
): DiscoveryMarketDetail | null {
  const card = toDiscoveryMarketCard(market, categories, freshnessPolicy, teams);
  if (!card) return null;
  return {
    ...card,
    description: market.description,
    resolvedOutcome: market.resolvedOutcome,
    // Placeholder — getMarketDetail() (the only live caller) always
    // overrides this, along with yesPercent/noPercent, with the real
    // Pick-share aggregation. See that function's own comment.
    totalPickCount: 0,
  };
}
