import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { getOddsProvider } from "@/lib/sports-data/provider-registry";
import { activeSportConfigs, type SportConfig } from "@/lib/sports-data/sport-registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { deactivateMarket, getActiveMarketByFixtureAndTemplate, upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import type { RawBookmakerOdds } from "@/lib/sports-data/types";
import { formatSpreadLine } from "@/lib/prediction-markets/selection-labels";
import { aggregateMoneyline, aggregateTotal } from "./aggregate-nfl-odds";
import { aggregateSpread } from "./aggregate-spread";
import { getMarketIngestionPolicy } from "./policy";
import { getMarketPolicy } from "@/lib/prediction-markets/market-policy";
import { ensureFixtureMarkets } from "./fixture-markets";
import type { PolicyMarketTemplate } from "@/lib/prediction-markets/market-policy-parse";
import { listUpcomingFixtures, type EligibleFixture } from "./fixture-window";

export type { EligibleFixture };

// The shared Market-ingestion pipeline for every sport (it began as the NFL's and its behaviour for the NFL is unchanged):
//
//   fixtures (eligible Games of one sport)
//     -> that sport's provider adapter, getFixtureRawOdds (generic RawBookmakerOdds shape)
//     -> aggregateMoneyline / aggregateTotal / aggregateSpread (vig-removed multi-bookmaker consensus)
//     -> canonical markets rows through the existing upsertMarket — never a parallel write path.
//
// Which templates a sport gets is data (sport-registry marketTemplates), not code. A puck line or run line is just SPREAD. Nothing here can
// fabricate a line: no bookmaker data -> no Market; a failed guard -> no Market.

export interface FixtureIngestionOutcome {
  fixtureId: string;
  /** "skipped-template-disabled": the template is not on the market_ingestion_templates allow-list (M2) — nothing was written for it. */
  moneyline: "inserted" | "updated" | "skipped-insufficient-bookmakers" | "skipped-no-data" | "skipped-template-disabled";
  total: "inserted" | "updated" | "line-moved" | "skipped-insufficient-bookmakers" | "skipped-no-data" | "skipped-template-disabled";
  /** Present only for sports whose registry templates include SPREAD. */
  spread?: "inserted" | "updated" | "line-moved" | "skipped-insufficient-bookmakers" | "skipped-no-data" | "skipped-unverifiable" | "skipped-template-disabled";
  /** The provider call itself threw (network, quota, plan): the fixture is skipped, and the run reports it instead of treating it as "no odds". */
  providerError?: string;
}


