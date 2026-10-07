/**
 * The cleanup migration for the two leaked production test teams removes ONLY those exact identities and ONLY when nothing references them.
 * Runs the migration's own SQL against the real local database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const SQL = readFileSync("supabase/migrations/20260101000180_remove_orphaned_sync_test_teams.sql", "utf8");
const created: { teams: string[]; communities: string[]; fixtures: string[]; users: string[] } = { teams: [], communities: [], fixtures: [], users: [] };

async function run() {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query(SQL);
  } finally {
    await client.end();
  }
}
async function insertTeam(external_id: string, name: string, provider = "api_nfl") {
  const { data, error } = await admin.from("teams").upsert({ provider, external_id, name, logo_url: null }, { onConflict: "provider,external_id" }).select("id").single();
  if (error || !data) throw error ?? new Error("team");
  created.teams.push(data.id);
  return data.id as string;
}
const exists = async (id: string) => (await admin.from("teams").select("id").eq("id", id).maybeSingle()).data !== null;

afterAll(async () => {
  if (created.fixtures.length) await admin.from("fixtures").delete().in("id", created.fixtures);
  if (created.communities.length) {
    await admin.from("community_follows").delete().in("community_id", created.communities);
    await admin.from("communities").delete().in("id", created.communities);
  }
  if (created.teams.length) await admin.from("teams").delete().in("id", created.teams);
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
});

describe("remove_orphaned_sync_test_teams", () => {
  it("deletes the two orphaned test teams, and nothing else", async () => {
    const home = await insertTeam("9101", "Home Sync Test NFL");
    const away = await insertTeam("9102", "Away Sync Test NFL");
    const real = await insertTeam(`real-${randomUUID()}`, "Some Real Team");
    const sameNameOtherProvider = await insertTeam("9101", "Home Sync Test NFL", "api_nhl");
    await run();
    expect(await exists(home)).toBe(false);
    expect(await exists(away)).toBe(false);
    expect(await exists(real)).toBe(true);
    expect(await exists(sameNameOtherProvider)).toBe(true); // another provider's identical external id is untouched
    await run(); // idempotent
  });

  it("removes an UNUSED team Community together with the team (the Community job may have created one in the meantime)", async () => {
    const home = await insertTeam("9101", "Home Sync Test NFL");
    const { data: community } = await admin.from("communities").insert({ type: "TEAM", team_id: home, slug: `orphan-unused-${randomUUID()}`, active: true }).select("id").single();
    created.communities.push(community!.id);
    await run();
    expect(await exists(home)).toBe(false);
    expect((await admin.from("communities").select("id").eq("id", community!.id)).data).toEqual([]);
  });

  it("keeps a test team that is referenced — by a followed Community or by a Game — instead of deleting or failing", async () => {
    const home = await insertTeam("9101", "Home Sync Test NFL");
    const away = await insertTeam("9102", "Away Sync Test NFL");
    const { data: community } = await admin.from("communities").insert({ type: "TEAM", team_id: home, slug: `orphan-test-${randomUUID()}`, active: true }).select("id").single();
    created.communities.push(community!.id);
    const { data: user } = await admin.auth.admin.createUser({ email: `orphan-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: user.user!.id, display_name: "follower", role: "player", is_active: true });
    created.users.push(user.user!.id);
    const { error: followError } = await admin.from("community_follows").insert({ user_id: user.user!.id, community_id: community!.id });
    expect(followError).toBeNull();
    const { data: fixture } = await admin.from("fixtures").insert({ provider: "api_nfl", external_fixture_id: `orphan-${randomUUID()}`, sport: "american_football", home_team_name: "X", away_team_name: "Y", away_team_external_id: "9102", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" }).select("id").single();
    created.fixtures.push(fixture!.id);
    await run();
    expect(await exists(home)).toBe(true); // a Community with a follower
    expect(await exists(away)).toBe(true); // referenced by a Game's external id
  });
});
