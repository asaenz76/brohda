/**
 * Integration tests for the stories row (Phase 8 of the Instagram-style
 * redesign): get_stories_row's "new activity since last visit" filtering
 * — a followed user's new entry, a followed admin's new published pool,
 * and the various things that must NOT trigger a bubble (unfollowed
 * users, activity before the threshold, draft pools). Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createTestPlayer(
  email: string,
  role: "player" | "super_admin" = "player",
  balanceCents = 5000,
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role,
    is_active: true,
  });

  if (balanceCents > 0) {
    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: data.user.id,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: balanceCents,
      p_admin_id: null,
      p_reason: "test funding",
      p_idempotency_key: randomUUID(),
    });
  }

  return { userId: data.user.id as string };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `stories-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id as string);
  return data.id as string;
}

async function createTestPool(fixtureId: string, adminId: string, status: string) {
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
      status,
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Home Test FC", sort_order: 0 },
      { pool_id: pool.id, label: "Away Test FC", sort_order: 1 },
    ])
    .select("id");
  if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

  return { poolId: pool.id as string, optionId: options[0].id as string };
}

async function enter(poolId: string, userId: string, optionId: string) {
  const { error } = await admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: 1000,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function follow(followerId: string, followeeId: string) {
  await admin.from("follows").insert({ follower_id: followerId, followee_id: followeeId });
}

const EPOCH = new Date(0).toISOString();

function storiesRow(viewerId: string, since: string) {
  return admin.rpc("get_stories_row", { p_viewer_id: viewerId, p_since: since });
}

describe.skipIf(!SERVICE_ROLE_KEY)("stories row", () => {
  let fixtureId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    await admin.from("fixtures").delete().eq("id", fixtureId);
    await Promise.all(createdUserIds.map(deactivate));
  });

  it("shows a followed player who made a new entry, but not an unfollowed player", async () => {
    const viewer = await createTestPlayer(`stories-viewer-${Date.now()}@example.com`);
    const followed = await createTestPlayer(`stories-followed-${Date.now()}@example.com`);
    const stranger = await createTestPlayer(`stories-stranger-${Date.now()}@example.com`);
    createdUserIds.push(viewer.userId, followed.userId, stranger.userId);

    await follow(viewer.userId, followed.userId);

    const { poolId, optionId } = await createTestPool(fixtureId, followed.userId, "OPEN");
    await enter(poolId, followed.userId, optionId);
    await enter(poolId, stranger.userId, optionId);

    const { data, error } = await storiesRow(viewer.userId, EPOCH);
    expect(error).toBeNull();
    const userIds = data!.map((r: { user_id: string }) => r.user_id);
    expect(userIds).toContain(followed.userId);
    expect(userIds).not.toContain(stranger.userId);
  });

  it("does not show activity that happened before the since threshold", async () => {
    const viewer = await createTestPlayer(`stories-old-viewer-${Date.now()}@example.com`);
    const followed = await createTestPlayer(`stories-old-followed-${Date.now()}@example.com`);
    createdUserIds.push(viewer.userId, followed.userId);

    await follow(viewer.userId, followed.userId);

    const { poolId, optionId } = await createTestPool(fixtureId, followed.userId, "OPEN");
    await enter(poolId, followed.userId, optionId);

    const future = new Date(Date.now() + 60_000).toISOString();
    const { data } = await storiesRow(viewer.userId, future);
    const userIds = data!.map((r: { user_id: string }) => r.user_id);
    expect(userIds).not.toContain(followed.userId);
  });

  it("shows a followed super_admin who published a new (non-draft) pool", async () => {
    const viewer = await createTestPlayer(`stories-admin-viewer-${Date.now()}@example.com`);
    const followedAdmin = await createTestPlayer(
      `stories-followed-admin-${Date.now()}@example.com`,
      "super_admin",
    );
    createdUserIds.push(viewer.userId, followedAdmin.userId);

    await follow(viewer.userId, followedAdmin.userId);
    await createTestPool(fixtureId, followedAdmin.userId, "OPEN");

    const { data } = await storiesRow(viewer.userId, EPOCH);
    const userIds = data!.map((r: { user_id: string }) => r.user_id);
    expect(userIds).toContain(followedAdmin.userId);
  });

  it("does not show a followed admin's still-DRAFT pool", async () => {
    const viewer = await createTestPlayer(`stories-draft-viewer-${Date.now()}@example.com`);
    const followedAdmin = await createTestPlayer(
      `stories-draft-admin-${Date.now()}@example.com`,
      "super_admin",
    );
    createdUserIds.push(viewer.userId, followedAdmin.userId);

    await follow(viewer.userId, followedAdmin.userId);
    await createTestPool(fixtureId, followedAdmin.userId, "DRAFT");

    const { data } = await storiesRow(viewer.userId, EPOCH);
    const userIds = data!.map((r: { user_id: string }) => r.user_id);
    expect(userIds).not.toContain(followedAdmin.userId);
  });
});
