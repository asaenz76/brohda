/**
 * Integration tests for TEMPLATE_GRADED pools — the new registry-driven
 * grading bridge (gradeTemplatePool, lib/pools/templates/grade.ts).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { gradeTemplatePool } from "@/lib/pools/templates/grade";
import { processAwaitingResults } from "@/lib/pools/settle";

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
  regulationHomeScore?: number | null;
  regulationAwayScore?: number | null;
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
}> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `template-pool-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      internal_status: overrides.internalStatus ?? "COMPLETED",
      // `??` treats an explicit `null` override the same as "not passed,"
      // which would silently default a deliberately-null score back to 3/1
      // — use `in` so a test asking for a missing score actually gets one.
      regulation_home_score: "regulationHomeScore" in overrides ? overrides.regulationHomeScore : 3,
      regulation_away_score: "regulationAwayScore" in overrides ? overrides.regulationAwayScore : 1,
    })
    .select(
      "id, internal_status, home_team_name, away_team_name, home_team_external_id, away_team_external_id, regulation_home_score, regulation_away_score, halftime_home_score, halftime_away_score",
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
  recommendationEvidence: Record<string, unknown> | null = null,
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
      // In the future regardless of the (already-completed) fixture's own
      // kickoff — create_pool_entry rejects entries once now() >= locks_at,
      // and these tests transition status by hand rather than relying on
      // the real lock cron.
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status,
      recommendation_evidence: recommendationEvidence,
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

describe.skipIf(!SERVICE_ROLE_KEY)("TEMPLATE_GRADED pools — gradeTemplatePool", () => {
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

  it("grades a WINNING_MARGIN pool YES, stamps the winner, and records evidence", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 3, regulationAwayScore: 1 });
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId } = await createTemplatePool(adminId, fixture.id, "WINNING_MARGIN", {
      team: "HOME",
      minimumMargin: 2,
    });

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "WINNING_MARGIN", template_config: { team: "HOME", minimumMargin: 2 } },
      fixture,
    );
    expect(outcome).toBe("readyForReview");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("READY_FOR_REVIEW");

    const { data: settlement } = await admin
      .from("settlements")
      .select("id, winning_option_id, winning_option_reason, grading_version")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);
    expect(settlement?.winning_option_reason).toBe("TEMPLATE_GRADED");

    const { data: evidenceRows } = await admin
      .from("pool_grading_evidence")
      .select("result, template_id, reason")
      .eq("settlement_id", settlement!.id);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows![0].result).toBe("YES");
    expect(evidenceRows![0].template_id).toBe("WINNING_MARGIN");

    const { data: yesOption } = await admin
      .from("pool_options")
      .select("is_winning_option")
      .eq("id", yesOptionId)
      .single();
    expect(yesOption?.is_winning_option).toBe(true);
  });

  it("is idempotent — grading the same pool twice does not duplicate the settlement or evidence", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 0 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "BOTH_TEAMS_TO_SCORE", {});

    const pool = { id: poolId, template_id: "BOTH_TEAMS_TO_SCORE", template_config: {} };
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

  it("stays PENDING (not VOID, not assumed zero) when regulation score is missing on a COMPLETED fixture", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: null, regulationAwayScore: null });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "MATCH_TOTAL_GOALS", {
      minimumGoals: 2,
    });

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "MATCH_TOTAL_GOALS", template_config: { minimumGoals: 2 } },
      fixture,
    );
    expect(outcome).toBe("pending");

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("AWAITING_RESULT");

    const { data: settlements } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlements).toHaveLength(0);
  });

  it("stays PENDING while the fixture is still live — never grades from an in-progress score", async () => {
    const fixture = await createTestFixture({
      internalStatus: "LIVE",
      regulationHomeScore: 1,
      regulationAwayScore: 0,
    });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "HOME_TEAM_TO_WIN", {});

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "HOME_TEAM_TO_WIN", template_config: {} },
      fixture,
    );
    expect(outcome).toBe("pending");

    const { data: settlements } = await admin.from("settlements").select("id").eq("pool_id", poolId);
    expect(settlements).toHaveLength(0);
  });

  it("full flow: gradeTemplatePool settles automatically — no separate confirm step needed (Phase 1.5)", async () => {
    const p1 = await createTestPlayer(`template-payout-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`template-payout-b-${Date.now()}@example.com`, 5000);

    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 1 });
    createdFixtureIds.push(fixture.id);
    // create_pool_entry requires the pool to be OPEN — created OPEN here,
    // then transitioned to AWAITING_RESULT after both entries are in,
    // mirroring the real OPEN -> LOCKED -> AWAITING_RESULT lifecycle.
    const { poolId, yesOptionId, noOptionId } = await createTemplatePool(
      adminId,
      fixture.id,
      "HOME_TEAM_TO_WIN",
      {},
      "OPEN",
    );

    const [{ error: enter1Error }, { error: enter2Error }] = await Promise.all([
      enter(poolId, p1.userId, yesOptionId),
      enter(poolId, p2.userId, noOptionId),
    ]);
    expect(enter1Error).toBeNull();
    expect(enter2Error).toBeNull();

    await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);

    // A single call — no separate confirm_pool_settlement call from the
    // test, unlike before Phase 1.5. An unambiguous outcome with real
    // entries on both sides settles fully automatically.
    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "HOME_TEAM_TO_WIN", template_config: {} },
      fixture,
    );
    expect(outcome).toBe("settled");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("SETTLED");

    const { data: settlement } = await admin
      .from("settlements")
      .select("id, winning_option_id, confirmed_at, confirmed_by_admin_id")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);
    expect(settlement?.confirmed_at).not.toBeNull();
    // null admin id is how a system-triggered confirm is distinguished
    // from a human one in the audit trail (settlements.confirmed_by_admin_id).
    expect(settlement?.confirmed_by_admin_id).toBeNull();

    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full 1800 payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    // A manual confirm attempted afterward (e.g. an admin double-clicking,
    // or a stray call) must be a safe, idempotent no-op — not a double-pay.
    const { error: repeatConfirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: pool!.snapshot_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: yesOptionId,
    });
    expect(repeatConfirmError).toBeNull();
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("processAwaitingResults settles a COMPLETED fixture's pool fully automatically — the real cron path, no admin step (Phase 1.5)", async () => {
    const p1 = await createTestPlayer(`process-results-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`process-results-b-${Date.now()}@example.com`, 5000);

    const fixture = await createTestFixture({ regulationHomeScore: 3, regulationAwayScore: 0 });
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId, noOptionId } = await createTemplatePool(
      adminId,
      fixture.id,
      "HOME_TEAM_TO_WIN",
      {},
      "OPEN",
    );

    await Promise.all([enter(poolId, p1.userId, yesOptionId), enter(poolId, p2.userId, noOptionId)]);
    await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);

    // The actual function app/api/cron/process-results/route.ts calls —
    // proves grading AND settlement are reachable through the automatic
    // orchestration path (finds every AWAITING_RESULT pool, reads its
    // fixture, grades it, and now settles it), not just through
    // gradeTemplatePool called directly with a hand-assembled pool/fixture
    // pair as every other test in this file does. Asserted per-pool (not
    // via the aggregate result counters) since other AWAITING_RESULT pools
    // may legitimately exist concurrently in a shared local database.
    const result = await processAwaitingResults();
    expect(result.failed).toBe(0);

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("SETTLED");

    const { data: settlement } = await admin
      .from("settlements")
      .select("winning_option_id, confirmed_at, confirmed_by_admin_id")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).toBe(yesOptionId);
    expect(settlement?.confirmed_at).not.toBeNull();
    expect(settlement?.confirmed_by_admin_id).toBeNull();

    // Money actually moved — no admin ever clicked confirm.
    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("falls back to READY_FOR_REVIEW (not an error, not a crash) when automatic settlement itself can't safely complete", async () => {
    // No entries on either side — automatic confirm_pool_settlement will
    // hit its own no-or-all-winner guard (0 winning entries == 0 total
    // entries) and raise, exactly the "settlement validation failure"
    // exceptional case Phase 1.5 is required to preserve. This proves the
    // fallback explicitly, rather than relying on it being incidental to
    // every other zero-entry test in this file.
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 0 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "HOME_TEAM_TO_WIN", {});

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "HOME_TEAM_TO_WIN", template_config: {} },
      fixture,
    );
    expect(outcome).toBe("readyForReview");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("READY_FOR_REVIEW");

    // The settlement proposal is intact and waiting exactly as before
    // Phase 1.5 — an admin can still pick it up and confirm manually.
    const { data: settlement } = await admin
      .from("settlements")
      .select("winning_option_id, confirmed_at")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    expect(settlement?.winning_option_id).not.toBeNull();
    expect(settlement?.confirmed_at).toBeNull();
  });

  it("a retired (activeForCreation: false) template still grades an existing historical pool via exact-version resolution", async () => {
    // CLEAN_SHEET was retired from new-pool creation in the launch
    // simplification (activeForCreation: false in
    // lib/pools/templates/goals.ts) but remains fully gradeable for any
    // pool created against it before the retirement — getTemplate(id,
    // version) never filters on activeForCreation, only getLatestTemplate
    // (creation-time only) does.
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 0 });
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId } = await createTemplatePool(adminId, fixture.id, "CLEAN_SHEET", { team: "HOME" });

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "CLEAN_SHEET", template_config: { team: "HOME" } },
      fixture,
    );
    expect(outcome).toBe("readyForReview");

    const { data: pool } = await admin.from("pools").select("status, snapshot_version").eq("id", poolId).single();
    expect(pool?.status).toBe("READY_FOR_REVIEW");

    const { data: settlement } = await admin
      .from("settlements")
      .select("winning_option_id, winning_option_reason")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    // Away conceded 0 -> home kept a clean sheet -> YES.
    expect(settlement?.winning_option_id).toBe(yesOptionId);
    expect(settlement?.winning_option_reason).toBe("TEMPLATE_GRADED");
  });

  it("resolves the winner via binary_outcome even when labels are swapped from the usual Yes/No", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 0 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(adminId, fixture.id, "BOTH_TEAMS_TO_SCORE", {});

    // Swap the labels so a label-based lookup would pick the wrong option —
    // binary_outcome is the primary lookup now, so this must still resolve
    // to the correct (NO) option.
    const { data: options } = await admin.from("pool_options").select("id, label").eq("pool_id", poolId);
    const yesRow = options!.find((o) => o.label === "Yes")!;
    const noRow = options!.find((o) => o.label === "No")!;
    // Staged through a transient null so the (pool_id, binary_outcome)
    // partial unique index is never briefly double-held by both rows.
    await admin.from("pool_options").update({ binary_outcome: null }).eq("id", noRow.id);
    await admin.from("pool_options").update({ label: "Swapped A", binary_outcome: "NO" }).eq("id", yesRow.id);
    await admin.from("pool_options").update({ label: "Swapped B", binary_outcome: "YES" }).eq("id", noRow.id);

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "BOTH_TEAMS_TO_SCORE", template_config: {}, template_version: 1 },
      fixture,
    );
    expect(outcome).toBe("readyForReview");

    const { data: pool } = await admin.from("pools").select("snapshot_version").eq("id", poolId).single();
    const { data: settlement } = await admin
      .from("settlements")
      .select("winning_option_id")
      .eq("pool_id", poolId)
      .eq("grading_version", pool!.snapshot_version)
      .single();
    // 2-0 is not "both teams to score" -> NO -> the option now labeled
    // "Swapped A" (binary_outcome NO), NOT the one still literally labeled "No".
    expect(settlement?.winning_option_id).toBe(yesRow.id);
  });

  it("routes to MANUAL_REVIEW (TEMPLATE_VERSION_UNRESOLVABLE) when the stored template_version no longer exists", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 1 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(
      adminId,
      fixture.id,
      "HOME_TEAM_TO_WIN",
      {},
      "AWAITING_RESULT",
    );

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "HOME_TEAM_TO_WIN", template_config: {}, template_version: 999 },
      fixture,
    );
    expect(outcome).toBe("manualReview");

    const { data: pool } = await admin.from("pools").select("status, review_reason").eq("id", poolId).single();
    expect(pool?.status).toBe("MANUAL_REVIEW");
    expect(pool?.review_reason).toBe("TEMPLATE_VERSION_UNRESOLVABLE");
  });

  it("routes to MANUAL_REVIEW (TEMPLATE_CONFIG_INVALID) when the stored config no longer validates", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 1 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(
      adminId,
      fixture.id,
      "WINNING_MARGIN",
      { team: "HOME", minimumMargin: 2 },
      "AWAITING_RESULT",
    );

    // WINNING_MARGIN's schema is strict and requires team/minimumMargin —
    // an empty config no longer validates against it.
    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "WINNING_MARGIN", template_config: {}, template_version: 1 },
      fixture,
    );
    expect(outcome).toBe("manualReview");

    const { data: pool } = await admin.from("pools").select("status, review_reason").eq("id", poolId).single();
    expect(pool?.status).toBe("MANUAL_REVIEW");
    expect(pool?.review_reason).toBe("TEMPLATE_CONFIG_INVALID");
  });

  it("routes to MANUAL_REVIEW (BINARY_OPTIONS_UNRESOLVABLE) when there's no NO option to resolve", async () => {
    const fixture = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 1 });
    createdFixtureIds.push(fixture.id);
    const { poolId } = await createTemplatePool(
      adminId,
      fixture.id,
      "HOME_TEAM_TO_WIN",
      {},
      "AWAITING_RESULT",
    );
    // Corrupt the options: both end up labeled/outcome "Yes"/YES.
    const { data: options } = await admin.from("pool_options").select("id, label").eq("pool_id", poolId);
    const noRow = options!.find((o) => o.label === "No")!;
    await admin.from("pool_options").update({ label: "Yes", binary_outcome: "YES" }).eq("id", noRow.id);

    const outcome = await gradeTemplatePool(
      { id: poolId, template_id: "HOME_TEAM_TO_WIN", template_config: {}, template_version: 1 },
      fixture,
    );
    expect(outcome).toBe("manualReview");

    const { data: pool } = await admin.from("pools").select("status, review_reason").eq("id", poolId).single();
    expect(pool?.status).toBe("MANUAL_REVIEW");
    expect(pool?.review_reason).toBe("BINARY_OPTIONS_UNRESOLVABLE");
  });
});

describe.skipIf(!SERVICE_ROLE_KEY)("recommendation_evidence — informational, frozen after first entry", () => {
  let adminId: string;

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
  });

  it("persists the snapshot stamped at creation and reads it back verbatim", async () => {
    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const evidence = {
      source: "MARKET_CONSENSUS",
      probability: 0.52,
      bookmakerCount: 4,
      bookmakerIds: [1, 4, 8, 16],
      marketKey: "MATCH_TOTAL_GOALS",
      oddsLine: 2.5,
      oddsUpdatedAt: new Date().toISOString(),
    };
    const { poolId } = await createTemplatePool(adminId, fixture.id, "MATCH_TOTAL_GOALS", { minimumGoals: 3 }, "OPEN", evidence);

    const { data: pool } = await admin.from("pools").select("recommendation_evidence").eq("id", poolId).single();
    expect(pool?.recommendation_evidence).toEqual(evidence);
  });

  it("is never touched by settlement — pool_grading_evidence stays independent", async () => {
    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const evidence = { source: "STATIC_PRIOR", probability: 0.5, bookmakerCount: 0, bookmakerIds: [], marketKey: null, oddsLine: null, oddsUpdatedAt: null };
    const { poolId } = await createTemplatePool(adminId, fixture.id, "BOTH_TEAMS_TO_SCORE", {}, "AWAITING_RESULT", evidence);

    await gradeTemplatePool({ id: poolId, template_id: "BOTH_TEAMS_TO_SCORE", template_config: {}, template_version: 1 }, fixture);

    const { data: pool } = await admin.from("pools").select("recommendation_evidence").eq("id", poolId).single();
    expect(pool?.recommendation_evidence).toEqual(evidence); // untouched by grading
  });

  it("rejects an update to recommendation_evidence once the pool has an entry", async () => {
    const player = await createTestPlayer(`rec-evidence-freeze-${Date.now()}@example.com`, 5000);
    const fixture = await createTestFixture();
    createdFixtureIds.push(fixture.id);
    const { poolId, yesOptionId } = await createTemplatePool(
      adminId,
      fixture.id,
      "BOTH_TEAMS_TO_SCORE",
      {},
      "OPEN",
      { source: "STATIC_PRIOR", probability: 0.5, bookmakerCount: 0, bookmakerIds: [], marketKey: null, oddsLine: null, oddsUpdatedAt: null },
    );

    await enter(poolId, player.userId, yesOptionId);

    const { error } = await admin
      .from("pools")
      .update({ recommendation_evidence: { source: "MARKET_CONSENSUS", probability: 0.9 } })
      .eq("id", poolId);
    expect(error).not.toBeNull();
    expect(error?.message).toContain("frozen after the first entry");

    await deactivate(player.userId);
  });
});
