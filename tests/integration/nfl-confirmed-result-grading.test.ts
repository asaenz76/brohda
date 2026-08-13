/**
 * Integration tests proving NFL grading only ever reads from the
 * authoritative nfl_game_results table, never directly from the raw,
 * live-syncing fixtures.regulation_*_score — a COMPLETED fixture with no
 * confirmed result must never settle a pool. Models template-pools.test.ts's
 * real-wallet pattern. Run with: pnpm test:integration (requires
 * `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { gradeTemplatePool } from "@/lib/pools/templates/grade";
import { resolveNflFixtureRow } from "@/lib/pools/templates/nfl-confirmed-result";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createTestPlayer(email: string, balanceCents = 0) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: "test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: email.split("@")[0], role: "player", is_active: true });
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
  const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
  return data!.id as string;
}

const createdPoolIds: string[] = [];
const createdFixtureIds: string[] = [];

// Fixture starts COMPLETED with a real score already synced — exactly the
// state a real NFL fixture is in the moment the provider reports FT/AOT,
// before the confirmed-result reconciliation pass has necessarily run yet.
async function createTestNflFixture(homeScore: number, awayScore: number) {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: `nfl-grading-test-${randomUUID()}`,
      home_team_name: "Green Bay Packers",
      away_team_name: "Pittsburgh Steelers",
      home_team_external_id: "10",
      away_team_external_id: "20",
      scheduled_start_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      internal_status: "COMPLETED",
      regulation_home_score: homeScore,
      regulation_away_score: awayScore,
    })
    .select(
      "id, internal_status, home_team_name, away_team_name, home_team_external_id, away_team_external_id, regulation_home_score, regulation_away_score, halftime_home_score, halftime_away_score, provider",
    )
    .single();
  if (error || !data) throw error ?? new Error("failed to create test NFL fixture");
  createdFixtureIds.push(data.id as string);
  return data;
}

async function createNflSpreadPool(creatorId: string, fixtureId: string, status: string = "AWAITING_RESULT") {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "NFL_SPREAD",
      template_config: { team: "HOME", line: 1.5 },
      question: "Will Green Bay Packers win by 2+ points?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status,
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create NFL_SPREAD pool");
  createdPoolIds.push(pool.id as string);

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0 },
      { pool_id: pool.id, label: "No", sort_order: 1 },
    ])
    .select("id, label");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create options");

  return {
    poolId: pool.id as string,
    yesOptionId: optionRows.find((o) => o.label === "Yes")!.id as string,
    noOptionId: optionRows.find((o) => o.label === "No")!.id as string,
  };
}

function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
  return admin.rpc("create_pool_entry", { p_pool_id: poolId, p_user_id: userId, p_option_id: optionId, p_amount: amount, p_idempotency_key: randomUUID() });
}

describe.skipIf(!SERVICE_ROLE_KEY)("NFL grading reads only the confirmed result, never the raw fixture", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      // createSettlementNotifications (fired by gradeTemplatePool's
      // automatic-settlement path) leaves notifications.pool_id rows that
      // block deleting the pool otherwise.
      await admin.from("notifications").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_grading_evidence").delete().in("pool_id", createdPoolIds);
      const { data: settlementRows } = await admin.from("settlements").select("id").in("pool_id", createdPoolIds);
      const settlementIds = (settlementRows ?? []).map((s) => s.id);
      if (settlementIds.length > 0) await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
      await admin.from("correct_prediction_log").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    // nfl_game_results rows are permanent by design (no delete grant) —
    // left in place, same as production. No FK on fixture_id (mirrors
    // pool_grading_evidence) means that never blocks the fixture deletion.
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  it("stays PENDING when the fixture is COMPLETED but no confirmed result exists yet — draft/provisional scores never settle a pool", async () => {
    const fixture = await createTestNflFixture(24, 21);
    const { poolId } = await createNflSpreadPool(adminId, fixture.id);

    const { fixtureRow, resultEvidence } = await resolveNflFixtureRow(admin, fixture.id, "api_nfl", fixture);
    expect(resultEvidence).toBeUndefined();

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "NFL_SPREAD", template_config: { team: "HOME", line: 1.5 } },
      fixtureRow,
    );
    expect(outcome).toBe("pending");

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("AWAITING_RESULT");
    const { data: settlements } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlements).toHaveLength(0);
  });

  it("settles correctly once a confirmed result exists, records which result revision backed it, and is idempotent on repeat grading", async () => {
    const p1 = await createTestPlayer(`nfl-grading-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`nfl-grading-b-${Date.now()}@example.com`, 5000);

    const fixture = await createTestNflFixture(24, 21);
    const { poolId, yesOptionId, noOptionId } = await createNflSpreadPool(adminId, fixture.id, "OPEN");
    await Promise.all([enter(poolId, p1.userId, yesOptionId), enter(poolId, p2.userId, noOptionId)]);
    await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);

    const { data: confirmedResult } = await admin
      .from("nfl_game_results")
      .insert({
        fixture_id: fixture.id,
        home_team_external_id: "10",
        away_team_external_id: "20",
        home_final_score: 24,
        away_final_score: 21,
        status: "CONFIRMED",
        is_current: true,
      })
      .select("id")
      .single();

    const { fixtureRow, resultEvidence } = await resolveNflFixtureRow(admin, fixture.id, "api_nfl", fixture);
    expect(resultEvidence?.source).toBe("NFL_GAME_RESULT");
    expect(resultEvidence?.rawValue).toBe(confirmedResult!.id);

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "NFL_SPREAD", template_config: { team: "HOME", line: 1.5 } },
      fixtureRow,
      { resultEvidence },
    );
    // Packers 24-21, margin 3 > 1.5 -> YES -> real entries on both sides -> settles fully automatically.
    expect(outcome).toBe("settled");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("SETTLED");

    const { data: settlement } = await admin
      .from("settlements")
      .select("id, winning_option_id")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);

    // The recorded evidence proves which nfl_game_results row backed grading.
    const { data: evidenceRows } = await admin
      .from("pool_grading_evidence")
      .select("evidence")
      .eq("settlement_id", settlement!.id)
      .single();
    const evidenceList = evidenceRows!.evidence as Array<{ source: string; rawValue: unknown }>;
    expect(evidenceList.some((e) => e.source === "NFL_GAME_RESULT" && e.rawValue === confirmedResult!.id)).toBe(true);

    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    // Re-run grading against the same (now-settled) pool — idempotent, no
    // duplicate settlement/evidence row, no duplicate wallet movement.
    const secondOutcome = await gradeTemplatePool(
      { id: poolId, template_id: "NFL_SPREAD", template_config: { team: "HOME", line: 1.5 } },
      fixtureRow,
      { resultEvidence },
    );
    expect(["settled", "readyForReview"]).toContain(secondOutcome);
    const { data: settlementsAfter } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlementsAfter).toHaveLength(1);
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("football fixtures are completely unaffected — resolveNflFixtureRow is a no-op for any non-api_nfl provider", async () => {
    const fixtureRow = {
      internal_status: "COMPLETED",
      home_team_name: "Home FC",
      away_team_name: "Away FC",
      home_team_external_id: "1",
      away_team_external_id: "2",
      regulation_home_score: 2,
      regulation_away_score: 1,
      halftime_home_score: 1,
      halftime_away_score: 0,
    };
    const { fixtureRow: resolved, resultEvidence } = await resolveNflFixtureRow(
      admin,
      randomUUID(),
      "api_football",
      fixtureRow,
    );
    expect(resolved).toEqual(fixtureRow);
    expect(resultEvidence).toBeUndefined();
  });
});
