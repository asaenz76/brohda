/**
 * Integration tests for get_pool_totals_bulk/get_pool_participants_bulk
 * (supabase/migrations/20260101000083_pool_totals_participants_bulk.sql) —
 * the functions that replaced getPoolCardViewModels's old per-pool RPC
 * fan-out (2 round trips × N pools) with 2 round trips total. The
 * regression this guards against is silent cross-pool attribution: a bug
 * in the SQL's `group by`/`join` (or a future edit to it) misreporting one
 * pool's totals/participants under a different pool's id.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`) —
 * pointed at LOCAL Supabase only, never .env.local (see lib/pools/fetch.ts
 * for why: that file currently holds production credentials).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

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

  return { userId: data.user.id as string };
}

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `pool-bulk-rpc-test-${randomUUID()}`,
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
const createdUserIds: string[] = [];

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

function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
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

describe.skipIf(!SERVICE_ROLE_KEY)("get_pool_totals_bulk / get_pool_participants_bulk", () => {
  let adminId: string;
  let fixtureId: string;
  let poolA: { poolId: string; optionIds: string[] };
  let poolB: { poolId: string; optionIds: string[] };
  let poolEmpty: { poolId: string; optionIds: string[] };
  let playerA1: { userId: string };
  let playerA2: { userId: string };
  let playerB1: { userId: string };

  beforeAll(async () => {
    adminId = await getAdminId();
    fixtureId = await createTestFixture();

    poolA = await createTestPool(fixtureId, adminId);
    poolB = await createTestPool(fixtureId, adminId);
    poolEmpty = await createTestPool(fixtureId, adminId); // deliberately no entries

    playerA1 = await createTestPlayer(`pool-bulk-a1-${Date.now()}@example.com`, 5000);
    playerA2 = await createTestPlayer(`pool-bulk-a2-${Date.now()}@example.com`, 5000);
    playerB1 = await createTestPlayer(`pool-bulk-b1-${Date.now()}@example.com`, 5000);
    createdUserIds.push(playerA1.userId, playerA2.userId, playerB1.userId);

    // Pool A: two entries totalling 2000. Pool B: one entry of 1000.
    // create_pool_entry rejects any amount that isn't exactly the pool's
    // entry_fee (1000 here), so the distinguishing signal between pools is
    // entry *count*, not amount — still enough to catch a cross-attribution
    // bug (pool A's count/sum leaking into pool B's row or vice versa).
    const entryA1 = await enter(poolA.poolId, playerA1.userId, poolA.optionIds[0]);
    const entryA2 = await enter(poolA.poolId, playerA2.userId, poolA.optionIds[1]);
    const entryB1 = await enter(poolB.poolId, playerB1.userId, poolB.optionIds[0]);
    if (entryA1.error || entryA2.error || entryB1.error) {
      throw entryA1.error ?? entryA2.error ?? entryB1.error;
    }
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    for (const userId of createdUserIds) {
      await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
    }
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("get_pool_totals_bulk attributes each pool's own totals, never a neighbor's", async () => {
    const { data, error } = await admin.rpc("get_pool_totals_bulk", {
      p_pool_ids: [poolA.poolId, poolB.poolId, poolEmpty.poolId],
    });
    expect(error).toBeNull();

    const byPoolId = new Map((data ?? []).map((r: { pool_id: string }) => [r.pool_id, r]));

    expect(byPoolId.get(poolA.poolId)).toMatchObject({ total_entries: 2, gross_pool: 2000 });
    expect(byPoolId.get(poolB.poolId)).toMatchObject({ total_entries: 1, gross_pool: 1000 });
  });

  it("get_pool_totals_bulk returns a real zero-row for a pool with options but no entries (pool_options rows always exist once a pool is created, regardless of entries)", async () => {
    const { data } = await admin.rpc("get_pool_totals_bulk", { p_pool_ids: [poolEmpty.poolId] });
    expect(data).toEqual([{ pool_id: poolEmpty.poolId, total_entries: 0, gross_pool: 0 }]);
  });

  it("get_pool_totals_bulk's per-pool slice matches the single-pool get_pool_totals exactly", async () => {
    const [{ data: bulk }, { data: singleA }, { data: singleB }] = await Promise.all([
      admin.rpc("get_pool_totals_bulk", { p_pool_ids: [poolA.poolId, poolB.poolId] }),
      admin.rpc("get_pool_totals", { p_pool_id: poolA.poolId }),
      admin.rpc("get_pool_totals", { p_pool_id: poolB.poolId }),
    ]);

    const byPoolId = new Map((bulk ?? []).map((r: { pool_id: string }) => [r.pool_id, r]));
    const singleARow = Array.isArray(singleA) ? singleA[0] : singleA;
    const singleBRow = Array.isArray(singleB) ? singleB[0] : singleB;

    expect(byPoolId.get(poolA.poolId)).toMatchObject({
      total_entries: singleARow.total_entries,
      gross_pool: singleARow.gross_pool,
    });
    expect(byPoolId.get(poolB.poolId)).toMatchObject({
      total_entries: singleBRow.total_entries,
      gross_pool: singleBRow.gross_pool,
    });
  });

  it("get_pool_participants_bulk attributes each pool's own participants, never a neighbor's", async () => {
    const { data, error } = await admin.rpc("get_pool_participants_bulk", {
      p_pool_ids: [poolA.poolId, poolB.poolId, poolEmpty.poolId],
    });
    expect(error).toBeNull();

    const participantsByPool = new Map<string, string[]>();
    for (const row of (data ?? []) as { pool_id: string; user_id: string }[]) {
      const list = participantsByPool.get(row.pool_id) ?? [];
      list.push(row.user_id);
      participantsByPool.set(row.pool_id, list);
    }

    expect(new Set(participantsByPool.get(poolA.poolId))).toEqual(
      new Set([playerA1.userId, playerA2.userId]),
    );
    expect(participantsByPool.get(poolB.poolId)).toEqual([playerB1.userId]);
    expect(participantsByPool.has(poolEmpty.poolId)).toBe(false);
  });
});
