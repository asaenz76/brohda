/**
 * Runs the real lock/process-results cron job functions (lib/pools/lock.ts's
 * lockDuePools, lib/pools/settle.ts's processAwaitingResults) directly
 * against a real CUSTOM pool — bypassing the HTTP routes' CRON_SECRET auth
 * — to prove both jobs handle a fixture-less pool correctly end to end.
 *
 * This is a standalone script, not a vitest integration test: both
 * functions operate on every OPEN/LOCKED/AWAITING_RESULT pool in the
 * database with no scoping, which is exactly what makes them "the real
 * job" — but that also means running them concurrently with other test
 * files (which assume an otherwise-quiescent database, e.g. wallet.test.ts's
 * exact house-balance assertions) causes cross-file races under vitest's
 * default parallel file execution. Kept as an on-demand script instead so
 * it can be re-run to verify this behavior without adding flakiness to the
 * regular pnpm test:integration run.
 *
 * Usage: pnpm verify-custom-pool-cron (requires `pnpm supabase:start`)
 */
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { lockDuePools } from "../lib/pools/lock";
import { processAwaitingResults } from "../lib/pools/settle";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

assertProductionWriteConfirmed(SUPABASE_URL, "verify-custom-pool-cron");

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function createTestPlayer(email: string, balanceCents: number) {
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

  return data.user.id as string;
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

async function main() {
  if (!SERVICE_ROLE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is not set — run via `pnpm verify-custom-pool-cron`.");
    process.exit(1);
  }

  const { data: adminProfile } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "super_admin")
    .eq("is_active", true)
    .limit(1)
    .single();
  const adminId = adminProfile!.id as string;

  console.log("Creating a CUSTOM pool with two players' entries...");
  const { data: pool, error: poolError } = await admin
    .from("pools")
    .insert({
      fixture_id: null,
      created_by: adminId,
      pool_type: "CUSTOM",
      question: "CRON-VERIFY: Who will win the election?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      // Starts in the future so create_pool_entry's own `now() >= locks_at`
      // guard doesn't reject the entries below — backdated afterwards.
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (poolError || !pool) throw poolError ?? new Error("failed to create pool");
  const poolId = pool.id as string;

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: poolId, label: "Alice", sort_order: 0 },
      { pool_id: poolId, label: "Bob", sort_order: 1 },
    ])
    .select("id");
  if (optionsError || !options) throw optionsError ?? new Error("failed to create options");

  const p1 = await createTestPlayer(`cron-verify-a-${Date.now()}@example.com`, 5000);
  const p2 = await createTestPlayer(`cron-verify-b-${Date.now()}@example.com`, 5000);

  let { error: enterError } = await enter(poolId, p1, options[0].id);
  if (enterError) throw enterError;
  ({ error: enterError } = await enter(poolId, p2, options[1].id));
  if (enterError) throw enterError;

  const { error: backdateError } = await admin
    .from("pools")
    .update({ locks_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    .eq("id", poolId);
  if (backdateError) throw backdateError;

  try {
    console.log("Running the real lockDuePools()...");
    const lockResult = await lockDuePools();
    console.log("  ", lockResult);
    assert(lockResult.failed === 0, "lockDuePools() reported a failure");

    const { data: afterLock } = await admin.from("pools").select("status").eq("id", poolId).single();
    assert(
      afterLock?.status === "AWAITING_RESULT",
      `expected AWAITING_RESULT after lockDuePools(), got ${afterLock?.status}`,
    );
    console.log("  OK: OPEN -> LOCKED -> AWAITING_RESULT with no fixture involved.");

    console.log("Running the real processAwaitingResults()...");
    const settleResult = await processAwaitingResults();
    console.log("  ", settleResult);
    assert(settleResult.skipped > 0, "expected processAwaitingResults() to report at least one skip");

    const { data: afterSettle } = await admin.from("pools").select("status").eq("id", poolId).single();
    assert(
      afterSettle?.status === "AWAITING_RESULT",
      `expected the CUSTOM pool to stay AWAITING_RESULT (skipped, not failed), got ${afterSettle?.status}`,
    );
    console.log("  OK: CUSTOM pool skipped, not counted as a failure.");

    console.log("\nAll checks passed.");
  } finally {
    await admin.from("entries").delete().eq("pool_id", poolId);
    await admin.from("pool_options").delete().eq("pool_id", poolId);
    await admin.from("pools").delete().eq("id", poolId);
    await admin.from("user_profiles").update({ is_active: false }).in("id", [p1, p2]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
