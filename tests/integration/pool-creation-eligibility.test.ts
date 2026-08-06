/**
 * Regression coverage for the pool-creation wizard's fixture-search gate —
 * the fixtures_available_for_pool_creation view queried by
 * app/(admin)/admin/pools/new/page.tsx. Locks in what was verified live in
 * the browser using scripts/seed-dev-grading.ts's seeded data: an eligible
 * fixture (matching, IMPORTED, pool_creation_enabled league_season_imports
 * row; not hidden; no fully-resolved pool) surfaces, and a fixture with no
 * matching import row does not — the gate itself is never weakened to make
 * this pass, only real prerequisite data is created.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PROVIDER = "eligibility-test";
const createdFixtureIds: string[] = [];
const createdLeagueIds: string[] = [];

async function createLeagueAndImport(overrides: { poolCreationEnabled?: boolean; archived?: boolean } = {}) {
  const externalLeagueId = `eligibility-test-league-${randomUUID()}`;
  const season = "2026";

  const { data: league, error: leagueError } = await admin
    .from("leagues")
    .insert({ provider: PROVIDER, external_id: externalLeagueId, name: "Eligibility Test League" })
    .select("id")
    .single();
  if (leagueError || !league) throw leagueError ?? new Error("failed to create test league");
  createdLeagueIds.push(league.id as string);

  const { error: importError } = await admin.from("league_season_imports").insert({
    provider: PROVIDER,
    external_league_id: externalLeagueId,
    season,
    league_id: league.id,
    import_status: "IMPORTED",
    pool_creation_enabled: overrides.poolCreationEnabled ?? true,
    archived_at: overrides.archived ? new Date().toISOString() : null,
  });
  if (importError) throw importError;

  return { externalLeagueId, season };
}

async function createFixture(competition: { externalLeagueId: string; season: string } | null) {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `eligibility-test-fixture-${randomUUID()}`,
      competition_external_id: competition?.externalLeagueId ?? "eligibility-test-unimported-league",
      season: competition?.season ?? "2026",
      home_team_name: "Eligibility Test Home FC",
      away_team_name: "Eligibility Test Away FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id as string);
  return data.id as string;
}

describe.skipIf(!SERVICE_ROLE_KEY)("fixtures_available_for_pool_creation — pool-creation wizard eligibility gate", () => {
  afterAll(async () => {
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
    if (createdLeagueIds.length > 0) {
      await admin.from("league_season_imports").delete().in("league_id", createdLeagueIds);
      await admin.from("leagues").delete().in("id", createdLeagueIds);
    }
  });

  it("surfaces a fixture with a real, IMPORTED, pool_creation_enabled league_season_imports row", async () => {
    const competition = await createLeagueAndImport();
    const fixtureId = await createFixture(competition);

    const { data } = await admin.from("fixtures_available_for_pool_creation").select("id").eq("id", fixtureId);
    expect(data).toHaveLength(1);
  });

  it("excludes a fixture with no matching league_season_imports row at all — the gate is not weakened", async () => {
    const fixtureId = await createFixture(null);

    const { data } = await admin.from("fixtures_available_for_pool_creation").select("id").eq("id", fixtureId);
    expect(data).toHaveLength(0);
  });

  it("excludes a fixture whose league_season_imports row has pool_creation_enabled = false", async () => {
    const competition = await createLeagueAndImport({ poolCreationEnabled: false });
    const fixtureId = await createFixture(competition);

    const { data } = await admin.from("fixtures_available_for_pool_creation").select("id").eq("id", fixtureId);
    expect(data).toHaveLength(0);
  });

  it("excludes a fixture whose league_season_imports row is archived", async () => {
    const competition = await createLeagueAndImport({ archived: true });
    const fixtureId = await createFixture(competition);

    const { data } = await admin.from("fixtures_available_for_pool_creation").select("id").eq("id", fixtureId);
    expect(data).toHaveLength(0);
  });
});
