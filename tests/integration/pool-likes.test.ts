/**
 * Integration tests for pool likes (Phase 5 of the Instagram-style
 * redesign): toggle_pool_like's atomic insert-or-delete + counter update,
 * and RLS isolation on pool_likes. Run with: pnpm test:integration
 * (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

  return { userId: data.user.id as string, client };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `like-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data.id as string;
}

const createdPoolIds: string[] = [];

async function createTestPool(fixtureId: string, adminId: string) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "WHO_WILL_ADVANCE",
      question: "Who will advance?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);
  return pool.id as string;
}

async function getAdminId(): Promise<string> {
  const { data } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "super_admin")
    .eq("is_active", true)
    .limit(1)
    .single();
  return data!.id as string;
}

async function getLikeCount(poolId: string): Promise<number> {
  const { data } = await admin.from("pools").select("like_count").eq("id", poolId).single();
  return data!.like_count as number;
}

describe.skipIf(!SERVICE_ROLE_KEY)("pool likes", () => {
  let adminId: string;
  let fixtureId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    adminId = await getAdminId();
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    await Promise.all(createdUserIds.map(deactivate));
    if (createdPoolIds.length > 0) {
      await admin.from("pool_likes").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("toggling on then off leaves like_count matching the raw row count", async () => {
    const player = await createTestPlayer(`like-toggle-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: liked } = await admin.rpc("toggle_pool_like", {
      p_pool_id: poolId,
      p_user_id: player.userId,
    });
    expect(liked).toBe(true);
    expect(await getLikeCount(poolId)).toBe(1);

    const { count } = await admin
      .from("pool_likes")
      .select("id", { count: "exact", head: true })
      .eq("pool_id", poolId);
    expect(count).toBe(1);

    const { data: unliked } = await admin.rpc("toggle_pool_like", {
      p_pool_id: poolId,
      p_user_id: player.userId,
    });
    expect(unliked).toBe(false);
    expect(await getLikeCount(poolId)).toBe(0);
  });

  it("like_count reflects multiple distinct likers", async () => {
    const a = await createTestPlayer(`like-multi-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`like-multi-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    await admin.rpc("toggle_pool_like", { p_pool_id: poolId, p_user_id: a.userId });
    await admin.rpc("toggle_pool_like", { p_pool_id: poolId, p_user_id: b.userId });

    expect(await getLikeCount(poolId)).toBe(2);
  });

  it("RLS: a player can only see their own like rows, and cannot write the table directly", async () => {
    const a = await createTestPlayer(`like-rls-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`like-rls-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    await admin.rpc("toggle_pool_like", { p_pool_id: poolId, p_user_id: a.userId });
    await admin.rpc("toggle_pool_like", { p_pool_id: poolId, p_user_id: b.userId });

    const { data: visibleToA } = await a.client.from("pool_likes").select("id, user_id");
    expect(visibleToA?.every((l) => l.user_id === a.userId)).toBe(true);
    expect(visibleToA?.length).toBe(1);

    // No INSERT/DELETE grant to authenticated — even a's own like/unlike
    // only ever happens through toggle_pool_like via the service role.
    const { data: insertData } = await a.client
      .from("pool_likes")
      .insert({ pool_id: poolId, user_id: a.userId })
      .select();
    expect(insertData ?? []).toHaveLength(0);

    const { data: deleteData } = await a.client
      .from("pool_likes")
      .delete()
      .eq("pool_id", poolId)
      .eq("user_id", a.userId)
      .select();
    expect(deleteData ?? []).toHaveLength(0);

    expect(await getLikeCount(poolId)).toBe(2);
  });
});
