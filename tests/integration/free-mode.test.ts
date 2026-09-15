/**
 * Integration tests for FREE prediction mode and the global platform
 * capability toggle (FREE_MODE_ARCHITECTURE_PROPOSAL.md §5, §7, §13, §15).
 * Covers: the amount contract (PAID exact-match / FREE reject-non-null),
 * fail-closed capability checks (true/false/missing-row), the entry-time
 * kill switch's in-flight-lifecycle and re-enable behavior for both modes,
 * and — using a raw Postgres connection, since a stateless PostgREST call
 * per RPC invocation cannot hold a transaction open across two sessions —
 * a direct proof that `SELECT ... FOR SHARE` on platform_settings actually
 * linearizes against a concurrent admin UPDATE the way §13 claims.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();

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

async function getProfile(userId: string) {
  const { data } = await admin
    .from("user_profiles")
    .select("current_streak, best_streak, correct_predictions_count")
    .eq("id", userId)
    .single();
  return data as { current_streak: number; best_streak: number; correct_predictions_count: number };
}

const createdPoolIds: string[] = [];
const createdFixtureIds: string[] = [];

async function createTestFixture(): Promise<{ id: string }> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `free-mode-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      internal_status: "LIVE",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id as string);
  return data as { id: string };
}

interface CreatePoolOptions {
  entryMode: "PAID" | "FREE";
  entryFee?: number;
  houseFeeBps?: number;
  minTotalEntries?: number;
}

async function createPool(creatorId: string, fixtureId: string, opts: CreatePoolOptions) {
  const isPaid = opts.entryMode === "PAID";
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "BOTH_TEAMS_TO_SCORE",
      template_config: {},
      question: "test question",
      entry_mode: opts.entryMode,
      entry_fee: isPaid ? (opts.entryFee ?? 1000) : null,
      house_fee_bps: isPaid ? (opts.houseFeeBps ?? 1000) : 0,
      min_total_entries: opts.minTotalEntries ?? 1,
      // Left unset (legacy-parity mode, matching the existing test-suite
      // precedent in advance-or-cancel-locked-pool.test.ts) so a
      // deliberately single-sided single-entrant test pool doesn't trip
      // the unrelated ONE_SIDED_POOL balanced-participation check — these
      // tests are about the capability toggle, not participation balance.
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
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0, binary_outcome: "YES" },
      { pool_id: pool.id, label: "No", sort_order: 1, binary_outcome: "NO" },
    ])
    .select("id, label");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create options");

  return {
    poolId: pool.id as string,
    optionIdByLabel: new Map(optionRows.map((o) => [o.label as string, o.id as string])),
  };
}

function enter(poolId: string, userId: string, optionId: string, amount: number | null) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
  });
}

async function lockAndAdvance(poolId: string) {
  await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
  const { data, error } = await admin.rpc("advance_or_cancel_locked_pool", { p_pool_id: poolId });
  if (error) throw error;
  return data;
}

async function countEntries(poolId: string, userId: string): Promise<number> {
  const { count } = await admin
    .from("entries")
    .select("id", { count: "exact", head: true })
    .eq("pool_id", poolId)
    .eq("user_id", userId);
  return count ?? 0;
}

async function countWalletTransactionsForPool(poolId: string): Promise<number> {
  const { count } = await admin
    .from("wallet_transactions")
    .select("id", { count: "exact", head: true })
    .eq("pool_id", poolId);
  return count ?? 0;
}

async function setCapability(paid: boolean | undefined, free: boolean | undefined) {
  const update: Record<string, boolean> = {};
  if (paid !== undefined) update.paid_pools_enabled = paid;
  if (free !== undefined) update.free_pools_enabled = free;
  const { error } = await admin.from("platform_settings").update(update).eq("id", true);
  if (error) throw error;
}

describe.skipIf(!process.env.TEST_SUPABASE_SERVICE_ROLE_KEY)("FREE prediction mode", () => {
  let adminId: string;
  const players: string[] = [];

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterEach(async () => {
    // Every test must leave the platform in its default state for the
    // next one — integration tests run sequentially (fileParallelism:
    // false) but share one real database.
    await setCapability(true, true);
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
    for (const userId of players) {
      await deactivate(userId);
    }
  });

  describe("amount contract (Decision 3)", () => {
    it("creates a FREE entry with amount = null and writes zero wallet_transactions rows", async () => {
      const p1 = await createTestPlayer(`free-amount-null-${randomUUID()}@example.com`);
      players.push(p1.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, { entryMode: "FREE" });

      const { data: entry, error } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, null);
      expect(error).toBeNull();
      expect(entry.amount).toBeNull();
      expect(await countWalletTransactionsForPool(poolId)).toBe(0);
    });

    it("rejects a non-null amount on a FREE pool, including 0, and creates no entry row", async () => {
      const p1 = await createTestPlayer(`free-amount-reject-${randomUUID()}@example.com`);
      players.push(p1.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, { entryMode: "FREE" });

      const { error: nonZeroError } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, 500);
      expect(nonZeroError?.message).toContain("amount_not_allowed_for_free_pool");

      const { error: zeroError } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, 0);
      expect(zeroError?.message).toContain("amount_not_allowed_for_free_pool");

      expect(await countEntries(poolId, p1.userId)).toBe(0);
    });

    it("rejects a null amount on a PAID pool (amount_mismatch), closing the previously-implicit NULL-comparison gap", async () => {
      const p1 = await createTestPlayer(`paid-amount-null-${randomUUID()}@example.com`);
      players.push(p1.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, { entryMode: "PAID", entryFee: 1000 });

      const { error } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, null);
      expect(error?.message).toContain("amount_mismatch");
      expect(await countEntries(poolId, p1.userId)).toBe(0);
    });

    it("still accepts a correctly-matching PAID amount (regression proof for the tightened guard)", async () => {
      const p1 = await createTestPlayer(`paid-amount-ok-${randomUUID()}@example.com`);
      players.push(p1.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, { entryMode: "PAID", entryFee: 1000 });

      const { error } = await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, 1000);
      expect(error).toBeNull();
      expect(await countEntries(poolId, p1.userId)).toBe(1);
    });
  });

  describe("fail-closed capability checks", () => {
    it("true (enabled) allows an entry, for both modes", async () => {
      const paid = await createTestPlayer(`fc-paid-true-${randomUUID()}@example.com`);
      const free = await createTestPlayer(`fc-free-true-${randomUUID()}@example.com`);
      players.push(paid.userId, free.userId);
      const fixture = await createTestFixture();

      await setCapability(true, true);
      const paidPool = await createPool(adminId, fixture.id, { entryMode: "PAID", entryFee: 500 });
      const freePool = await createPool(adminId, fixture.id, { entryMode: "FREE" });

      expect((await enter(paidPool.poolId, paid.userId, paidPool.optionIdByLabel.get("Yes")!, 500)).error).toBeNull();
      expect((await enter(freePool.poolId, free.userId, freePool.optionIdByLabel.get("Yes")!, null)).error).toBeNull();
    });

    it("false (disabled) blocks an entry, for both modes, with the correctly-named exception", async () => {
      const paid = await createTestPlayer(`fc-paid-false-${randomUUID()}@example.com`);
      const free = await createTestPlayer(`fc-free-false-${randomUUID()}@example.com`);
      players.push(paid.userId, free.userId);
      const fixture = await createTestFixture();
      const paidPool = await createPool(adminId, fixture.id, { entryMode: "PAID", entryFee: 500 });
      const freePool = await createPool(adminId, fixture.id, { entryMode: "FREE" });

      await setCapability(false, false);

      const paidResult = await enter(paidPool.poolId, paid.userId, paidPool.optionIdByLabel.get("Yes")!, 500);
      expect(paidResult.error?.message).toContain("paid_pools_disabled");
      const freeResult = await enter(freePool.poolId, free.userId, freePool.optionIdByLabel.get("Yes")!, null);
      expect(freeResult.error?.message).toContain("free_pools_disabled");
    });

    it("a missing platform_settings row blocks entries for both modes with platform_settings_missing", async () => {
      const paid = await createTestPlayer(`fc-missing-paid-${randomUUID()}@example.com`);
      const free = await createTestPlayer(`fc-missing-free-${randomUUID()}@example.com`);
      players.push(paid.userId, free.userId);
      const fixture = await createTestFixture();
      const paidPool = await createPool(adminId, fixture.id, { entryMode: "PAID", entryFee: 500 });
      const freePool = await createPool(adminId, fixture.id, { entryMode: "FREE" });

      // platform_settings intentionally grants service_role only SELECT and
      // UPDATE (no DELETE/INSERT — see 20260101000050_platform_settings.sql)
      // so this simulation needs a superuser connection, not the app's own
      // service-role client, to remove and restore the singleton row.
      const superuser = new Client({ connectionString: getTestDatabaseUrl() });
      await superuser.connect();
      const { rows } = await superuser.query('select * from public.platform_settings where id = true');
      const savedRow = rows[0];
      try {
        await superuser.query('delete from public.platform_settings where id = true');

        const paidResult = await enter(paidPool.poolId, paid.userId, paidPool.optionIdByLabel.get("Yes")!, 500);
        expect(paidResult.error?.message).toContain("platform_settings_missing");
        const freeResult = await enter(freePool.poolId, free.userId, freePool.optionIdByLabel.get("Yes")!, null);
        expect(freeResult.error?.message).toContain("platform_settings_missing");
      } finally {
        // Restore exactly, including columns unrelated to this feature
        // (registration_enabled, fee defaults) — this row is shared with
        // every other test file.
        const columns = Object.keys(savedRow);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        await superuser.query(
          `insert into public.platform_settings (${columns.join(", ")}) values (${placeholders})`,
          columns.map((c) => savedRow[c]),
        );
        await superuser.end();
      }
    });

    it("paid_pools_enabled/free_pools_enabled cannot be set to NULL (schema-level backstop for the defensive IS DISTINCT FROM TRUE check)", async () => {
      const { error } = await admin.from("platform_settings").update({ paid_pools_enabled: null }).eq("id", true);
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toContain("null");
    });
  });

  describe("global toggle — PAID, in-flight lifecycle (Test A)", () => {
    it("blocks a new entry once disabled, leaves the existing entries and pool lifecycle untouched, and settles correctly", async () => {
      const winner = await createTestPlayer(`toggle-paid-a-winner-${randomUUID()}@example.com`, 5000);
      const loser = await createTestPlayer(`toggle-paid-a-loser-${randomUUID()}@example.com`, 5000);
      const blocked = await createTestPlayer(`toggle-paid-a-blocked-${randomUUID()}@example.com`, 5000);
      players.push(winner.userId, loser.userId, blocked.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, {
        entryMode: "PAID",
        entryFee: 1000,
        houseFeeBps: 1000,
        minTotalEntries: 1,
      });
      const yesId = optionIdByLabel.get("Yes")!;
      const noId = optionIdByLabel.get("No")!;

      const { error: winnerEnterError } = await enter(poolId, winner.userId, yesId, 1000);
      expect(winnerEnterError).toBeNull();
      const { error: loserEnterError } = await enter(poolId, loser.userId, noId, 1000);
      expect(loserEnterError).toBeNull();

      await setCapability(false, undefined);

      const { error: blockedError } = await enter(poolId, blocked.userId, yesId, 1000);
      expect(blockedError?.message).toContain("paid_pools_disabled");
      expect(await countEntries(poolId, blocked.userId)).toBe(0);
      expect(await countWalletTransactionsForPool(poolId)).toBe(2); // only the two real debits

      expect(await countEntries(poolId, winner.userId)).toBe(1);
      expect(await countEntries(poolId, loser.userId)).toBe(1);

      // Pool proceeds through lock -> grade -> settle entirely while the
      // toggle remains off — proving grading/settlement never consult it.
      const advanced = await lockAndAdvance(poolId);
      expect(advanced.status).toBe("AWAITING_RESULT");

      const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
      expect(settlement.requires_manual_verification).toBe(true);

      const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
        p_pool_id: poolId,
        p_admin_id: adminId,
        p_grading_version: settlement.grading_version,
        p_idempotency_key: randomUUID(),
        p_winning_option_id: yesId,
      });
      expect(confirmError).toBeNull();

      // Gross 2000, 10% house fee -> 1800 net, sole winner -> full 1800 payout.
      expect(await getBalance(winner.userId)).toBe(5000 - 1000 + 1800);
      expect(await getBalance(loser.userId)).toBe(5000 - 1000);
      const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
      expect(pool!.status).toBe("SETTLED");
    });
  });

  describe("global toggle — PAID, re-enable (Test B, a separate pool)", () => {
    it("rejects an entry while disabled, then accepts it once re-enabled, with an exact wallet debit", async () => {
      const player = await createTestPlayer(`toggle-paid-b-${randomUUID()}@example.com`, 5000);
      players.push(player.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, {
        entryMode: "PAID",
        entryFee: 750,
        minTotalEntries: 1,
      });
      const yesId = optionIdByLabel.get("Yes")!;

      await setCapability(false, undefined);
      const { error: blockedError } = await enter(poolId, player.userId, yesId, 750);
      expect(blockedError?.message).toContain("paid_pools_disabled");
      expect(await countEntries(poolId, player.userId)).toBe(0);

      await setCapability(true, undefined);
      const before = await getBalance(player.userId);
      const { error: successError } = await enter(poolId, player.userId, yesId, 750);
      expect(successError).toBeNull();
      expect(await getBalance(player.userId)).toBe(before - 750);

      const { data: tx } = await admin
        .from("wallet_transactions")
        .select("amount")
        .eq("pool_id", poolId)
        .eq("type", "pool_entry_debit")
        .single();
      expect(tx!.amount).toBe(750);
    });
  });

  describe("global toggle — FREE, in-flight lifecycle (Test A)", () => {
    it("blocks a new prediction once disabled, leaves the existing predictions and grading untouched", async () => {
      const winner = await createTestPlayer(`toggle-free-a-winner-${randomUUID()}@example.com`);
      const loser = await createTestPlayer(`toggle-free-a-loser-${randomUUID()}@example.com`);
      const blocked = await createTestPlayer(`toggle-free-a-blocked-${randomUUID()}@example.com`);
      players.push(winner.userId, loser.userId, blocked.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, {
        entryMode: "FREE",
        minTotalEntries: 1,
      });
      const yesId = optionIdByLabel.get("Yes")!;
      const noId = optionIdByLabel.get("No")!;

      const { error: winnerEnterError } = await enter(poolId, winner.userId, yesId, null);
      expect(winnerEnterError).toBeNull();
      const { error: loserEnterError } = await enter(poolId, loser.userId, noId, null);
      expect(loserEnterError).toBeNull();

      await setCapability(undefined, false);

      const { error: blockedError } = await enter(poolId, blocked.userId, yesId, null);
      expect(blockedError?.message).toContain("free_pools_disabled");
      expect(await countEntries(poolId, blocked.userId)).toBe(0);

      const profileBefore = await getProfile(winner.userId);

      const advanced = await lockAndAdvance(poolId);
      expect(advanced.status).toBe("AWAITING_RESULT");

      const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
      expect(settlement.requires_manual_verification).toBe(true);

      const { error: gradeError } = await admin.rpc("confirm_pool_grading_only", {
        p_pool_id: poolId,
        p_admin_id: adminId,
        p_grading_version: settlement.grading_version,
        p_idempotency_key: randomUUID(),
        p_winning_option_id: yesId,
      });
      expect(gradeError).toBeNull();
      expect(await countWalletTransactionsForPool(poolId)).toBe(0); // never any money

      const { data: winnerEntry } = await admin
        .from("entries")
        .select("status")
        .eq("pool_id", poolId)
        .eq("user_id", winner.userId)
        .single();
      expect(winnerEntry!.status).toBe("WON");

      const profileAfter = await getProfile(winner.userId);
      expect(profileAfter.current_streak).toBe(profileBefore.current_streak + 1);
      expect(profileAfter.correct_predictions_count).toBe(profileBefore.correct_predictions_count + 1);

      const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
      expect(pool!.status).toBe("SETTLED");
    });
  });

  describe("global toggle — FREE, re-enable (Test B, a separate pool)", () => {
    it("rejects a prediction while disabled, then accepts it once re-enabled", async () => {
      const player = await createTestPlayer(`toggle-free-b-${randomUUID()}@example.com`);
      players.push(player.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, {
        entryMode: "FREE",
        minTotalEntries: 1,
      });
      const yesId = optionIdByLabel.get("Yes")!;

      await setCapability(undefined, false);
      const { error: blockedError } = await enter(poolId, player.userId, yesId, null);
      expect(blockedError?.message).toContain("free_pools_disabled");

      await setCapability(undefined, true);
      const { data: entry, error: successError } = await enter(poolId, player.userId, yesId, null);
      expect(successError).toBeNull();
      expect(entry.amount).toBeNull();
    });
  });

  describe("void_pool_no_refund dispatch (below-minimum FREE pool at lock time)", () => {
    it("cancels a below-minimum FREE pool with zero wallet activity, unlike confirm_pool_refund", async () => {
      const p1 = await createTestPlayer(`free-void-${randomUUID()}@example.com`);
      players.push(p1.userId);
      const fixture = await createTestFixture();
      const { poolId, optionIdByLabel } = await createPool(adminId, fixture.id, {
        entryMode: "FREE",
        minTotalEntries: 2,
      });

      await enter(poolId, p1.userId, optionIdByLabel.get("Yes")!, null);
      const advanced = await lockAndAdvance(poolId);

      expect(advanced.status).toBe("CANCELLED");
      expect(advanced.void_reason).toBe("MINIMUM_ENTRIES_NOT_REACHED");
      expect(await countWalletTransactionsForPool(poolId)).toBe(0);

      const { data: entry } = await admin
        .from("entries")
        .select("status")
        .eq("pool_id", poolId)
        .eq("user_id", p1.userId)
        .single();
      expect(entry!.status).toBe("VOID");
    });
  });
});

describe.skipIf(!process.env.TEST_SUPABASE_SERVICE_ROLE_KEY)("toggle/entry linearization (FOR SHARE proof)", () => {
  // This suite drives the exact SQL statement create_pool_entry's
  // capability gate uses (`SELECT paid_pools_enabled, free_pools_enabled
  // FROM platform_settings WHERE id = true FOR SHARE`) against two
  // independently-held raw Postgres connections, rather than instrumenting
  // the RPC itself — the RPC is one opaque, atomic function call from
  // PostgREST's point of view, so there is no way to pause it mid-execution
  // through the REST API. Testing the literal lock primitive the RPC
  // depends on, in the same statement form, against the same row, under
  // the same default isolation level (READ COMMITTED), is a faithful proof
  // of the mechanism §13 claims — see FREE_MODE_ARCHITECTURE_PROPOSAL.md's
  // TOGGLE/ENTRY SERIALIZATION DESIGN.
  let conn1: Client;
  let conn2: Client;

  beforeAll(async () => {
    const connectionString = getTestDatabaseUrl();
    conn1 = new Client({ connectionString });
    conn2 = new Client({ connectionString });
    await conn1.connect();
    await conn2.connect();
  });

  afterAll(async () => {
    await admin.from("platform_settings").update({ paid_pools_enabled: true }).eq("id", true);
    await conn1.end();
    await conn2.end();
  });

  it("Case A — a FOR SHARE reader that started first blocks a concurrent UPDATE until it commits", async () => {
    await admin.from("platform_settings").update({ paid_pools_enabled: true }).eq("id", true);

    await conn1.query("BEGIN");
    const readResult = await conn1.query(
      "SELECT paid_pools_enabled FROM public.platform_settings WHERE id = true FOR SHARE",
    );
    expect(readResult.rows[0].paid_pools_enabled).toBe(true);

    let updateResolved = false;
    const updatePromise = conn2
      .query("UPDATE public.platform_settings SET paid_pools_enabled = false WHERE id = true")
      .then(() => {
        updateResolved = true;
      });

    // Give the UPDATE every chance to (wrongly) complete immediately if the
    // FOR SHARE lock weren't actually blocking it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(updateResolved).toBe(false);

    await conn1.query("COMMIT");
    await updatePromise;
    expect(updateResolved).toBe(true);

    const { data } = await admin.from("platform_settings").select("paid_pools_enabled").eq("id", true).single();
    expect(data!.paid_pools_enabled).toBe(false);
  });

  it("Case B — an UPDATE that already committed is immediately visible to a subsequent FOR SHARE read, no stale snapshot", async () => {
    await admin.from("platform_settings").update({ paid_pools_enabled: true }).eq("id", true);

    await conn2.query("UPDATE public.platform_settings SET paid_pools_enabled = false WHERE id = true");

    await conn1.query("BEGIN");
    const readResult = await conn1.query(
      "SELECT paid_pools_enabled FROM public.platform_settings WHERE id = true FOR SHARE",
    );
    expect(readResult.rows[0].paid_pools_enabled).toBe(false);
    await conn1.query("COMMIT");
  });
});
