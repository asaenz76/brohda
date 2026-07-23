/**
 * Integration tests for pools/entries (spec §13.3's atomic entry flow,
 * §11.3's fee immutability, X.9/X.15's query-layer privacy). Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
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

async function createTestPlayer(email: string, balanceCents = 0) {
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
      external_fixture_id: `pool-test-${randomUUID()}`,
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

// Tracked so afterAll can delete every test pool before deleting the
// fixture — pools/entries aren't append-only (unlike audit_logs/
// wallet_transactions), so real cleanup is possible and expected here.
// Skipping this left dozens of stray pools cluttering the live feed.
const createdPoolIds: string[] = [];

async function createTestPool(
  fixtureId: string,
  adminId: string,
  overrides: Partial<{
    entryFee: number;
    locksAt: string;
    status: string;
    participationVisibility: string;
  }> = {},
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "WHO_WILL_ADVANCE",
      question: "Who will advance?",
      entry_fee: overrides.entryFee ?? 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: overrides.locksAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: overrides.status ?? "OPEN",
      ...(overrides.participationVisibility
        ? { participation_visibility: overrides.participationVisibility }
        : {}),
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

  return { poolId: pool.id as string, optionIds: options.map((o) => o.id as string) };
}

function enter(poolId: string, userId: string, optionId: string, amount = 1000, key?: string) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: key ?? randomUUID(),
  });
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

describe.skipIf(!SERVICE_ROLE_KEY)("pools and entries", () => {
  let adminId: string;
  let fixtureId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    // Only succeeds once no pool still references the fixture — the FK
    // would otherwise silently block this and leave everything behind.
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("creates an entry atomically and debits the wallet", async () => {
    const player = await createTestPlayer(`pool-entry-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    const { data: entry, error } = await enter(poolId, player.userId, optionIds[0]);

    expect(error).toBeNull();
    expect(entry.status).toBe("ACTIVE");

    const { data: balance } = await admin
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .single();
    expect(balance!.balance).toBe(4000);

    const { data: option } = await admin
      .from("pool_options")
      .select("entry_count, total_entry_amount")
      .eq("id", optionIds[0])
      .single();
    expect(option!.entry_count).toBe(1);
    expect(option!.total_entry_amount).toBe(1000);

    await deactivate(player.userId);
  });

  it("is idempotent: replaying the same key never double-enters or double-debits", async () => {
    const player = await createTestPlayer(`pool-idem-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);
    const key = randomUUID();

    const first = await enter(poolId, player.userId, optionIds[0], 1000, key);
    const second = await enter(poolId, player.userId, optionIds[0], 1000, key);

    expect(second.data.id).toBe(first.data.id);

    const { data: balance } = await admin
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .single();
    expect(balance!.balance).toBe(4000);

    await deactivate(player.userId);
  });

  it("returns the existing entry when a second attempt uses a different idempotency key", async () => {
    const player = await createTestPlayer(`pool-dup-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    const first = await enter(poolId, player.userId, optionIds[0]);
    const second = await enter(poolId, player.userId, optionIds[1]);

    // The one-entry-per-pool unique index is the final arbiter — the
    // second attempt never created a new row or a new debit.
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.option_id).toBe(first.data.option_id);

    const { data: balance } = await admin
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .single();
    expect(balance!.balance).toBe(4000);

    await deactivate(player.userId);
  });

  it("serializes concurrent entry attempts for the same user/pool to exactly one entry", async () => {
    const player = await createTestPlayer(`pool-concurrent-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => enter(poolId, player.userId, optionIds[0])),
    );

    const entryIds = new Set(results.map((r) => r.data?.id));
    expect(entryIds.size).toBe(1);

    const { data: balance } = await admin
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .single();
    expect(balance!.balance).toBe(4000);

    const { data: option } = await admin
      .from("pool_options")
      .select("entry_count")
      .eq("id", optionIds[0])
      .single();
    expect(option!.entry_count).toBe(1);

    await deactivate(player.userId);
  });

  it("rejects an entry once the pool is LOCKED", async () => {
    const player = await createTestPlayer(`pool-locked-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId, { status: "LOCKED" });

    const { error } = await enter(poolId, player.userId, optionIds[0]);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("pool_not_open");

    await deactivate(player.userId);
  });

  it("rejects an entry once the lock time has passed, even if status is still OPEN", async () => {
    const player = await createTestPlayer(`pool-pastlock-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId, {
      locksAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const { error } = await enter(poolId, player.userId, optionIds[0]);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("pool_locked");

    await deactivate(player.userId);
  });

  it("enforces fee immutability once an entry exists", async () => {
    const player = await createTestPlayer(`pool-feefreeze-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    await enter(poolId, player.userId, optionIds[0]);

    const { error } = await admin.from("pools").update({ entry_fee: 2000 }).eq("id", poolId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("frozen");

    await deactivate(player.userId);
  });

  it("allows lock time to move earlier, but not later, after the first entry", async () => {
    const player = await createTestPlayer(`pool-lockmove-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    await enter(poolId, player.userId, optionIds[0]);

    const { data: pool } = await admin.from("pools").select("locks_at").eq("id", poolId).single();
    const earlier = new Date(new Date(pool!.locks_at).getTime() - 60_000).toISOString();
    const later = new Date(new Date(pool!.locks_at).getTime() + 60_000).toISOString();

    const earlierResult = await admin.from("pools").update({ locks_at: earlier }).eq("id", poolId);
    expect(earlierResult.error).toBeNull();

    const laterResult = await admin.from("pools").update({ locks_at: later }).eq("id", poolId);
    expect(laterResult.error).not.toBeNull();

    await deactivate(player.userId);
  });

  it("hides per-option distribution pre-entry when a pool is explicitly set to SHOW_AFTER_ENTRY, and reveals it after", async () => {
    const playerA = await createTestPlayer(`pool-privacy-a-${Date.now()}@example.com`, 5000);
    const playerB = await createTestPlayer(`pool-privacy-b-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId, {
      participationVisibility: "SHOW_AFTER_ENTRY",
    });

    const { data: preEntry } = await playerB.client
      .from("pool_options_public")
      .select("entry_count")
      .eq("pool_id", poolId);
    expect(preEntry?.every((o) => o.entry_count === null)).toBe(true);

    await enter(poolId, playerA.userId, optionIds[0]);

    const { data: stillHidden } = await playerB.client
      .from("pool_options_public")
      .select("entry_count")
      .eq("pool_id", poolId);
    expect(stillHidden?.every((o) => o.entry_count === null)).toBe(true);

    await enter(poolId, playerB.userId, optionIds[1]);

    const { data: revealed } = await playerB.client
      .from("pool_options_public")
      .select("entry_count")
      .eq("pool_id", poolId)
      .order("sort_order");
    expect(revealed?.map((o) => o.entry_count)).toEqual([1, 1]);

    await deactivate(playerA.userId);
    await deactivate(playerB.userId);
  });

  it("shows per-option distribution before entry by default (SHOW_BEFORE_ENTRY)", async () => {
    const playerA = await createTestPlayer(`pool-public-a-${Date.now()}@example.com`, 5000);
    const playerB = await createTestPlayer(`pool-public-b-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    const { data: preEntry } = await playerB.client
      .from("pool_options_public")
      .select("entry_count")
      .eq("pool_id", poolId)
      .order("sort_order");
    expect(preEntry?.every((o) => o.entry_count === 0)).toBe(true);

    await enter(poolId, playerA.userId, optionIds[0]);

    const { data: afterEntry } = await playerB.client
      .from("pool_options_public")
      .select("entry_count")
      .eq("pool_id", poolId)
      .order("sort_order");
    expect(afterEntry?.map((o) => o.entry_count)).toEqual([1, 0]);

    await deactivate(playerA.userId);
    await deactivate(playerB.userId);
  });

  it("does not let a player read another player's entry", async () => {
    const playerA = await createTestPlayer(`pool-entryprivacy-a-${Date.now()}@example.com`, 5000);
    const playerB = await createTestPlayer(`pool-entryprivacy-b-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createTestPool(fixtureId, adminId);

    await enter(poolId, playerA.userId, optionIds[0]);

    const { data } = await playerB.client.from("entries").select("*").eq("pool_id", poolId);
    expect(data).toEqual([]);

    await deactivate(playerA.userId);
    await deactivate(playerB.userId);
  });
});
