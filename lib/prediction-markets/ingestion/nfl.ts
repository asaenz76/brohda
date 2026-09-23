import "server-only";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";
import { API_NFL_PROVIDER } from "@/lib/sports-data/provider-names";
import { createAdminClient } from "@/lib/supabase/admin";
import { deactivateMarket, getActiveMarketByFixtureAndTemplate, upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import type { NflBookmakerOdds } from "@/lib/sports-data/types";
import { aggregateMoneyline, aggregateTotal } from "./aggregate-nfl-odds";
import { getMarketIngestionPolicy } from "./policy";

// Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md, Sports Market Ingestion) —
// the real, Brohda-native pipeline:
//
//   fixtures (eligible NFL Games)
//     -> apiNflProvider.getFixtureRawOdds (existing provider integration,
//        already live for the pool-creation wizard)
//     -> aggregateMoneyline / aggregateTotal (this domain's own vig-removed
//        multi-bookmaker consensus, ./aggregate-nfl-odds.ts)
//     -> canonical markets rows, written through the existing
//        upsertMarket (R1) — never a parallel write path.
//
// One real provider (api_nfl), one clean boundary — no generic
// multi-provider abstraction, matching lib/sports-data/types.ts's own
// documented decision that a shared cross-sport odds contract "fights
// every provider except the one it was modeled on."

export interface FixtureIngestionOutcome {
  fixtureId: string;
  moneyline: "inserted" | "updated" | "skipped-insufficient-bookmakers" | "skipped-no-data";
  total: "inserted" | "updated" | "line-moved" | "skipped-insufficient-bookmakers" | "skipped-no-data";
}

export interface EligibleFixture {
  id: string;
  externalFixtureId: string;
  homeTeamName: string;
  awayTeamName: string;
}

function moneylineMarket(fixture: EligibleFixture, homeProbability: number): NormalizedMarket {
  return {
    provider: API_NFL_PROVIDER,
    providerMarketId: `${fixture.externalFixtureId}:MONEYLINE`,
    providerEventId: fixture.externalFixtureId,
    question: `Will the ${fixture.homeTeamName} win?`,
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    // homeProbability is already a fair (de-vigged) probability, not a raw
    // provider price — its complement genuinely IS 1 - yes here, unlike
    // the "never derive no = 1 - yes" rule this table's own header comment
    // states for RAW provider prices (a different, earlier concern: not
    // assuming vig cancels out before it's been removed).
    price: { yes: homeProbability, no: 1 - homeProbability, outcomeLabels: { yes: `${fixture.homeTeamName} win`, no: `${fixture.homeTeamName} do not win` } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "nfl_market_ingestion",
    providerMetadata: {},
  };
}

function totalMarket(fixture: EligibleFixture, line: number, overProbability: number): NormalizedMarket {
  return {
    provider: API_NFL_PROVIDER,
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
    ingestionSource: "nfl_market_ingestion",
    providerMetadata: {},
  };
}

/**
 * Ingests both automatically-supported templates (MONEYLINE, TOTAL) for one
 * fixture. Idempotent and safe to retry: a failed or partial run leaves
 * whatever canonical Markets already existed untouched (§19) — this
 * function only ever adds/refreshes state, never deletes, and every write
 * goes through `upsertMarket`'s own idempotent (provider, provider_market_id)
 * upsert plus R1's DB-level uniqueness/immutability guarantees as the final
 * backstop against a concurrent duplicate.
 */
export async function ingestNflMarketsForFixture(fixture: EligibleFixture, minBookmakerCount: number): Promise<FixtureIngestionOutcome> {
  const odds = await apiNflProvider.getFixtureRawOdds(fixture.externalFixtureId).catch(() => null);
  if (!odds || odds.bookmakers.length === 0) {
    return { fixtureId: fixture.id, moneyline: "skipped-no-data", total: "skipped-no-data" };
  }

  const moneylineOutcome = await ingestMoneyline(fixture, odds.bookmakers, minBookmakerCount);
  const totalOutcome = await ingestTotal(fixture, odds.bookmakers, minBookmakerCount);

  return { fixtureId: fixture.id, moneyline: moneylineOutcome, total: totalOutcome };
}

async function ingestMoneyline(fixture: EligibleFixture, bookmakers: NflBookmakerOdds[], minBookmakerCount: number): Promise<FixtureIngestionOutcome["moneyline"]> {
  const aggregate = aggregateMoneyline(bookmakers, minBookmakerCount);
  if (!aggregate) return "skipped-insufficient-bookmakers";

  const { outcome } = await upsertMarket(moneylineMarket(fixture, aggregate.homeProbability));
  return outcome;
}

async function ingestTotal(fixture: EligibleFixture, bookmakers: NflBookmakerOdds[], minBookmakerCount: number): Promise<FixtureIngestionOutcome["total"]> {
  const aggregate = aggregateTotal(bookmakers, minBookmakerCount);
  if (!aggregate) return "skipped-insufficient-bookmakers";

  const currentlyActive = await getActiveMarketByFixtureAndTemplate(fixture.id, "TOTAL");
  const lineMoved = currentlyActive !== null && currentlyActive.lineValue !== aggregate.line;
  if (lineMoved) {
    // Deactivate before inserting the new line's row — never the other way
    // around, so there is never a moment with two ACTIVE TOTAL Markets for
    // the same fixture. The old row's identity (fixture_id, TOTAL,
    // currentlyActive.lineValue) is completely untouched: only `status`
    // changes, which R1's immutability trigger allows.
    await deactivateMarket(currentlyActive.id);
  }

  const { outcome } = await upsertMarket(totalMarket(fixture, aggregate.line, aggregate.overProbability));
  return lineMoved ? "line-moved" : outcome;
}

async function listEligibleNflFixtures(): Promise<EligibleFixture[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("fixtures")
    .select("id, external_fixture_id, home_team_name, away_team_name")
    .eq("provider", API_NFL_PROVIDER)
    .eq("internal_status", "NOT_STARTED")
    .gt("scheduled_start_utc", new Date().toISOString());
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    externalFixtureId: row.external_fixture_id,
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
  }));
}

