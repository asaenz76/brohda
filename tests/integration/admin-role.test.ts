/**
 * Integration tests for the distinct, lower-privileged `admin` role: full
 * admin-panel visibility (all pools incl. DRAFT, all entries, invitations,
 * comment moderation) but no money visibility (wallet_balances/
 * wallet_transactions/wallet_requests for other users stay RLS-blocked).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
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

async function createTestUser(email: string, role: "player" | "admin" | "super_admin") {
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

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (signInError) throw signInError;

  return { userId: data.user.id as string, client };
}

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `admin-role-test-${randomUUID()}`,
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

async function createTestPool(
  fixtureId: string,
  creatorId: string,
  status: "DRAFT" | "OPEN" = "OPEN",
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
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
  return pool.id as string;
}

describe.skipIf(!SERVICE_ROLE_KEY)("admin role", () => {
  let superAdmin: Awaited<ReturnType<typeof createTestUser>>;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let player: Awaited<ReturnType<typeof createTestUser>>;
  let fixtureId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const suffix = Date.now();
    superAdmin = await createTestUser(`admin-role-super-${suffix}@example.com`, "super_admin");
    adminUser = await createTestUser(`admin-role-admin-${suffix}@example.com`, "admin");
    player = await createTestUser(`admin-role-player-${suffix}@example.com`, "player");
    createdUserIds.push(superAdmin.userId, adminUser.userId, player.userId);
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    // wallet_transactions is append-only — service_role has no delete grant
    // on it at all, so once the "entries" test below writes a row for
    // `player` via apply_wallet_transaction, that user can never be
    // hard-deleted (pools.test.ts/settlements.test.ts hit the same wall and
    // deactivate their wallet-touched users instead, same as here). Every
    // other getAdminId() in this suite now filters on is_active = true
    // (fixed alongside this test), so leaving these rows deactivated
    // doesn't risk another file's cleanup picking one of them.
    if (createdPoolIds.length > 0) {
      await admin.from("pool_comments").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    await admin.from("invitations").delete().in("invited_by", createdUserIds);
    await Promise.all(
      createdUserIds.map((id) => admin.from("user_profiles").update({ is_active: false }).eq("id", id)),
    );
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("is_admin_or_above is true and is_super_admin is false for an 'admin' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: adminUser.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: adminUser.userId });
    expect(adminOrAbove).toBe(true);
    expect(superAdminCheck).toBe(false);
  });

  it("is_admin_or_above and is_super_admin are both true for a 'super_admin' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: superAdmin.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: superAdmin.userId });
    expect(adminOrAbove).toBe(true);
    expect(superAdminCheck).toBe(true);
  });

  it("is_admin_or_above and is_super_admin are both false for a 'player' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: player.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: player.userId });
    expect(adminOrAbove).toBe(false);
    expect(superAdminCheck).toBe(false);
  });

  it("lets an admin read a DRAFT pool that a plain player cannot see", async () => {
    const poolId = await createTestPool(fixtureId, superAdmin.userId, "DRAFT");

    const { data: visibleToAdmin } = await adminUser.client
      .from("pools")
      .select("id, status")
      .eq("id", poolId)
      .maybeSingle();
    expect(visibleToAdmin?.id).toBe(poolId);

    const { data: visibleToPlayer } = await player.client
      .from("pools")
      .select("id, status")
      .eq("id", poolId)
      .maybeSingle();
    expect(visibleToPlayer).toBeNull();
  });

  it("lets an admin read entries on any pool", async () => {
    const poolId = await createTestPool(fixtureId, superAdmin.userId, "OPEN");
    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: poolId, label: "Home Test FC", sort_order: 0 },
        { pool_id: poolId, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: player.userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: 5000,
      p_admin_id: player.userId,
      p_reason: "admin-role test seed balance",
      p_idempotency_key: randomUUID(),
    });
    const { error: entryError } = await admin.rpc("create_pool_entry", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_option_id: options[0].id,
      p_amount: 1000,
      p_idempotency_key: randomUUID(),
    });
    expect(entryError).toBeNull();

    const { data: visibleToAdmin } = await adminUser.client
      .from("entries")
      .select("id, pool_id")
      .eq("pool_id", poolId);
    expect(visibleToAdmin?.length).toBe(1);
  });

  it("lets an admin read the invitations table", async () => {
    await admin.from("invitations").insert({
      email: `invite-target-${Date.now()}@example.com`,
      invited_by: superAdmin.userId,
    });

    const { data, error } = await adminUser.client.from("invitations").select("id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  // Mirrors the exact query app/(admin)/admin/users/page.tsx runs: scoped
  // by .eq("invited_by", viewer.id) for a plain 'admin' viewer, unfiltered
  // for super_admin. select_all_profiles_as_admin (RLS) lets an 'admin'
  // read any profile row, so the scoping has to come from the query itself,
  // not from what RLS blocks — this confirms that query actually narrows
  // the result set rather than relying on RLS to do it.
  it("admin/users scoping: a plain admin only sees users they invited/created, super_admin sees all", async () => {
    const suffix = Date.now();
    const adminA = await createTestUser(`admin-role-scope-a-${suffix}@example.com`, "admin");
    const adminB = await createTestUser(`admin-role-scope-b-${suffix}@example.com`, "admin");
    createdUserIds.push(adminA.userId, adminB.userId);

    const { data: authA } = await admin.auth.admin.createUser({
      email: `admin-role-scope-playera-${suffix}@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
    const { data: authB } = await admin.auth.admin.createUser({
      email: `admin-role-scope-playerb-${suffix}@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
    const playerAId = authA!.user!.id;
    const playerBId = authB!.user!.id;
    createdUserIds.push(playerAId, playerBId);

    await admin.from("user_profiles").insert([
      {
        id: playerAId,
        display_name: "PlayerOwnedByA",
        role: "player",
        is_active: true,
        invited_by: adminA.userId,
      },
      {
        id: playerBId,
        display_name: "PlayerOwnedByB",
        role: "player",
        is_active: true,
        invited_by: adminB.userId,
      },
    ]);

    const { data: adminAView } = await adminA.client
      .from("user_profiles")
      .select("id")
      .eq("invited_by", adminA.userId)
      .in("id", [playerAId, playerBId]);
    expect((adminAView ?? []).map((u) => u.id)).toEqual([playerAId]);

    const { data: superAdminView } = await superAdmin.client
      .from("user_profiles")
      .select("id")
      .in("id", [playerAId, playerBId]);
    expect((superAdminView ?? []).map((u) => u.id).sort()).toEqual([playerAId, playerBId].sort());
  });

  it("lets an admin delete another user's comment via delete_pool_comment", async () => {
    const poolId = await createTestPool(fixtureId, superAdmin.userId, "OPEN");
    const { data: row } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "admin should be able to remove this",
    });
    const comment = Array.isArray(row) ? row[0] : row;

    const { error } = await admin.rpc("delete_pool_comment", {
      p_comment_id: comment.id,
      p_user_id: adminUser.userId,
    });
    expect(error).toBeNull();

    const { data: pool } = await admin
      .from("pools")
      .select("comment_count")
      .eq("id", poolId)
      .single();
    expect(pool?.comment_count).toBe(0);
  });

  it("blocks an admin from reading another user's wallet_balances row via RLS", async () => {
    const { data } = await adminUser.client
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("blocks an admin from reading another user's wallet_transactions via RLS", async () => {
    const { data } = await adminUser.client
      .from("wallet_transactions")
      .select("id")
      .eq("user_id", player.userId);
    expect(data).toEqual([]);
  });

  it("blocks an admin from reading another user's wallet_requests via RLS", async () => {
    await admin.from("wallet_requests").insert({
      user_id: player.userId,
      type: "deposit",
      amount: 500,
    });

    const { data } = await adminUser.client
      .from("wallet_requests")
      .select("id")
      .eq("user_id", player.userId);
    expect(data).toEqual([]);
  });

  it("rejects create_pool_entry for an admin", async () => {
    const poolId = await createTestPool(fixtureId, superAdmin.userId, "OPEN");
    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: poolId, label: "Home Test FC", sort_order: 0 },
        { pool_id: poolId, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

    const { error } = await admin.rpc("create_pool_entry", {
      p_pool_id: poolId,
      p_user_id: adminUser.userId,
      p_option_id: options[0].id,
      p_amount: 1000,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("admin_cannot_enter_pool");

    const { data: entries } = await admin.from("entries").select("id").eq("pool_id", poolId);
    expect(entries).toEqual([]);
  });

  it("rejects create_pool_entry for a super_admin", async () => {
    const poolId = await createTestPool(fixtureId, superAdmin.userId, "OPEN");
    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: poolId, label: "Home Test FC", sort_order: 0 },
        { pool_id: poolId, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

    const { error } = await admin.rpc("create_pool_entry", {
      p_pool_id: poolId,
      p_user_id: superAdmin.userId,
      p_option_id: options[0].id,
      p_amount: 1000,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("admin_cannot_enter_pool");
  });
});