function moneylineMarket(config: SportConfig, fixture: EligibleFixture, homeProbability: number): NormalizedMarket {
  return {
    provider: config.provider,
    providerMarketId: `${fixture.externalFixtureId}:MONEYLINE`,
    providerEventId: fixture.externalFixtureId,
    question: `Will the ${fixture.homeTeamName} win?`,
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    // homeProbability is already a fair (de-vigged) probability, not a raw provider price — its complement genuinely IS 1 - yes here.
    price: { yes: homeProbability, no: 1 - homeProbability, outcomeLabels: { yes: `${fixture.homeTeamName} win`, no: `${fixture.homeTeamName} do not win` } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: config.ingestionSource,
    providerMetadata: {},
  };
}

function totalMarket(config: SportConfig, fixture: EligibleFixture, line: number, overProbability: number): NormalizedMarket {
  return {
    provider: config.provider,
    providerMarketId: `${fixture.externalFixtureId}:TOTAL:${line}`,
    providerEventId: fixture.externalFixtureId,
    question: `Will the total score be over ${line}?`,
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: "TOTAL",
    lineValue: line,
    yesSide: null,
    price: { yes: overProbability, no: 1 - overProbability, outcomeLabels: { yes: `Over ${line}`, no: `Under ${line}` } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: config.ingestionSource,
    providerMetadata: {},
  };
}

function spreadMarket(config: SportConfig, fixture: EligibleFixture, homeLine: number, homeCoverProbability: number): NormalizedMarket {
  const home = fixture.homeTeamName;
  return {
    provider: config.provider,
    providerMarketId: `${fixture.externalFixtureId}:SPREAD:HOME:${homeLine}`,
    providerEventId: fixture.externalFixtureId,
    question: `Will the ${home} cover ${formatSpreadLine(homeLine)}?`,
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: "SPREAD",
    lineValue: homeLine,
    yesSide: "HOME",
    price: { yes: homeCoverProbability, no: 1 - homeCoverProbability, outcomeLabels: { yes: `${home} ${formatSpreadLine(homeLine)}`, no: `${home} ${formatSpreadLine(homeLine)} not covered` } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: config.ingestionSource,
    providerMetadata: {},
  };
}

/**
 * Ingests the sport's configured templates for one fixture. Idempotent and safe to retry: a failed or partial run leaves whatever canonical
 * Markets already existed untouched — this only adds/refreshes state, never deletes, and every write goes through `upsertMarket`'s own
 * idempotent (provider, provider_market_id) upsert plus the DB's uniqueness/immutability guarantees as the backstop against a concurrent duplicate.
 */
export async function ingestMarketsForFixture(
  config: SportConfig,
  fixture: EligibleFixture,
  minBookmakerCount: number,
  /** M2: the policy's ingestion allow-list (market_ingestion_templates). Defaults to every template so existing callers and tests keep today's behaviour; the effective set is this ∩ the sport's own registered templates. */
  allowedTemplates: readonly PolicyMarketTemplate[] = ["MONEYLINE", "SPREAD", "TOTAL"],
): Promise<FixtureIngestionOutcome> {
  const wantsMoneyline = allowedTemplates.includes("MONEYLINE");
  const wantsTotal = allowedTemplates.includes("TOTAL");
  const sportHasSpread = config.marketTemplates.includes("SPREAD");
  const wantsSpread = sportHasSpread && allowedTemplates.includes("SPREAD");
  // Nothing on the allow-list for this Game: no provider request at all (the odds request exists only to feed a template that is wanted).
  if (!wantsMoneyline && !wantsTotal && !wantsSpread) {
    return { fixtureId: fixture.id, moneyline: "skipped-template-disabled", total: "skipped-template-disabled", ...(sportHasSpread ? { spread: "skipped-template-disabled" as const } : {}) };
  }
  const provider = getOddsProvider(config.provider);
  let providerError: string | undefined;
  const odds = provider
    ? await provider.getFixtureRawOdds(fixture.externalFixtureId).catch((error: unknown) => {
        providerError = errorMessage(error);
        return null;
      })
    : null;
  if (!odds || odds.bookmakers.length === 0) {
    return { fixtureId: fixture.id, moneyline: wantsMoneyline ? "skipped-no-data" : "skipped-template-disabled", total: wantsTotal ? "skipped-no-data" : "skipped-template-disabled", ...(sportHasSpread ? { spread: wantsSpread ? ("skipped-no-data" as const) : ("skipped-template-disabled" as const) } : {}), ...(providerError ? { providerError } : {}) };
  }

  // The MONEYLINE consensus is computed even when MONEYLINE itself is not written, because the SPREAD verification reads it.
  const moneylineAggregate = aggregateMoneyline(odds.bookmakers, minBookmakerCount);
  // Enrichment: upsertMarket matches the Game's canonical MONEYLINE row by (provider, provider_market_id) — the same identity a fixture-driven row carries — so a Market created without a price gets its price here; no second row.
  const moneyline: FixtureIngestionOutcome["moneyline"] = !wantsMoneyline
    ? "skipped-template-disabled"
    : moneylineAggregate
      ? (await upsertMarket(moneylineMarket(config, fixture, moneylineAggregate.homeProbability))).outcome
      : "skipped-insufficient-bookmakers";
  const total: FixtureIngestionOutcome["total"] = wantsTotal ? await ingestTotal(config, fixture, odds.bookmakers, minBookmakerCount) : "skipped-template-disabled";
  if (!sportHasSpread) return { fixtureId: fixture.id, moneyline, total };
  const spread: NonNullable<FixtureIngestionOutcome["spread"]> = wantsSpread ? await ingestSpread(config, fixture, odds.bookmakers, minBookmakerCount, moneylineAggregate?.homeProbability ?? null) : "skipped-template-disabled";
  return { fixtureId: fixture.id, moneyline, total, spread };
}

async function ingestTotal(config: SportConfig, fixture: EligibleFixture, bookmakers: RawBookmakerOdds[], minBookmakerCount: number): Promise<FixtureIngestionOutcome["total"]> {
  const aggregate = aggregateTotal(bookmakers, minBookmakerCount);
  if (!aggregate) return "skipped-insufficient-bookmakers";

  const currentlyActive = await getActiveMarketByFixtureAndTemplate(fixture.id, "TOTAL");
  const lineMoved = currentlyActive !== null && currentlyActive.lineValue !== aggregate.line;
  // Deactivate before inserting the new line's row — never the other way around, so there is never a moment with two ACTIVE TOTAL Markets for
  // the same fixture. The old row's identity is untouched: only `status` changes, which the immutability trigger allows.
  if (lineMoved) await deactivateMarket(currentlyActive.id);

  const { outcome } = await upsertMarket(totalMarket(config, fixture, aggregate.line, aggregate.overProbability));
  return lineMoved ? "line-moved" : outcome;
}

async function ingestSpread(
  config: SportConfig,
  fixture: EligibleFixture,
  bookmakers: RawBookmakerOdds[],
  minBookmakerCount: number,
  moneylineHomeProbability: number | null,
): Promise<NonNullable<FixtureIngestionOutcome["spread"]>> {
  const hasAnyHandicap = bookmakers.some((b) => b.asianHandicap.length > 0);
  if (!hasAnyHandicap) return "skipped-no-data";
  const aggregate = aggregateSpread(bookmakers, minBookmakerCount, moneylineHomeProbability, config.spreadMainLineBand);
  if (!aggregate) return moneylineHomeProbability === null ? "skipped-unverifiable" : "skipped-insufficient-bookmakers";

  const currentlyActive = await getActiveMarketByFixtureAndTemplate(fixture.id, "SPREAD");
  const lineMoved = currentlyActive !== null && currentlyActive.lineValue !== aggregate.homeLine;
  if (lineMoved) await deactivateMarket(currentlyActive.id);

  const { outcome } = await upsertMarket(spreadMarket(config, fixture, aggregate.homeLine, aggregate.homeCoverProbability));
  return lineMoved ? "line-moved" : outcome;
}

/** Upcoming Games worth an odds request now: the sport's window (listUpcomingFixtures), minus those whose price was refreshed within the sport's minimum refresh interval. */
export async function listEligibleFixtures(config: SportConfig, now: Date = new Date()): Promise<EligibleFixture[]> {
  const admin = createAdminClient();
  const upcoming = await listUpcomingFixtures(config, now);
  let rows = upcoming.map((f) => ({ id: f.id, external_fixture_id: f.externalFixtureId, home_team_name: f.homeTeamName, away_team_name: f.awayTeamName }));

  if (config.oddsMinRefreshMinutes > 0 && rows.length > 0) {
    const cutoff = new Date(now.getTime() - config.oddsMinRefreshMinutes * 60_000).toISOString();
    const { data: fresh, error: freshError } = await admin
      .from("markets")
      .select("fixture_id")
      .in("fixture_id", rows.map((r) => r.id))
      .eq("status", "ACTIVE")
      // M2: only a Market that actually carries a price counts as "recently refreshed". A fixture-driven Market has no price; without this a price-less row (last_synced_at = creation) would hide its Game from odds requests and the price would never arrive.
      .not("yes_price", "is", null)
      .gte("last_synced_at", cutoff);
    if (freshError) throw freshError;
    const recentlyRefreshed = new Set((fresh ?? []).map((m) => m.fixture_id));
    rows = rows.filter((r) => !recentlyRefreshed.has(r.id));
  }

  return rows.map((row) => ({ id: row.id, externalFixtureId: row.external_fixture_id, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name }));
}

export interface MarketIngestionSummary {
  ranAt: string;
  policyEnabled: boolean;
  /** M2: what the Game-driven Market step did this run (absent when it did not run). */
  fixtureMarkets?: import("./fixture-markets").FixtureMarketEnsureSummary;
  fixturesExamined: number;
  outcomes: FixtureIngestionOutcome[];
  /** Per-fixture failures (never allowed to abort the run), plus a sport-level entry when EVERY provider call in a run failed (a systemic outage, not "no odds"). Each names the sport, provider and game ids. */
  failures: Array<{ fixtureId: string; error: string; sport?: string; provider?: string; externalFixtureId?: string }>;
}

/** The ingestion job for ONE sport. The NFL's own entry point (nfl.ts) is this function with the NFL config. */
export async function runSportMarketIngestion(config: SportConfig, now: Date = new Date()): Promise<MarketIngestionSummary> {
  const policy = await getMarketIngestionPolicy();
  if (!policy.enabled) {
    return { ranAt: now.toISOString(), policyEnabled: false, fixturesExamined: 0, outcomes: [], failures: [] };
  }

  const fixtures = await listEligibleFixtures(config, now);
  const { ingestionTemplates } = await getMarketPolicy();
  const outcomes: FixtureIngestionOutcome[] = [];
  const failures: MarketIngestionSummary["failures"] = [];
  const externalIdByFixture = new Map(fixtures.map((f) => [f.id, f.externalFixtureId]));

  for (const fixture of fixtures) {
    try {
      outcomes.push(await ingestMarketsForFixture(config, fixture, policy.minBookmakerCount, ingestionTemplates));
    } catch (error) {
      // One fixture's failure must never abort the rest of the run — canonical state already written for other fixtures stays intact.
      failures.push({ fixtureId: fixture.id, error: errorMessage(error), sport: config.sport, provider: config.provider, externalFixtureId: fixture.externalFixtureId });
    }
  }

  // Provider calls that threw are skipped per fixture; when EVERY call in a run threw it is an outage (quota, plan, auth), and is reported.
  const providerErrors = outcomes.filter((o) => o.providerError);
  if (fixtures.length > 0 && providerErrors.length === fixtures.length) {
    failures.push({
      fixtureId: providerErrors[0].fixtureId,
      error: `every odds request failed: ${providerErrors[0].providerError}`,
      sport: config.sport,
      provider: config.provider,
      externalFixtureId: externalIdByFixture.get(providerErrors[0].fixtureId),
    });
  }

  return { ranAt: now.toISOString(), policyEnabled: true, fixturesExamined: fixtures.length, outcomes, failures };
}

/** The one ingestion job (the existing `ingest-nfl-markets` cron): every ACTIVE sport, in parallel, each failure-isolated. */
export async function runMarketIngestion(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<MarketIngestionSummary> {
  const configs = activeSportConfigs(env).filter((c) => getOddsProvider(c.provider) !== null);
  // M2: Market existence is Game-driven and independent of the odds switch below — it runs first, so odds fetched later in this same run enrich the Market just created. With
  // fixture_markets_enabled off (the default) it reads one setting and does nothing.
  const fixtureMarkets = await ensureFixtureMarkets(env, now);
  const policy = await getMarketIngestionPolicy();
  if (!policy.enabled) return { ranAt: now.toISOString(), policyEnabled: false, fixtureMarkets, fixturesExamined: 0, outcomes: [], failures: [] };

  const settled = await Promise.allSettled(configs.map((c) => runSportMarketIngestion(c, now)));
  const merged: MarketIngestionSummary = { ranAt: now.toISOString(), policyEnabled: true, fixtureMarkets, fixturesExamined: 0, outcomes: [], failures: [] };
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      merged.fixturesExamined += outcome.value.fixturesExamined;
      merged.outcomes.push(...outcome.value.outcomes);
      merged.failures.push(...outcome.value.failures);
    } else {
      merged.failures.push({ fixtureId: "(sport run)", error: errorMessage(outcome.reason), sport: configs[i].sport, provider: configs[i].provider });
    }
  });
  return merged;
}
