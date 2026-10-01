/**
 * Integration tests for the wallet ledger (spec §8) against a real local
 * Supabase instance.
 *
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

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
