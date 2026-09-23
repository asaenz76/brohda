/**
 * Integration tests for Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Sports Market Ingestion). Real local Supabase, real `fixtures`/`markets`
 * rows and real `platform_settings` policy — only `apiNflProvider` is
 * mocked (no live network call), matching the exact mocking pattern
 * already proven in tests/integration/sync-does-not-fetch-odds.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import type { NormalizedNflFixtureOdds } from "@/lib/sports-data/types";

const admin = getTestAdminClient();

const getFixtureRawOddsMock = vi.fn<(externalFixtureId: string) => Promise<NormalizedNflFixtureOdds | null>>();

vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: {
    name: "api_nfl",
    isEnabled: () => true,
    getFixtureRawOdds: (...args: [string]) => getFixtureRawOddsMock(...args),
  },
}));

const { ingestNflMarketsForFixture, runNflMarketIngestion } = await import("@/lib/prediction-markets/ingestion/nfl");

function moneyline(homeOdd: number, awayOdd: number) {
  return [{ value: "Home", odd: homeOdd }, { value: "Away", odd: awayOdd }];
}

function total(point: number, overOdd: number, underOdd: number) {
  return [{ value: `Over ${point}`, odd: overOdd }, { value: `Under ${point}`, odd: underOdd }];
}

function oddsFixture(externalFixtureId: string, opts: { moneylinePairs?: number; totalPoint?: number } = {}): NormalizedNflFixtureOdds {
  const n = opts.moneylinePairs ?? 2;
  return {
    externalFixtureId,
    providerUpdatedAt: new Date().toISOString(),
    bookmakers: Array.from({ length: n }, (_, i) => ({
      bookmakerId: i + 1,
      bookmakerName: `book-${i + 1}`,
      moneyline: moneyline(1.5 + i * 0.02, 2.7 - i * 0.02),
      asianHandicap: [],
      gameTotal: opts.totalPoint !== undefined ? total(opts.totalPoint, 1.91 - i * 0.01, 1.91 + i * 0.01) : [],
      homeTeamTotal: [],
      awayTeamTotal: [],
    })),
  };
}

const createdFixtureIds: string[] = [];

async function createFixture(): Promise<{ id: string; externalFixtureId: string; homeTeamName: string; awayTeamName: string }> {
  const externalFixtureId = `r2-ingestion-${crypto.randomUUID()}`;
  const homeTeamName = "Home Test NFL";
  const awayTeamName = "Away Test NFL";
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: externalFixtureId,
      home_team_name: homeTeamName,
      away_team_name: awayTeamName,
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return { id: data.id, externalFixtureId, homeTeamName, awayTeamName };
}

async function setIngestionPolicy(enabled: boolean, minBookmakerCount = 2) {
  await admin.from("platform_settings").update({ market_ingestion_enabled: enabled, market_ingestion_min_bookmaker_count: minBookmakerCount }).eq("id", true);
}

async function marketsFor(fixtureId: string) {
  const { data, error } = await admin.from("markets").select("*").eq("fixture_id", fixtureId);
  if (error) throw error;
  return data ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await setIngestionPolicy(true, 2);
});

afterEach(async () => {
  if (createdFixtureIds.length > 0) {
    // Predictions before markets — predictions.market_id is a soft
    // reference (no FK), so deleting the market first would leave the
    // prediction permanently orphaned.
    const { data: marketsToDelete } = await admin.from("markets").select("id").in("fixture_id", createdFixtureIds);
    const marketIds = (marketsToDelete ?? []).map((m) => m.id);
    if (marketIds.length > 0) await admin.from("predictions").delete().in("market_id", marketIds);
    await admin.from("markets").delete().in("fixture_id", createdFixtureIds);
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  await setIngestionPolicy(false, 2);
});

describe("policy gate", () => {
  it("does nothing when market_ingestion_enabled is false", async () => {
    await setIngestionPolicy(false);
    const summary = await runNflMarketIngestion();
    expect(summary.policyEnabled).toBe(false);
    expect(summary.fixturesExamined).toBe(0);
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
  });
});

describe("Market creation", () => {
  it("creates a MONEYLINE and TOTAL Market from sufficient bookmaker data", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));

    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.moneyline).toBe("inserted");
    expect(outcome.total).toBe("inserted");

    const rows = await marketsFor(fixture.id);
    expect(rows).toHaveLength(2);
    const moneylineRow = rows.find((r) => r.market_template === "MONEYLINE")!;
    const totalRow = rows.find((r) => r.market_template === "TOTAL")!;
    expect(moneylineRow.yes_side).toBe("HOME");
    expect(moneylineRow.line_value).toBeNull();
    expect(totalRow.line_value).toBe(47.5);
    expect(totalRow.yes_side).toBeNull();
    expect(moneylineRow.status).toBe("ACTIVE");
    expect(totalRow.status).toBe("ACTIVE");
  });

  it("skips a template with insufficient bookmakers without creating a malformed Market", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { moneylinePairs: 1 }));

    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.moneyline).toBe("skipped-insufficient-bookmakers");
    expect(outcome.total).toBe("skipped-insufficient-bookmakers");
    expect(await marketsFor(fixture.id)).toHaveLength(0);
  });

  it("skips safely (no crash, no write) when the provider returns no data", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(null);

    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.moneyline).toBe("skipped-no-data");
    expect(outcome.total).toBe("skipped-no-data");
    expect(await marketsFor(fixture.id)).toHaveLength(0);
  });

  it("skips safely when the provider call throws", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockRejectedValueOnce(new Error("provider timeout"));

    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.moneyline).toBe("skipped-no-data");
    expect(await marketsFor(fixture.id)).toHaveLength(0);
  });
});

describe("idempotency — price movement never creates a duplicate or changes proposition identity", () => {
  it("re-ingesting the same line with a different price updates the existing rows in place", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));
    await ingestNflMarketsForFixture(fixture, 2);
    const firstPass = await marketsFor(fixture.id);
    const totalId = firstPass.find((r) => r.market_template === "TOTAL")!.id;

    // Same line, different (shifted) prices on the second pass.
    const shifted = oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 });
    shifted.bookmakers.forEach((b) => (b.gameTotal = total(47.5, 2.05, 1.8)));
    getFixtureRawOddsMock.mockResolvedValueOnce(shifted);

    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.total).toBe("updated");

    const secondPass = await marketsFor(fixture.id);
    expect(secondPass).toHaveLength(2); // still just one MONEYLINE + one TOTAL row
    const updatedTotal = secondPass.find((r) => r.id === totalId)!;
    expect(updatedTotal.line_value).toBe(47.5); // identity unchanged
    expect(Number(updatedTotal.yes_price)).not.toBeCloseTo(Number(firstPass.find((r) => r.id === totalId)!.yes_price), 3);
  });

  it("running ingestion twice with completely unchanged data never duplicates a Market", async () => {
    const fixture = await createFixture();
    const odds = oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 });
    getFixtureRawOddsMock.mockResolvedValue(odds);

    await ingestNflMarketsForFixture(fixture, 2);
    await ingestNflMarketsForFixture(fixture, 2);
    await ingestNflMarketsForFixture(fixture, 2);

    expect(await marketsFor(fixture.id)).toHaveLength(2);
  });
});

describe("line movement — historical propositions are preserved, current one changes", () => {
  it("a moved TOTAL line deactivates the old Market and creates a new ACTIVE one, preserving the old row untouched", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));
    await ingestNflMarketsForFixture(fixture, 2);
    const afterFirst = await marketsFor(fixture.id);
    const oldTotal = afterFirst.find((r) => r.market_template === "TOTAL")!;

    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 48.5 }));
    const outcome = await ingestNflMarketsForFixture(fixture, 2);
    expect(outcome.total).toBe("line-moved");

    const afterSecond = await marketsFor(fixture.id);
    const totals = afterSecond.filter((r) => r.market_template === "TOTAL");
    expect(totals).toHaveLength(2); // BOTH historical rows still exist
    const stillOld = totals.find((r) => r.id === oldTotal.id)!;
    expect(stillOld.line_value).toBe(47.5); // never mutated
    expect(stillOld.status).toBe("INACTIVE"); // no longer current
    const newActive = totals.find((r) => r.id !== oldTotal.id)!;
    expect(newActive.line_value).toBe(48.5);
    expect(newActive.status).toBe("ACTIVE");
  });

  it("a Prediction referencing the old line keeps its exact original meaning after the line moves", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));
    await ingestNflMarketsForFixture(fixture, 2);
    const oldTotal = (await marketsFor(fixture.id)).find((r) => r.market_template === "TOTAL")!;

    const { data: user } = await admin.auth.admin.createUser({ email: `r2-pick-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: user!.user!.id, display_name: "R2 Pick Test", role: "player", is_active: true });
    await admin.from("predictions").insert({
      user_id: user!.user!.id,
      market_id: oldTotal.id,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.5,
      no_probability_snapshot: 0.5,
      market_question_snapshot: oldTotal.question,
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
    });

    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 48.5 }));
    await ingestNflMarketsForFixture(fixture, 2);

    const { data: prediction } = await admin.from("predictions").select("market_id, market_question_snapshot").eq("user_id", user!.user!.id).single();
    expect(prediction!.market_id).toBe(oldTotal.id);
    expect(prediction!.market_question_snapshot).toBe(oldTotal.question);
    const { data: refreshedOldTotal } = await admin.from("markets").select("line_value").eq("id", oldTotal.id).single();
    expect(refreshedOldTotal!.line_value).toBe(47.5);

    await admin.auth.admin.deleteUser(user!.user!.id);
  });
});

describe("concurrency", () => {
  it("two overlapping ingestion runs for the same fixture never produce two ACTIVE TOTAL Markets or a duplicate proposition", async () => {
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValue(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));

    // Two concurrent calls sharing the same underlying data — the DB's own
    // uniqueness constraint (R1) is the final backstop if both attempt an
    // insert; the application logic on top must not crash the process
    // either way.
    const results = await Promise.allSettled([ingestNflMarketsForFixture(fixture, 2), ingestNflMarketsForFixture(fixture, 2)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const rows = await marketsFor(fixture.id);
    const activeTotals = rows.filter((r) => r.market_template === "TOTAL" && r.status === "ACTIVE");
    expect(activeTotals).toHaveLength(1);
  });
});

describe("discovery compatibility (§24 — zero changes made to the discovery layer)", () => {
  it("a newly-ingested ACTIVE Market is immediately visible through the existing listActiveMarkets/discovery repository, unmodified", async () => {
    const { listActiveMarkets } = await import("@/lib/prediction-markets/repository");
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));
    await ingestNflMarketsForFixture(fixture, 2);

    const active = await listActiveMarkets(500);
    const ids = active.map((m) => m.id);
    const rows = await marketsFor(fixture.id);
    for (const row of rows) expect(ids).toContain(row.id);
  });

  it("a superseded (line-moved) Market disappears from listActiveMarkets without any code change to the discovery layer", async () => {
    const { listActiveMarkets } = await import("@/lib/prediction-markets/repository");
    const fixture = await createFixture();
    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 47.5 }));
    await ingestNflMarketsForFixture(fixture, 2);
    const oldTotal = (await marketsFor(fixture.id)).find((r) => r.market_template === "TOTAL")!;

    getFixtureRawOddsMock.mockResolvedValueOnce(oddsFixture(fixture.externalFixtureId, { totalPoint: 48.5 }));
    await ingestNflMarketsForFixture(fixture, 2);

    const active = await listActiveMarkets(500);
    expect(active.map((m) => m.id)).not.toContain(oldTotal.id);
  });
});

describe("security", () => {
  it("an anon client cannot mutate the new ingestion policy columns directly", async () => {
    const { getTestAnonClient } = await import("./helpers/test-env");
    const anon = getTestAnonClient();
    const { error } = await anon.from("platform_settings").update({ market_ingestion_enabled: true }).eq("id", true);
    expect(error).not.toBeNull();
  });
});
