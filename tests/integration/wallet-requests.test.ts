/**
 * Integration tests for player-facing wallet requests: a deposit/withdrawal
 * request row, approved via the existing apply_wallet_transaction RPC
 * (unchanged) or rejected with no money movement, plus RLS isolation.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createWalletRequestSubmittedNotification } from "@/lib/notifications/create";

const createdPoolIds: string[] = [];

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

async function createTestPool(entryFee: number) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: null,
      created_by: await getAdminId(),
      pool_type: "CUSTOM",
      question: "Quick top-up test pool",
      entry_fee: entryFee,
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

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0 },
      { pool_id: pool.id, label: "No", sort_order: 1 },
    ])
    .select("id");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create test pool options");

  return { poolId: pool.id as string, optionId: optionRows[0].id as string };
}

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

// Notification-only recipient — no auth sign-in/balance needed, just a
// user_profiles row with the given role for createWalletRequestSubmittedNotification
// to find via its role-based query.
async function createTestStaff(email: string, role: "admin" | "super_admin") {
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

  return data.user.id as string;
}

async function insertRequest(params: {
  userId: string;
  type: "deposit" | "withdrawal";
  amount: number;
  intendedPoolId?: string;
  intendedOptionId?: string;
}) {
  const { data, error } = await admin
    .from("wallet_requests")
    .insert({
      user_id: params.userId,
      type: params.type,
      amount: params.amount,
      idempotency_key: randomUUID(),
      intended_pool_id: params.intendedPoolId ?? null,
      intended_option_id: params.intendedOptionId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

// Mirrors what approveWalletRequestAction's completeQuickTopUpEntry helper
// does after a quick-top-up deposit is credited: attempt the intended
// entry using the pool's own entry_fee (never the client-supplied amount)
// and a deterministic idempotency key derived from the request id.
async function attemptQuickTopUpEntry(request: {
  id: string;
  user_id: string;
  intended_pool_id: string;
  intended_option_id: string;
}) {
  const { data: pool } = await admin
    .from("pools")
    .select("entry_fee")
    .eq("id", request.intended_pool_id)
    .single();

  return admin.rpc("create_pool_entry", {
    p_pool_id: request.intended_pool_id,
    p_user_id: request.user_id,
    p_option_id: request.intended_option_id,
    p_amount: pool!.entry_fee,
    p_idempotency_key: `quick_topup:${request.id}`,
  });
}

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  return data!.balance;
}

describe.skipIf(!SERVICE_ROLE_KEY)("wallet requests", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await Promise.all(createdUserIds.map(deactivate));

    if (createdPoolIds.length > 0) {
      // wallet_requests.intended_pool_id/intended_option_id FK these test
      // pools/options — must clear before pool_options/pools can go. Nulling
      // the FKs (rather than deleting the rows outright, which the DELETE
      // grant added in 20260101000103 now permits) keeps this cleanup
      // symmetric with the deposit/withdrawal rows other tests leave behind
      // for manual inspection.
      let result = await admin
        .from("wallet_requests")
        .update({ intended_pool_id: null, intended_option_id: null })
        .in("intended_pool_id", createdPoolIds);
      if (result.error) throw result.error;
      result = await admin.from("entries").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;
      result = await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;
      result = await admin.from("pools").delete().in("id", createdPoolIds);
      if (result.error) throw result.error;
    }
  });

  // Regression test for the missing service_role DELETE grant (Phase 8
  // Technical Debt, same bug class as provider_request_log/
  // fixture_odds_cache) — before 20260101000103, this delete returned an
  // error the caller wasn't checking, so the row silently survived.
  it("lets service_role delete a wallet_requests row", async () => {
    const { userId } = await createTestPlayer(`wallet-req-delete-grant-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    const request = await insertRequest({ userId, type: "deposit", amount: 500 });

    const { error: deleteError } = await admin.from("wallet_requests").delete().eq("id", request.id);
    expect(deleteError).toBeNull();

    const { data: stillThere } = await admin
      .from("wallet_requests")
      .select("id")
      .eq("id", request.id)
      .maybeSingle();
    expect(stillThere).toBeNull();
  });

  it("approving a deposit request credits the wallet and marks it approved", async () => {
    const { userId } = await createTestPlayer(`wallet-req-deposit-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    const request = await insertRequest({ userId, type: "deposit", amount: 2000 });
    expect(request.status).toBe("pending");

    const { error: rpcError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: request.amount,
      p_admin_id: null,
      p_reason: "wallet request approved",
      p_idempotency_key: `wallet_request:${request.id}`,
    });
    expect(rpcError).toBeNull();

    await admin
      .from("wallet_requests")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", request.id);

    expect(await getBalance(userId)).toBe(2000);
    const { data: updated } = await admin
      .from("wallet_requests")
      .select("status")
      .eq("id", request.id)
      .single();
    expect(updated!.status).toBe("approved");
  });

  it("approving a withdrawal that would go negative is rejected and leaves the request pending", async () => {
    const { userId } = await createTestPlayer(
      `wallet-req-withdraw-${Date.now()}@example.com`,
      1000,
    );
    createdUserIds.push(userId);

    const request = await insertRequest({ userId, type: "withdrawal", amount: 5000 });

    const { error: rpcError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_withdrawal",
      p_direction: "debit",
      p_amount: request.amount,
      p_admin_id: null,
      p_reason: "wallet request approved",
      p_idempotency_key: `wallet_request:${request.id}`,
    });
    expect(rpcError?.message).toContain("insufficient_balance");

    // The real approve action never marks the request resolved when the
    // RPC fails — confirm the balance and the request are both untouched.
    expect(await getBalance(userId)).toBe(1000);
    const { data: stillPending } = await admin
      .from("wallet_requests")
      .select("status")
      .eq("id", request.id)
      .single();
    expect(stillPending!.status).toBe("pending");
  });

  it("rejecting a request never touches the wallet balance", async () => {
    const { userId } = await createTestPlayer(`wallet-req-reject-${Date.now()}@example.com`, 500);
    createdUserIds.push(userId);

    const request = await insertRequest({ userId, type: "deposit", amount: 3000 });

    await admin
      .from("wallet_requests")
      .update({ status: "rejected", reviewed_at: new Date().toISOString() })
      .eq("id", request.id);

    expect(await getBalance(userId)).toBe(500);
  });

  it("quick top-up: approving a deposit with an intended entry auto-completes that entry", async () => {
    const { userId } = await createTestPlayer(`wallet-req-topup-ok-${Date.now()}@example.com`, 0);
    createdUserIds.push(userId);
    const { poolId, optionId } = await createTestPool(1000);

    // Player is short the full entry fee — a real shortfall, matching what
    // TopUpAndJoinModal would compute and submit.
    const request = await insertRequest({
      userId,
      type: "deposit",
      amount: 1000,
      intendedPoolId: poolId,
      intendedOptionId: optionId,
    });

    const { error: rpcError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: request.amount,
      p_admin_id: null,
      p_reason: "wallet request approved",
      p_idempotency_key: `wallet_request:${request.id}`,
    });
    expect(rpcError).toBeNull();
    await admin
      .from("wallet_requests")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", request.id);

    const { error: entryError } = await attemptQuickTopUpEntry({
      id: request.id,
      user_id: userId,
      intended_pool_id: poolId,
      intended_option_id: optionId,
    });
    expect(entryError).toBeNull();

    expect(await getBalance(userId)).toBe(0);
    const { data: entry } = await admin
      .from("entries")
      .select("option_id, amount")
      .eq("pool_id", poolId)
      .eq("user_id", userId)
      .single();
    expect(entry?.option_id).toBe(optionId);
    expect(entry?.amount).toBe(1000);
  });

  it("quick top-up: if the pool locks before approval, the deposit still lands but the entry doesn't", async () => {
    const { userId } = await createTestPlayer(`wallet-req-topup-locked-${Date.now()}@example.com`, 0);
    createdUserIds.push(userId);
    const { poolId, optionId } = await createTestPool(1000);

    const request = await insertRequest({
      userId,
      type: "deposit",
      amount: 1000,
      intendedPoolId: poolId,
      intendedOptionId: optionId,
    });

    // Simulate the pool locking in the gap between the top-up request and
    // an admin getting to it.
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: request.amount,
      p_admin_id: null,
      p_reason: "wallet request approved",
      p_idempotency_key: `wallet_request:${request.id}`,
    });
    await admin
      .from("wallet_requests")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", request.id);

    const { error: entryError } = await attemptQuickTopUpEntry({
      id: request.id,
      user_id: userId,
      intended_pool_id: poolId,
      intended_option_id: optionId,
    });
    expect(entryError?.message).toContain("pool_not_open");

    // The credit already landed and must stay — completeQuickTopUpEntry
    // only decides which notification to send on this failure, it never
    // reverses the deposit.
    expect(await getBalance(userId)).toBe(1000);
    const { data: entry } = await admin
      .from("entries")
      .select("id")
      .eq("pool_id", poolId)
      .eq("user_id", userId)
      .maybeSingle();
    expect(entry).toBeNull();
  });

  it("stores the currency/transaction-ref/other-method fields and they round-trip unchanged", async () => {
    const { userId } = await createTestPlayer(`wallet-req-currency-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    const { data: inserted, error } = await admin
      .from("wallet_requests")
      .insert({
        user_id: userId,
        type: "deposit",
        amount: 1500,
        idempotency_key: randomUUID(),
        payment_method: "USDT",
        transaction_ref: "0xabc123",
      })
      .select("payment_method, other_method_note, transaction_ref")
      .single();

    expect(error).toBeNull();
    expect(inserted?.payment_method).toBe("USDT");
    expect(inserted?.transaction_ref).toBe("0xabc123");
    expect(inserted?.other_method_note).toBeNull();
  });

  it("approving a withdrawal snapshots its payout destination onto the resulting ledger entry", async () => {
    const { userId } = await createTestPlayer(
      `wallet-req-destination-${Date.now()}@example.com`,
      5000,
    );
    createdUserIds.push(userId);

    const { data: request } = await admin
      .from("wallet_requests")
      .insert({
        user_id: userId,
        type: "withdrawal",
        amount: 2000,
        idempotency_key: randomUUID(),
        payment_method: "VENMO",
        note: "@janedoe",
      })
      .select("*")
      .single();

    const { data: transaction, error: rpcError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_withdrawal",
      p_direction: "debit",
      p_amount: request!.amount,
      p_admin_id: null,
      p_reason: "wallet request approved",
      p_idempotency_key: `wallet_request:${request!.id}`,
      p_destination: `Venmo: ${request!.note}`,
    });

    expect(rpcError).toBeNull();
    expect(transaction?.destination).toBe("Venmo: @janedoe");
  });

  it("createWalletRequestSubmittedNotification notifies every admin and super_admin, not players", async () => {
    const adminId = await createTestStaff(`wallet-req-notify-admin-${Date.now()}@example.com`, "admin");
    const superAdminId = await createTestStaff(
      `wallet-req-notify-superadmin-${Date.now()}@example.com`,
      "super_admin",
    );
    const { userId: playerId } = await createTestPlayer(
      `wallet-req-notify-player-${Date.now()}@example.com`,
    );
    createdUserIds.push(adminId, superAdminId, playerId);

    await createWalletRequestSubmittedNotification({
      requesterDisplayName: "Alice",
      requestType: "withdrawal",
      amountCents: 2000,
    });

    const { data: notifications } = await admin
      .from("notifications")
      .select("user_id, type, title, body")
      .in("user_id", [adminId, superAdminId, playerId]);

    const recipientIds = (notifications ?? []).map((n) => n.user_id).sort();
    expect(recipientIds).toEqual([adminId, superAdminId].sort());

    for (const n of notifications ?? []) {
      expect(n.type).toBe("WALLET_REQUEST_SUBMITTED");
      expect(n.title).toBe("New withdrawal request");
      expect(n.body).toBe("Alice requested a withdrawal of $20.00.");
    }
  });

  it("RLS: a player can only see their own requests, and cannot approve/reject anything", async () => {
    const a = await createTestPlayer(`wallet-req-rls-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`wallet-req-rls-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);

    const requestA = await insertRequest({ userId: a.userId, type: "deposit", amount: 1000 });
    await insertRequest({ userId: b.userId, type: "deposit", amount: 1000 });

    const { data: visibleToA } = await a.client.from("wallet_requests").select("id, user_id");
    expect(visibleToA?.every((r) => r.user_id === a.userId)).toBe(true);
    expect(visibleToA?.length).toBe(1);

    // No UPDATE grant to authenticated at all — even on their own row.
    const { error: updateError, data: updateData } = await a.client
      .from("wallet_requests")
      .update({ status: "approved" })
      .eq("id", requestA.id)
      .select();
    expect(updateData ?? []).toHaveLength(0);
    void updateError;

    const { data: stillPending } = await admin
      .from("wallet_requests")
      .select("status")
      .eq("id", requestA.id)
      .single();
    expect(stillPending!.status).toBe("pending");
  });
});
