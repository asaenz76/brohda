/**
 * Prediction-card simplification — database-level proof. One Game with a MONEYLINE, a SPREAD and a TOTAL Market, a Pick on each side:
 * every surface that names a Pick (the shared loader, the notification subject, the admin rows) must read the same label for the same
 * canonical selection — and the stored selection must stay exactly "YES" / "NO". Real local Supabase; nothing here writes a label.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { upsertMarket, listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { getChoicePresentation, getMarketSubject, getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { getMarketNotificationContext } from "@/lib/notifications/market-context";
import { listAdminPredictionRows } from "@/lib/predictions/admin-rows";
import type { NormalizedMarket, MarketTemplate } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();
const suffix = randomUUID().slice(0, 8);
const HOME = `Colts ${suffix}`;
const AWAY = `Commanders ${suffix}`;

const created = { fixtureId: "", marketIds: [] as string[], userIds: [] as string[] };
const markets = {} as Record<"moneyline" | "spread" | "total", string>;
let yesUser = "";
let noUser = "";

async function createUser(label: string) {
  const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, username: `cp${label}${suffix}`, role: "player", is_active: true });
  created.userIds.push(data.user.id);
  return data.user.id;
}

async function createMarket(template: MarketTemplate, lineValue: number | null, yesSide: "HOME" | "AWAY" | null): Promise<string> {
  const payload: NormalizedMarket = {
    provider: "api_nfl",
    providerMarketId: `cp_${template}_${randomUUID()}`,
    providerEventId: null,
    question: `Old question text for ${template}?`,
    description: null,
    status: "ACTIVE",
    fixtureId: created.fixtureId,
    marketTemplate: template,
    lineValue,
    yesSide,
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Legacy yes", no: "Legacy no" } },
    volume24hr: null, liquidity: null, resolutionStatus: null, resolvedBy: null, resolvedOutcome: null,
    opensAt: null, closesAt: null, closedAt: null, ingestionSource: "test", providerMetadata: {},
  };
  const { id } = await upsertMarket(payload);
  created.marketIds.push(id);
  return id;
}

async function pick(userId: string, marketId: string, selected: "YES" | "NO") {
  const { error } = await admin.from("predictions").insert({
    user_id: userId, market_id: marketId, selected_outcome: selected, yes_probability_snapshot: 0.6, no_probability_snapshot: 0.4,
    market_question_snapshot: "snapshot", market_close_at_snapshot: null, market_status_snapshot: "ACTIVE", idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

beforeAll(async () => {
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `cp-${randomUUID()}`, sport: "american_football", home_team_name: HOME, away_team_name: AWAY, scheduled_start_utc: new Date(Date.now() + 48 * 3600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("fixture");
  created.fixtureId = fixture.id;
  markets.moneyline = await createMarket("MONEYLINE", null, "HOME");
  markets.spread = await createMarket("SPREAD", 3.5, "HOME");
  markets.total = await createMarket("TOTAL", 47.5, null);
  yesUser = await createUser("yes");
  noUser = await createUser("no");
  for (const marketId of Object.values(markets)) {
    await pick(yesUser, marketId, "YES");
    await pick(noUser, marketId, "NO");
  }
});

afterAll(async () => {
  await admin.from("predictions").delete().in("market_id", created.marketIds);
  await admin.from("markets").delete().in("id", created.marketIds);
  await admin.from("fixtures").delete().eq("id", created.fixtureId);
  for (const id of created.userIds) await admin.auth.admin.deleteUser(id);
});

describe("shared choice sources, read from the real Market and Game", () => {
  it("returns template, line, side, both team names and the sport for every Market in one batch", async () => {
    const sources = await listChoiceSourcesByMarketIds(Object.values(markets));
    expect(sources.get(markets.moneyline)).toMatchObject({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, homeTeamName: HOME, awayTeamName: AWAY, sport: "american_football" });
    expect(sources.get(markets.spread)).toMatchObject({ marketTemplate: "SPREAD", yesSide: "HOME", lineValue: 3.5, homeTeamName: HOME, awayTeamName: AWAY });
    expect(sources.get(markets.total)).toMatchObject({ marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5 });
  });

  it("labels each canonical side from that data — and never from the legacy ingestion labels", async () => {
    const sources = await listChoiceSourcesByMarketIds(Object.values(markets));
    expect([getSelectionLabel(sources.get(markets.moneyline)!, "YES"), getSelectionLabel(sources.get(markets.moneyline)!, "NO")]).toEqual([HOME, AWAY]);
    expect([getSelectionLabel(sources.get(markets.spread)!, "YES"), getSelectionLabel(sources.get(markets.spread)!, "NO")]).toEqual([`${HOME} +3.5`, `${AWAY} -3.5`]);
    expect([getSelectionLabel(sources.get(markets.total)!, "YES"), getSelectionLabel(sources.get(markets.total)!, "NO")]).toEqual(["Over 47.5", "Under 47.5"]);
    // Display order follows the sport's matchup order (Away @ Home for American football), whichever side is YES.
    expect(getChoicePresentation(sources.get(markets.moneyline)!).choices.map((c) => c.label)).toEqual([AWAY, HOME]);
    expect(getChoicePresentation(sources.get(markets.spread)!).choices.map((c) => c.label)).toEqual([`${AWAY} -3.5`, `${HOME} +3.5`]);
  });

  it("a missing Market is simply absent — callers fall back, nothing throws", async () => {
    const sources = await listChoiceSourcesByMarketIds([randomUUID()]);
    expect(sources.size).toBe(0);
    expect(getChoicePresentation({}).templateAware).toBe(false);
  });
});

describe("the same canonical Pick reads the same everywhere", () => {
  it("notification subject, admin rows and the shared presentation agree for every template", async () => {
    const sources = await listChoiceSourcesByMarketIds(Object.values(markets));
    const rows = await listAdminPredictionRows(200);
    const mine = rows.filter((r) => Object.values(markets).includes(r.market.id));
    expect(mine).toHaveLength(6);

    for (const [name, marketId] of Object.entries(markets)) {
      const source = sources.get(marketId)!;
      // Notifications name the Market by matchup + label, not by the old question.
      const { subject } = await getMarketNotificationContext(marketId);
      expect(subject).toBe(getMarketSubject(source, "unused"));
      expect(subject).not.toMatch(/Old question text/);

      for (const outcome of ["YES", "NO"] as const) {
        const row = mine.find((r) => r.market.id === marketId && r.selectedOutcome === outcome)!;
        // Admin: the human label leads, and the raw canonical value is still there for diagnostics.
        expect(row.selectedLabel, `${name} ${outcome}`).toBe(getSelectionLabel(source, outcome));
        expect(row.selectedOutcome).toBe(outcome);
      }
    }
    expect((await getMarketNotificationContext(markets.moneyline)).subject).toBe(`${AWAY} @ ${HOME} · Moneyline`);
    expect((await getMarketNotificationContext(markets.spread)).subject).toBe(`${AWAY} @ ${HOME} · Spread`);
    expect((await getMarketNotificationContext(markets.total)).subject).toBe(`${AWAY} @ ${HOME} · Total 47.5`);
  });

  it("the stored Picks are untouched: still the canonical YES / NO, one each per Market", async () => {
    const { data } = await admin.from("predictions").select("market_id, selected_outcome").in("market_id", Object.values(markets));
    for (const marketId of Object.values(markets)) {
      const picks = (data ?? []).filter((p) => p.market_id === marketId).map((p) => p.selected_outcome).sort();
      expect(picks).toEqual(["NO", "YES"]);
    }
  });

  it("opposing visible choices are opposing canonical selections (the Call BS / money rule is unchanged)", async () => {
    const sources = await listChoiceSourcesByMarketIds(Object.values(markets));
    const { data } = await admin.from("predictions").select("user_id, market_id, selected_outcome").in("market_id", Object.values(markets));
    for (const marketId of Object.values(markets)) {
      const a = data!.find((p) => p.market_id === marketId && p.user_id === yesUser)!;
      const b = data!.find((p) => p.market_id === marketId && p.user_id === noUser)!;
      expect(getSelectionLabel(sources.get(marketId)!, a.selected_outcome)).not.toBe(getSelectionLabel(sources.get(marketId)!, b.selected_outcome));
      expect(a.selected_outcome).not.toBe(b.selected_outcome);
    }
  });
});
