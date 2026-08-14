/**
 * Dev/demo seed data (spec §25 / Phase 7 Decision 11). Reuses the actual
 * RPCs the app calls (`create_pool_entry`, `prepare_pool_settlement`,
 * `confirm_pool_settlement`, `confirm_pool_refund`, `reverse_pool_settlement`,
 * `apply_wallet_transaction`) rather than raw inserts, so seeded rows obey
 * the same invariants (unique indexes, trigger-maintained aggregates) real
 * traffic does.
 *
 * Not idempotent — run against a freshly reset database:
 *   pnpm supabase db reset
 *   pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
 *   pnpm seed
 *
 * NEVER run against production — see docs/DEPLOYMENT.md. Enforced (not
 * just documented) as of Phase 3 — see assertProductionWriteConfirmed.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { generatePoolTemplate, type PoolType } from "../lib/pools/templates";
import { buildNoticeCopy } from "../lib/pools/notices";
import type { PoolVoidReason } from "../lib/pools/anomaly";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

assertProductionWriteConfirmed(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "seed");

function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const admin = createAdminClient();

const DEMO_PASSWORD = "PollPoolsDemo123!";

async function getSuperAdminId(): Promise<string> {
  const { data } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "super_admin")
    .limit(1)
    .single();

  if (!data) {
    console.error("No super admin found — run `pnpm create-super-admin` first.");
    process.exit(1);
  }

  return data.id;
}

async function createDemoUser(email: string, displayName: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });

  if (error || !created.user) {
    throw new Error(`Failed to create ${email}: ${error?.message}`);
  }

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: created.user.id,
    display_name: displayName,
    role: "player",
    is_active: true,
  });

  if (profileError) {
    throw new Error(`Failed to create profile for ${email}: ${profileError.message}`);
  }

  return created.user.id;
}

async function fundWallet(
  userId: string,
  adminId: string,
  amountCents: number,
  direction: "credit" | "debit",
  type: "manual_deposit" | "manual_withdrawal",
  reason: string,
) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: type,
    p_direction: direction,
    p_amount: amountCents,
    p_admin_id: adminId,
    p_reason: reason,
    p_idempotency_key: `seed:${type}:${userId}:${Date.now()}:${Math.random()}`,
  });

  if (error) throw new Error(`Wallet funding failed for ${userId}: ${error.message}`);
}

interface FixtureConfig {
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string;
  scheduledStartUtc: string;
  internalStatus: string;
  regulationHomeScore?: number | null;
  regulationAwayScore?: number | null;
}

async function createFixture(config: FixtureConfig): Promise<string> {
  const externalId = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: "seed",
      external_fixture_id: externalId,
      sport: "football",
      competition_name: config.competitionName,
      home_team_external_id: `${externalId}-home`,
      home_team_name: config.homeTeamName,
      away_team_external_id: `${externalId}-away`,
      away_team_name: config.awayTeamName,
      scheduled_start_utc: config.scheduledStartUtc,
      internal_status: config.internalStatus,
      regulation_home_score: config.regulationHomeScore ?? null,
      regulation_away_score: config.regulationAwayScore ?? null,
      home_score: config.regulationHomeScore ?? null,
      away_score: config.regulationAwayScore ?? null,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to create fixture: ${error?.message}`);
  return data.id;
}

interface PoolConfig {
  fixtureId: string;
  adminId: string;
  poolType: PoolType;
  entryFeeCents: number;
  houseFeeBps: number;
  minTotalEntries: number;
  visibility: "VISIBLE_TO_ALL_MEMBERS" | "HIDDEN";
  locksAt: string;
}

async function createPool(config: PoolConfig): Promise<{ poolId: string; optionIds: string[] }> {
  const { data: fixture } = await admin
    .from("fixtures")
    .select(
      "home_team_external_id, home_team_name, home_team_logo_url, away_team_external_id, away_team_name, away_team_logo_url",
    )
    .eq("id", config.fixtureId)
    .single();

  if (!fixture) throw new Error("Fixture not found for pool creation");

  const template = generatePoolTemplate(config.poolType, {
    homeTeamExternalId: fixture.home_team_external_id,
    homeTeamName: fixture.home_team_name,
    homeTeamLogoUrl: fixture.home_team_logo_url,
    awayTeamExternalId: fixture.away_team_external_id,
    awayTeamName: fixture.away_team_name,
    awayTeamLogoUrl: fixture.away_team_logo_url,
  });

  const { data: pool, error: poolError } = await admin
    .from("pools")
    .insert({
      fixture_id: config.fixtureId,
      created_by: config.adminId,
      pool_type: config.poolType,
      question: template.question,
      entry_fee: config.entryFeeCents,
      house_fee_bps: config.houseFeeBps,
      min_total_entries: config.minTotalEntries,
      visibility: config.visibility,
      participation_visibility: "SHOW_BEFORE_ENTRY",
      open_at: new Date().toISOString(),
      locks_at: config.locksAt,
      status: "OPEN",
    })
    .select("id")
    .single();

  if (poolError || !pool) throw new Error(`Failed to create pool: ${poolError?.message}`);

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert(
      template.options.map((option) => ({
        pool_id: pool.id,
        label: option.label,
        external_team_id: option.externalTeamId,
        team_name: option.teamName,
        logo_url: option.logoUrl,
        sort_order: option.sortOrder,
      })),
    )
    .select("id, sort_order");

  if (optionsError || !options) throw new Error(`Failed to create pool options: ${optionsError?.message}`);

  const sorted = [...options].sort((a, b) => a.sort_order - b.sort_order);
  return { poolId: pool.id, optionIds: sorted.map((o) => o.id) };
}

async function enterPool(poolId: string, userId: string, optionId: string, amountCents: number) {
  const { error } = await admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amountCents,
    p_idempotency_key: `seed:entry:${poolId}:${userId}`,
  });
  if (error) throw new Error(`Entry failed for ${userId} in ${poolId}: ${error.message}`);
}

async function setPoolStatus(poolId: string, status: string) {
  const { error } = await admin.from("pools").update({ status }).eq("id", poolId);
  if (error) throw new Error(`Failed to set pool ${poolId} to ${status}: ${error.message}`);
}

async function insertSettlementNotifications(poolId: string) {
  const { data: settlement } = await admin
    .from("settlements")
    .select("id, winning_option_id")
    .eq("pool_id", poolId)
    .order("grading_version", { ascending: false })
    .limit(1)
    .single();
  if (!settlement) return;

  const { data: options } = await admin.from("pool_options").select("id, label").eq("pool_id", poolId);
  const labelById = new Map((options ?? []).map((o) => [o.id, o.label]));
  const winningOptionLabel = settlement.winning_option_id
    ? (labelById.get(settlement.winning_option_id) ?? null)
    : null;

  const { data: entries } = await admin
    .from("entries")
    .select("id, user_id, option_id, status")
    .eq("pool_id", poolId)
    .in("status", ["WON", "LOST"]);
  if (!entries || entries.length === 0) return;

  const { data: payouts } = await admin
    .from("settlement_payouts")
    .select("entry_id, amount")
    .eq("settlement_id", settlement.id);
  const payoutByEntry = new Map((payouts ?? []).map((p) => [p.entry_id, p.amount]));

  const rows = entries.map((entry) => {
    const isWon = entry.status === "WON";
    const notice = buildNoticeCopy({
      poolStatus: "SETTLED",
      fixtureInternalStatus: "COMPLETED",
      voidReason: null,
      entryStatus: entry.status as "WON" | "LOST",
      entryAmount: 0,
      finalPayout: isWon ? (payoutByEntry.get(entry.id) ?? null) : null,
      winningOptionLabel,
      selectedOptionLabel: labelById.get(entry.option_id) ?? null,
    });
    return {
      user_id: entry.user_id,
      type: notice?.type ?? (isWon ? "SETTLED_WON" : "SETTLED_LOST"),
      title: isWon ? "You won!" : "Pool settled",
      body: notice?.message ?? "This pool has been settled.",
      pool_id: poolId,
    };
  });

  await admin.from("notifications").insert(rows);
}

async function insertRefundNotifications(
  poolId: string,
  poolStatus: "VOIDED" | "CANCELLED",
  voidReason: PoolVoidReason,
) {
  const { data: entries } = await admin
    .from("entries")
    .select("user_id, amount")
    .eq("pool_id", poolId)
    .eq("status", "REFUNDED");
  if (!entries || entries.length === 0) return;

  const title = voidReason === "MINIMUM_ENTRIES_NOT_REACHED" ? "Pool cancelled" : "Pool voided";
  const rows = entries.map((entry) => {
    const notice = buildNoticeCopy({
      poolStatus,
      fixtureInternalStatus: "UNKNOWN",
      voidReason,
      entryStatus: "REFUNDED",
      entryAmount: entry.amount,
      finalPayout: null,
    });
    return {
      user_id: entry.user_id,
      type: notice?.type ?? voidReason,
      title,
      body: notice?.message ?? "This pool has been voided.",
      pool_id: poolId,
    };
  });

  await admin.from("notifications").insert(rows);
}

async function main() {
  console.log("Seeding demo data...");
  const adminId = await getSuperAdminId();

  console.log("Creating demo players...");
  const alice = await createDemoUser("alice@pollpools.demo", "Alice");
  const bob = await createDemoUser("bob@pollpools.demo", "Bob");
  const carol = await createDemoUser("carol@pollpools.demo", "Carol");
  const dave = await createDemoUser("dave@pollpools.demo", "Dave");
  const erin = await createDemoUser("erin@pollpools.demo", "Erin");

  for (const userId of [alice, bob, carol, dave, erin]) {
    await fundWallet(userId, adminId, 20000, "credit", "manual_deposit", "Seed initial funding");
  }
  await fundWallet(alice, adminId, 3000, "debit", "manual_withdrawal", "Seed demo withdrawal");

  const now = Date.now();
  const hours = (n: number) => new Date(now + n * 60 * 60 * 1000).toISOString();

  // P1: OPEN, no entries yet — fresh pool in the feed.
  const fixture1 = await createFixture({
    homeTeamName: "Costa Rica",
    awayTeamName: "Panama",
    competitionName: "CONCACAF Qualifiers",
    scheduledStartUtc: hours(48),
    internalStatus: "NOT_STARTED",
  });
  await createPool({
    fixtureId: fixture1,
    adminId,
    poolType: "WHO_WILL_ADVANCE",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(47.9),
  });
  console.log("  P1 OPEN (no entries) done");

  // P2: OPEN with entries, HIDDEN visibility — exercises SharePoolButton.
  const fixture2 = await createFixture({
    homeTeamName: "Barcelona",
    awayTeamName: "Real Madrid",
    competitionName: "La Liga",
    scheduledStartUtc: hours(24),
    internalStatus: "NOT_STARTED",
  });
  const p2 = await createPool({
    fixtureId: fixture2,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "HIDDEN",
    locksAt: hours(23.9),
  });
  await enterPool(p2.poolId, bob, p2.optionIds[0], 1000);
  await enterPool(p2.poolId, carol, p2.optionIds[2], 1000);
  console.log("  P2 OPEN (hidden, with entries) done");

  // P3: LOCKED, past lock time, entries already placed.
  const fixture3 = await createFixture({
    homeTeamName: "Yankees",
    awayTeamName: "Red Sox",
    competitionName: "MLB",
    scheduledStartUtc: hours(-1),
    internalStatus: "NOT_STARTED",
  });
  const p3 = await createPool({
    fixtureId: fixture3,
    adminId,
    poolType: "WHO_WILL_ADVANCE",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p3.poolId, alice, p3.optionIds[0], 1000);
  await enterPool(p3.poolId, bob, p3.optionIds[1], 1000);
  await setPoolStatus(p3.poolId, "LOCKED");
  console.log("  P3 LOCKED done");

  // P4: AWAITING_RESULT, fixture LIVE — exercises the LIVE card state.
  const fixture4 = await createFixture({
    homeTeamName: "Lakers",
    awayTeamName: "Celtics",
    competitionName: "NBA",
    scheduledStartUtc: hours(-1),
    internalStatus: "LIVE",
  });
  await admin.from("fixtures").update({ elapsed_minutes: 58, home_score: 2, away_score: 1 }).eq("id", fixture4);
  const p4 = await createPool({
    fixtureId: fixture4,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p4.poolId, carol, p4.optionIds[0], 1000);
  await enterPool(p4.poolId, dave, p4.optionIds[2], 1000);
  await setPoolStatus(p4.poolId, "LOCKED");
  await setPoolStatus(p4.poolId, "AWAITING_RESULT");
  console.log("  P4 AWAITING_RESULT (live) done");

  // P5: READY_FOR_REVIEW — admin still needs to confirm in the UI.
  const fixture5 = await createFixture({
    homeTeamName: "Arsenal",
    awayTeamName: "Chelsea",
    competitionName: "Premier League",
    scheduledStartUtc: hours(-3),
    internalStatus: "COMPLETED",
    regulationHomeScore: 2,
    regulationAwayScore: 1,
  });
  const p5 = await createPool({
    fixtureId: fixture5,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p5.poolId, alice, p5.optionIds[0], 1000);
  await enterPool(p5.poolId, erin, p5.optionIds[2], 1000);
  await setPoolStatus(p5.poolId, "LOCKED");
  await setPoolStatus(p5.poolId, "AWAITING_RESULT");
  await admin.rpc("prepare_pool_settlement", { p_pool_id: p5.poolId });
  console.log("  P5 READY_FOR_REVIEW done");

  // P6: SETTLED, clean payout (no rounding remainder).
  const fixture6 = await createFixture({
    homeTeamName: "Golden State Warriors",
    awayTeamName: "Miami Heat",
    competitionName: "NBA",
    scheduledStartUtc: hours(-6),
    internalStatus: "COMPLETED",
    regulationHomeScore: 3,
    regulationAwayScore: 0,
  });
  const p6 = await createPool({
    fixtureId: fixture6,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p6.poolId, bob, p6.optionIds[0], 1000);
  await enterPool(p6.poolId, carol, p6.optionIds[0], 1000);
  await enterPool(p6.poolId, dave, p6.optionIds[2], 1000);
  await setPoolStatus(p6.poolId, "LOCKED");
  await setPoolStatus(p6.poolId, "AWAITING_RESULT");
  await admin.rpc("prepare_pool_settlement", { p_pool_id: p6.poolId });
  await admin.rpc("confirm_pool_settlement", {
    p_pool_id: p6.poolId,
    p_admin_id: adminId,
    p_grading_version: 1,
    p_idempotency_key: `seed:confirm:${p6.poolId}`,
  });
  await insertSettlementNotifications(p6.poolId);
  console.log("  P6 SETTLED (clean payout) done");

  // P7: SETTLED with a rounding remainder — exercises the payout accordion's
  // rounding-disclosure line. 10.5% fee on 3x$10 entries, 2 winners:
  // gross 3000, fee 315, net 2685, payout 1342 each, remainder 1 cent.
  const fixture7 = await createFixture({
    homeTeamName: "PSG",
    awayTeamName: "Marseille",
    competitionName: "Ligue 1",
    scheduledStartUtc: hours(-8),
    internalStatus: "COMPLETED",
    regulationHomeScore: 1,
    regulationAwayScore: 0,
  });
  const p7 = await createPool({
    fixtureId: fixture7,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1050,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p7.poolId, alice, p7.optionIds[0], 1000);
  await enterPool(p7.poolId, erin, p7.optionIds[0], 1000);
  await enterPool(p7.poolId, dave, p7.optionIds[2], 1000);
  await setPoolStatus(p7.poolId, "LOCKED");
  await setPoolStatus(p7.poolId, "AWAITING_RESULT");
  await admin.rpc("prepare_pool_settlement", { p_pool_id: p7.poolId });
  await admin.rpc("confirm_pool_settlement", {
    p_pool_id: p7.poolId,
    p_admin_id: adminId,
    p_grading_version: 1,
    p_idempotency_key: `seed:confirm:${p7.poolId}`,
  });
  await insertSettlementNotifications(p7.poolId);
  console.log("  P7 SETTLED (rounding remainder) done");

  // P8: reversed settlement. reverse_pool_settlement immediately re-preps a
  // fresh snapshot after reversing (spec §17.3), so the pool lands back on
  // READY_FOR_REVIEW (grading_version 2) with the original settlement's
  // history (confirmed + reversed) visible in the admin pool detail page.
  const fixture8 = await createFixture({
    homeTeamName: "Bayern Munich",
    awayTeamName: "Dortmund",
    competitionName: "Bundesliga",
    scheduledStartUtc: hours(-10),
    internalStatus: "COMPLETED",
    regulationHomeScore: 4,
    regulationAwayScore: 2,
  });
  const p8 = await createPool({
    fixtureId: fixture8,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p8.poolId, bob, p8.optionIds[0], 1000);
  await enterPool(p8.poolId, dave, p8.optionIds[2], 1000);
  await setPoolStatus(p8.poolId, "LOCKED");
  await setPoolStatus(p8.poolId, "AWAITING_RESULT");
  await admin.rpc("prepare_pool_settlement", { p_pool_id: p8.poolId });
  await admin.rpc("confirm_pool_settlement", {
    p_pool_id: p8.poolId,
    p_admin_id: adminId,
    p_grading_version: 1,
    p_idempotency_key: `seed:confirm:${p8.poolId}`,
  });
  await insertSettlementNotifications(p8.poolId);
  await admin.rpc("reverse_pool_settlement", {
    p_pool_id: p8.poolId,
    p_admin_id: adminId,
    p_reason: "Seed demo: incorrect final score reported by provider",
    p_idempotency_key: `seed:reverse:${p8.poolId}`,
  });
  console.log("  P8 reversed (back to READY_FOR_REVIEW, grading_version 2) done");

  // P9: VOIDED — match postponed, anomaly refund.
  const fixture9 = await createFixture({
    homeTeamName: "Juventus",
    awayTeamName: "AC Milan",
    competitionName: "Serie A",
    scheduledStartUtc: hours(-4),
    internalStatus: "POSTPONED",
  });
  const p9 = await createPool({
    fixtureId: fixture9,
    adminId,
    poolType: "REGULATION_RESULT",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 2,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p9.poolId, carol, p9.optionIds[0], 1000);
  await enterPool(p9.poolId, erin, p9.optionIds[2], 1000);
  await setPoolStatus(p9.poolId, "LOCKED");
  await setPoolStatus(p9.poolId, "AWAITING_RESULT");
  await admin.rpc("confirm_pool_refund", {
    p_pool_id: p9.poolId,
    p_void_reason: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
    p_idempotency_key: `seed:void:${p9.poolId}`,
  });
  await insertRefundNotifications(p9.poolId, "VOIDED", "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY");
  console.log("  P9 VOIDED (postponed) done");

  // P10: CANCELLED — below minimum entries at lock time.
  const fixture10 = await createFixture({
    homeTeamName: "Boca Juniors",
    awayTeamName: "River Plate",
    competitionName: "Copa Argentina",
    scheduledStartUtc: hours(-2),
    internalStatus: "NOT_STARTED",
  });
  const p10 = await createPool({
    fixtureId: fixture10,
    adminId,
    poolType: "WHO_WILL_ADVANCE",
    entryFeeCents: 1000,
    houseFeeBps: 1000,
    minTotalEntries: 3,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    locksAt: hours(0.02),
  });
  await enterPool(p10.poolId, dave, p10.optionIds[0], 1000);
  await setPoolStatus(p10.poolId, "LOCKED");
  await admin.rpc("confirm_pool_refund", {
    p_pool_id: p10.poolId,
    p_void_reason: "MINIMUM_ENTRIES_NOT_REACHED",
    p_idempotency_key: `seed:void:${p10.poolId}`,
  });
  await insertRefundNotifications(p10.poolId, "CANCELLED", "MINIMUM_ENTRIES_NOT_REACHED");
  console.log("  P10 CANCELLED (below minimum) done");

  await admin.from("audit_logs").insert([
    {
      actor_id: adminId,
      action: "pool.created",
      entity_type: "pool",
      entity_id: p6.poolId,
      after: { question: "Seed data" },
      reason: null,
    },
    {
      actor_id: adminId,
      action: "wallet.deposit",
      entity_type: "wallet_balance",
      entity_id: alice,
      before: { balance: 0 },
      after: { balance: 20000 },
      reason: "Seed initial funding",
    },
  ]);

  console.log("\nSeed data complete. Demo accounts (password: PollPoolsDemo123!):");
  console.log("  alice@pollpools.demo, bob@pollpools.demo, carol@pollpools.demo,");
  console.log("  dave@pollpools.demo, erin@pollpools.demo");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
