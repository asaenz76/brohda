/**
 * Small seeding helpers for integration tests that need a Game, a Market, members and Picks. No cleanup is needed here: the isolation
 * setup file (./isolation.ts) purges transient domain rows before and after every file. Accounts are left (they can hold ledger history).
 */
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { MarketTemplate, NormalizedMarket } from "@/lib/prediction-markets/types";
import { getSportConfig } from "@/lib/sports-data/sport-registry";

const admin = getTestAdminClient();

export interface SeedGameOptions {
  /** Minutes from now until kickoff. Default: tomorrow. */
  startsInMinutes?: number;
  template?: MarketTemplate;
  lineValue?: number | null;
  yesSide?: "HOME" | "AWAY" | null;
  sport?: string;
  /** Provider identity stored on the Game and its Market. Default: the provider the registry assigns to `sport` (so a basketball Game is an api_nba Game). */
  provider?: string;
  homeName?: string;
  awayName?: string;
}

export async function seedGame(options: SeedGameOptions = {}): Promise<{ fixtureId: string; marketId: string }> {
  const { startsInMinutes = 24 * 60, template = "MONEYLINE", sport = "american_football" } = options;
  const provider = options.provider ?? getSportConfig(sport)?.provider ?? "api_nfl";
  const lineValue = options.lineValue === undefined ? (template === "MONEYLINE" ? null : 3.5) : options.lineValue;
  const yesSide = options.yesSide === undefined ? (template === "TOTAL" ? null : "HOME") : options.yesSide;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({
      provider,
      external_fixture_id: `seed-${randomUUID()}`,
      sport,
      home_team_name: options.homeName ?? "Seed Home",
      away_team_name: options.awayName ?? "Seed Away",
      scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const market: NormalizedMarket = {
    provider,
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

/**
 * A SPONSOR login: an auth user with NO member profile, its sponsor organization and the one-to-one account link, made through the same database function
 * the signup action uses. `status` defaults to ACTIVE so it can act commercially; pass PENDING_REVIEW (the signup default) etc. to test the other states.
 */
export async function seedSponsorAccount(label: string, status: "PENDING_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED" | "DISABLED" = "ACTIVE"): Promise<{ userId: string; sponsorId: string; email: string }> {
  const email = `sponsor-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: sponsor, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: label, p_contact_name: "Test Contact", p_website: null, p_country: null, p_phone: null });
  if (accountError || !sponsor) throw accountError ?? new Error("failed to create sponsor account");
  const row = (Array.isArray(sponsor) ? sponsor[0] : sponsor) as { id: string };
  const { error: statusError } = await admin.from("sponsors").update({ status, logo_path: `${randomUUID()}/logo.webp` }).eq("id", row.id);
  if (statusError) throw statusError;
  return { userId: data.user.id, sponsorId: row.id, email };
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