export interface MarketIngestionSummary {
  ranAt: string;
  policyEnabled: boolean;
  fixturesExamined: number;
  outcomes: FixtureIngestionOutcome[];
  /** Fixtures whose provider call threw (network/parse failure) — recorded, never allowed to abort the whole run (§19: one bad fixture must not block the rest). */
  failures: Array<{ fixtureId: string; error: string }>;
}

/**
 * The ingestion job itself. Not wired to any scheduler by this milestone —
 * exposed as a callable function (this), a cron-compatible route
 * (app/api/cron/ingest-nfl-markets/route.ts), and a manual script
 * (scripts/ingest-nfl-markets.ts), all three calling this exact function —
 * no parallel logic, matching the established sync-fixtures-nfl/
 * grade-predictions precedent.
 */
export async function runNflMarketIngestion(): Promise<MarketIngestionSummary> {
  const policy = await getMarketIngestionPolicy();
  if (!policy.enabled) {
    return { ranAt: new Date().toISOString(), policyEnabled: false, fixturesExamined: 0, outcomes: [], failures: [] };
  }

  const fixtures = await listEligibleNflFixtures();
  const outcomes: FixtureIngestionOutcome[] = [];
  const failures: MarketIngestionSummary["failures"] = [];

  for (const fixture of fixtures) {
    try {
      outcomes.push(await ingestNflMarketsForFixture(fixture, policy.minBookmakerCount));
    } catch (error) {
      // One fixture's failure (e.g. a uniqueness race lost, or an
      // unexpected provider shape) must never abort the rest of the run —
      // canonical state already written for other fixtures stays intact.
      failures.push({ fixtureId: fixture.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ranAt: new Date().toISOString(), policyEnabled: true, fixturesExamined: fixtures.length, outcomes, failures };
}
