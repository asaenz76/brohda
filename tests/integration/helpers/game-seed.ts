/**
 * Small seeding helpers for integration tests that need a Game, a Market, members and Picks. No cleanup is needed here: the isolation
 * setup file (./isolation.ts) purges transient domain rows before and after every file. Accounts are left (they can hold ledger history).
 */
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { MarketTemplate, NormalizedMarket } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();

export interface SeedGameOptions {
  /** Minutes from now until kickoff. Default: tomorrow. */
  startsInMinutes?: number;
  template?: MarketTemplate;
  lineValue?: number | null;
  yesSide?: "HOME" | "AWAY" | null;
  sport?: string;
}

export async function seedGame(options: SeedGameOptions = {}): Promise<{ fixtureId: string; marketId: string }> {
  const { startsInMinutes = 24 * 60, template = "MONEYLINE", sport = "american_football" } = options;
  const lineValue = options.lineValue === undefined ? (template === "MONEYLINE" ? null : 3.5) : options.lineValue;
  const yesSide = options.yesSide === undefined ? (template === "TOTAL" ? null : "HOME") : options.yesSide;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: `seed-${randomUUID()}`,
      sport,
      home_team_name: "Seed Home",
      away_team_name: "Seed Away",
      scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const market: NormalizedMarket = {
    provider: "api_nfl",
    providerMarketId: `seed_${randomUUID()}`,
    providerEventId: null,
    question: "Seed market?",
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: template,
    lineValue,
    yesSide,
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
  };
  const { id } = await upsertMarket(market);
  return { fixtureId: fixture.id, marketId: id };
}

export async function seedUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
  return data.user.id;
}

/** Makes a Pick through the real set_pick path and returns the prediction id. */
export async function seedPick(userId: string, marketId: string, selectedOutcome: "YES" | "NO"): Promise<string> {
  const { prediction, outcome } = await setPick({
    userId,
    marketId,
    selectedOutcome,
    yesProbability: 0.6,
    noProbability: 0.4,
    marketQuestionSnapshot: "q",
    marketCloseAtSnapshot: null,
    marketStatusSnapshot: "ACTIVE",
    idempotencyKey: randomUUID(),
  });
  if (!prediction) throw new Error(`pick failed: ${outcome}`);
  return prediction.id;
}

export async function setFixture(fixtureId: string, values: Record<string, unknown>) {
  const { error } = await admin.from("fixtures").update(values).eq("id", fixtureId);
  if (error) throw error;
}
