/**
 * Integration tests against a real local Supabase instance (spec §22:
 * "Integration (real database)"). Requires `pnpm supabase:start` to be
 * running first — these are not part of the default `pnpm test` unit run,
 * since Vitest's jsdom unit config only picks up `tests/unit/**`.
 *
 * Run with: pnpm exec vitest run --config vitest.integration.config.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role: "player",
    is_active: true,
  });

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (signInError) throw signInError;

  return { userId: data.user.id, client };
}

describe.skipIf(!SERVICE_ROLE_KEY)("RLS: user_profiles and audit_logs", () => {
  let playerA: Awaited<ReturnType<typeof createTestPlayer>>;
  let playerB: Awaited<ReturnType<typeof createTestPlayer>>;

  beforeAll(async () => {
    const suffix = Date.now();
    playerA = await createTestPlayer(`rls-test-a-${suffix}@example.com`);
    playerB = await createTestPlayer(`rls-test-b-${suffix}@example.com`);

    await admin.from("audit_logs").insert({
      actor_id: playerA.userId,
      action: "test.event",
      entity_type: "test",
    });
  });

  afterAll(async () => {
    // audit_logs is append-only (a trigger blocks DELETE unconditionally,
    // even for service_role) — a user with an audit_logs row can never be
    // hard-deleted once one exists, by design (Appendix Y #33). Deactivate
    // instead of attempting deleteUser, which would fail on the FK and
    // silently leave the auth user behind anyway.
    await admin.from("user_profiles").update({ is_active: false }).eq("id", playerA.userId);
    await admin.auth.admin.deleteUser(playerB.userId);
  });

  it("lets a player read their own full profile", async () => {
    const { data, error } = await playerA.client
      .from("user_profiles")
      .select("*")
      .eq("id", playerA.userId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(playerA.userId);
  });

  it("does not let a player read another player's full profile row", async () => {
    const { data } = await playerA.client
      .from("user_profiles")
      .select("*")
      .eq("id", playerB.userId)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("lets any active member read public_profiles for another user", async () => {
    const { data } = await playerA.client
      .from("public_profiles")
      .select("*")
      .eq("id", playerB.userId)
      .maybeSingle();
    expect(data?.id).toBe(playerB.userId);
  });

  it("does not let a player read audit_logs", async () => {
    const { data } = await playerA.client.from("audit_logs").select("*");
    expect(data).toEqual([]);
  });

  it("does not let a player update their own role via direct client write", async () => {
    const { error } = await playerA.client
      .from("user_profiles")
      .update({ role: "super_admin" })
      .eq("id", playerA.userId);
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!SERVICE_ROLE_KEY)("RLS: fixtures", () => {
  let player: Awaited<ReturnType<typeof createTestPlayer>>;
  let fixtureId: string;

  beforeAll(async () => {
    player = await createTestPlayer(`fixtures-rls-test-${Date.now()}@example.com`);

    const { data, error } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `test-${Date.now()}`,
        home_team_name: "Test Home",
        away_team_name: "Test Away",
        scheduled_start_utc: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("failed to seed test fixture");
    fixtureId = data.id;
  });

  afterAll(async () => {
    await admin.from("fixtures").delete().eq("id", fixtureId);
    await admin.auth.admin.deleteUser(player.userId);
  });

  it("lets a player read fixtures", async () => {
    const { data, error } = await player.client
      .from("fixtures")
      .select("*")
      .eq("id", fixtureId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.id).toBe(fixtureId);
  });

  it("does not let a player insert a fixture", async () => {
    const { error } = await player.client.from("fixtures").insert({
      external_fixture_id: `player-attempt-${Date.now()}`,
      home_team_name: "Should",
      away_team_name: "Fail",
      scheduled_start_utc: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  // Phase 4.1: fixtures RLS is enabled with only a SELECT policy
  // (members_can_read_fixtures) — no UPDATE/DELETE policy exists at all.
  // Per Postgres's own documented RLS semantics, that means UPDATE/DELETE
  // affects zero rows for `authenticated`, but the call itself does NOT
  // return an error (RLS-blocked-by-absence-of-policy is silent, not a
  // permission-denied throw) — confirmed live against production
  // (pg_policy shows exactly one policy, command 'r', role
  // authenticated). Asserting only `error !== null` can't actually prove
  // the fixture was protected — it would pass identically whether the
  // update silently affected 0 rows (safe) or actually mutated the row
  // (unsafe, if a broader GRANT and a permissive policy both existed).
  // Re-reading the row via the admin client afterward is what actually
  // proves nothing changed.
  it("does not let a player update a fixture", async () => {
    const { error } = await player.client
      .from("fixtures")
      .update({ home_score: 99 })
      .eq("id", fixtureId);
    void error; // may be null — RLS silently blocks rather than erroring, see comment above
    const { data: unchanged } = await admin.from("fixtures").select("home_score").eq("id", fixtureId).single();
    expect(unchanged?.home_score).toBeNull();
  });

  it("does not let a player delete a fixture", async () => {
    const { error } = await player.client.from("fixtures").delete().eq("id", fixtureId);
    void error; // may be null — RLS silently blocks rather than erroring, see comment above
    const { data: stillExists } = await admin.from("fixtures").select("id").eq("id", fixtureId).maybeSingle();
    expect(stillExists?.id).toBe(fixtureId);
  });
});
