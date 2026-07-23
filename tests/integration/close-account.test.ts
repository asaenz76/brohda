/**
 * Integration tests for self-service account closure (self-exclusion
 * compliance). close_own_account() must refuse to run while money could
 * still move for this user (nonzero balance, a pending wallet request, or
 * an unsettled active entry), and on success must deactivate the profile
 * and scrub its identifying fields. Run with: pnpm test:integration
 * (requires `pnpm supabase:start`).
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
    username: email.split("@")[0],
    avatar_url: "https://example.test/avatars/some-file.webp",
    role: "player",
    is_active: true,
  });

  return data.user.id;
}

function deposit(userId: string, amount: number) {
  return admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: userId,
    p_reason: "integration test",
    p_idempotency_key: randomUUID(),
  });
}

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `close-account-test-${randomUUID()}`,
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

describe.skipIf(!SERVICE_ROLE_KEY)("close_own_account", () => {
  let fixtureId: string;
  let creatorId: string;
  const createdUserIds: string[] = [];
  const createdPoolIds: string[] = [];

  beforeAll(async () => {
    fixtureId = await createTestFixture();
    creatorId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    // wallet_transactions is append-only (no DELETE grant, even for
    // service_role) — any user who received a deposit can never be
    // hard-deleted. Deactivate instead, matching this suite's established
    // pattern.
    await Promise.all(
      createdUserIds.map((id) => admin.from("user_profiles").update({ is_active: false }).eq("id", id)),
    );
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("refuses to close while the balance is nonzero", async () => {
    const userId = await createTestPlayer(`close-nonzero-${Date.now()}@example.com`);
    createdUserIds.push(userId);
    await deposit(userId, 500);

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error?.message).toContain("nonzero_balance");

    const { data: profile } = await admin
      .from("user_profiles")
      .select("is_active, display_name")
      .eq("id", userId)
      .single();
    expect(profile?.is_active).toBe(true);
  });

  it("refuses to close with a pending wallet request", async () => {
    const userId = await createTestPlayer(`close-pending-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    await admin.from("wallet_requests").insert({
      user_id: userId,
      type: "deposit",
      amount: 1000,
      idempotency_key: randomUUID(),
    });

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error?.message).toContain("pending_wallet_request");
  });

  it("refuses to close with an active (unsettled) entry", async () => {
    const userId = await createTestPlayer(`close-active-entry-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    const { data: pool, error: poolError } = await admin
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
        status: "OPEN",
      })
      .select("id")
      .single();
    if (poolError || !pool) throw poolError ?? new Error("failed to create test pool");
    createdPoolIds.push(pool.id as string);

    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: pool.id, label: "Home Test FC", sort_order: 0 },
        { pool_id: pool.id, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

    await deposit(userId, 1000);
    const { error: entryError } = await admin.rpc("create_pool_entry", {
      p_pool_id: pool.id,
      p_user_id: userId,
      p_option_id: options[0].id,
      p_amount: 1000,
      p_idempotency_key: randomUUID(),
    });
    expect(entryError).toBeNull();

    // Entering the pool debits the entry fee back to zero, so the balance
    // guard alone wouldn't catch this — it's the ACTIVE entry itself that
    // must block closure.
    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error?.message).toContain("active_entries");
  });

  it("deactivates the profile and scrubs identifying fields on success", async () => {
    const userId = await createTestPlayer(`close-success-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error).toBeNull();

    const { data: profile } = await admin
      .from("user_profiles")
      .select("is_active, display_name, username, avatar_url")
      .eq("id", userId)
      .single();
    expect(profile).toEqual({
      is_active: false,
      display_name: "Deleted User",
      username: null,
      avatar_url: null,
    });
  });
});
