/**
 * Integration tests for the atomic `advance_or_cancel_locked_pool` RPC —
 * replaces lockDuePools()'s/advanceLockedPoolAction's previous two-round-trip
 * below-minimum decision with one row-locked read-decide-act SQL function.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createTestPlayer(email: string, balanceCents = 5000) {
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

  return { userId: data.user.id as string };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  return data!.balance as number;
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

const createdPoolIds: string[] = [];
const createdFixtureIds: string[] = [];

async function createTestFixture(): Promise<{ id: string }> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `advance-rpc-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      internal_status: "LIVE",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data as { id: string };
}

interface CreatePoolOptions {
  minTotalEntries?: number;
  participationRuleVersion?: number | null;
  /** Option shapes as {label, binaryOutcome}. Defaults to a clean Yes/No pair. */
  options?: Array<{ label: string; binaryOutcome: "YES" | "NO" | null }>;
}

async function createLockablePool(creatorId: string, fixtureId: string, opts: CreatePoolOptions = {}) {
  const options = opts.options ?? [
    { label: "Yes", binaryOutcome: "YES" as const },
    { label: "No", binaryOutcome: "NO" as const },
  ];

  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "BOTH_TEAMS_TO_SCORE",
      template_config: {},
      question: "test question",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: opts.minTotalEntries ?? 2,
      // `??` would collapse an explicit `null` override (legacy-parity
      // test) back to the default 2 — `in` treats "not passed" and
      // "passed as null" differently, which is exactly what's needed here.
      participation_rule_version: "participationRuleVersion" in opts ? opts.participationRuleVersion : 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert(
      options.map((o, i) => ({
        pool_id: pool.id,
        label: o.label,
        sort_order: i,
        binary_outcome: o.binaryOutcome,
      })),
    )
    .select("id, label");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create options");

  return {
    poolId: pool.id as string,
    optionIdByLabel: new Map(optionRows.map((o) => [o.label as string, o.id as string])),
  };
}

function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
  });
}

async function lock(poolId: string) {
  await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
}

function advance(poolId: string, adminId?: string) {
  return admin.rpc("advance_or_cancel_locked_pool", {
    p_pool_id: poolId,
    ...(adminId ? { p_admin_id: adminId } : {}),
  });
}

