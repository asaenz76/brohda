/**
 * Integration tests for Phase 2's FIXTURE_EVENTS-dependent TEMPLATE_GRADED
 * pools — extends tests/integration/template-pools.test.ts's own patterns
 * (same fixture/pool helpers, same afterAll cleanup ordering) to cover the
 * new "missing events != zero" PENDING gate and a full grade -> confirm
 * payout flow for an events-graded template.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { gradeTemplatePool } from "@/lib/pools/templates/grade";
import type { NormalizedFixtureEvent } from "@/lib/sports-data/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
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

interface TestFixtureOverrides {
  internalStatus?: string;
  providerEventsPayload?: NormalizedFixtureEvent[] | null;
}

async function createTestFixture(overrides: TestFixtureOverrides = {}): Promise<{
  id: string;
  internal_status: string;
  home_team_name: string;
  away_team_name: string;
  home_team_external_id: string | null;
  away_team_external_id: string | null;
  regulation_home_score: number | null;
  regulation_away_score: number | null;
  halftime_home_score: number | null;
  halftime_away_score: number | null;
  provider_events_payload: unknown;
}> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `template-pool-events-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      home_team_external_id: "1001",
      away_team_external_id: "1002",
      scheduled_start_utc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      internal_status: overrides.internalStatus ?? "COMPLETED",
      regulation_home_score: 1,
      regulation_away_score: 0,
      provider_events_payload: "providerEventsPayload" in overrides ? overrides.providerEventsPayload : null,
    })
    .select(
      "id, internal_status, home_team_name, away_team_name, home_team_external_id, away_team_external_id, regulation_home_score, regulation_away_score, halftime_home_score, halftime_away_score, provider_events_payload",
    )
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data;
}

const createdPoolIds: string[] = [];
const createdFixtureIds: string[] = [];

async function createTemplatePool(
  creatorId: string,
  fixtureId: string,
  templateId: string,
  templateConfig: Record<string, unknown>,
  status: string = "AWAITING_RESULT",
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: templateId,
      template_config: templateConfig,
      question: "test question",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status,
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create template pool");
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
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
  });
}

describe.skipIf(!SERVICE_ROLE_KEY)("TEMPLATE_GRADED pools — FIXTURE_EVENTS templates", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("pool_grading_evidence").delete().in("pool_id", createdPoolIds);

      const { data: settlementRows } = await admin
        .from("settlements")
        .select("id")
        .in("pool_id", createdPoolIds);
      const settlementIds = (settlementRows ?? []).map((s) => s.id);
      if (settlementIds.length > 0) {
        await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
      }

      await admin.from("correct_prediction_log").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  it("stays PENDING on a COMPLETED fixture when events haven't been synced yet (missing data != zero)", async () => {
    const fixture = await createTestFixture({ providerEventsPayload: null });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "RED_CARD", {
      includeSecondYellowDismissal: false,
    });

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "RED_CARD", template_config: { includeSecondYellowDismissal: false } },
      fixture,
    );
    expect(outcome).toBe("pending");

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("AWAITING_RESULT");

    const { data: settlements } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlements).toHaveLength(0);
  });

  it("grades a RED_CARD pool YES from a real cached events payload, and records evidence", async () => {
    const events: NormalizedFixtureEvent[] = [
      {
        effectiveMinute: 63,
        teamExternalId: "1002",
        playerExternalId: "p-defender",
        playerName: "Test Defender",
        assistPlayerExternalId: null,
        assistPlayerName: null,
        type: "CARD",
        detail: "CARD_RED",
      },
    ];
    const fixture = await createTestFixture({ providerEventsPayload: events });
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId } = await createTemplatePool(adminId, fixture.id, "RED_CARD", {
      includeSecondYellowDismissal: false,
    });

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "RED_CARD", template_config: { includeSecondYellowDismissal: false } },
      fixture,
    );
    expect(outcome).toBe("readyForReview");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("READY_FOR_REVIEW");

    const { data: settlement } = await admin
      .from("settlements")
      .select("id, winning_option_id, winning_option_reason")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);
    expect(settlement?.winning_option_reason).toBe("TEMPLATE_GRADED");

    const { data: evidenceRows } = await admin
      .from("pool_grading_evidence")
      .select("result, template_id")
      .eq("settlement_id", settlement!.id);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows![0].result).toBe("YES");
    expect(evidenceRows![0].template_id).toBe("RED_CARD");
  });

  it("is idempotent for an events-graded template — grading twice does not duplicate settlement or evidence", async () => {
    const events: NormalizedFixtureEvent[] = [
      {
        effectiveMinute: 40,
        teamExternalId: "1001",
        playerExternalId: "p1",
        playerName: "Test Scorer",
        assistPlayerExternalId: null,
        assistPlayerName: null,
        type: "GOAL",
        detail: "GOAL_NORMAL",
      },
    ];
    const fixture = await createTestFixture({ providerEventsPayload: events });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "OWN_GOAL", {});

    const pool = { id: poolId, template_id: "OWN_GOAL", template_config: {} };
    const first = await gradeTemplatePool(pool, fixture);
    const second = await gradeTemplatePool(pool, fixture);
    expect(first).toBe("readyForReview");
    expect(second).toBe("readyForReview");

    const { data: settlements } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlements).toHaveLength(1);

    const { data: evidence } = await admin
      .from("pool_grading_evidence")
      .select("id")
      .eq("settlement_id", settlements![0].id);
    expect(evidence).toHaveLength(1);
  });

  it("full flow: PLAYER_TO_SCORE grade then confirm_pool_settlement pays out correctly", async () => {
    const p1 = await createTestPlayer(`template-events-payout-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`template-events-payout-b-${Date.now()}@example.com`, 5000);

    const events: NormalizedFixtureEvent[] = [
      {
        effectiveMinute: 12,
        teamExternalId: "1001",
        playerExternalId: "star-player",
        playerName: "Star Player",
        assistPlayerExternalId: null,
        assistPlayerName: null,
        type: "GOAL",
        detail: "GOAL_NORMAL",
      },
    ];
    const fixture = await createTestFixture({ providerEventsPayload: events });
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId, noOptionId } = await createTemplatePool(
      adminId,
      fixture.id,
      "PLAYER_TO_SCORE",
      { playerExternalId: "star-player", playerName: "Star Player" },
      "OPEN",
    );

    const [{ error: enter1Error }, { error: enter2Error }] = await Promise.all([
      enter(poolId, p1.userId, yesOptionId),
      enter(poolId, p2.userId, noOptionId),
    ]);
    expect(enter1Error).toBeNull();
    expect(enter2Error).toBeNull();

    await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);

    await gradeTemplatePool(
      { id: poolId, template_id: "PLAYER_TO_SCORE", template_config: { playerExternalId: "star-player", playerName: "Star Player" } },
      fixture,
    );

    const { data: pool } = await admin.from("pools").select("snapshot_version").eq("id", poolId).single();
    const { data: settlement } = await admin
      .from("settlements")
      .select("id, grading_version, winning_option_id")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement!.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: yesOptionId,
    });
    expect(confirmError).toBeNull();

    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full 1800 payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });
});
