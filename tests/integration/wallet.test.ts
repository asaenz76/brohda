/**
 * Integration tests for the wallet ledger (spec §8) against a real local
 * Supabase instance. This is the explicit gate spec §23 calls out: "No pool
 * features until wallet concurrency tests pass."
 *
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

async function createTestPlayer(email: string): Promise<string> {
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

  return data.user.id;
}

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin
    .from("wallet_balances")
    .select("balance")
    .eq("user_id", userId)
    .single();
  return data!.balance;
}

function applyTransaction(params: {
  userId: string;
  type: "manual_deposit" | "manual_withdrawal";
  direction: "credit" | "debit";
  amount: number;
  idempotencyKey?: string;
}) {
  return admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: params.userId,
    p_type: params.type,
    p_direction: params.direction,
    p_amount: params.amount,
    p_admin_id: params.userId,
    p_reason: "integration test",
    p_idempotency_key: params.idempotencyKey ?? randomUUID(),
  });
}

describe.skipIf(!SERVICE_ROLE_KEY)("wallet ledger", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await createTestPlayer(`wallet-test-${Date.now()}@example.com`);
  });

  afterAll(async () => {
    // wallet_transactions is append-only (a trigger blocks DELETE
    // unconditionally, even for service_role) — this user now has ledger
    // rows and can never be hard-deleted, by design. Deactivate instead of
    // attempting deleteUser, which would fail on the FK anyway.
    await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
  });

  it("starts every new profile at a zero balance", async () => {
    expect(await getBalance(userId)).toBe(0);
  });

  it("credits a deposit atomically", async () => {
    const { data, error } = await applyTransaction({
      userId,
      type: "manual_deposit",
      direction: "credit",
      amount: 5000,
    });
    expect(error).toBeNull();
    expect(data.balance_before).toBe(0);
    expect(data.balance_after).toBe(5000);
    expect(await getBalance(userId)).toBe(5000);
  });

  it("is idempotent: replaying the same key never double-applies", async () => {
    const key = randomUUID();
    const first = await applyTransaction({
      userId,
      type: "manual_deposit",
      direction: "credit",
      amount: 1000,
      idempotencyKey: key,
    });
    const balanceAfterFirst = await getBalance(userId);

    const second = await applyTransaction({
      userId,
      type: "manual_deposit",
      direction: "credit",
      amount: 1000,
      idempotencyKey: key,
    });

    expect(second.error).toBeNull();
    expect(second.data.id).toBe(first.data.id);
    expect(await getBalance(userId)).toBe(balanceAfterFirst);
  });

  it("rejects a debit that would drive the balance below zero", async () => {
    const balanceBefore = await getBalance(userId);
    const { error } = await applyTransaction({
      userId,
      type: "manual_withdrawal",
      direction: "debit",
      amount: balanceBefore + 100_000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("insufficient_balance");
    expect(await getBalance(userId)).toBe(balanceBefore);
  });

  it("serializes concurrent debits so the balance never goes negative", async () => {
    // Arrange a known balance directly (bypassing the ledger on purpose —
    // this is test setup, not a simulated business flow) for a
    // deterministic concurrency check.
    await admin.from("wallet_balances").update({ balance: 1000 }).eq("user_id", userId);

    const attempts = 10;
    const debitAmount = 200; // exactly 5 of 10 concurrent debits can succeed

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        applyTransaction({
          userId,
          type: "manual_withdrawal",
          direction: "debit",
          amount: debitAmount,
        }),
      ),
    );

    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    expect(succeeded.length).toBe(5);
    expect(failed.length).toBe(5);
    failed.forEach((r) => expect(r.error!.message).toContain("insufficient_balance"));
    expect(await getBalance(userId)).toBe(0);
  });

  it("stamps pool/fixture/option context onto the transaction at write time, surviving the pool's later deletion", async () => {
    const { data: adminUser } = await admin
      .from("user_profiles")
      .select("id")
      .eq("role", "super_admin")
      .eq("is_active", true)
      .limit(1)
      .single();

    const { data: fixture } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `wallet-ctx-test-${randomUUID()}`,
        home_team_name: "Ledger FC",
        away_team_name: "Context United",
        competition_name: "Test League",
        scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        internal_status: "NOT_STARTED",
      })
      .select("id")
      .single();

    const { data: pool } = await admin
      .from("pools")
      .insert({
        fixture_id: fixture!.id,
        created_by: adminUser!.id,
        pool_type: "WHO_WILL_ADVANCE",
        question: "Who will advance?",
        entry_fee: 1000,
        house_fee_bps: 1000,
        min_total_entries: 1,
        open_at: new Date().toISOString(),
        locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: "OPEN",
      })
      .select("id")
      .single();

    const { data: option } = await admin
      .from("pool_options")
      .insert({ pool_id: pool!.id, label: "Ledger FC", sort_order: 0 })
      .select("id")
      .single();

    const { data: entry } = await admin
      .from("entries")
      .insert({
        pool_id: pool!.id,
        user_id: userId,
        option_id: option!.id,
        amount: 1000,
        idempotency_key: randomUUID(),
      })
      .select("id")
      .single();

    // Fund the entry fee regardless of whatever balance earlier tests in
    // this file left behind — this test only cares about the stamped
    // context, not the debit succeeding off pre-existing state.
    await applyTransaction({ userId, type: "manual_deposit", direction: "credit", amount: 1000 });

    const { data: transaction, error } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "pool_entry_debit",
      p_direction: "debit",
      p_amount: 1000,
      p_admin_id: null,
      p_reason: null,
      p_idempotency_key: randomUUID(),
      p_pool_id: pool!.id,
      p_entry_id: entry!.id,
    });
    expect(error).toBeNull();
    expect(transaction.pool_question).toBe("Who will advance?");
    expect(transaction.fixture_label).toBe("Ledger FC vs Context United");
    expect(transaction.competition_name).toBe("Test League");
    expect(transaction.option_label).toBe("Ledger FC");

    // Hard-delete the pool the same way delete_terminal_pool does (cascades
    // entries/pool_options) — the whole point of stamping this at write
    // time is that the transaction's own copy doesn't care.
    await admin.from("entries").delete().eq("pool_id", pool!.id);
    await admin.from("pool_options").delete().eq("pool_id", pool!.id);
    await admin.from("pools").delete().eq("id", pool!.id);
    await admin.from("fixtures").delete().eq("id", fixture!.id);

    const { data: afterDelete } = await admin
      .from("wallet_transactions")
      .select("pool_question, fixture_label, competition_name, option_label")
      .eq("id", transaction.id)
      .single();
    expect(afterDelete?.pool_question).toBe("Who will advance?");
    expect(afterDelete?.fixture_label).toBe("Ledger FC vs Context United");
    expect(afterDelete?.competition_name).toBe("Test League");
    expect(afterDelete?.option_label).toBe("Ledger FC");
  });

  it("credits and debits the house account the same way as a user account", async () => {
    const { data: houseBefore } = await admin
      .from("wallet_balances")
      .select("balance")
      .eq("account_type", "house")
      .single();

    const { data, error } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "house",
      p_user_id: null,
      p_type: "house_fee_credit",
      p_direction: "credit",
      p_amount: 250,
      p_admin_id: null,
      p_reason: "integration test",
      p_idempotency_key: randomUUID(),
    });

    expect(error).toBeNull();
    expect(data.balance_before).toBe(houseBefore!.balance);
    expect(data.balance_after).toBe(houseBefore!.balance + 250);
  });
});