describe.skipIf(!SERVICE_ROLE_KEY)("advance_or_cancel_locked_pool", () => {
  let adminId: string;
  const players: string[] = [];

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
    for (const userId of players) {
      await deactivate(userId);
    }
  });

  it("cancels below-minimum entries (MINIMUM_ENTRIES_NOT_REACHED) and refunds in full", async () => {
    const p1 = await createTestPlayer(`advance-rpc-min-${randomUUID()}@example.com`);
    players.push(p1.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, {
      minTotalEntries: 2,
    });

    const { error: enterError } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    expect(enterError).toBeNull();

    await lock(poolId);
    const before = await getBalance(p1.userId);

    const { data: updated, error } = await advance(poolId);
    expect(error).toBeNull();
    expect(updated.status).toBe("CANCELLED");
    expect(updated.void_reason).toBe("MINIMUM_ENTRIES_NOT_REACHED");
    expect(await getBalance(p1.userId)).toBe(before + 1000);
  });

  it("advances a balanced two-sided pool to AWAITING_RESULT", async () => {
    const p1 = await createTestPlayer(`advance-rpc-two-a-${randomUUID()}@example.com`);
    const p2 = await createTestPlayer(`advance-rpc-two-b-${randomUUID()}@example.com`);
    players.push(p1.userId, p2.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, { minTotalEntries: 2 });

    await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    await enter(poolId, p2.userId, optionIdByLabel.get("No")!);
    await lock(poolId);

    const { data: updated, error } = await advance(poolId);
    expect(error).toBeNull();
    expect(updated.status).toBe("AWAITING_RESULT");
  });

  it("cancels a one-sided TEMPLATE_GRADED pool (ONE_SIDED_POOL) even with enough total entries", async () => {
    const p1 = await createTestPlayer(`advance-rpc-onesided-a-${randomUUID()}@example.com`);
    const p2 = await createTestPlayer(`advance-rpc-onesided-b-${randomUUID()}@example.com`);
    players.push(p1.userId, p2.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, { minTotalEntries: 2 });

    // Both entries land on YES — total (2) clears min_total_entries, but
    // there's no genuine two-sided market.
    await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    await enter(poolId, p2.userId, optionIdByLabel.get("Yes")!);
    await lock(poolId);

    const before1 = await getBalance(p1.userId);
    const before2 = await getBalance(p2.userId);

    const { data: updated, error } = await advance(poolId);
    expect(error).toBeNull();
    expect(updated.status).toBe("CANCELLED");
    expect(updated.void_reason).toBe("ONE_SIDED_POOL");
    expect(await getBalance(p1.userId)).toBe(before1 + 1000);
    expect(await getBalance(p2.userId)).toBe(before2 + 1000);
  });

  it("routes to MANUAL_REVIEW (BINARY_OPTIONS_UNRESOLVABLE) when options don't resolve to exactly one YES and one NO", async () => {
    const p1 = await createTestPlayer(`advance-rpc-unresolvable-a-${randomUUID()}@example.com`);
    const p2 = await createTestPlayer(`advance-rpc-unresolvable-b-${randomUUID()}@example.com`);
    players.push(p1.userId, p2.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    // Two options, neither with a binary_outcome — simulates corrupted/
    // legacy data on a pool nonetheless stamped participation_rule_version=2.
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, {
      minTotalEntries: 2,
      options: [
        { label: "Yes", binaryOutcome: null },
        { label: "No", binaryOutcome: null },
      ],
    });

    await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    await enter(poolId, p2.userId, optionIdByLabel.get("No")!);
    await lock(poolId);

    const before1 = await getBalance(p1.userId);
    const before2 = await getBalance(p2.userId);

    const { data: updated, error } = await advance(poolId);
    expect(error).toBeNull();
    expect(updated.status).toBe("MANUAL_REVIEW");
    expect(updated.review_reason).toBe("BINARY_OPTIONS_UNRESOLVABLE");
    // Funds are preserved — no refund happens on routing to manual review.
    expect(await getBalance(p1.userId)).toBe(before1);
    expect(await getBalance(p2.userId)).toBe(before2);
  });

  it("is idempotent — calling it again on an already-cancelled pool is a no-op", async () => {
    const p1 = await createTestPlayer(`advance-rpc-idem-${randomUUID()}@example.com`);
    players.push(p1.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, { minTotalEntries: 2 });

    await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    await lock(poolId);

    const first = await advance(poolId);
    expect(first.data.status).toBe("CANCELLED");
    const balanceAfterFirst = await getBalance(p1.userId);

    const second = await advance(poolId);
    expect(second.error).toBeNull();
    expect(second.data.status).toBe("CANCELLED");
    expect(await getBalance(p1.userId)).toBe(balanceAfterFirst);
  });

  it("legacy parity (participation_rule_version null): a one-sided pool with enough entries still advances", async () => {
    const p1 = await createTestPlayer(`advance-rpc-legacy-a-${randomUUID()}@example.com`);
    const p2 = await createTestPlayer(`advance-rpc-legacy-b-${randomUUID()}@example.com`);
    players.push(p1.userId, p2.userId);

    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, optionIdByLabel } = await createLockablePool(adminId, fixture.id, {
      minTotalEntries: 2,
      participationRuleVersion: null,
    });

    // Both entries on YES — old behavior never checked per-side
    // distribution, only the aggregate total against min_total_entries.
    await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!);
    await enter(poolId, p2.userId, optionIdByLabel.get("Yes")!);
    await lock(poolId);

    const { data: updated, error } = await advance(poolId);
    expect(error).toBeNull();
    expect(updated.status).toBe("AWAITING_RESULT");
  });
});
